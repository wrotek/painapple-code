"""
Welcome Screen API Routes

Endpoints for:
- Welcome screen data (recent sessions, search, project list)
"""

import logging
from pathlib import Path

from fastapi import APIRouter, Request


logger = logging.getLogger(__name__)

router = APIRouter(tags=["sessions"])


# ═══════════════════════════════════════════════════════════════════
# Welcome Screen Endpoints
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/welcome/sessions")
async def get_welcome_sessions(limit: int = 10):
    """Get recent sessions with enriched shadow git data for the welcome screen."""
    from painapple_code.welcome_search import get_recent_sessions

    # Fetch extra to account for filtering out empty sessions
    sessions = await get_recent_sessions(limit=limit + 20)

    # Filter out empty sessions (opened but no messages sent)
    sessions = [
        s for s in sessions
        if s.get("message_count", 0) > 0 or s.get("turn_count", 0) > 0
    ]

    sessions = sessions[:limit]

    return {
        "sessions": sessions,
        "total": len(sessions),
    }


@router.post("/api/welcome/search")
async def search_welcome(request: Request):
    """Smart session search using shadow git archaeology."""
    from painapple_code.welcome_search import get_welcome_searcher

    body = await request.json()
    query = body.get("query", "").strip()
    limit = body.get("limit", 10)

    if not query:
        from painapple_code.welcome_search import get_recent_sessions
        sessions = await get_recent_sessions(limit=limit)
        return {
            "query": "",
            "parsed": {"keywords": [], "tags": [], "files": [], "intent": "browse"},
            "results": sessions,
            "total_found": len(sessions),
            "suggestions": [
                "Try: '#bugfix last week'",
                "Try: 'files:server.py'",
                "Try: 'auth bug fix'",
            ],
        }

    searcher = get_welcome_searcher()
    result = await searcher.search(query=query, limit=limit)

    return result


@router.get("/api/welcome/projects")
async def get_welcome_projects(request: Request):
    """Get projects for the quick-start picker, plus workspace siblings the
    user hasn't opened a session in yet."""
    from painapple_code.paths import list_projects, list_workspace_dirs

    projects = list_projects()

    enriched = []
    for p in projects:
        enriched.append({
            "path": p["path"],
            "hash": p["hash"],
            "name": Path(p["path"]).name,
            "session_count": p.get("session_count", 0),
            "color": p.get("color"),  # custom override, else None (→ hash color)
        })

    enriched.sort(key=lambda x: x["name"].lower())

    workspace_root = getattr(request.app.state, "workspace_root", None)
    workspace_dirs: list[dict] = []
    if workspace_root:
        exclude = [p["path"] for p in projects]
        workspace_dirs = list_workspace_dirs(workspace_root, exclude_paths=exclude)

    return {
        "projects": enriched,
        "workspace_root": workspace_root,
        "workspace_dirs": workspace_dirs,
    }


@router.get("/api/welcome/projects/sessions")
async def get_project_sessions(path: str, limit: int = 15):
    """Recent sessions for a specific project — drives the quick-switcher drill-in.

    limit=0 returns ALL non-empty sessions, enriched with shadow-git AI
    summaries — the quick-switcher's search-over-everything path. Positive
    limits stay summary-free so the instant drill-in preview keeps its
    meta.json-only fast path.
    """
    from painapple_code.session_store import SessionStoreV2
    from painapple_code.welcome_search import get_session_summaries

    # Skip if the project path isn't mounted in this container. Avoids
    # listing sessions the user can't actually resume.
    if not Path(path).is_dir():
        return {"sessions": []}

    store = SessionStoreV2(path)
    all_sessions = store.list_all()

    # Drop empty/never-used sessions — they're noise here.
    active = [s for s in all_sessions if s.get("message_count", 0) > 0]
    summaries = {}
    if limit > 0:
        active = active[:limit]
    else:
        summaries = await get_session_summaries(path)

    return {
        "sessions": [
            {
                "id": s["id"],
                "name": s.get("name", ""),
                "description": s.get("description", ""),
                "summary": summaries.get(s["id"], ""),
                "message_count": s.get("message_count", 0),
                "total_cost": s.get("total_cost", 0),
                "last_activity": s.get("last_activity", ""),
                "model": s.get("model"),
                "provider": s.get("provider"),  # None = default provider (claude-sdk)
            }
            for s in active
        ],
    }
