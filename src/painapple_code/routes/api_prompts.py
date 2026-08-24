"""
Prompt Explorer API Routes - Search and browse user prompts across sessions

These endpoints provide access to prompt history, search functionality,
and prompt favorites management.
"""

import logging

from fastapi import APIRouter, HTTPException, Request

from painapple_code.prompt_explorer import get_prompt_extractor
from painapple_code import paths

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


# ═══════════════════════════════════════════════════════════════════════
# Prompt Search & List
# ═══════════════════════════════════════════════════════════════════════

@router.get("")
async def list_prompts(
    q: str = None,
    project: str = None,
    session: str = None,
    since: str = None,
    until: str = None,
    limit: int = 50,
    offset: int = 0,
):
    """
    List user prompts with search and filtering.

    Query params:
    - q: Search query with advanced syntax:
        - word1 word2       → AND (both required)
        - "exact phrase"    → Exact phrase match
        - -exclude          → Exclude term
        - word1 OR word2    → Either term
        - in:response       → Search in Claude's responses
        - project:name      → Filter by project name
        - after:YYYY-MM-DD  → After date
        - before:YYYY-MM-DD → Before date
        - long:             → Long prompts (>500 chars)
        - short:            → Short prompts (<100 chars)
        - has:image         → Prompts with images
        - today: yesterday: week: → Quick date filters
    - project: Filter by project hash
    - session: Filter by session ID
    - since: Start date (ISO or YYYY-MM-DD)
    - until: End date (ISO or YYYY-MM-DD)
    - limit: Max results (default 50)
    - offset: Skip N results for pagination
    """
    extractor = get_prompt_extractor()

    prompts, total, parsed_query = extractor.get_all_prompts(
        project_hash=project,
        since=since,
        until=until,
        search_query=q,
        limit=limit,
        offset=offset,
    )

    # Filter by session if specified
    if session:
        prompts = [p for p in prompts if p.session_id == session]
        total = len(prompts)

    response = {
        "prompts": [p.to_dict() for p in prompts],
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(prompts) < total,
    }

    # Include query parsing info for UI
    if parsed_query:
        response["query"] = {
            "original": parsed_query.original_query,
            "filters": parsed_query.active_filters,
            "search_response": parsed_query.search_response,
        }
        # Extract all terms for highlighting
        highlight_terms = list(parsed_query.required_terms)
        for phrase in parsed_query.exact_phrases:
            highlight_terms.append(phrase)
        for or_group in parsed_query.or_groups:
            highlight_terms.extend(or_group)
        response["query"]["highlight_terms"] = highlight_terms

    return response


@router.get("/recent")
async def get_recent_prompts(
    limit: int = 20,
    project: str = None,
    session: str = None,
):
    """
    Get most recent prompts (optimized for Ctrl+R quick access).

    Query params:
    - limit: Max prompts (default 20)
    - project: Filter by project hash
    - session: Filter by specific session only
    """
    extractor = get_prompt_extractor()

    prompts = extractor.get_recent_prompts(
        limit=limit,
        project_hash=project,
        session_id=session,
    )

    return {
        "prompts": [p.to_dict() for p in prompts],
        "count": len(prompts),
    }


@router.get("/frequent")
async def get_frequent_prompts(
    limit: int = 10,
):
    """
    Get frequently used prompts (similar prompts grouped).

    Finds prompts that appear multiple times with slight variations.
    Useful for discovering common patterns.
    """
    extractor = get_prompt_extractor()
    groups = extractor.get_frequent_prompts(limit=limit)

    return {
        "groups": groups,
        "count": len(groups),
    }


@router.get("/stats")
async def get_prompt_stats(
    project: str = None,
):
    """
    Get statistics about prompts.

    Returns counts, averages, and time distribution.
    """
    extractor = get_prompt_extractor()
    stats = extractor.get_prompt_stats(project_hash=project)
    return stats


@router.get("/response/{prompt_id:path}")
async def get_prompt_response(prompt_id: str):
    """
    Get the full Claude response for a prompt.

    prompt_id is `{session_id}:{line_number}` (URL-encoded colon is fine).
    Returns concatenated text of all assistant messages between this user
    message and the next one.
    """
    extractor = get_prompt_extractor()
    response = extractor.get_full_response(prompt_id)
    if response is None:
        raise HTTPException(status_code=404, detail="Response not found")
    return {"prompt_id": prompt_id, "response": response}


# ═══════════════════════════════════════════════════════════════════════════
# Prompt Favorites
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/favorites")
async def get_prompt_favorites():
    """
    Get all favorited prompts.

    Returns dict of prompt_id -> metadata (content_preview, note, added_at).
    """
    favorites = paths.get_all_prompt_favorites()
    return {"favorites": favorites, "count": len(favorites)}


@router.post("/favorites")
async def add_prompt_favorite(request: Request):
    """
    Add a prompt to favorites.

    Body: { "prompt_id": "session:line", "content_preview": "...", "note": "..." }
    """
    body = await request.json()
    prompt_id = body.get("prompt_id")
    content_preview = body.get("content_preview", "")
    note = body.get("note", "")

    if not prompt_id:
        raise HTTPException(status_code=400, detail="prompt_id required")

    added = paths.add_prompt_favorite(prompt_id, content_preview, note)
    return {"success": added, "prompt_id": prompt_id}


@router.delete("/favorites/{prompt_id:path}")
async def remove_prompt_favorite(prompt_id: str):
    """
    Remove a prompt from favorites.

    Path param prompt_id is URL-encoded (contains colon).
    """
    removed = paths.remove_prompt_favorite(prompt_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Prompt not in favorites")
    return {"success": True, "prompt_id": prompt_id}


@router.get("/favorites/{prompt_id:path}")
async def check_prompt_favorite(prompt_id: str):
    """
    Check if a specific prompt is favorited.
    """
    is_fav = paths.is_prompt_favorite(prompt_id)
    metadata = paths.get_prompt_favorite(prompt_id) if is_fav else None
    return {"is_favorite": is_fav, "metadata": metadata}
