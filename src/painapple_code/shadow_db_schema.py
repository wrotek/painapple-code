"""Schema DDL, migrations, and FTS index management for ShadowDB.

Mixed into ShadowDB. Owns SCHEMA_SQL and the system field definitions.
Methods here run at DB init time, on recovery, or to refresh FTS state.
"""

import logging
import time

import duckdb

from painapple_code import bridge_paths

logger = logging.getLogger("painapple-code.shadow-db")

# ═══════════════════════════════════════════════════════════════════════════
# System field definitions (seeded on init)
# ═══════════════════════════════════════════════════════════════════════════

SYSTEM_FIELD_DEFS = [
    {"key": "summary", "label": "Summary", "field_type": "text",
     "prompt": "One sentence: what was accomplished", "display_order": 1},
    {"key": "work_done", "label": "Work Done", "field_type": "list",
     "prompt": "Bullet points of specific changes", "display_order": 2},
    {"key": "learnings", "label": "Learnings", "field_type": "list",
     "prompt": "Key insights discovered", "display_order": 3},
    {"key": "context_for_resume", "label": "Context", "field_type": "text",
     "prompt": "What someone needs to continue this work", "display_order": 4},
    {"key": "commands", "label": "Commands", "field_type": "list",
     "prompt": "Reusable shell commands worth remembering", "display_order": 6},
]


# ═══════════════════════════════════════════════════════════════════════════
# Schema DDL
# ═══════════════════════════════════════════════════════════════════════════

SCHEMA_SQL = """
-- Sessions: container for turns
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR PRIMARY KEY,
    project_hash VARCHAR NOT NULL,
    git_repo_hash VARCHAR,
    name VARCHAR,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    model VARCHAR,
    archived BOOLEAN DEFAULT false,
    total_cost DECIMAL(10,4) DEFAULT 0,
    turn_count INTEGER DEFAULT 0,
    provider VARCHAR DEFAULT 'claude'  -- CLI agent backing the session
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(git_repo_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- Turns: THE HERO TABLE
CREATE TABLE IF NOT EXISTS turns (
    id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    project_hash VARCHAR NOT NULL,
    git_repo_hash VARCHAR,
    turn_number INTEGER,
    status VARCHAR DEFAULT 'pending',

    -- Prompt (captured immediately)
    user_prompt VARCHAR NOT NULL,
    has_images BOOLEAN DEFAULT false,
    has_files BOOLEAN DEFAULT false,
    started_at TIMESTAMPTZ DEFAULT now(),

    -- Git context (captured on send)
    git_branch VARCHAR,
    shadow_branch VARCHAR,

    -- Completion (filled after turn finishes)
    completed_at TIMESTAMPTZ,
    git_hash VARCHAR,
    cost DECIMAL(10,4),
    summary_cost DECIMAL(10,4),
    tokens_in UINTEGER,
    tokens_out UINTEGER,
    duration_ms INTEGER,
    model VARCHAR,

    -- Provider + result metadata
    provider VARCHAR DEFAULT 'claude',  -- CLI agent backing the turn
    provider_session_id VARCHAR,
    provider_turn_uuid VARCHAR,
    result_subtype VARCHAR,
    is_error BOOLEAN DEFAULT false,
    num_tool_loops INTEGER,
    duration_api_ms INTEGER,
    service_tier VARCHAR,

    -- Cache efficiency
    cache_read_tokens UINTEGER,
    cache_creation_tokens UINTEGER,

    -- Web tool usage
    web_search_count INTEGER DEFAULT 0,
    web_fetch_count INTEGER DEFAULT 0,

    -- Error tracking
    error_message VARCHAR,
    permission_denials VARCHAR[]
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project_hash);
CREATE INDEX IF NOT EXISTS idx_turns_repo ON turns(git_repo_hash);
CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);
CREATE INDEX IF NOT EXISTS idx_turns_git ON turns(git_hash);
CREATE INDEX IF NOT EXISTS idx_turns_branch ON turns(git_branch);
CREATE INDEX IF NOT EXISTS idx_turns_provider_session ON turns(provider_session_id);

-- Field definitions (system + user)
CREATE TABLE IF NOT EXISTS field_defs (
    id INTEGER PRIMARY KEY,
    project_hash VARCHAR,
    key VARCHAR NOT NULL,
    label VARCHAR NOT NULL,
    field_type VARCHAR NOT NULL,
    prompt VARCHAR,
    display_order INTEGER DEFAULT 0,
    source VARCHAR DEFAULT 'user',
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(project_hash, key)
);

-- Turn fields: one row per field per turn
CREATE TABLE IF NOT EXISTS turn_fields (
    id INTEGER PRIMARY KEY,
    turn_id VARCHAR NOT NULL,
    field_key VARCHAR NOT NULL,
    value_text VARCHAR,
    value_list VARCHAR[],
    search_text VARCHAR,
    edited BOOLEAN DEFAULT false,
    UNIQUE(turn_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_turn_fields_turn ON turn_fields(turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_fields_key ON turn_fields(field_key);

-- Tags
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    turn_id VARCHAR NOT NULL,
    tag VARCHAR NOT NULL,
    source VARCHAR DEFAULT 'auto',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(turn_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_turn ON tags(turn_id);

-- Files changed per turn
CREATE TABLE IF NOT EXISTS turn_files (
    id INTEGER PRIMARY KEY,
    turn_id VARCHAR NOT NULL,
    file_path VARCHAR NOT NULL,
    change_type VARCHAR,
    UNIQUE(turn_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_turn_files_path ON turn_files(file_path);
CREATE INDEX IF NOT EXISTS idx_turn_files_turn ON turn_files(turn_id);

-- Tools used per turn
CREATE TABLE IF NOT EXISTS turn_tools (
    id INTEGER PRIMARY KEY,
    turn_id VARCHAR NOT NULL,
    tool_name VARCHAR NOT NULL,
    call_count INTEGER DEFAULT 1,
    UNIQUE(turn_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_turn_tools_name ON turn_tools(tool_name);
CREATE INDEX IF NOT EXISTS idx_turn_tools_turn ON turn_tools(turn_id);

-- Per-model token/cost breakdown
CREATE TABLE IF NOT EXISTS turn_model_usage (
    id INTEGER PRIMARY KEY,
    turn_id VARCHAR NOT NULL,
    model_id VARCHAR NOT NULL,
    model_name VARCHAR,
    input_tokens UINTEGER,
    output_tokens UINTEGER,
    cache_read_tokens UINTEGER,
    cache_creation_tokens UINTEGER,
    cost DECIMAL(10,6),
    context_window INTEGER,
    web_search_count INTEGER DEFAULT 0,
    UNIQUE(turn_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_usage_turn ON turn_model_usage(turn_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_model ON turn_model_usage(model_id);

-- Attachments (images, files) sent with prompts
CREATE TABLE IF NOT EXISTS turn_attachments (
    id INTEGER PRIMARY KEY,
    turn_id VARCHAR NOT NULL,
    attachment_type VARCHAR NOT NULL,
    file_path VARCHAR,
    file_name VARCHAR,
    media_type VARCHAR,
    size_bytes INTEGER,
    storage_path VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_attachments_turn ON turn_attachments(turn_id);

-- Context snapshots (token usage from /context)
CREATE TABLE IF NOT EXISTS context_snapshots (
    id INTEGER PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    turn_id VARCHAR,
    captured_at TIMESTAMPTZ DEFAULT now(),
    trigger VARCHAR NOT NULL,
    model VARCHAR,
    total_tokens INTEGER,
    context_window INTEGER,
    usage_pct INTEGER,
    system_prompt_tokens INTEGER,
    conversation_tokens INTEGER,
    files_tokens INTEGER,
    tools_tokens INTEGER,
    other_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_context_session ON context_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_context_turn ON context_snapshots(turn_id);

-- Compaction events
CREATE TABLE IF NOT EXISTS compactions (
    id INTEGER PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    triggered_at TIMESTAMPTZ DEFAULT now(),
    trigger VARCHAR,
    trigger_turn_id VARCHAR,
    pre_tokens INTEGER,
    post_tokens INTEGER,
    summary VARCHAR,
    turns_compacted INTEGER
);

CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id);

-- Raw messages (optional, for deep FTS)
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    turn_id VARCHAR,
    role VARCHAR NOT NULL,
    content VARCHAR,
    timestamp TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id);

-- Plans: first-class plan tracking
CREATE TABLE IF NOT EXISTS plans (
    id VARCHAR PRIMARY KEY,
    turn_id VARCHAR NOT NULL UNIQUE,       -- The turn that created the plan
    session_id VARCHAR NOT NULL,
    project_hash VARCHAR NOT NULL,
    git_repo_hash VARCHAR,

    -- Plan identity
    plan_file VARCHAR,                     -- e.g. ~/.claude/plans/zesty-prancing-hammock.md
    plan_name VARCHAR,                     -- "zesty-prancing-hammock" (stem from path)

    -- Content (short - full content read from file or shadow-git)
    title VARCHAR,                         -- AI-generated: "Background Tasks Feature"
    summary VARCHAR,                       -- AI-generated: 1-2 sentence description

    -- Outcome tracking
    status VARCHAR DEFAULT 'proposed',     -- proposed | approved | rejected | abandoned
    approved_at TIMESTAMPTZ,

    -- Scope metrics (updated as implementation progresses)
    implementation_turns INTEGER DEFAULT 0,
    implementation_cost DECIMAL(10,4) DEFAULT 0,
    files_changed INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_hash);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_repo ON plans(git_repo_hash);

-- Plan-turn links: which turns implemented a plan
CREATE TABLE IF NOT EXISTS plan_turns (
    id INTEGER PRIMARY KEY,
    plan_id VARCHAR NOT NULL,
    turn_id VARCHAR NOT NULL,
    role VARCHAR DEFAULT 'implementation',  -- planning, implementation, verification
    UNIQUE(plan_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_plan_turns_plan ON plan_turns(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_turns_turn ON plan_turns(turn_id);

-- File review acceptances: per-file review status within a session
CREATE TABLE IF NOT EXISTS file_acceptances (
    id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    project_hash VARCHAR NOT NULL,
    file_path VARCHAR NOT NULL,
    shadow_commit VARCHAR NOT NULL,
    status VARCHAR DEFAULT 'reviewed',  -- 'reviewed' | 'flagged'
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ DEFAULT current_timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acceptances_session_file
    ON file_acceptances(session_id, file_path);
CREATE INDEX IF NOT EXISTS idx_acceptances_session
    ON file_acceptances(session_id);

-- Projects: one row per local working-copy path. id = SHA256(abspath).
-- merged_into is reserved for the future merge widget that will let users
-- manually link two projects (e.g. two clones of the same repo) — until
-- that ships, all rows have merged_into IS NULL.
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    merged_into VARCHAR,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_merged ON projects(merged_into);

-- Sequences for auto-increment IDs
CREATE SEQUENCE IF NOT EXISTS seq_field_defs START 1;
CREATE SEQUENCE IF NOT EXISTS seq_turn_fields START 1;
CREATE SEQUENCE IF NOT EXISTS seq_tags START 1;
CREATE SEQUENCE IF NOT EXISTS seq_turn_files START 1;
CREATE SEQUENCE IF NOT EXISTS seq_turn_tools START 1;
CREATE SEQUENCE IF NOT EXISTS seq_model_usage START 1;
CREATE SEQUENCE IF NOT EXISTS seq_attachments START 1;
CREATE SEQUENCE IF NOT EXISTS seq_context START 1;
CREATE SEQUENCE IF NOT EXISTS seq_compactions START 1;
CREATE SEQUENCE IF NOT EXISTS seq_messages START 1;
CREATE SEQUENCE IF NOT EXISTS seq_plan_turns START 1;
CREATE SEQUENCE IF NOT EXISTS seq_file_acceptances START 1;
"""


class _SchemaMixin:
    """Schema init, migrations, FTS, and index recovery for ShadowDB."""

    def _recover_indexes(self) -> duckdb.DuckDBPyConnection:
        """Drop and recreate all indexes to fix ART corruption."""
        logger.warning("Attempting ART index rebuild recovery...")
        con = duckdb.connect(str(self.db_path))
        # Extract CREATE INDEX statements from SCHEMA_SQL
        index_stmts = []
        for stmt in SCHEMA_SQL.split(";"):
            s = stmt.strip()
            if s.upper().startswith("CREATE INDEX"):
                parts = s.split()
                idx_name = parts[5] if "IF" in s.upper() else parts[2]
                index_stmts.append((idx_name, s))
        # Drop all indexes (safe — doesn't scan corrupt ART nodes)
        for idx_name, _ in index_stmts:
            try:
                con.execute(f"DROP INDEX IF EXISTS {idx_name}")
            except Exception:
                pass
        # Recreate from clean data
        for idx_name, stmt in index_stmts:
            try:
                con.execute(stmt)
            except Exception as e:
                logger.warning(f"Index {idx_name} recreate skipped: {e}")
        logger.warning(f"Shadow DB recovered via ART index rebuild ({len(index_stmts)} indexes)")
        return con

    def _init_schema(self):
        """Initialize all tables and seed system field defs."""
        con = self._con  # Use raw connection (called from _get_con)
        # Execute schema DDL (multiple statements)
        for statement in SCHEMA_SQL.split(";"):
            statement = statement.strip()
            if statement:
                try:
                    con.execute(statement)
                except duckdb.FatalException:
                    raise  # DB is dead, don't mask it
                except Exception as e:
                    logger.warning(f"Schema statement skipped: {e}")

        # ── Migrations ──
        # NOTE: DuckDB has a bug where ALTER TABLE ADD COLUMN in the WAL
        # fails on replay ("GetDefaultDatabase with no default database set").
        # Every migration that uses ALTER TABLE MUST call _migrate_add_column()
        # which checkpoints immediately after each ALTER.
        self._migrate_add_column(con, "sessions", "git_repo_hash", "VARCHAR")
        self._migrate_add_column(con, "turns", "git_repo_hash", "VARCHAR")
        self._migrate_add_column(con, "turns", "is_plan", "BOOLEAN DEFAULT false")
        # Multi-provider readiness: existing rows predate other CLIs → all Claude.
        self._migrate_add_column(con, "sessions", "provider", "VARCHAR DEFAULT 'claude'")
        self._migrate_add_column(con, "turns", "provider", "VARCHAR DEFAULT 'claude'")
        # Provider-neutral rename: the summary-fork cost column was haiku_cost.
        self._migrate_rename_column(con, "turns", "haiku_cost", "summary_cost")
        # Provider-neutral rename of the provider conversation/turn identity columns
        # (claude_session_id predates multi-provider). The index is renamed too.
        self._migrate_rename_column(con, "turns", "claude_session_id", "provider_session_id")
        self._migrate_rename_column(con, "turns", "claude_turn_uuid", "provider_turn_uuid")
        self._migrate_rename_index(con, "idx_turns_claude_session", "idx_turns_provider_session", "turns", "provider_session_id")

        # Backfill plans from existing turn_tools data
        self._backfill_plans(con)

        # Backfill git_repo_hash for existing rows from project path files
        nulls = con.execute(
            "SELECT COUNT(*) FROM turns WHERE git_repo_hash IS NULL AND status != 'interrupted'"
        ).fetchone()[0]
        if nulls > 0:
            self._backfill_git_repo_hash(con)

        # Seed system field definitions if empty
        count = con.execute("SELECT COUNT(*) FROM field_defs WHERE source = 'system'").fetchone()[0]
        if count == 0:
            for fd in SYSTEM_FIELD_DEFS:
                con.execute(
                    """INSERT INTO field_defs (id, project_hash, key, label, field_type, prompt, display_order, source)
                       VALUES (nextval('seq_field_defs'), NULL, ?, ?, ?, ?, ?, 'system')""",
                    [fd["key"], fd["label"], fd["field_type"], fd["prompt"], fd["display_order"]]
                )
            logger.info(f"Seeded {len(SYSTEM_FIELD_DEFS)} system field definitions")

        # Repair desynced sequences (e.g. after rebuild tool used manual IDs)
        self._repair_sequences(con)

        # Mark stale pending turns from previous server runs
        stale = con.execute(
            "UPDATE turns SET status = 'interrupted' WHERE status = 'pending' RETURNING id"
        ).fetchall()
        if stale:
            logger.info(f"Marked {len(stale)} stale pending turns as 'interrupted'")

        # Full-text search setup
        self._init_fts(con)

        logger.info("Shadow DB schema initialized")

    def _repair_sequences(self, con):
        """Ensure DuckDB sequences are ahead of MAX(id) in their tables.

        The rebuild tool uses manual ID counters, which can leave sequences
        behind the actual max ID. This causes 'Duplicate key' errors on
        subsequent nextval() calls.
        """
        seq_table_map = [
            ("seq_turn_fields", "turn_fields"),
            ("seq_tags", "tags"),
            ("seq_turn_files", "turn_files"),
            ("seq_turn_tools", "turn_tools"),
            ("seq_model_usage", "turn_model_usage"),
            ("seq_attachments", "turn_attachments"),
            ("seq_context", "context_snapshots"),
            ("seq_compactions", "compactions"),
            ("seq_messages", "messages"),
            ("seq_plan_turns", "plan_turns"),
        ]
        # Read current sequence values from catalog (no side effects, unlike nextval)
        try:
            rows = con.execute(
                "SELECT sequence_name, start_value FROM duckdb_sequences()"
            ).fetchall()
            seq_values = {r[0]: r[1] for r in rows}
        except Exception as e:
            logger.warning(f"Cannot read duckdb_sequences(), skipping repair: {e}")
            return

        repaired = []
        for seq_name, table_name in seq_table_map:
            try:
                max_id = con.execute(f"SELECT COALESCE(MAX(id), 0) FROM {table_name}").fetchone()[0]
                if max_id == 0:
                    continue
                next_val = seq_values.get(seq_name)
                if next_val is not None and next_val <= max_id:
                    target = max_id + 1
                    con.execute(f"DROP SEQUENCE {seq_name}")
                    con.execute(f"CREATE SEQUENCE {seq_name} START {target}")
                    repaired.append(f"{seq_name}: {next_val}→{target}")
            except Exception as e:
                logger.warning(f"Sequence repair skipped for {seq_name}: {e}")
        if repaired:
            logger.warning(f"Repaired desynced sequences: {', '.join(repaired)}")

    def _init_fts(self, con):
        """Load FTS extension and build indexes."""
        try:
            con.execute("INSTALL fts; LOAD fts;")
            self._rebuild_fts_indexes(con)
        except Exception as e:
            logger.warning(f"FTS init failed (search will use ILIKE fallback): {e}")
            self._fts_ready = False

    def _rebuild_fts_indexes(self, con):
        """Build/rebuild FTS indexes on turns.user_prompt and turn_fields.search_text."""
        t0 = time.monotonic()
        try:
            con.execute(
                "PRAGMA create_fts_index('turns', 'id', 'user_prompt', "
                "stemmer='porter', stopwords='english', overwrite=1)"
            )
            con.execute(
                "PRAGMA create_fts_index('turn_fields', 'id', 'search_text', "
                "stemmer='porter', stopwords='english', overwrite=1)"
            )
            self._fts_ready = True
            self._fts_dirty = False
            elapsed = (time.monotonic() - t0) * 1000
            logger.info(f"FTS indexes built ({elapsed:.0f}ms)")
        except Exception as e:
            logger.warning(f"FTS index build failed: {e}")
            self._fts_ready = False

    def rebuild_fts_if_needed(self):
        """Rebuild FTS indexes if data has changed since last build."""
        if not self._fts_dirty:
            return
        with self._lock:
            if not self._fts_dirty:
                return
            con = self._get_con()
            try:
                con.execute("LOAD fts;")
            except Exception:
                pass
            self._rebuild_fts_indexes(con)

    @staticmethod
    def _migrate_add_column(con, table: str, column: str, col_type: str):
        """Add a column if it doesn't exist, with immediate checkpoint.

        DuckDB WAL replay bug: ALTER TABLE in WAL fails on restart.
        Checkpoint flushes the ALTER into the DB file so WAL never replays it.
        """
        try:
            con.execute(f"SELECT {column} FROM {table} LIMIT 0")
        except duckdb.FatalException:
            raise  # DB is dead
        except Exception:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
            con.execute("CHECKPOINT")
            logger.info(f"Migration: added {table}.{column} ({col_type}) + checkpoint")

    @staticmethod
    def _migrate_rename_column(con, table: str, old: str, new: str):
        """Rename a column if the old name still exists, with immediate checkpoint.

        Idempotent: skips when the new column already exists (fresh schema or
        already migrated). CHECKPOINT after the ALTER works around DuckDB's
        WAL-replay bug (the rename must not live only in the WAL on restart).

        In DuckDB an FTS index AND the regular ART indexes on the table are
        catalog dependencies that block RENAME COLUMN ("Cannot alter entry ...
        because there are entries that depend on it"). So we capture each ART
        index's CREATE SQL, drop them (and the FTS index), rename, then rebuild
        the ART indexes from their saved SQL. _init_fts() rebuilds the FTS index
        later in this same schema-init pass.
        """
        try:
            con.execute(f"SELECT {new} FROM {table} LIMIT 0")
            return  # new column already present — nothing to do
        except duckdb.FatalException:
            raise  # DB is dead
        except Exception:
            pass
        try:
            con.execute(f"SELECT {old} FROM {table} LIMIT 0")
        except duckdb.FatalException:
            raise
        except Exception:
            return  # neither column exists — let the CREATE TABLE DDL own it

        # Capture ART index definitions so we can rebuild them after the rename.
        index_sql = []
        try:
            for name, sql in con.execute(
                "SELECT index_name, sql FROM duckdb_indexes() WHERE table_name = ?", [table]
            ).fetchall():
                if sql:
                    index_sql.append((name, sql))
        except Exception as e:
            logger.warning(f"Could not enumerate indexes on {table}: {e}")

        # Drop the FTS index (separate dependency) and every ART index.
        try:
            con.execute("LOAD fts;")
            con.execute(f"PRAGMA drop_fts_index('{table}')")
        except Exception:
            pass  # no FTS index on this table (or extension absent) — fine
        for name, _ in index_sql:
            try:
                con.execute(f"DROP INDEX IF EXISTS {name}")
            except Exception as e:
                logger.warning(f"Could not drop index {name}: {e}")

        con.execute(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}")
        con.execute("CHECKPOINT")

        # Rebuild the ART indexes, rewriting any reference to the renamed column
        # in the captured DDL (e.g. an index defined ON the column we just renamed).
        for name, sql in index_sql:
            try:
                con.execute(sql.replace(old, new))
            except Exception as e:
                logger.warning(f"Could not recreate index {name}: {e}")
        con.execute("CHECKPOINT")
        logger.info(
            f"Migration: renamed {table}.{old} → {new} "
            f"(dropped/rebuilt {len(index_sql)} ART indexes + FTS) + checkpoint"
        )

    @staticmethod
    def _migrate_rename_index(con, old_name: str, new_name: str, table: str, columns: str):
        """Rename an index (DuckDB has no RENAME INDEX): drop the old, create the
        new. Idempotent + checkpointed. Used when a renamed column's index should
        also shed the old name."""
        try:
            con.execute(f"DROP INDEX IF EXISTS {old_name}")
            con.execute(f"CREATE INDEX IF NOT EXISTS {new_name} ON {table}({columns})")
            con.execute("CHECKPOINT")
        except duckdb.FatalException:
            raise
        except Exception as e:
            logger.warning(f"Index rename {old_name} → {new_name} skipped: {e}")

    def _backfill_git_repo_hash(self, con):
        """One-time backfill: compute git_repo_hash for existing rows."""
        try:
            from painapple_code.bridge_paths import get_git_repo_hash

            # Build mapping from project_hash -> git_repo_hash via path files
            projects_dir = bridge_paths.BRIDGE_HOME / "projects"
            if not projects_dir.exists():
                return

            mapping = {}
            for h_dir in projects_dir.iterdir():
                if h_dir.is_dir():
                    path_file = h_dir / "path"
                    if path_file.exists():
                        project_path = path_file.read_text().strip()
                        repo_hash = get_git_repo_hash(project_path)
                        if repo_hash:
                            mapping[h_dir.name] = repo_hash

            for ph, rh in mapping.items():
                for table in ("turns", "sessions"):
                    rows = con.execute(
                        f"UPDATE {table} SET git_repo_hash = ? "
                        f"WHERE project_hash = ? AND git_repo_hash IS NULL RETURNING id",
                        [rh, ph]
                    ).fetchall()
                    if rows:
                        logger.info(f"Backfill: set git_repo_hash={rh} on {len(rows)} {table} rows (project={ph})")
        except Exception as e:
            logger.warning(f"git_repo_hash backfill failed (non-fatal): {e}")
