"""Plan tracking for ShadowDB.

Mixed into ShadowDB. Owns plan-record creation (triggered by
EnterPlanMode / ExitPlanMode tool usage), turn-to-plan linking, and the
plan list/detail/stats queries surfaced by `/api/shadow-db/plans`.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("painapple-code.shadow-db")


class _PlansMixin:
    """Plan CRUD, linking, and queries for ShadowDB."""

    def _create_plan_from_turn(self, turn_id: str, modified_files: Optional[list[str]],
                                structured_data: Optional[dict] = None):
        """Create a plan record when EnterPlanMode/ExitPlanMode detected."""
        from pathlib import Path as _Path

        # Find .claude/plans/ file
        plan_file = None
        plan_name = None
        if modified_files:
            for f in modified_files:
                if '.claude/plans/' in f and f.endswith('.md'):
                    plan_file = f
                    plan_name = _Path(f).stem
                    break

        # Extract plan title/summary from summary-fork structured data
        title = None
        summary = None
        if structured_data:
            title = structured_data.get("plan_title") or structured_data.get("session_title")
            summary = structured_data.get("plan_summary") or structured_data.get("summary")

        # Get turn info for session/project
        turn = self._fetch_one(
            "SELECT session_id, project_hash, git_repo_hash FROM turns WHERE id = ?",
            [turn_id]
        )
        if not turn:
            return

        plan_id = str(uuid.uuid4())
        self._execute("""
            INSERT INTO plans (id, turn_id, session_id, project_hash, git_repo_hash,
                              plan_file, plan_name, title, summary, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')
            ON CONFLICT (turn_id) DO UPDATE SET
                plan_file = COALESCE(EXCLUDED.plan_file, plans.plan_file),
                plan_name = COALESCE(EXCLUDED.plan_name, plans.plan_name),
                title = COALESCE(EXCLUDED.title, plans.title),
                summary = COALESCE(EXCLUDED.summary, plans.summary),
                updated_at = now()
        """, [plan_id, turn_id, turn[0], turn[1], turn[2],
              plan_file, plan_name, title, summary])

        # Also link this turn to the plan as the 'planning' role
        self._execute("""
            INSERT INTO plan_turns (id, plan_id, turn_id, role)
            VALUES (nextval('seq_plan_turns'), ?, ?, 'planning')
            ON CONFLICT (plan_id, turn_id) DO NOTHING
        """, [plan_id, turn_id])

    def _link_turn_to_plan(self, turn_id: str):
        """Link a non-plan turn to the most recent active plan in its session.

        A plan is 'active' if it's proposed/approved and was the last plan in this session.
        The first non-plan turn after a plan automatically marks it as approved.
        """
        # Get this turn's session
        row = self._fetch_one(
            "SELECT session_id FROM turns WHERE id = ?", [turn_id]
        )
        if not row:
            return
        session_id = row[0]

        # Find the most recent plan in this session
        plan = self._fetch_one("""
            SELECT p.id, p.status, p.turn_id FROM plans p
            WHERE p.session_id = ? AND p.status IN ('proposed', 'approved')
            ORDER BY p.created_at DESC LIMIT 1
        """, [session_id])
        if not plan:
            return

        plan_id, plan_status, plan_turn_id = plan

        # Don't link the planning turn itself
        if turn_id == plan_turn_id:
            return

        # Link this turn as implementation
        self._execute("""
            INSERT INTO plan_turns (id, plan_id, turn_id, role)
            VALUES (nextval('seq_plan_turns'), ?, ?, 'implementation')
            ON CONFLICT (plan_id, turn_id) DO NOTHING
        """, [plan_id, turn_id])

        # First implementation turn auto-approves the plan
        now = datetime.now(timezone.utc).isoformat()
        if plan_status == 'proposed':
            self._execute("""
                UPDATE plans SET status = 'approved', approved_at = ?, updated_at = ?
                WHERE id = ? AND status = 'proposed'
            """, [now, now, plan_id])

        # Update plan metrics
        self._execute("""
            UPDATE plans SET
                implementation_turns = (
                    SELECT COUNT(*) FROM plan_turns WHERE plan_id = ? AND role = 'implementation'
                ),
                implementation_cost = (
                    SELECT COALESCE(SUM(t.cost), 0) FROM plan_turns pt
                    JOIN turns t ON pt.turn_id = t.id WHERE pt.plan_id = ? AND pt.role = 'implementation'
                ),
                files_changed = (
                    SELECT COUNT(DISTINCT tf.file_path) FROM plan_turns pt
                    JOIN turn_files tf ON pt.turn_id = tf.turn_id
                    WHERE pt.plan_id = ? AND pt.role = 'implementation'
                      AND tf.change_type IS DISTINCT FROM 'read'
                ),
                updated_at = ?
            WHERE id = ?
        """, [plan_id, plan_id, plan_id, now, plan_id])

    def _backfill_plans(self, con):
        """One-time backfill: create plan records from existing turn_tools data."""
        try:
            # Check if plans table has any rows
            count = con.execute("SELECT COUNT(*) FROM plans").fetchone()[0]
            if count > 0:
                return  # Already has data, skip backfill

            from pathlib import Path as _Path

            rows = con.execute("""
                SELECT DISTINCT t.id, t.session_id, t.project_hash, t.git_repo_hash
                FROM turns t
                JOIN turn_tools tt ON t.id = tt.turn_id
                WHERE tt.tool_name IN ('EnterPlanMode', 'ExitPlanMode')
            """).fetchall()

            for turn_id, session_id, project_hash, git_repo_hash in rows:
                # Mark the turn
                con.execute("UPDATE turns SET is_plan = true WHERE id = ?", [turn_id])

                # Find plan file
                file_row = con.execute("""
                    SELECT file_path FROM turn_files
                    WHERE turn_id = ? AND file_path LIKE '%.claude/plans/%.md'
                      AND change_type IS DISTINCT FROM 'read'
                    LIMIT 1
                """, [turn_id]).fetchone()
                plan_file = file_row[0] if file_row else None
                plan_name = _Path(plan_file).stem if plan_file else None

                # Get summary
                summary_row = con.execute("""
                    SELECT value_text FROM turn_fields
                    WHERE turn_id = ? AND field_key = 'summary'
                """, [turn_id]).fetchone()

                con.execute("""
                    INSERT INTO plans (id, turn_id, session_id, project_hash, git_repo_hash,
                                      plan_file, plan_name, title, summary, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')
                    ON CONFLICT (turn_id) DO NOTHING
                """, [str(uuid.uuid4()), turn_id, session_id, project_hash, git_repo_hash,
                      plan_file, plan_name, plan_name,
                      summary_row[0] if summary_row else None])

            if rows:
                logger.info(f"Backfilled {len(rows)} plan records from existing turn_tools data")
        except Exception as e:
            logger.warning(f"Plan backfill failed (non-fatal): {e}")

    def list_plans(
        self,
        project_hash: Optional[str] = None,
        git_repo_hash: Optional[str] = None,
        session_id: Optional[str] = None,
        status: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict:
        """List plans with optional filters. Returns {plans, total, has_more}."""
        conditions = []
        params = []

        if git_repo_hash:
            conditions.append("p.git_repo_hash = ?")
            params.append(git_repo_hash)
        elif project_hash:
            conditions.append("p.project_hash = ?")
            params.append(project_hash)
        if session_id:
            conditions.append("p.session_id = ?")
            params.append(session_id)
        if status:
            conditions.append("p.status = ?")
            params.append(status)
        if search:
            if self._fts_ready:
                self.rebuild_fts_if_needed()
                # FTS on turn_fields, ILIKE on short plan-specific columns and tags
                conditions.append(
                    "(p.title ILIKE ? OR p.summary ILIKE ? OR p.plan_name ILIKE ? "
                    "OR EXISTS (SELECT 1 FROM turn_fields tf WHERE tf.turn_id = p.turn_id "
                    "AND fts_main_turn_fields.match_bm25(tf.id, ?) IS NOT NULL) "
                    "OR EXISTS (SELECT 1 FROM tags tg WHERE tg.turn_id = p.turn_id "
                    "AND tg.tag ILIKE ?))"
                )
                s = f"%{search}%"
                params.extend([s, s, s, search, s])
            else:
                conditions.append(
                    "(p.title ILIKE ? OR p.summary ILIKE ? OR p.plan_name ILIKE ? "
                    "OR EXISTS (SELECT 1 FROM turn_fields tf WHERE tf.turn_id = p.turn_id "
                    "AND tf.search_text ILIKE ?) "
                    "OR EXISTS (SELECT 1 FROM tags tg WHERE tg.turn_id = p.turn_id "
                    "AND tg.tag ILIKE ?))"
                )
                s = f"%{search}%"
                params.extend([s, s, s, s, s])

        where = " AND ".join(conditions) if conditions else "1=1"

        total = self._fetch_one(
            f"SELECT COUNT(*) FROM plans p WHERE {where}", params
        )[0]

        rows = self._fetch_all(
            f"""SELECT p.id, p.turn_id, p.session_id, p.project_hash,
                       p.plan_file, p.plan_name, p.title, p.summary,
                       p.status, p.approved_at, p.implementation_turns,
                       p.implementation_cost, p.files_changed,
                       p.created_at, p.updated_at,
                       t.user_prompt, t.cost as plan_cost, t.model, t.git_branch
                FROM plans p
                JOIN turns t ON p.turn_id = t.id
                WHERE {where}
                ORDER BY p.created_at DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset]
        )

        columns = ["id", "turn_id", "session_id", "project_hash",
                    "plan_file", "plan_name", "title", "summary",
                    "status", "approved_at", "implementation_turns",
                    "implementation_cost", "files_changed",
                    "created_at", "updated_at",
                    "user_prompt", "plan_cost", "model", "git_branch"]

        plans = []
        for row in rows:
            plan = dict(zip(columns, row))
            # Attach tags from the planning turn
            plan["tags"] = [r[0] for r in self._fetch_all(
                "SELECT tag FROM tags WHERE turn_id = ?", [plan["turn_id"]]
            )]
            plans.append(plan)

        return {"plans": plans, "total": total, "has_more": offset + limit < total}

    def get_plan(self, plan_id: str) -> Optional[dict]:
        """Get full plan details with implementation turns."""
        columns, rows = self._fetch_columns(
            """SELECT p.*, t.user_prompt, t.cost as plan_cost, t.model,
                      t.git_branch, t.duration_ms as plan_duration_ms
               FROM plans p JOIN turns t ON p.turn_id = t.id
               WHERE p.id = ?""",
            [plan_id]
        )
        if not rows:
            return None

        plan = dict(zip(columns, rows[0]))

        # Tags from planning turn
        plan["tags"] = [r[0] for r in self._fetch_all(
            "SELECT tag FROM tags WHERE turn_id = ?", [plan["turn_id"]]
        )]

        # Implementation turns
        impl_rows = self._fetch_all("""
            SELECT pt.role, t.id, t.user_prompt, t.started_at, t.cost,
                   t.model, t.duration_ms, tf.value_text as summary
            FROM plan_turns pt
            JOIN turns t ON pt.turn_id = t.id
            LEFT JOIN turn_fields tf ON t.id = tf.turn_id AND tf.field_key = 'summary'
            WHERE pt.plan_id = ?
            ORDER BY t.started_at
        """, [plan_id])

        plan["turns"] = [
            {"role": r[0], "turn_id": r[1], "user_prompt": r[2],
             "started_at": str(r[3]) if r[3] else None, "cost": float(r[4] or 0),
             "model": r[5], "duration_ms": r[6], "summary": r[7]}
            for r in impl_rows
        ]

        return plan

    def update_plan_status(self, plan_id: str, status: str):
        """Manually update a plan's status (approve/reject/abandon)."""
        now = datetime.now(timezone.utc).isoformat()
        params = [status, now]
        extra = ""
        if status == "approved":
            extra = ", approved_at = COALESCE(approved_at, ?)"
            params.append(now)
        params.append(plan_id)
        self._execute(
            f"UPDATE plans SET status = ?, updated_at = ?{extra} WHERE id = ?",
            params
        )

    def update_plan_title(self, plan_id: str, title: str):
        """Update a plan's title."""
        self._execute(
            "UPDATE plans SET title = ?, updated_at = now() WHERE id = ?",
            [title, plan_id]
        )

    def get_plan_stats(self, project_hash: Optional[str] = None,
                       git_repo_hash: Optional[str] = None) -> dict:
        """Get plan statistics: counts by status, avg implementation cost, etc."""
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
            f"""SELECT COUNT(*) as total,
                       COUNT(CASE WHEN status = 'proposed' THEN 1 END) as proposed,
                       COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
                       COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
                       COUNT(CASE WHEN status = 'abandoned' THEN 1 END) as abandoned,
                       AVG(CASE WHEN status = 'approved' THEN implementation_turns END) as avg_impl_turns,
                       AVG(CASE WHEN status = 'approved' THEN implementation_cost END) as avg_impl_cost,
                       SUM(implementation_cost) as total_impl_cost,
                       AVG(CASE WHEN status = 'approved' THEN files_changed END) as avg_files_changed
                FROM plans WHERE {where}""",
            params
        )

        return {
            "total": row["total"],
            "proposed": row["proposed"],
            "approved": row["approved"],
            "rejected": row["rejected"],
            "abandoned": row["abandoned"],
            "avg_implementation_turns": round(float(row["avg_impl_turns"] or 0), 1),
            "avg_implementation_cost": round(float(row["avg_impl_cost"] or 0), 4),
            "total_implementation_cost": round(float(row["total_impl_cost"] or 0), 4),
            "avg_files_changed": round(float(row["avg_files_changed"] or 0), 1),
        }
