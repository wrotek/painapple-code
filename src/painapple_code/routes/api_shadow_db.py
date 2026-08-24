"""
Shadow DB API - REST endpoints for the turn-centric metadata database.

Endpoints:
    GET  /api/turns                  - List/search turns
    GET  /api/turns/{id}             - Get turn details
    POST /api/turns/{id}/tags        - Add tag to turn
    DELETE /api/turns/{id}/tags/{tag} - Remove tag from turn
    POST /api/tags/rename            - Rename tag globally
    GET  /api/turns/tags             - Tag cloud
    GET  /api/turns/branches         - Branch activity
    GET  /api/turns/stats            - Database statistics
    GET  /api/shadow-db/search       - Rich FTS search with section scoping + field selection
    GET  /api/shadow-db/file-history - File change history with structured context
    GET  /api/shadow-db/recent-files - Files recently touched by Claude in a project
    POST /api/shadow-db/sql          - Read-only SQL passthrough (replaces db-query CLI)
"""

import asyncio
import logging
import re
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse

logger = logging.getLogger("api_shadow_db")

router = APIRouter()


def _get_db():
    """Lazy import to avoid circular deps."""
    from painapple_code.shadow_db import get_shadow_db
    return get_shadow_db()


# ═══════════════════════════════════════════════════════════════════════════
# Turn listing & search
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/turns")
async def list_turns(
    project: str = Query(None, description="Filter by project hash"),
    repo: str = Query(None, description="Filter by git repo hash (cross-worktree)"),
    session: str = Query(None, description="Filter by session ID"),
    branch: str = Query(None, description="Filter by git branch"),
    status: str = Query(None, description="Filter by status"),
    tag: str = Query(None, description="Filter by tag"),
    q: str = Query(None, description="Search prompt and fields"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List turns with optional filters."""
    try:
        db = _get_db()
        result = db.list_turns(
            project_hash=project,
            git_repo_hash=repo,
            session_id=session,
            git_branch=branch,
            status=status,
            tag=tag,
            search=q,
            limit=limit,
            offset=offset,
        )
        # Serialize timestamps
        for t in result["turns"]:
            for key in ("started_at", "completed_at"):
                if t.get(key):
                    t[key] = str(t[key])
            if t.get("cost"):
                t["cost"] = float(t["cost"])
        return result
    except Exception as e:
        logger.exception(f"list_turns failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/turns/stats")
async def get_stats(
    project: str = Query(None, description="Filter by project hash"),
    repo: str = Query(None, description="Filter by git repo hash (cross-worktree)"),
):
    """Get database statistics."""
    try:
        db = _get_db()
        stats = db.get_stats(project_hash=project, git_repo_hash=repo)
        # Serialize timestamps
        for key in ("first_turn", "last_turn"):
            if stats.get(key):
                stats[key] = str(stats[key])
        return stats
    except Exception as e:
        logger.exception(f"get_stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/turns/tags")
async def get_tag_cloud(
    project: str = Query(None, description="Filter by project hash"),
):
    """Get tag cloud with usage statistics."""
    try:
        db = _get_db()
        return {"tags": db.get_tag_cloud(project_hash=project)}
    except Exception as e:
        logger.exception(f"get_tag_cloud failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/turns/branches")
async def get_branch_stats(
    project: str = Query(None, description="Filter by project hash"),
):
    """Get branch activity overview."""
    try:
        db = _get_db()
        branches = db.get_branch_stats(project_hash=project)
        for b in branches:
            for key in ("first_turn", "last_turn"):
                if b.get(key):
                    b[key] = str(b[key])
        return {"branches": branches}
    except Exception as e:
        logger.exception(f"get_branch_stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# ═══════════════════════════════════════════════════════════════════════════
# Individual turn
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/turns/{turn_id}")
async def get_turn(turn_id: str):
    """Get full turn details with fields, tags, files, and tools."""
    try:
        db = _get_db()
        turn = db.get_turn(turn_id)
        if not turn:
            return JSONResponse({"error": "Turn not found"}, status_code=404)
        # Serialize
        for key in ("started_at", "completed_at"):
            if turn.get(key):
                turn[key] = str(turn[key])
        for key in ("cost", "summary_cost"):
            if turn.get(key):
                turn[key] = float(turn[key])
        return turn
    except Exception as e:
        logger.exception(f"get_turn failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# ═══════════════════════════════════════════════════════════════════════════
# Tag management
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/api/turns/{turn_id}/tags")
async def add_tag(turn_id: str, tag: str = Query(..., description="Tag name")):
    """Add a tag to a turn."""
    try:
        db = _get_db()
        db.add_tag(turn_id, tag)
        return {"ok": True, "tag": tag.strip().lstrip("#").lower()}
    except Exception as e:
        logger.exception(f"add_tag failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.delete("/api/turns/{turn_id}/tags/{tag}")
async def remove_tag(turn_id: str, tag: str):
    """Remove a tag from a turn."""
    try:
        db = _get_db()
        db.remove_tag(turn_id, tag)
        return {"ok": True}
    except Exception as e:
        logger.exception(f"remove_tag failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/tags/rename")
async def rename_tag(
    old: str = Query(..., description="Old tag name"),
    new: str = Query(..., description="New tag name"),
):
    """Rename a tag globally across all turns."""
    try:
        db = _get_db()
        db.rename_tag(old, new)
        return {"ok": True, "old": old, "new": new.strip().lstrip("#").lower()}
    except Exception as e:
        logger.exception(f"rename_tag failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# ═══════════════════════════════════════════════════════════════════════════
# Rich FTS search (for agents / CLI)
# ═══════════════════════════════════════════════════════════════════════════

def _serialize_turns(turns: list[dict]):
    """Serialize timestamps and decimals in turn dicts."""
    for t in turns:
        for key in ("started_at", "completed_at"):
            if t.get(key):
                t[key] = str(t[key])
        if t.get("cost"):
            t["cost"] = float(t["cost"])


@router.get("/api/shadow-db/search")
async def search_turns(
    q: str = Query(None, description="Full-text search across prompts and fields"),
    in_sections: str = Query(
        None,
        description="Restrict FTS to these sections (comma-separated field_keys, "
                    "e.g. decisions,learnings,problems_solved)"
    ),
    fields: str = Query(
        "summary",
        description="Which fields to return per turn (comma-separated, "
                    "e.g. summary,decisions,learnings)"
    ),
    file: str = Query(None, description="Exact file path filter"),
    file_pattern: str = Query(None, description="File path ILIKE pattern (e.g. %server.py)"),
    tag: str = Query(None, description="Filter by tag"),
    branch: str = Query(None, description="Filter by git branch"),
    session: str = Query(None, description="Filter by session ID"),
    project: str = Query(None, description="Filter by project hash"),
    repo: str = Query(None, description="Filter by git repo hash"),
    status: str = Query("completed", description="Filter by status (default: completed)"),
    since: str = Query(None, description="ISO datetime lower bound"),
    until: str = Query(None, description="ISO datetime upper bound"),
    include_tags: bool = Query(True, description="Include tags array"),
    include_files: bool = Query(False, description="Include changed files array"),
    include_tools: bool = Query(False, description="Include tools dict"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Rich FTS search with section scoping and field selection.

    Designed for agent/CLI consumption. Returns only the fields you ask for,
    avoiding the token waste of fetching all 15+ summary sections per turn.

    Section/field keys: summary, work_done, decisions, problems_solved, learnings,
    context_for_resume, investigation, findings, verification, tools_used,
    commands, entities
    """
    try:
        db = _get_db()
        field_list = [f.strip() for f in fields.split(",") if f.strip()] if fields else None
        section_list = (
            [s.strip() for s in in_sections.split(",") if s.strip()]
            if in_sections else None
        )

        result = db.search_turns(
            query=q,
            search_sections=section_list,
            file_path=file,
            file_pattern=file_pattern,
            tag=tag,
            git_branch=branch,
            session_id=session,
            project_hash=project,
            git_repo_hash=repo,
            status=status,
            since=since,
            until=until,
            fields=field_list,
            include_tags=include_tags,
            include_files=include_files,
            include_tools=include_tools,
            limit=limit,
            offset=offset,
        )
        _serialize_turns(result["turns"])
        return result
    except Exception as e:
        logger.exception(f"search_turns failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/shadow-db/query")
async def query_turns(
    q: str = Query(..., description="TurnQL query string"),
    repo: str = Query(None, description="Filter by git repo hash"),
    project: str = Query(None, description="Filter by project hash"),
    fields: str = Query(
        "summary",
        description="Which fields to return per turn (comma-separated)"
    ),
    include_tags: bool = Query(True, description="Include tags array"),
    include_files: bool = Query(False, description="Include changed files array"),
    include_tools: bool = Query(False, description="Include tools dict"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """TurnQL: Lucene-inspired query language for searching turns.

    Supports section-scoped FTS, boolean logic, parenthesized grouping,
    numeric ranges, date filters, and metadata filters.

    Examples:
        deploy                           - text search across all
        decisions:refactor               - section-scoped FTS
        (summary:X OR work_done:X) AND branch:main
        file:server.py cost:>1 since:week
        is:error model:opus -tag:test
        "exact phrase"
    """
    try:
        db = _get_db()
        field_list = [f.strip() for f in fields.split(",") if f.strip()] if fields else None

        result = db.query_turns(
            q,
            git_repo_hash=repo,
            project_hash=project,
            fields=field_list,
            include_tags=include_tags,
            include_files=include_files,
            include_tools=include_tools,
            limit=limit,
            offset=offset,
        )
        _serialize_turns(result["turns"])
        return result
    except Exception as e:
        logger.exception(f"query_turns failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/shadow-db/recent-files")
async def recent_files(
    cwd: str = Query(None, description="Project working directory (converted to project_hash)"),
    project: str = Query(None, description="Project hash (alternative to cwd)"),
    repo: str = Query(None, description="Filter by git repo hash (cross-worktree)"),
    limit: int = Query(100, ge=1, le=500),
):
    """Files recently touched by Claude in this project, newest first.

    One of `cwd`, `project`, or `repo` is required. Returns a list sorted
    by last-touched timestamp descending, with touch counts.
    """
    try:
        project_hash = project
        if not project_hash and not repo and cwd:
            from painapple_code.paths import get_project_hash
            project_hash = get_project_hash(cwd)
        if not project_hash and not repo:
            return JSONResponse({"error": "cwd, project, or repo is required"}, status_code=400)

        db = _get_db()
        files = db.get_recent_files(
            project_hash=project_hash,
            git_repo_hash=repo,
            limit=limit,
        )
        return {"files": files, "project_hash": project_hash, "cwd": cwd}
    except Exception as e:
        logger.exception(f"recent_files failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/shadow-db/file-history")
async def file_history(
    path: str = Query(..., description="File path (exact or ILIKE pattern with %)"),
    fields: str = Query(
        "summary,work_done,decisions",
        description="Fields to include per turn"
    ),
    repo: str = Query(None, description="Filter by git repo hash"),
    limit: int = Query(30, ge=1, le=100),
):
    """History of changes to a file with structured context.

    Returns turns that modified the given file, newest first,
    with selected structured fields inline.
    """
    try:
        db = _get_db()
        field_list = [f.strip() for f in fields.split(",") if f.strip()] if fields else None
        is_pattern = "%" in path

        result = db.search_turns(
            file_path=None if is_pattern else path,
            file_pattern=path if is_pattern else None,
            git_repo_hash=repo,
            status="completed",
            fields=field_list,
            include_tags=True,
            include_files=True,
            limit=limit,
        )
        _serialize_turns(result["turns"])
        return result
    except Exception as e:
        logger.exception(f"file_history failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# ═══════════════════════════════════════════════════════════════════════════
# Raw SQL passthrough (read-only) — replaces the external `db-query` CLI
# ═══════════════════════════════════════════════════════════════════════════

_MUTATION_KEYWORDS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|COPY|"
    r"INSTALL|LOAD|CALL|TRUNCATE|VACUUM|CHECKPOINT|BEGIN|COMMIT|"
    r"ROLLBACK|REPLACE|MERGE|GRANT|REVOKE|EXPORT|IMPORT|SET|RESET|USE)\b",
    re.IGNORECASE,
)

# DuckDB table functions that read arbitrary host files/URLs. A plain SELECT
# using these (e.g. `SELECT * FROM read_csv('/etc/passwd')`) would exfiltrate
# files despite passing the mutation check, so reject them explicitly.
# This is now defense-in-depth with a friendly error: the connection itself
# runs with `enable_external_access=false` (set in ShadowDB._lock_down_external_access
# after FTS init), which blocks these functions AND the `FROM 'file'` replacement
# scan / `COPY ... TO 'file'` engine-wide. This denylist just catches the common
# read_* case before the query runs, with a clearer message than DuckDB's
# PermissionException.
_FILE_ACCESS_FUNCS = re.compile(
    r"\b(read_csv|read_csv_auto|read_parquet|parquet_scan|read_json|"
    r"read_json_auto|read_ndjson|read_ndjson_auto|read_text|read_blob|"
    r"glob|sniff_csv|parquet_metadata|parquet_schema)\s*\(",
    re.IGNORECASE,
)


def _sanitize_for_validation(sql: str) -> str:
    """Strip comments and string/identifier literals so keyword detection
    doesn't trip on values like `'INSERT INTO foo'` inside a SELECT."""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    sql = re.sub(r"--[^\n]*", " ", sql)
    sql = re.sub(r"'(?:[^']|'')*'", "''", sql)
    sql = re.sub(r'"(?:[^"]|"")*"', '""', sql)
    sql = re.sub(r"\$([A-Za-z_]\w*)?\$.*?\$\1\$", " ", sql, flags=re.DOTALL)
    return sql


@router.post("/api/shadow-db/sql")
async def execute_sql(request: Request, format: str = Query("json", pattern="^(json|tsv)$")):
    """Read-only SQL passthrough against the shadow DuckDB.

    Body: raw SQL (Content-Type: text/plain) or `{"sql": "..."}` JSON.
    Query: `format=json` (default) returns `{columns, rows, count}`;
    `format=tsv` returns tab-separated text with header row.

    Rejects any query containing mutation keywords (INSERT/UPDATE/DROP/etc.).
    Runs through the server's existing connection so reads are consistent
    with concurrent writes.
    """
    raw = await request.body()
    sql = raw.decode("utf-8", errors="replace").strip()
    if sql.startswith("{"):
        try:
            import json as _json
            payload = _json.loads(sql)
            sql = (payload.get("sql") or "").strip()
            format = payload.get("format", format)
        except Exception:
            pass
    if not sql:
        return JSONResponse({"error": "SQL body is required"}, status_code=400)

    cleaned = _sanitize_for_validation(sql)
    file_match = _FILE_ACCESS_FUNCS.search(cleaned)
    if file_match:
        fn = file_match.group(1).lower()
        return JSONResponse(
            {"error": f"File-access function '{fn}' is not allowed"},
            status_code=400,
        )
    match = _MUTATION_KEYWORDS.search(cleaned)
    if match:
        return JSONResponse(
            {"error": f"Mutation keyword '{match.group(0).upper()}' is not allowed"},
            status_code=400,
        )

    try:
        db = _get_db()
        # Off the event loop AND on a deadline. Both halves are required, and
        # neither is sufficient alone:
        #
        #   to_thread   — keeps the loop serving. Run inline, one slow SELECT
        #                 freezes every WebSocket, every streaming turn and the
        #                 compact heartbeat.
        #   the deadline (inside fetch_columns_adhoc) — ends the query. Without
        #                 it the request never completes, uvicorn's graceful
        #                 shutdown waits on it forever, and SIGTERM closes the
        #                 socket without exiting: `pkill` looks like a no-op and
        #                 recovery needs `kill -9`.
        #
        # Note `asyncio.wait_for` here would be worse than nothing — it frees
        # the caller while the query keeps burning a core, so a retry stacks
        # runaway queries. Cancellation has to happen at the DuckDB level.
        columns, rows = await asyncio.to_thread(db.fetch_columns_adhoc, sql)
    except Exception as e:
        logger.warning(f"execute_sql query failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=400)

    str_rows = [["" if v is None else str(v) for v in row] for row in rows]

    if format == "tsv":
        lines = ["\t".join(columns)]
        for row in str_rows:
            lines.append("\t".join(row))
        return PlainTextResponse("\n".join(lines) + "\n")

    return {"columns": columns, "rows": str_rows, "count": len(rows)}
