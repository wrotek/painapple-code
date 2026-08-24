"""
Session Stash & Favorites API Routes

Endpoints for managing:
- Session stash (context references for next message)
- Favorites (bookmarked sessions)
"""

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from painapple_code.session_store import SessionStore
from painapple_code.routes.dependencies import get_session_store

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sessions"])


# ═══════════════════════════════════════════════════════════════════
# Stash API
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/session/{session_id}/stash")
async def get_session_stash(session_id: str, store: SessionStore = Depends(get_session_store)):
    """Get all stash items for a session."""
    items = store.get_stash(session_id)
    return {"items": items, "count": len(items)}


@router.post("/api/session/{session_id}/stash")
async def add_stash_item(session_id: str, request: Request, store: SessionStore = Depends(get_session_store)):
    """Add an item to the session stash."""
    item = await request.json()
    success = store.add_stash_item(session_id, item)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save stash item")
    return {"success": True, "item": item}


@router.delete("/api/session/{session_id}/stash")
async def clear_session_stash(session_id: str, scope: str = "all",
                              store: SessionStore = Depends(get_session_store)):
    """Clear stash items by scope: 'pending' (default UI clear keeps sent
    history), 'history' (keeps pending), or 'all' (legacy behavior)."""
    if scope not in ("pending", "history", "all"):
        raise HTTPException(status_code=400, detail=f"Unknown scope: {scope}")
    success = store.clear_stash_scope(session_id, scope)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to clear stash")
    return {"success": True, "scope": scope}


class MarkSentRequest(BaseModel):
    item_ids: list[str]
    message_id: Optional[str] = None
    sent_at: Optional[str] = None
    sent_session_id: Optional[str] = None


@router.post("/api/session/{session_id}/stash/mark-sent")
async def mark_stash_sent(session_id: str, req: MarkSentRequest,
                          store: SessionStore = Depends(get_session_store)):
    """Mark stash items as sent — they move to history instead of being
    deleted. Trims sent history beyond the per-session cap."""
    marked, saved = store.mark_stash_sent(
        session_id,
        req.item_ids,
        message_id=req.message_id,
        sent_at=req.sent_at,
        sent_session_id=req.sent_session_id,
    )
    if marked and not saved:
        raise HTTPException(status_code=500, detail="Failed to save stash")
    return {"success": True, "marked": marked}


@router.delete("/api/session/{session_id}/stash/{item_id}")
async def remove_stash_item(session_id: str, item_id: str, store: SessionStore = Depends(get_session_store)):
    """Remove a specific item from the session stash."""
    success = store.remove_stash_item(session_id, item_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to remove stash item")
    return {"success": True}


@router.patch("/api/session/{session_id}/stash/{item_id}")
async def update_stash_item(session_id: str, item_id: str, request: Request, store: SessionStore = Depends(get_session_store)):
    """Update a stash item (toggle enabled, edit note)."""
    updates = await request.json()
    found, saved = store.update_stash_item(session_id, item_id, updates)
    if not found:
        raise HTTPException(status_code=404, detail="Item not found")
    if not saved:
        raise HTTPException(status_code=500, detail="Failed to save stash update")

    return {"success": True}


# ═══════════════════════════════════════════════════════════════════
# Favorites API
# ═══════════════════════════════════════════════════════════════════

class FavoriteRequest(BaseModel):
    note: Optional[str] = None


@router.get("/api/favorites")
async def get_favorites():
    """Get all favorited sessions with full session metadata."""
    from painapple_code.paths import load_favorites
    from painapple_code.welcome_search import get_welcome_searcher

    fav_data = load_favorites()
    favorites = fav_data.get("favorites", [])

    if not favorites:
        return {"favorites": []}

    searcher = get_welcome_searcher()
    all_sessions_result = await searcher.search("", limit=500)
    all_sessions = {s["session_id"]: s for s in all_sessions_result.get("results", [])}

    enriched = []
    for fav in favorites:
        session_id = fav["session_id"]
        session = all_sessions.get(session_id)

        if session:
            enriched.append({
                "session_id": session_id,
                "note": fav.get("note"),
                "added_at": fav.get("added_at"),
                "updated_at": fav.get("updated_at"),
                "project_hash": fav.get("project_hash") or session.get("project_hash"),
                "session": {
                    "name": session.get("name") or session.get("project") or "Session",
                    "project": session.get("project"),
                    "project_path": session.get("project_path"),
                    "last_activity": session.get("last_activity"),
                    "created_at": session.get("created_at"),
                    "summary": session.get("summary"),
                    "tags": session.get("tags", []),
                    "total_cost": session.get("total_cost", 0),
                    "message_count": session.get("message_count", 0),
                }
            })
        else:
            session_data = SessionStore.load(session_id)
            if session_data:
                cwd = session_data.get("cwd", "")
                enriched.append({
                    "session_id": session_id,
                    "note": fav.get("note"),
                    "added_at": fav.get("added_at"),
                    "updated_at": fav.get("updated_at"),
                    "project_hash": fav.get("project_hash") or session_data.get("project_hash"),
                    "session": {
                        "name": session_data.get("name") or (Path(cwd).name if cwd else "") or "Session",
                        "project": Path(cwd).name if cwd else None,
                        "project_path": cwd,
                        "last_activity": session_data.get("last_activity"),
                        "created_at": session_data.get("created_at"),
                        "summary": None,
                        "tags": [],
                        "total_cost": session_data.get("total_cost", 0),
                        "message_count": session_data.get("message_count", 0),
                    }
                })
            else:
                enriched.append({
                    "session_id": session_id,
                    "note": fav.get("note"),
                    "added_at": fav.get("added_at"),
                    "updated_at": fav.get("updated_at"),
                    "project_hash": fav.get("project_hash"),
                    "session": None,
                })

    enriched.sort(key=lambda x: (x.get("session") or {}).get("last_activity") or x.get("added_at") or "", reverse=True)

    return {"favorites": enriched}


@router.post("/api/favorites/{session_id}")
async def add_favorite(session_id: str, request: FavoriteRequest = None):
    """Add a session to favorites."""
    from painapple_code.paths import add_favorite as _add_favorite

    session_data = SessionStore.load(session_id)
    if not session_data:
        raise HTTPException(status_code=404, detail="Session not found")

    cwd = session_data.get("cwd")
    project_hash = session_data.get("project_hash")
    if not project_hash and cwd:
        from painapple_code.paths import get_project_hash
        project_hash = get_project_hash(cwd)

    note = request.note if request else None
    added = _add_favorite(session_id, project_hash, note)

    if added:
        return {"success": True, "session_id": session_id, "note": note}
    else:
        return {"success": False, "message": "Already favorited", "session_id": session_id}


@router.delete("/api/favorites/{session_id}")
async def remove_favorite_endpoint(session_id: str):
    """Remove a session from favorites."""
    from painapple_code.paths import remove_favorite

    removed = remove_favorite(session_id)
    if removed:
        return {"success": True, "session_id": session_id}
    else:
        raise HTTPException(status_code=404, detail="Favorite not found")


@router.patch("/api/favorites/{session_id}")
async def update_favorite(session_id: str, request: FavoriteRequest):
    """Update a favorite's note."""
    from painapple_code.paths import update_favorite_note

    updated = update_favorite_note(session_id, request.note or "")
    if updated:
        return {"success": True, "session_id": session_id, "note": request.note}
    else:
        raise HTTPException(status_code=404, detail="Favorite not found")
