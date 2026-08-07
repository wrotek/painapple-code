"""
Prompt Drafts API Routes

Explicit "save this prompt for later" drafts — global (cross-session,
cross-project), stored server-side at ~/.painapple-code/drafts.json so
they survive the iPad PWA's flaky localStorage persistence.

Distinct from the per-session auto-draft (client-side, one slot per
session, restored on refresh) — these are deliberately banked prompts.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from painapple_code.bridge_paths import load_drafts, save_drafts

logger = logging.getLogger(__name__)

router = APIRouter(tags=["drafts"])

# Safety cap — trim oldest on write so drafts.json can't grow unbounded
MAX_DRAFTS = 200
TITLE_MAX_LEN = 60


class DraftCreate(BaseModel):
    text: str
    cwd: Optional[str] = None
    session_id: Optional[str] = None


class DraftUpdate(BaseModel):
    text: str
    cwd: Optional[str] = None
    session_id: Optional[str] = None


def _title_from_text(text: str) -> str:
    """Auto title: first non-empty line, truncated to ~60 chars."""
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:TITLE_MAX_LEN] + ("…" if len(line) > TITLE_MAX_LEN else "")
    return text.strip()[:TITLE_MAX_LEN] or "Draft"


@router.get("/api/drafts")
async def list_drafts():
    """List all saved drafts, newest first."""
    data = load_drafts()
    drafts = data.get("drafts", [])
    drafts.sort(key=lambda d: d.get("updatedAt") or "", reverse=True)
    return {"drafts": drafts, "count": len(drafts)}


@router.post("/api/drafts")
async def create_draft(req: DraftCreate):
    """Save a new draft. Title is derived from the first line of text."""
    if not (req.text or "").strip():
        raise HTTPException(status_code=400, detail="Draft text is empty")

    now = datetime.now(timezone.utc).isoformat()
    draft = {
        "id": uuid.uuid4().hex[:12],
        "text": req.text,
        "title": _title_from_text(req.text),
        "cwd": req.cwd,
        "sessionId": req.session_id,
        "createdAt": now,
        "updatedAt": now,
    }

    data = load_drafts()
    data.setdefault("drafts", []).insert(0, draft)
    # Trim oldest beyond the cap (list is kept newest-first)
    if len(data["drafts"]) > MAX_DRAFTS:
        data["drafts"] = data["drafts"][:MAX_DRAFTS]

    if not save_drafts(data):
        raise HTTPException(status_code=500, detail="Failed to save draft")
    return {"success": True, "draft": draft}


@router.put("/api/drafts/{draft_id}")
async def update_draft(draft_id: str, req: DraftUpdate):
    """Update a draft in place (auto-sync keeps the live input's draft fresh).

    Title is re-derived from the new text; updatedAt bumps so the draft
    floats to the top of the newest-first list.
    """
    if not (req.text or "").strip():
        raise HTTPException(status_code=400, detail="Draft text is empty")

    data = load_drafts()
    for draft in data.get("drafts", []):
        if draft.get("id") == draft_id:
            draft["text"] = req.text
            draft["title"] = _title_from_text(req.text)
            if req.cwd is not None:
                draft["cwd"] = req.cwd
            if req.session_id is not None:
                draft["sessionId"] = req.session_id
            draft["updatedAt"] = datetime.now(timezone.utc).isoformat()
            if not save_drafts(data):
                raise HTTPException(status_code=500, detail="Failed to save draft")
            return {"success": True, "draft": draft}

    raise HTTPException(status_code=404, detail="Draft not found")


@router.delete("/api/drafts")
async def clear_drafts():
    """Wipe all saved drafts at once (Clear All)."""
    data = load_drafts()
    count = len(data.get("drafts", []))
    data["drafts"] = []
    if not save_drafts(data):
        raise HTTPException(status_code=500, detail="Failed to clear drafts")
    return {"success": True, "cleared": count}


@router.delete("/api/drafts/{draft_id}")
async def delete_draft(draft_id: str):
    """Delete a draft (explicit delete, or consumed on send)."""
    data = load_drafts()
    drafts = data.get("drafts", [])
    remaining = [d for d in drafts if d.get("id") != draft_id]
    if len(remaining) == len(drafts):
        raise HTTPException(status_code=404, detail="Draft not found")

    data["drafts"] = remaining
    if not save_drafts(data):
        raise HTTPException(status_code=500, detail="Failed to save drafts")
    return {"success": True}
