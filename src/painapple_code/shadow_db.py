"""
Shadow DB - DuckDB metadata store for shadow git turns.

Turn-centric schema: each turn (user prompt → Claude response → result) is the hero.
Turns are created immediately on prompt send (never lost), updated on completion.

Database: ~/.painapple-code/shadow.duckdb (global, cross-project)

Module layout:
    shadow_db.py          — ShadowDB core (connection, CRUD, async wrappers, file review)
    shadow_db_schema.py   — SCHEMA_SQL, init/migration/FTS helpers (_SchemaMixin)
    shadow_db_queries.py  — list_turns / search_turns / query_turns / stats (_QueriesMixin)
    shadow_db_plans.py    — plan create/link/list/get/update (_PlansMixin)

Usage:
    db = get_shadow_db()
    turn_id = db.start_turn(session_id, project_hash, prompt, git_branch)
    # ... Claude processes ...
    db.complete_turn(turn_id, result_msg, structured_data, commit_hash, ...)
"""

import asyncio
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import duckdb

from painapple_code import paths
from painapple_code.shadow_db_plans import _PlansMixin
from painapple_code.shadow_db_queries import _QueriesMixin
from painapple_code.shadow_db_schema import _SchemaMixin
from painapple_code.utils.agent_cli import short_model_name

logger = logging.getLogger("painapple-code.shadow-db")

# ═══════════════════════════════════════════════════════════════════════════
# Database location
# ═══════════════════════════════════════════════════════════════════════════

DB_PATH = paths.DATA_HOME / "shadow.duckdb"


# ═══════════════════════════════════════════════════════════════════════════
# ShadowDB class
# ═══════════════════════════════════════════════════════════════════════════

class ShadowDB(_SchemaMixin, _QueriesMixin, _PlansMixin):
    """DuckDB metadata store for shadow git turns.

    Thread-safe: all writes go through _execute() which uses a lock.
    Async-safe: use the async wrappers (astart_turn, acomplete_turn) from async code.
    """

    # Checkpoint WAL every N completed turns or every CHECKPOINT_INTERVAL_SEC seconds
    CHECKPOINT_EVERY_TURNS = 10
    CHECKPOINT_INTERVAL_SEC = 3600  # 1 hour

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._con: Optional[duckdb.DuckDBPyConnection] = None
        self._init_done = False
        self._fts_ready = False  # FTS indexes built and current
        self._fts_dirty = False  # New data since last FTS rebuild
        self._turns_since_checkpoint = 0
        self._last_checkpoint = time.monotonic()

    def _get_con(self) -> duckdb.DuckDBPyConnection:
        """Get or create DuckDB connection with automatic corruption recovery.

        Recovery strategies (tried in order on connect or init failure):
        1. Normal connect + init
        2. WAL corruption → back up WAL, reconnect
        3. ART index corruption → drop and recreate all indexes
        """
        if self._con is None:
            self._con = self._open_db()
        if not self._init_done:
            try:
                self._init_schema()
            except (duckdb.FatalException, duckdb.InternalException, duckdb.TransactionException) as e:
                logger.error(f"Schema init hit DB corruption: {e}")
                try:
                    self._con.close()
                except Exception:
                    pass
                self._con = self._recover_indexes()
                self._init_schema()
            self._init_done = True
            try:
                self._con.execute("CHECKPOINT")
                logger.info("Startup WAL checkpoint")
            except Exception:
                pass
            self._lock_down_external_access()
        return self._con

    def _lock_down_external_access(self):
        """Disable DuckDB external file access once FTS is installed.

        The ad-hoc SQL endpoint (POST /api/shadow-db/sql) runs on this same
        connection instance. enable_external_access=false is instance-wide and
        one-way, so it must be set AFTER INSTALL/LOAD fts + index build (those
        need external access on first run). Afterwards FTS queries and index
        rebuilds still work (the extension is already loaded), but read_csv/
        read_parquet, the `FROM 'file'` replacement scan, and `COPY ... TO 'file'`
        are all blocked engine-wide — closing the file-read/exfil vectors that a
        string-level denylist can't fully cover. The server never legitimately
        reads external files through DuckDB, so nothing else is affected.
        """
        try:
            self._con.execute("SET enable_external_access=false")
            logger.info("DuckDB external file access locked down (SQL endpoint hardening)")
        except Exception as e:
            logger.warning(f"Could not lock down DuckDB external access: {e}")

    def _open_db(self) -> duckdb.DuckDBPyConnection:
        """Open DuckDB, recovering from WAL corruption if needed."""
        import time as _time

        try:
            con = duckdb.connect(str(self.db_path))
            con.execute("SELECT 1")  # triggers WAL replay
            logger.info(f"Connected to shadow DB: {self.db_path}")
            return con
        except duckdb.IOException as e:
            # Lock contention is not recoverable here — re-raise immediately
            if "lock" in str(e).lower():
                raise
            logger.error(f"DuckDB connect failed: {e}")
            try:
                con.close()
            except Exception:
                pass
        except (duckdb.FatalException, duckdb.InternalException, duckdb.TransactionException) as e:
            logger.error(f"DuckDB connect failed: {e}")
            try:
                con.close()
            except Exception:
                pass

        # WAL corruption → back up and retry without it
        wal_path = Path(f"{self.db_path}.wal")
        if wal_path.exists():
            backup = wal_path.with_suffix(f".wal.corrupt-{int(_time.time())}")
            # os.replace: Path.rename raises on win32 if the dest exists
            # (same-second double recovery would collide on the timestamp).
            os.replace(wal_path, backup)
            logger.warning(f"Moved corrupt WAL to {backup.name} — some recent turns may be lost")
            con = duckdb.connect(str(self.db_path))
            con.execute("SELECT 1")
            logger.info(f"Connected to shadow DB (WAL recovered): {self.db_path}")
            return con
        raise  # no WAL to remove, re-raise

    def _maybe_checkpoint(self):
        """Checkpoint WAL if enough turns or time have elapsed. Call with _lock held."""
        if self._con is None:
            return
        elapsed = time.monotonic() - self._last_checkpoint
        if (self._turns_since_checkpoint >= self.CHECKPOINT_EVERY_TURNS
                or elapsed >= self.CHECKPOINT_INTERVAL_SEC):
            try:
                self._con.execute("CHECKPOINT")
                logger.debug(f"WAL checkpoint ({self._turns_since_checkpoint} turns, {elapsed:.0f}s)")
            except Exception as e:
                logger.warning(f"Checkpoint failed: {e}")
            self._turns_since_checkpoint = 0
            self._last_checkpoint = time.monotonic()

    def _execute(self, sql: str, params: list = None) -> duckdb.DuckDBPyConnection:
        """Execute SQL with thread lock. For fire-and-forget statements only.

        WARNING: Do NOT chain .fetchone()/.fetchall() on the result — the lock
        is released on return, so another thread can invalidate the cursor.
        Use _fetch_one/_fetch_all/_fetch_columns instead.
        """
        with self._lock:
            con = self._get_con()
            if params:
                return con.execute(sql, params)
            return con.execute(sql)

    def _fetch_one(self, sql: str, params: list = None) -> Optional[tuple]:
        """Execute SQL and fetchone() atomically under the lock."""
        with self._lock:
            con = self._get_con()
            result = con.execute(sql, params) if params else con.execute(sql)
            return result.fetchone()

    def _fetch_all(self, sql: str, params: list = None) -> list:
        """Execute SQL and fetchall() atomically under the lock."""
        with self._lock:
            con = self._get_con()
            result = con.execute(sql, params) if params else con.execute(sql)
            return result.fetchall()

    def _fetch_columns(self, sql: str, params: list = None) -> tuple[list[str], list]:
        """Execute SQL and return (column_names, rows) atomically under the lock."""
        with self._lock:
            con = self._get_con()
            result = con.execute(sql, params) if params else con.execute(sql)
            columns = [desc[0] for desc in result.description]
            return columns, result.fetchall()

    # Hard deadline for caller-written SQL. Long enough that no honest query
    # against this schema reaches it; short enough to bound shutdown.
    ADHOC_TIMEOUT_SEC = 30.0

    def fetch_columns_adhoc(self, sql: str, timeout: float = None) -> tuple[list[str], list]:
        """Run CALLER-SUPPLIED SQL under a hard deadline, off the shared connection.

        Every other query in this class is one we wrote, with a bounded shape.
        Ad-hoc SQL is the only path where the user picks the query, so it is the
        only one that can run unbounded — a `WITH RECURSIVE` typo is enough, and
        it passes the endpoint's keyword validator because it is a plain SELECT.
        Two deliberate deviations from `_fetch_columns`:

        - **Its own cursor**, not the shared `_con` under `_lock`. A slow read
          therefore cannot stall turn recording, and — the load-bearing part —
          the watchdog below can only ever interrupt *this* query. Interrupting
          the shared connection would race a turn write that acquired the lock
          just as the deadline fired, and kill the write instead.
        - **A watchdog that calls `interrupt()`** at the deadline. This is the
          only thing that actually ends a runaway query: Python cannot kill a
          thread, and DuckDB has no statement timeout. Without it an in-flight
          request blocks uvicorn's graceful shutdown indefinitely, so SIGTERM
          closes the listening socket but never exits — `pkill` appears to do
          nothing and recovery needs `kill -9`.

        `interrupt()` is cooperative (DuckDB polls a flag between operators), so
        this is the best available mechanism rather than a guarantee.
        """
        with self._lock:
            cursor = self._get_con().cursor()
        watchdog = threading.Timer(timeout or self.ADHOC_TIMEOUT_SEC, cursor.interrupt)
        watchdog.start()
        try:
            result = cursor.execute(sql)
            columns = [desc[0] for desc in result.description]
            return columns, result.fetchall()
        finally:
            watchdog.cancel()
            cursor.close()

    def _fetch_one_dict(self, sql: str, params: list = None) -> Optional[dict]:
        """Execute SQL and return the first row as {column: value} (or None).

        Prefer this over `_fetch_one` + `row[N]` indexing — positional access
        breaks silently when columns are added/reordered.
        """
        columns, rows = self._fetch_columns(sql, params)
        if not rows:
            return None
        return dict(zip(columns, rows[0]))

    def _executemany(self, sql: str, params_list: list) -> None:
        """Execute SQL with multiple parameter sets."""
        with self._lock:
            con = self._get_con()
            con.executemany(sql, params_list)

    # ═══════════════════════════════════════════════════════════════════
    # Project identity (one project per local path; SHA256 of abspath)
    # ═══════════════════════════════════════════════════════════════════

    def get_project(self, project_id: str) -> Optional[dict]:
        """Return project metadata as a dict, or None if not found."""
        return self._fetch_one_dict(
            "SELECT id, name, merged_into, created_at FROM projects WHERE id = ?",
            [project_id]
        )

    def create_project(self, project_id: str, name: str) -> None:
        """Insert a new project row keyed by the path-derived hash."""
        self._execute(
            "INSERT INTO projects (id, name) VALUES (?, ?) "
            "ON CONFLICT (id) DO NOTHING",
            [project_id, name]
        )

    def rename_project(self, project_id: str, name: str) -> None:
        """Update the display name."""
        self._execute(
            "UPDATE projects SET name = ? WHERE id = ?", [name, project_id]
        )

    def merge_project(self, source: str, target: str) -> None:
        """Fold source project into target. Reversible by setting
        merged_into = NULL on the source row.

        Reserved for the future merge widget — no callers today.
        """
        if source == target:
            return
        self._execute(
            "UPDATE projects SET merged_into = ? WHERE id = ?", [target, source]
        )

    def list_projects(self, include_merged: bool = False) -> list[dict]:
        """All projects with turn counts."""
        sql = (
            "SELECT p.id, p.name, p.merged_into, p.created_at, "
            "       (SELECT COUNT(*) FROM turns t WHERE t.project_hash = p.id) AS turn_count "
            "FROM projects p"
        )
        if not include_merged:
            sql += " WHERE p.merged_into IS NULL"
        sql += " ORDER BY p.created_at DESC"
        rows = self._fetch_all(sql)
        return [
            {
                "id": r[0], "name": r[1], "merged_into": r[2],
                "created_at": r[3], "turn_count": r[4],
            }
            for r in rows
        ]

    def close(self):
        """Close the database connection, checkpointing WAL first."""
        if self._con:
            try:
                self._con.execute("CHECKPOINT")
            except Exception:
                pass
            self._con.close()
            self._con = None
            self._init_done = False

    # ═══════════════════════════════════════════════════════════════════
    # Session management
    # ═══════════════════════════════════════════════════════════════════

    def ensure_session(self, session_id: str, project_hash: str,
                       name: Optional[str] = None, model: Optional[str] = None,
                       git_repo_hash: Optional[str] = None,
                       provider: Optional[str] = None):
        """Create session if it doesn't exist, update if it does."""
        now = datetime.now(timezone.utc).isoformat()
        self._execute(
            """INSERT INTO sessions (id, project_hash, git_repo_hash, name, created_at, updated_at, model, provider)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET
                   updated_at = EXCLUDED.updated_at,
                   name = COALESCE(EXCLUDED.name, sessions.name),
                   model = COALESCE(EXCLUDED.model, sessions.model),
                   git_repo_hash = COALESCE(EXCLUDED.git_repo_hash, sessions.git_repo_hash),
                   provider = COALESCE(EXCLUDED.provider, sessions.provider)""",
            [session_id, project_hash, git_repo_hash, name, now, now, model,
             provider]  # None upserts to NULL only on a fresh row; COALESCE
                        # keeps an existing row's label (never downgrades it)
        )

    # ═══════════════════════════════════════════════════════════════════
    # Turn lifecycle
    # ═══════════════════════════════════════════════════════════════════

    def start_turn(
        self,
        session_id: str,
        project_hash: str,
        user_prompt: str,
        git_branch: Optional[str] = None,
        shadow_branch: Optional[str] = None,
        has_images: bool = False,
        has_files: bool = False,
        turn_number: Optional[int] = None,
        git_repo_hash: Optional[str] = None,
        is_plan: bool = False,
        provider: Optional[str] = None,
    ) -> str:
        """Record turn start. Returns turn_id (UUID).

        Called immediately when user sends a message - prompt is never lost.
        """
        turn_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        self._execute(
            """INSERT INTO turns (id, session_id, project_hash, git_repo_hash, turn_number, status,
                                  user_prompt, has_images, has_files, started_at,
                                  git_branch, shadow_branch, is_plan, provider)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)""",
            [turn_id, session_id, project_hash, git_repo_hash, turn_number,
             user_prompt, has_images, has_files, now,
             git_branch, shadow_branch, is_plan,
             provider or "claude"]  # mirror the column's legacy DEFAULT
        )

        # Update session
        self.ensure_session(session_id, project_hash, git_repo_hash=git_repo_hash,
                            provider=provider)

        logger.debug(f"Turn started: {turn_id[:8]} session={session_id[:8]} branch={git_branch}")
        return turn_id

    def complete_turn(
        self,
        turn_id: str,
        *,
        # From result message
        result_msg: Optional[dict] = None,
        # From shadow git
        git_hash: Optional[str] = None,
        git_branch: Optional[str] = None,
        shadow_branch: Optional[str] = None,
        # From the summary fork
        structured_data: Optional[dict] = None,
        summary_cost: float = 0.0,
        # Tracker data
        modified_files: Optional[list[str]] = None,
        # path -> created|modified|deleted|detected (TurnTracker.file_kinds);
        # missing entries default to 'modified'
        file_kinds: Optional[dict[str, str]] = None,
        # Files read but not modified → change_type='read' rows
        read_files: Optional[list[str]] = None,
        tools_summary: Optional[dict[str, int]] = None,
        # Model behind the main chat thread, captured live during the turn
        # (TurnTracker.main_thread_model). Authoritative when present.
        main_thread_model: Optional[str] = None,
        # Override status
        status: str = "completed",
        error_message: Optional[str] = None,
    ):
        """Finalize a turn with result data.

        Called after shadow git commit completes (has structured_data + git_hash).
        """
        now = datetime.now(timezone.utc).isoformat()

        # Extract fields from result message
        cost = 0.0
        tokens_in = 0
        tokens_out = 0
        duration_ms = 0
        duration_api_ms = 0
        model = main_thread_model
        provider_session_id = None
        provider_turn_uuid = None
        result_subtype = None
        is_error = False
        num_tool_loops = 0
        service_tier = None
        cache_read = 0
        cache_creation = 0
        web_search = 0
        web_fetch = 0
        permission_denials = None
        model_usage_data = {}

        if result_msg:
            cost = result_msg.get("total_cost_usd", 0)
            duration_ms = result_msg.get("duration_ms", 0)
            duration_api_ms = result_msg.get("duration_api_ms", 0)
            num_tool_loops = result_msg.get("num_turns", 0)
            result_subtype = result_msg.get("subtype")
            is_error = result_msg.get("is_error", False)
            provider_session_id = result_msg.get("session_id")
            provider_turn_uuid = result_msg.get("uuid")
            permission_denials = result_msg.get("permission_denials") or None

            usage = result_msg.get("usage", {})
            tokens_in = usage.get("input_tokens", 0)
            tokens_out = usage.get("output_tokens", 0)
            cache_read = usage.get("cache_read_input_tokens", 0)
            cache_creation = usage.get("cache_creation_input_tokens", 0)
            service_tier = usage.get("service_tier")

            model_usage_data = result_msg.get("modelUsage", {})
            if model_usage_data:
                # Cost is only a fallback: modelUsage aggregates Task-tool
                # subagents with the main thread, so the highest spender is
                # often a subagent, not the model that answered. Prefer the
                # main-thread model captured live during the turn.
                if not model:
                    model = max(model_usage_data.keys(),
                                key=lambda m: model_usage_data[m].get("costUSD", 0))
                # Aggregate web search/fetch across models
                for mu in model_usage_data.values():
                    web_search += mu.get("webSearchRequests", 0)
                    web_fetch += mu.get("webFetchRequests", 0)

        if is_error and not error_message:
            # Try to extract error from result text
            error_message = result_msg.get("result", "")[:500] if result_msg else None
            status = "failed"

        # Update the turn
        self._execute(
            """UPDATE turns SET
                status = ?,
                completed_at = ?,
                git_hash = ?,
                git_branch = COALESCE(?, git_branch),
                shadow_branch = COALESCE(?, shadow_branch),
                cost = ?,
                summary_cost = ?,
                tokens_in = ?,
                tokens_out = ?,
                duration_ms = ?,
                model = ?,
                provider_session_id = ?,
                provider_turn_uuid = ?,
                result_subtype = ?,
                is_error = ?,
                num_tool_loops = ?,
                duration_api_ms = ?,
                service_tier = ?,
                cache_read_tokens = ?,
                cache_creation_tokens = ?,
                web_search_count = ?,
                web_fetch_count = ?,
                error_message = ?,
                permission_denials = ?
            WHERE id = ?""",
            [status, now, git_hash, git_branch, shadow_branch, cost, summary_cost,
             tokens_in, tokens_out, duration_ms, model,
             provider_session_id, provider_turn_uuid, result_subtype,
             is_error, num_tool_loops, duration_api_ms, service_tier,
             cache_read, cache_creation, web_search, web_fetch,
             error_message, permission_denials, turn_id]
        )

        # Insert per-model usage
        if model_usage_data:
            for model_id, mu in model_usage_data.items():
                self._execute(
                    """INSERT INTO turn_model_usage
                       (id, turn_id, model_id, model_name, input_tokens, output_tokens,
                        cache_read_tokens, cache_creation_tokens, cost, context_window, web_search_count)
                       VALUES (nextval('seq_model_usage'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (turn_id, model_id) DO NOTHING""",
                    [turn_id, model_id, short_model_name(model_id),
                     mu.get("inputTokens", 0), mu.get("outputTokens", 0),
                     mu.get("cacheReadInputTokens", 0), mu.get("cacheCreationInputTokens", 0),
                     mu.get("costUSD", 0), mu.get("contextWindow"),
                     mu.get("webSearchRequests", 0)]
                )

        # Insert structured fields from the summary fork
        if structured_data:
            self._insert_structured_fields(turn_id, structured_data)

        # Insert files. change_type ∈ created|modified|deleted|detected|read.
        # Every query that means "files Claude changed" excludes 'read'
        # (IS DISTINCT FROM 'read' — rows predating this column's use are
        # NULL-safe 'modified').
        kinds = file_kinds or {}
        rows = [(fp, kinds.get(fp) or "modified") for fp in (modified_files or [])]
        written = {fp for fp, _ in rows}
        rows += [(fp, "read") for fp in (read_files or []) if fp not in written]
        for fp, change_type in rows:
            self._execute(
                """INSERT INTO turn_files (id, turn_id, file_path, change_type)
                   VALUES (nextval('seq_turn_files'), ?, ?, ?)
                   ON CONFLICT (turn_id, file_path) DO NOTHING""",
                [turn_id, fp, change_type]
            )

        # Insert tools
        if tools_summary:
            for tool_name, count in tools_summary.items():
                self._execute(
                    """INSERT INTO turn_tools (id, turn_id, tool_name, call_count)
                       VALUES (nextval('seq_turn_tools'), ?, ?, ?)
                       ON CONFLICT (turn_id, tool_name) DO NOTHING""",
                    [turn_id, tool_name, count]
                )

        # Plan detection: if EnterPlanMode/ExitPlanMode used, create plan record
        if tools_summary and {'EnterPlanMode', 'ExitPlanMode'} & set(tools_summary.keys()):
            self._execute("UPDATE turns SET is_plan = true WHERE id = ?", [turn_id])
            self._create_plan_from_turn(turn_id, modified_files, structured_data)
        else:
            # Non-plan turn: link to active plan in same session as implementation
            self._link_turn_to_plan(turn_id)

        # Update session aggregates
        self._execute(
            """UPDATE sessions SET
                turn_count = turn_count + 1,
                total_cost = total_cost + ?,
                updated_at = ?
            WHERE id = (SELECT session_id FROM turns WHERE id = ?)""",
            [cost, now, turn_id]
        )

        self._fts_dirty = True  # FTS indexes need rebuild

        logger.debug(f"Turn completed: {turn_id[:8]} git={git_hash[:8] if git_hash else 'none'} "
                      f"cost=${cost:.4f}")

        # Periodic WAL checkpoint
        with self._lock:
            self._turns_since_checkpoint += 1
            self._maybe_checkpoint()

    def _insert_structured_fields(self, turn_id: str, data: dict):
        """Insert summary-fork structured output as turn_fields rows."""
        # Known non-field keys to skip
        skip_keys = {"session_title", "tags"}

        for key, value in data.items():
            if key in skip_keys:
                continue

            value_text = None
            value_list = None
            search_text = ""

            if isinstance(value, list):
                value_list = value
                search_text = " ".join(str(v) for v in value)
            elif isinstance(value, str):
                value_text = value
                search_text = value
            else:
                value_text = str(value)
                search_text = value_text

            self._execute(
                """INSERT INTO turn_fields (id, turn_id, field_key, value_text, value_list, search_text)
                   VALUES (nextval('seq_turn_fields'), ?, ?, ?, ?, ?)
                   ON CONFLICT (turn_id, field_key) DO UPDATE SET
                       value_text = EXCLUDED.value_text,
                       value_list = EXCLUDED.value_list,
                       search_text = EXCLUDED.search_text""",
                [turn_id, key, value_text, value_list, search_text]
            )

        # Insert tags if present
        tags = data.get("tags", [])
        if isinstance(tags, list):
            for tag in tags:
                if isinstance(tag, str) and tag.strip():
                    tag_clean = tag.strip().lstrip("#").lower()
                    self._execute(
                        """INSERT INTO tags (id, turn_id, tag, source)
                           VALUES (nextval('seq_tags'), ?, ?, 'auto')
                           ON CONFLICT (turn_id, tag) DO NOTHING""",
                        [turn_id, tag_clean]
                    )

    def fail_turn(self, turn_id: str, error_message: str = ""):
        """Mark a turn as failed (crash, abort, etc.)."""
        now = datetime.now(timezone.utc).isoformat()
        self._execute(
            """UPDATE turns SET status = 'failed', completed_at = ?, error_message = ?
               WHERE id = ? AND status = 'pending'""",
            [now, error_message, turn_id]
        )

    # ═══════════════════════════════════════════════════════════════════
    # Tags (user-editable)
    # ═══════════════════════════════════════════════════════════════════

    def add_tag(self, turn_id: str, tag: str, source: str = "manual"):
        """Add a tag to a turn."""
        tag = tag.strip().lstrip("#").lower()
        self._execute(
            """INSERT INTO tags (id, turn_id, tag, source)
               VALUES (nextval('seq_tags'), ?, ?, ?)
               ON CONFLICT (turn_id, tag) DO NOTHING""",
            [turn_id, tag, source]
        )

    def remove_tag(self, turn_id: str, tag: str):
        """Remove a tag from a turn."""
        self._execute("DELETE FROM tags WHERE turn_id = ? AND tag = ?", [turn_id, tag])

    def rename_tag(self, old_tag: str, new_tag: str):
        """Rename a tag globally."""
        new_tag = new_tag.strip().lstrip("#").lower()
        self._execute("UPDATE tags SET tag = ? WHERE tag = ?", [new_tag, old_tag])

    # ═══════════════════════════════════════════════════════════════════
    # Async wrappers (for use from async code)
    # ═══════════════════════════════════════════════════════════════════

    async def astart_turn(self, **kwargs) -> str:
        """Async wrapper for start_turn."""
        return await asyncio.to_thread(self.start_turn, **kwargs)

    # ═══════════════════════════════════════════════════════════════════
    # File review acceptances
    # ═══════════════════════════════════════════════════════════════════

    def mark_file_reviewed(
        self,
        session_id: str,
        project_hash: str,
        file_path: str,
        shadow_commit: str,
        status: str = "reviewed",
        note: Optional[str] = None,
    ) -> str:
        """Upsert a file acceptance record. Returns acceptance ID."""
        acceptance_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        self._execute(
            """INSERT INTO file_acceptances (id, session_id, project_hash, file_path, shadow_commit, status, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (session_id, file_path) DO UPDATE SET
                   shadow_commit = EXCLUDED.shadow_commit,
                   status = EXCLUDED.status,
                   note = EXCLUDED.note,
                   updated_at = EXCLUDED.updated_at""",
            [acceptance_id, session_id, project_hash, file_path, shadow_commit, status, note, now, now]
        )
        return acceptance_id

    def mark_files_reviewed(
        self,
        session_id: str,
        project_hash: str,
        file_paths: list[str],
        shadow_commit: str,
    ):
        """Batch mark files as reviewed."""
        now = datetime.now(timezone.utc).isoformat()
        rows = [
            (str(uuid.uuid4()), session_id, project_hash, fp, shadow_commit, "reviewed", None, now, now)
            for fp in file_paths
        ]
        self._executemany(
            """INSERT INTO file_acceptances (id, session_id, project_hash, file_path, shadow_commit, status, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (session_id, file_path) DO UPDATE SET
                   shadow_commit = EXCLUDED.shadow_commit,
                   status = EXCLUDED.status,
                   note = EXCLUDED.note,
                   updated_at = EXCLUDED.updated_at""",
            rows
        )

    def get_file_acceptances(self, session_id: str) -> list[dict]:
        """Get all file acceptances for a session."""
        rows = self._fetch_all(
            "SELECT id, file_path, shadow_commit, status, note, created_at, updated_at FROM file_acceptances WHERE session_id = ? ORDER BY file_path",
            [session_id]
        )
        return [
            {"id": r[0], "file_path": r[1], "shadow_commit": r[2], "status": r[3], "note": r[4], "created_at": r[5], "updated_at": r[6]}
            for r in rows
        ]

    def delete_file_acceptance(self, session_id: str, file_path: str):
        """Remove a file acceptance (undo review)."""
        self._execute(
            "DELETE FROM file_acceptances WHERE session_id = ? AND file_path = ?",
            [session_id, file_path]
        )

    def get_recent_files(
        self,
        *,
        project_hash: Optional[str] = None,
        git_repo_hash: Optional[str] = None,
        limit: int = 100,
    ) -> list[dict]:
        """Files recently touched in a project/repo, newest first.

        Aggregates `turn_files` joined to `turns`, returning one row per
        unique `file_path` with last-touched timestamp and touch count.

        Both edits and reads count as "touched" (the quick switcher ranks
        by recency, then demotes read-only files); `kind` says which —
        'modified' when any turn changed the file, else 'read'.
        `touch_count` stays the EDIT count for backwards compatibility;
        `read_count` and `last_edited_at` are separate. A path whose most
        recent change is 'deleted' is omitted — nothing on disk to open.
        """
        conditions = []
        params: list = []
        if git_repo_hash:
            conditions.append("t.git_repo_hash = ?")
            params.append(git_repo_hash)
        elif project_hash:
            conditions.append("t.project_hash = ?")
            params.append(project_hash)
        else:
            return []

        where = " AND ".join(conditions)
        rows = self._fetch_all(
            f"""SELECT tf.file_path,
                       COUNT(DISTINCT CASE WHEN tf.change_type IS DISTINCT FROM 'read'
                                           THEN tf.turn_id END) AS edit_count,
                       COUNT(DISTINCT CASE WHEN tf.change_type = 'read'
                                           THEN tf.turn_id END) AS read_count,
                       MAX(CASE WHEN tf.change_type IS DISTINCT FROM 'read'
                                THEN COALESCE(t.completed_at, t.started_at) END) AS last_edited_at,
                       MAX(COALESCE(t.completed_at, t.started_at)) AS last_touched_at
                FROM turn_files tf
                JOIN turns t ON tf.turn_id = t.id
                WHERE {where}
                GROUP BY tf.file_path
                HAVING arg_max(tf.change_type, COALESCE(t.completed_at, t.started_at))
                       IS DISTINCT FROM 'deleted'
                ORDER BY last_touched_at DESC
                LIMIT ?""",
            params + [limit],
        )
        out = []
        for r in rows:
            edits = int(r[1]) if r[1] is not None else 0
            out.append({
                "path": r[0],
                "touch_count": edits,
                "read_count": int(r[2]) if r[2] is not None else 0,
                "kind": "modified" if edits > 0 else "read",
                "last_edited_at": str(r[3]) if r[3] is not None else None,
                "last_touched_at": str(r[4]) if r[4] is not None else None,
            })
        return out

    async def acomplete_turn(self, turn_id: str, **kwargs):
        """Async wrapper for complete_turn."""
        return await asyncio.to_thread(self.complete_turn, turn_id, **kwargs)

    async def afail_turn(self, turn_id: str, error_message: str = ""):
        """Async wrapper for fail_turn."""
        return await asyncio.to_thread(self.fail_turn, turn_id, error_message)


# ═══════════════════════════════════════════════════════════════════════════
# Singleton
# ═══════════════════════════════════════════════════════════════════════════

_instance: Optional[ShadowDB] = None
_instance_lock = threading.Lock()


def init_shadow_db(db_path: Path) -> ShadowDB:
    """Initialize the global ShadowDB with a custom path. Must be called before get_shadow_db()."""
    global _instance
    with _instance_lock:
        if _instance is not None:
            logger.warning(f"Re-initializing ShadowDB (was {_instance.db_path}, now {db_path})")
            _instance.close()
        _instance = ShadowDB(db_path=db_path)
    return _instance


def get_shadow_db() -> ShadowDB:
    """Get the global ShadowDB instance (creates on first call)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = ShadowDB()
    return _instance
