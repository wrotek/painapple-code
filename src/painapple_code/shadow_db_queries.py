"""Read-only query methods for ShadowDB.

Mixed into ShadowDB. Contains get_turn, list_turns, search_turns,
query_turns, and stats helpers. All methods return data dicts — no DB
mutations here.
"""

import logging
from typing import Optional

logger = logging.getLogger("painapple-code.shadow-db")


class _QueriesMixin:
    """Read-only query methods for ShadowDB."""

    def get_turn(self, turn_id: str) -> Optional[dict]:
        """Get a turn with all its fields, tags, files, and tools."""
        columns, rows = self._fetch_columns(
            "SELECT * FROM turns WHERE id = ?", [turn_id]
        )
        if not rows:
            return None

        turn = dict(zip(columns, rows[0]))

        # Attach fields
        turn["fields"] = {}
        for r in self._fetch_all(
            "SELECT field_key, value_text, value_list FROM turn_fields WHERE turn_id = ?",
            [turn_id]
        ):
            turn["fields"][r[0]] = r[2] if r[2] is not None else r[1]

        # Attach tags
        turn["tags"] = [r[0] for r in self._fetch_all(
            "SELECT tag FROM tags WHERE turn_id = ?", [turn_id]
        )]

        # Attach files. "files" = what Claude changed (every consumer reads it
        # that way); reads are their own list.
        turn["files"] = [r[0] for r in self._fetch_all(
            "SELECT file_path FROM turn_files WHERE turn_id = ? AND change_type IS DISTINCT FROM 'read'",
            [turn_id]
        )]
        turn["read_files"] = [r[0] for r in self._fetch_all(
            "SELECT file_path FROM turn_files WHERE turn_id = ? AND change_type = 'read'",
            [turn_id]
        )]

        # Attach tools
        turn["tools"] = {r[0]: r[1] for r in self._fetch_all(
            "SELECT tool_name, call_count FROM turn_tools WHERE turn_id = ?", [turn_id]
        )}

        return turn

    def list_turns(
        self,
        project_hash: Optional[str] = None,
        session_id: Optional[str] = None,
        git_branch: Optional[str] = None,
        status: Optional[str] = None,
        tag: Optional[str] = None,
        search: Optional[str] = None,
        git_repo_hash: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict:
        """List turns with filters. Returns {turns, total, has_more}."""
        conditions = []
        params = []

        if git_repo_hash:
            conditions.append("t.git_repo_hash = ?")
            params.append(git_repo_hash)
        elif project_hash:
            conditions.append("t.project_hash = ?")
            params.append(project_hash)
        if session_id:
            conditions.append("t.session_id = ?")
            params.append(session_id)
        if git_branch:
            conditions.append("t.git_branch = ?")
            params.append(git_branch)
        if status:
            conditions.append("t.status = ?")
            params.append(status)
        if tag:
            conditions.append("EXISTS (SELECT 1 FROM tags tg WHERE tg.turn_id = t.id AND tg.tag = ?)")
            params.append(tag)
        if search:
            if self._fts_ready:
                self.rebuild_fts_if_needed()
                conditions.append(
                    "(fts_main_turns.match_bm25(t.id, ?) IS NOT NULL OR EXISTS "
                    "(SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
                    "AND fts_main_turn_fields.match_bm25(f.id, ?) IS NOT NULL))"
                )
                params.extend([search, search])
            else:
                conditions.append(
                    "(t.user_prompt ILIKE ? OR EXISTS "
                    "(SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id AND f.search_text ILIKE ?))"
                )
                params.extend([f"%{search}%", f"%{search}%"])

        where = " AND ".join(conditions) if conditions else "1=1"

        # Count total
        total = self._fetch_one(
            f"SELECT COUNT(*) FROM turns t WHERE {where}", params
        )[0]

        # Fetch turns with summary
        rows = self._fetch_all(
            f"""SELECT t.id, t.session_id, t.project_hash, t.git_repo_hash, t.turn_number,
                       t.status, t.user_prompt, t.started_at, t.completed_at,
                       t.cost, t.git_branch, t.git_hash, t.model, t.is_error,
                       t.duration_ms, t.tokens_in, t.tokens_out,
                       f.value_text as summary
                FROM turns t
                LEFT JOIN turn_fields f ON t.id = f.turn_id AND f.field_key = 'summary'
                WHERE {where}
                ORDER BY t.started_at DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset]
        )

        columns = ["id", "session_id", "project_hash", "git_repo_hash", "turn_number",
                    "status", "user_prompt", "started_at", "completed_at",
                    "cost", "git_branch", "git_hash", "model", "is_error",
                    "duration_ms", "tokens_in", "tokens_out", "summary"]

        turns = [dict(zip(columns, row)) for row in rows]

        # Attach tags to each turn (batch)
        if turns:
            turn_ids = [t["id"] for t in turns]
            placeholders = ", ".join(["?"] * len(turn_ids))
            tag_rows = self._fetch_all(
                f"SELECT turn_id, tag FROM tags WHERE turn_id IN ({placeholders})",
                turn_ids
            )
            tags_by_turn = {}
            for tid, tg in tag_rows:
                tags_by_turn.setdefault(tid, []).append(tg)
            for t in turns:
                t["tags"] = tags_by_turn.get(t["id"], [])

        return {"turns": turns, "total": total, "has_more": offset + limit < total}

    def search_turns(
        self,
        *,
        query: Optional[str] = None,
        search_sections: Optional[list[str]] = None,
        file_path: Optional[str] = None,
        file_pattern: Optional[str] = None,
        tag: Optional[str] = None,
        git_branch: Optional[str] = None,
        session_id: Optional[str] = None,
        project_hash: Optional[str] = None,
        git_repo_hash: Optional[str] = None,
        status: Optional[str] = "completed",
        since: Optional[str] = None,
        until: Optional[str] = None,
        fields: Optional[list[str]] = None,
        include_tags: bool = True,
        include_files: bool = False,
        include_tools: bool = False,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """Rich search with section-scoped FTS and field selection.

        Unlike list_turns(), this method:
        - Supports section-scoped search (only match within specific field_keys)
        - Returns selected turn_fields inline (not just summary)
        - Supports file-based filtering via turn_files
        - Supports date range filtering
        - Defaults to status='completed' to skip noise

        Returns {turns, total, has_more, query_info}.
        """
        conditions = []
        params = []

        if git_repo_hash:
            conditions.append("t.git_repo_hash = ?")
            params.append(git_repo_hash)
        elif project_hash:
            conditions.append("t.project_hash = ?")
            params.append(project_hash)
        if session_id:
            conditions.append("t.session_id = ?")
            params.append(session_id)
        if git_branch:
            conditions.append("t.git_branch = ?")
            params.append(git_branch)
        if status:
            conditions.append("t.status = ?")
            params.append(status)
        if tag:
            conditions.append("EXISTS (SELECT 1 FROM tags tg WHERE tg.turn_id = t.id AND tg.tag = ?)")
            params.append(tag)
        if file_path:
            conditions.append(
                "EXISTS (SELECT 1 FROM turn_files tf WHERE tf.turn_id = t.id AND tf.file_path = ? "
                "AND tf.change_type IS DISTINCT FROM 'read')"
            )
            params.append(file_path)
        if file_pattern:
            conditions.append(
                "EXISTS (SELECT 1 FROM turn_files tf WHERE tf.turn_id = t.id AND tf.file_path ILIKE ? "
                "AND tf.change_type IS DISTINCT FROM 'read')"
            )
            params.append(file_pattern)
        if since:
            conditions.append("t.started_at >= ?")
            params.append(since)
        if until:
            conditions.append("t.started_at <= ?")
            params.append(until)

        # Text search — section-scoped or broad
        fts_used = False
        if query:
            if search_sections:
                # Section-scoped: only match within specified field_keys
                sec_placeholders = ", ".join(["?"] * len(search_sections))
                if self._fts_ready:
                    self.rebuild_fts_if_needed()
                    fts_used = True
                    conditions.append(
                        f"EXISTS (SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
                        f"AND f.field_key IN ({sec_placeholders}) "
                        f"AND fts_main_turn_fields.match_bm25(f.id, ?) IS NOT NULL)"
                    )
                    params.extend(search_sections + [query])
                else:
                    conditions.append(
                        f"EXISTS (SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
                        f"AND f.field_key IN ({sec_placeholders}) "
                        f"AND f.search_text ILIKE ?)"
                    )
                    params.extend(search_sections + [f"%{query}%"])
            else:
                # Broad: search user_prompt + all turn_fields
                if self._fts_ready:
                    self.rebuild_fts_if_needed()
                    fts_used = True
                    conditions.append(
                        "(fts_main_turns.match_bm25(t.id, ?) IS NOT NULL OR EXISTS "
                        "(SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
                        "AND fts_main_turn_fields.match_bm25(f.id, ?) IS NOT NULL))"
                    )
                    params.extend([query, query])
                else:
                    conditions.append(
                        "(t.user_prompt ILIKE ? OR EXISTS "
                        "(SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
                        "AND f.search_text ILIKE ?))"
                    )
                    params.extend([f"%{query}%", f"%{query}%"])

        where = " AND ".join(conditions) if conditions else "1=1"

        # Count
        total = self._fetch_one(
            f"SELECT COUNT(*) FROM turns t WHERE {where}", params
        )[0]

        # Fetch turns
        rows = self._fetch_all(
            f"""SELECT t.id, t.session_id, t.user_prompt, t.started_at, t.completed_at,
                       t.cost, t.model, t.git_branch, t.git_hash, t.duration_ms,
                       t.is_error, t.tokens_in, t.tokens_out, t.num_tool_loops
                FROM turns t
                WHERE {where}
                ORDER BY t.started_at DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset]
        )

        columns = ["id", "session_id", "user_prompt", "started_at", "completed_at",
                    "cost", "model", "git_branch", "git_hash", "duration_ms",
                    "is_error", "tokens_in", "tokens_out", "num_tool_loops"]

        turns = []
        for row in rows:
            t = dict(zip(columns, row))
            # Truncate long prompts
            if t["user_prompt"] and len(t["user_prompt"]) > 200:
                t["user_prompt"] = t["user_prompt"][:200] + "..."
            turns.append(t)

        if not turns:
            return {"turns": [], "total": total, "has_more": False,
                    "query_info": {"fts_used": fts_used}}

        turn_ids = [t["id"] for t in turns]
        id_placeholders = ", ".join(["?"] * len(turn_ids))

        # Batch-fetch selected fields
        if fields:
            key_placeholders = ", ".join(["?"] * len(fields))
            field_rows = self._fetch_all(
                f"SELECT turn_id, field_key, value_text, value_list "
                f"FROM turn_fields WHERE turn_id IN ({id_placeholders}) "
                f"AND field_key IN ({key_placeholders})",
                turn_ids + fields
            )
            fields_by_turn: dict[str, dict] = {}
            for tid, fkey, vtext, vlist in field_rows:
                fields_by_turn.setdefault(tid, {})[fkey] = vlist if vlist is not None else vtext
            for t in turns:
                t["fields"] = fields_by_turn.get(t["id"], {})

        # Batch-fetch tags
        if include_tags:
            tag_rows = self._fetch_all(
                f"SELECT turn_id, tag FROM tags WHERE turn_id IN ({id_placeholders})",
                turn_ids
            )
            tags_by_turn: dict[str, list] = {}
            for tid, tg in tag_rows:
                tags_by_turn.setdefault(tid, []).append(tg)
            for t in turns:
                t["tags"] = tags_by_turn.get(t["id"], [])

        # Batch-fetch files
        if include_files:
            file_rows = self._fetch_all(
                f"SELECT turn_id, file_path FROM turn_files WHERE turn_id IN ({id_placeholders}) "
                f"AND change_type IS DISTINCT FROM 'read'",
                turn_ids
            )
            files_by_turn: dict[str, list] = {}
            for tid, fp in file_rows:
                files_by_turn.setdefault(tid, []).append(fp)
            for t in turns:
                t["files"] = files_by_turn.get(t["id"], [])

        # Batch-fetch tools
        if include_tools:
            tool_rows = self._fetch_all(
                f"SELECT turn_id, tool_name, call_count FROM turn_tools "
                f"WHERE turn_id IN ({id_placeholders})",
                turn_ids
            )
            tools_by_turn: dict[str, dict] = {}
            for tid, tn, cc in tool_rows:
                tools_by_turn.setdefault(tid, {})[tn] = cc
            for t in turns:
                t["tools"] = tools_by_turn.get(t["id"], {})

        return {
            "turns": turns,
            "total": total,
            "has_more": offset + limit < total,
            "query_info": {
                "fts_used": fts_used,
                "fields_requested": fields,
                "search_sections": search_sections,
            },
        }

    def query_turns(
        self,
        query: str,
        *,
        git_repo_hash: Optional[str] = None,
        project_hash: Optional[str] = None,
        fields: Optional[list[str]] = None,
        include_tags: bool = True,
        include_files: bool = False,
        include_tools: bool = False,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """Execute a TurnQL query. Returns {turns, total, has_more, query_info}.

        The query string supports Lucene-like syntax: section:text, AND/OR,
        parenthesized grouping, negation, numeric ranges, date filters, etc.
        See turn_query.py for full syntax docs.
        """
        from painapple_code.turn_query import parse_turn_query, compile_turn_query

        # Accept comma-separated string for fields (common from API callers)
        if isinstance(fields, str):
            fields = [f.strip() for f in fields.split(",") if f.strip()]

        # Ensure DB connection (and FTS indexes) are initialized before compiling
        self._get_con()

        ast, parse_warnings = parse_turn_query(query)
        compiled = compile_turn_query(ast, fts_available=self._fts_ready)

        if compiled.fts_used:
            self.rebuild_fts_if_needed()

        # Build full WHERE: TurnQL conditions + context filters
        conditions = []
        params = []

        if compiled.where_clause and compiled.where_clause != "1=1":
            conditions.append(compiled.where_clause)
            params.extend(compiled.params)

        if git_repo_hash:
            conditions.append("t.git_repo_hash = ?")
            params.append(git_repo_hash)
        elif project_hash:
            conditions.append("t.project_hash = ?")
            params.append(project_hash)

        where = " AND ".join(conditions) if conditions else "1=1"

        # Count
        total = self._fetch_one(
            f"SELECT COUNT(*) FROM turns t WHERE {where}", params
        )[0]

        # Fetch turns
        rows = self._fetch_all(
            f"""SELECT t.id, t.session_id, t.user_prompt, t.started_at, t.completed_at,
                       t.cost, t.model, t.git_branch, t.git_hash, t.duration_ms,
                       t.is_error, t.tokens_in, t.tokens_out, t.num_tool_loops
                FROM turns t
                WHERE {where}
                ORDER BY t.started_at DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset]
        )

        columns = ["id", "session_id", "user_prompt", "started_at", "completed_at",
                    "cost", "model", "git_branch", "git_hash", "duration_ms",
                    "is_error", "tokens_in", "tokens_out", "num_tool_loops"]

        turns = []
        for row in rows:
            t = dict(zip(columns, row))
            if t["user_prompt"] and len(t["user_prompt"]) > 200:
                t["user_prompt"] = t["user_prompt"][:200] + "..."
            turns.append(t)

        if not turns:
            return {"turns": [], "total": total, "has_more": False,
                    "query_info": {"fts_used": compiled.fts_used,
                                   "description": compiled.description,
                                   "warnings": parse_warnings + compiled.warnings}}

        turn_ids = [t["id"] for t in turns]
        id_placeholders = ", ".join(["?"] * len(turn_ids))

        # Batch-fetch selected fields
        if fields:
            key_placeholders = ", ".join(["?"] * len(fields))
            field_rows = self._fetch_all(
                f"SELECT turn_id, field_key, value_text, value_list "
                f"FROM turn_fields WHERE turn_id IN ({id_placeholders}) "
                f"AND field_key IN ({key_placeholders})",
                turn_ids + fields
            )
            fields_by_turn: dict[str, dict] = {}
            for tid, fkey, vtext, vlist in field_rows:
                fields_by_turn.setdefault(tid, {})[fkey] = vlist if vlist is not None else vtext
            for t in turns:
                t["fields"] = fields_by_turn.get(t["id"], {})

        # Batch-fetch tags
        if include_tags:
            tag_rows = self._fetch_all(
                f"SELECT turn_id, tag FROM tags WHERE turn_id IN ({id_placeholders})",
                turn_ids
            )
            tags_by_turn: dict[str, list] = {}
            for tid, tg in tag_rows:
                tags_by_turn.setdefault(tid, []).append(tg)
            for t in turns:
                t["tags"] = tags_by_turn.get(t["id"], [])

        # Batch-fetch files
        if include_files:
            file_rows = self._fetch_all(
                f"SELECT turn_id, file_path FROM turn_files WHERE turn_id IN ({id_placeholders}) "
                f"AND change_type IS DISTINCT FROM 'read'",
                turn_ids
            )
            files_by_turn: dict[str, list] = {}
            for tid, fp in file_rows:
                files_by_turn.setdefault(tid, []).append(fp)
            for t in turns:
                t["files"] = files_by_turn.get(t["id"], [])

        # Batch-fetch tools
        if include_tools:
            tool_rows = self._fetch_all(
                f"SELECT turn_id, tool_name, call_count FROM turn_tools "
                f"WHERE turn_id IN ({id_placeholders})",
                turn_ids
            )
            tools_by_turn: dict[str, dict] = {}
            for tid, tn, cc in tool_rows:
                tools_by_turn.setdefault(tid, {})[tn] = cc
            for t in turns:
                t["tools"] = tools_by_turn.get(t["id"], {})

        all_warnings = parse_warnings + compiled.warnings
        return {
            "turns": turns,
            "total": total,
            "has_more": offset + limit < total,
            "query_info": {
                "fts_used": compiled.fts_used,
                "description": compiled.description,
                "warnings": all_warnings,
            },
        }

    def get_tag_cloud(self, project_hash: Optional[str] = None) -> list[dict]:
        """Get tag statistics."""
        if project_hash:
            rows = self._fetch_all(
                """SELECT tg.tag, tg.source, COUNT(*) as count,
                          SUM(t.cost) as total_cost
                   FROM tags tg
                   JOIN turns t ON tg.turn_id = t.id
                   WHERE t.project_hash = ?
                   GROUP BY tg.tag, tg.source
                   ORDER BY count DESC""",
                [project_hash]
            )
        else:
            rows = self._fetch_all(
                """SELECT tg.tag, tg.source, COUNT(*) as count,
                          SUM(t.cost) as total_cost
                   FROM tags tg
                   JOIN turns t ON tg.turn_id = t.id
                   GROUP BY tg.tag, tg.source
                   ORDER BY count DESC"""
            )

        return [{"tag": r[0], "source": r[1], "count": r[2], "total_cost": float(r[3] or 0)}
                for r in rows]

    def get_branch_stats(self, project_hash: Optional[str] = None) -> list[dict]:
        """Get branch activity overview."""
        conditions = ["git_branch IS NOT NULL"]
        params = []
        if project_hash:
            conditions.append("project_hash = ?")
            params.append(project_hash)

        where = " AND ".join(conditions)
        rows = self._fetch_all(
            f"""SELECT git_branch, COUNT(*) as turns, SUM(cost) as total_cost,
                       MIN(started_at) as first_turn, MAX(started_at) as last_turn,
                       COUNT(DISTINCT session_id) as sessions
                FROM turns
                WHERE {where}
                GROUP BY git_branch
                ORDER BY last_turn DESC""",
            params
        )

        return [{"branch": r[0], "turns": r[1], "cost": float(r[2] or 0),
                 "first_turn": r[3], "last_turn": r[4], "sessions": r[5]}
                for r in rows]

    def get_stats(self, project_hash: Optional[str] = None,
                  git_repo_hash: Optional[str] = None) -> dict:
        """Get overall database statistics."""
        conditions = []
        params = []
        if git_repo_hash:
            conditions.append("git_repo_hash = ?")
            params.append(git_repo_hash)
        elif project_hash:
            conditions.append("project_hash = ?")
            params.append(project_hash)
        where = " AND ".join(conditions) if conditions else "1=1"

        row = self._fetch_one_dict(
            f"""SELECT COUNT(*) as total_turns,
                       COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
                       COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                       COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
                       COUNT(CASE WHEN status = 'interrupted' THEN 1 END) as interrupted,
                       SUM(cost) as total_cost,
                       SUM(summary_cost) as total_summary_cost,
                       COUNT(DISTINCT session_id) as sessions,
                       COUNT(DISTINCT git_branch) as branches,
                       MIN(started_at) as first_turn,
                       MAX(started_at) as last_turn
                FROM turns WHERE {where}""",
            params
        )

        return {
            **row,
            "total_cost": float(row["total_cost"] or 0),
            "total_summary_cost": float(row["total_summary_cost"] or 0),
        }
