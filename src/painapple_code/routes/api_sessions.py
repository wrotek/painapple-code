"""
Sessions API Routes - Session CRUD, search, fork, threads

These endpoints manage:
- Session listing, creation, deletion, renaming
- Session search (keyword and AI-powered)
- Session preview, thinking tokens
- Session fork, graduate, threads
"""

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from painapple_code import paths
from painapple_code.session_store import SessionStore
from painapple_code.utils.file_paths import safe_resolve

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sessions"])


# ═══════════════════════════════════════════════════════════════════
# Session CRUD
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/sessions")
async def list_sessions():
    """List all stored sessions (filters out ungraduated discussion threads)."""
    all_sessions = SessionStore.list_all()
    visible_sessions = [
        s for s in all_sessions
        if not s.get("isCommentThread") or s.get("graduated")
    ]
    return {"sessions": visible_sessions}


@router.post("/api/sessions")
async def create_session(request: Request, cwd: str, name: str = None, provider: str = None):
    """Create a new session.

    `provider` picks the engine for this session (recorded in meta, permanent —
    the session's provider_session_id only means anything to that engine).
    Unknown names 400 — REST callers asked for it explicitly, so failing loud
    beats a silent claude-sdk fallback. Omitted → the same effective default a
    WS-created session gets (--default-provider flag / `default_provider`
    config key), so REST- and WS-created sessions no longer diverge.
    """
    from painapple_code.providers import get_provider, provider_names
    if provider is not None and provider not in provider_names():
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {provider}. Valid: {provider_names()}",
        )
    resolved_cwd = str(safe_resolve(cwd))
    session_data = SessionStore.create(resolved_cwd, name)
    agents = getattr(request.app.state, "agents", None)
    provider_name = (provider
                     or getattr(agents, "default_provider", None)
                     or paths.load_global_config().get("default_provider"))
    if provider_name:
        SessionStore.update_metadata(session_data["id"], provider=provider_name)
        session_data["provider"] = provider_name
        # Bind-time permission anchoring — same contract as the WS create
        # path: a global default level this engine doesn't speak is replaced
        # by the engine's own default so meta, UI, and launch agree.
        from painapple_code.routes.dependencies import bind_permission_level
        anchored = bind_permission_level(None, get_provider(provider_name))
        if anchored:
            SessionStore.update_metadata(
                session_data["id"], permission_level=anchored)
            session_data["permission_level"] = anchored
    return session_data


@router.get("/api/session/{session_id}")
async def get_session(session_id: str):
    """Get a session by ID (includes messages)."""
    data = SessionStore.load(session_id)
    if not data:
        raise HTTPException(status_code=404, detail="Session not found")
    return data


@router.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    """Delete a session."""
    if SessionStore.delete(session_id):
        return {"deleted": True, "id": session_id}
    raise HTTPException(status_code=404, detail="Session not found")


@router.patch("/api/sessions/{session_id}/meta")
async def update_session_meta(session_id: str, request: Request):
    """Update session metadata (name)."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    body = await request.json()

    if "name" in body:
        SessionStore.update_metadata(session_id, name=body["name"])
    elif "description" in body:
        SessionStore.update_metadata(session_id, name=body["description"])

    updated_meta = SessionStore.load_meta(session_id)
    return {"id": session_id, "meta": updated_meta}


class RenameRequest(BaseModel):
    name: str


@router.post("/api/sessions/{session_id}/rename")
async def rename_session(session_id: str, request: RenameRequest):
    """Rename a session. Sets manual_name flag to prevent summary auto-overwrite."""
    data = SessionStore.load(session_id)
    if not data:
        raise HTTPException(status_code=404, detail="Session not found")

    SessionStore.save(session_id, {
        "name": request.name,
        "manual_name": True,
    })

    return {"success": True, "session_id": session_id, "name": request.name}


# ═══════════════════════════════════════════════════════════════════
# Session Thinking Tokens
# ═══════════════════════════════════════════════════════════════════

def _get_max_thinking_tokens() -> int:
    """Get the max thinking tokens from config or default."""
    config = paths.load_global_config()
    return config.get("max_thinking_tokens", 31999)


@router.get("/api/session/{session_id}/thinking-tokens")
async def get_session_thinking_tokens(session_id: str):
    """Get the max thinking tokens for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    session_tokens = meta.get("max_thinking_tokens")
    global_default = _get_max_thinking_tokens()

    return {
        "max_thinking_tokens": session_tokens if session_tokens is not None else global_default,
        "is_session_override": session_tokens is not None,
        "global_default": global_default,
    }


@router.put("/api/session/{session_id}/thinking-tokens")
async def set_session_thinking_tokens(session_id: str, request: Request):
    """Set the max thinking tokens for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    body = await request.json()
    value = body.get("max_thinking_tokens")

    if value is not None:
        try:
            value = int(value)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="max_thinking_tokens must be an integer or null")

        if value < 0:
            raise HTTPException(status_code=400, detail="max_thinking_tokens cannot be negative")
        if value > 63999:
            raise HTTPException(status_code=400, detail="max_thinking_tokens cannot exceed 63999")

    meta["max_thinking_tokens"] = value
    SessionStore.update_metadata(session_id, max_thinking_tokens=value)

    logger.info(f"Session {session_id} thinking tokens set to: {value}")

    return await get_session_thinking_tokens(session_id)


# ═══════════════════════════════════════════════════════════════════
# Session Permission Level
# ═══════════════════════════════════════════════════════════════════

def _get_default_permission_level() -> str:
    """Get the default permission level from config, falling back to the default
    provider's own default (no hardcoded engine vocabulary)."""
    from painapple_code.providers import get_provider, DEFAULT_PROVIDER
    config = paths.load_global_config()
    return config.get("default_permission_level") or get_provider(DEFAULT_PROVIDER).default_permission_mode()


@router.get("/api/session/{session_id}/permission-mode")
async def get_session_permission_mode(session_id: str, request: Request):
    """Get the permission mode for a specific session, plus the mode vocabulary
    of the engine that session runs on (drives the client's permission picker —
    each provider self-describes its modes, e.g. claude-sdk adds "Ask")."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    session_level = meta.get("permission_level")
    global_default = _get_default_permission_level()

    from painapple_code.providers import get_provider
    from painapple_code.routes.dependencies import effective_default_provider
    provider = (get_provider(meta["provider"]) if meta.get("provider")
                else effective_default_provider(request.app))

    return {
        "permission_level": session_level if session_level is not None else global_default,
        "is_session_override": session_level is not None,
        "global_default": global_default,
        "modes": provider.permission_modes(),
        "provider_default": provider.default_permission_mode(),
    }


@router.put("/api/session/{session_id}/permission-mode")
async def set_session_permission_mode(session_id: str, request: Request):
    """Set the permission mode for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    body = await request.json()
    value = body.get("permission_level")

    from painapple_code.providers import valid_permission_values
    if value is not None and value not in valid_permission_values():
        raise HTTPException(status_code=400, detail=f"Invalid permission level: {value}")

    SessionStore.update_metadata(session_id, permission_level=value)
    logger.info(f"Session {session_id} permission level set to: {value}")

    return await get_session_permission_mode(session_id, request)


# ═══════════════════════════════════════════════════════════════════
# Session Token Profile
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/session/{session_id}/token-profile")
async def get_session_token_profile(session_id: str):
    """Get the token profile for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    from painapple_code.providers import get_provider
    session_profile = meta.get("token_profile")
    # The default shown/used is the SESSION ENGINE's configured profile.
    global_default = paths.engine_default_token_profile(
        get_provider(meta.get("provider")))

    return {
        "token_profile": session_profile if session_profile is not None else global_default,
        "is_session_override": session_profile is not None,
        "global_default": global_default,
    }


@router.put("/api/session/{session_id}/token-profile")
async def set_session_token_profile(session_id: str, request: Request):
    """Set the token profile for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    body = await request.json()
    value = body.get("token_profile")  # string or null

    # Validate profile exists
    if value is not None:
        from painapple_code.utils.token_profiles import list_profiles
        profile_names = {p["name"] for p in list_profiles()}
        if value not in profile_names:
            raise HTTPException(status_code=400, detail=f"Token profile not found: {value}")

    SessionStore.update_metadata(session_id, token_profile=value)

    # Update live session and kill idle process so next turn uses new token
    from painapple_code.server import agents
    if agents:
        live_session = agents.get_session(session_id)
        if live_session:
            live_session.token_profile = value
            if live_session.is_idle and live_session.process:
                live_session._interrupting = True  # suppress session_ended WS msg
                await agents.stop_session(live_session)
                logger.info(f"Killed idle process for session {session_id} (token profile changed)")

    logger.info(f"Session {session_id} token profile set to: {value}")

    return await get_session_token_profile(session_id)


# ═══════════════════════════════════════════════════════════════════
# Session Preferred Model
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/session/{session_id}/model")
async def get_session_model(session_id: str):
    """Get the preferred model for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    from painapple_code.providers import get_provider
    session_model = meta.get("preferred_model")
    # The default shown by the chip is the SESSION ENGINE's configured model
    # (models_key-scoped map, legacy flat key as fallback).
    global_default = paths.engine_default_model(
        get_provider(meta.get("provider")))

    return {
        "preferred_model": session_model if session_model is not None else global_default,
        "is_session_override": session_model is not None,
        "global_default": global_default,
    }


@router.put("/api/session/{session_id}/model")
async def set_session_model(session_id: str, request: Request):
    """Set the preferred model for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    body = await request.json()
    value = body.get("preferred_model")  # string or null

    SessionStore.update_metadata(session_id, preferred_model=value)

    # Update live session and kill idle process so next turn uses new model
    from painapple_code.server import agents
    if agents:
        live_session = agents.get_session(session_id)
        if live_session:
            live_session.preferred_model = value
            if live_session.is_idle and live_session.process:
                live_session._interrupting = True
                await agents.stop_session(live_session)
                logger.info(f"Killed idle process for session {session_id} (model changed to: {value})")

    logger.info(f"Session {session_id} preferred model set to: {value}")

    return await get_session_model(session_id)


# ═══════════════════════════════════════════════════════════════════
# Session Effort Level
# ═══════════════════════════════════════════════════════════════════

VALID_EFFORT_LEVELS = {"low", "medium", "high", "xhigh", "max"}


@router.get("/api/session/{session_id}/effort")
async def get_session_effort(session_id: str):
    """Get the effort level for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    from painapple_code.providers import get_provider
    session_effort = meta.get("effort_level")
    # The default is the SESSION ENGINE's configured effort (vocab-gated).
    global_default = paths.engine_default_effort(
        get_provider(meta.get("provider"))) or "high"

    return {
        "effort_level": session_effort if session_effort is not None else global_default,
        "is_session_override": session_effort is not None,
        "global_default": global_default,
    }


@router.put("/api/session/{session_id}/effort")
async def set_session_effort(session_id: str, request: Request):
    """Set the effort level for a specific session."""
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    body = await request.json()
    value = body.get("effort_level")  # string or null

    if value is not None:
        # Validate against the SESSION ENGINE's own effort vocabulary — Codex
        # speaks a richer scale (xhigh/max/ultra, per its models cache) than the
        # Claude 5-level fallback, so a hardcoded set would reject valid levels.
        from painapple_code.providers import get_provider
        provider = get_provider(meta.get("provider"))
        valid = set(provider.effort_levels() or VALID_EFFORT_LEVELS)
        if value not in valid:
            raise HTTPException(status_code=400, detail=f"Invalid effort level: {value}. Valid: {sorted(valid)}")

    SessionStore.update_metadata(session_id, effort_level=value)

    # Update live session and kill idle process so next turn uses new effort
    from painapple_code.server import agents
    if agents:
        live_session = agents.get_session(session_id)
        if live_session:
            live_session.effort_level = value
            if live_session.is_idle and live_session.process:
                live_session._interrupting = True
                await agents.stop_session(live_session)
                logger.info(f"Killed idle process for session {session_id} (effort changed to: {value})")

    logger.info(f"Session {session_id} effort level set to: {value}")

    return await get_session_effort(session_id)


# ═══════════════════════════════════════════════════════════════════
# Session Fork
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/session/{session_id}/provider")
async def get_session_provider(session_id: str, request: Request):
    """This session's engine + whether it can still be changed.

    `locked` flips permanently once the session has run a turn (or holds an
    upstream provider_session_id) — the conversation lives in that engine's
    own on-disk format and can't transfer."""
    from painapple_code.routes.dependencies import effective_default_provider, provider_is_locked
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")
    configured = meta.get("provider")
    default_name = effective_default_provider(request.app).name
    return {
        "provider": configured or default_name,
        "is_session_override": bool(configured),
        "global_default": default_name,
        "locked": provider_is_locked(meta),
    }


@router.put("/api/session/{session_id}/provider")
async def set_session_provider(session_id: str, request: Request):
    """Switch an EMPTY session to another engine (409 once locked).

    Also hot-swaps a live in-memory session: the provider object and its cost
    state are replaced in place, and an idle warm process (spawned for the old
    engine) is stopped so the next message launches on the new one."""
    from painapple_code.providers import get_provider, provider_names
    from painapple_code.routes.dependencies import provider_is_locked
    meta = SessionStore.load_meta(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    body = await request.json()
    value = body.get("provider")  # string, or null to clear back to default

    if value is not None and value not in provider_names():
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {value}. Valid: {provider_names()}",
        )
    if provider_is_locked(meta):
        raise HTTPException(
            status_code=409,
            detail="Session already ran on its engine — provider is locked. Start a new session to switch.",
        )

    SessionStore.update_metadata(session_id, provider=value)

    # Re-anchor the permission level to the new engine's vocabulary: a level
    # from the old engine (Claude's dontAsk on a switch to Codex, a sandbox
    # tier on the way back) would launch through a silent back-compat mapping
    # the UI can't label. Stamping the new engine's own default keeps meta,
    # UI, and launch agreeing. A level both engines speak survives.
    from painapple_code.routes.dependencies import (
        bind_permission_level,
        preferred_model_survives,
    )
    anchored = bind_permission_level(
        meta.get("permission_level"), get_provider(value))
    if anchored:
        SessionStore.update_metadata(session_id, permission_level=anchored)

    # Same contract for the model pick: a preferred_model from the old
    # engine's catalog (a Claude id on a switch to Codex, a gpt id on the way
    # back) is cleared so the session falls back to the new engine's own
    # default instead of launching a model the engine drops or rejects.
    model_cleared = not preferred_model_survives(
        meta.get("preferred_model"), get_provider(value))
    if model_cleared:
        SessionStore.update_metadata(session_id, preferred_model=None)

    agents = getattr(request.app.state, "agents", None)
    if agents:
        live_session = agents.get_session(session_id)
        if live_session:
            live_session.provider = get_provider(value)
            live_session._cost_state = live_session.provider.new_cost_state()
            # Mirror the anchoring into the in-memory overrides — they win
            # over meta at launch, so a stale old-engine value here would
            # undo the re-stamp above.
            if anchored:
                live_session.permission_mode = anchored
            if model_cleared:
                live_session.preferred_model = None
            if live_session.is_idle and live_session.process:
                live_session._interrupting = True
                await agents.stop_session(live_session)

    return await get_session_provider(session_id, request)


@router.post("/api/session/{session_id}/fork")
async def fork_session(session_id: str, comment_thread: bool = False, thread_anchor: str = None):
    """Fork a session - create a new session that branches from the source."""
    source_meta = SessionStore.load_meta(session_id)
    if not source_meta:
        raise HTTPException(status_code=404, detail="Source session not found")

    provider_session_id = source_meta.get("provider_session_id")
    if not provider_session_id:
        raise HTTPException(
            status_code=400,
            detail="Cannot fork: source session has no Claude conversation"
        )

    # Engines that can't branch a conversation (capabilities.fork=False, e.g.
    # ephemeral `codex exec`) fail loud here rather than minting a fork meta
    # that would error on its first turn.
    from painapple_code.providers import get_provider
    source_provider = get_provider(source_meta.get("provider"))
    if not source_provider.capabilities.fork:
        raise HTTPException(
            status_code=409,
            detail=f"{source_provider.display_name} does not support forking sessions",
        )

    cwd = source_meta.get("cwd", ".")
    source_name = source_meta.get("name", "Session")

    if comment_thread:
        new_name = f"\U0001f4ac Thread from {source_name}"
    else:
        new_name = f"Fork of {source_name}"

    new_session = SessionStore.create(cwd, name=new_name)

    store, meta = SessionStore._find_session(new_session["id"])
    if store and meta:
        meta["forked_from"] = {
            "store_id": session_id,
            "provider_session_id": provider_session_id,
        }
        if comment_thread:
            meta["isCommentThread"] = True
            if thread_anchor:
                try:
                    meta["threadAnchor"] = json.loads(thread_anchor)
                except json.JSONDecodeError:
                    meta["threadAnchor"] = thread_anchor
        # Inherit token_profile from source session
        source_token_profile = source_meta.get("token_profile")
        if source_token_profile:
            meta["token_profile"] = source_token_profile
        # Inherit the source's engine + launch settings so the branch continues
        # on the same provider/model/effort/permissions rather than the app
        # defaults. `provider` is essential for correctness: without it the fork
        # falls back to the default engine (Claude) and can't resume the source's
        # thread — e.g. a Codex thread id handed to Claude resumes nothing and the
        # turn errors. (Native forking only happens within one engine.)
        for key in ("provider", "permission_mode", "model", "effort"):
            val = source_meta.get(key)
            if val is not None:
                meta[key] = val
        store._write_meta(new_session["id"], meta)

    logger.info(f"Created fork session {new_session['id']} from {session_id} (claude: {provider_session_id}, comment_thread={comment_thread})")

    return {
        "id": new_session["id"],
        "cwd": cwd,
        "forked_from": session_id,
        "provider_session_id": provider_session_id,
        "isCommentThread": comment_thread,
    }


# ═══════════════════════════════════════════════════════════════════
# Session Graduate (promote thread to session)
# ═══════════════════════════════════════════════════════════════════

@router.post("/api/session/{session_id}/graduate")
async def graduate_session(session_id: str):
    """Graduate a discussion thread to a full session."""
    store, meta = SessionStore._find_session(session_id)
    if not store or not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    if not meta.get("isCommentThread"):
        raise HTTPException(status_code=400, detail="Session is not a discussion thread")

    if meta.get("graduated"):
        return {
            "id": session_id,
            "graduated": True,
            "graduated_at": meta.get("graduated_at"),
            "already_graduated": True
        }

    graduated_at = datetime.now(timezone.utc).isoformat()

    meta["graduated"] = True
    meta["graduated_at"] = graduated_at

    original_name = meta.get("name", "Thread")
    if original_name.startswith("\U0001f4ac Thread"):
        meta["name"] = original_name.replace("\U0001f4ac Thread", "\U0001f4ac\u2192 Discussion")

    store._write_meta(session_id, meta)

    logger.info(f"Graduated discussion thread {session_id} to full session")

    return {
        "id": session_id,
        "graduated": True,
        "graduated_at": graduated_at,
        "name": meta.get("name"),
        "cwd": meta.get("cwd"),
        "parent_session_id": meta.get("forked_from", {}).get("store_id")
    }


# ═══════════════════════════════════════════════════════════════════
# Session Threads
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/session/{session_id}/threads")
async def get_session_threads(session_id: str):
    """Get all comment threads for a parent session."""
    all_sessions = SessionStore.list_all()
    threads = []

    for session in all_sessions:
        if not session.get("isCommentThread"):
            continue

        forked_from = session.get("forked_from")
        if not forked_from:
            continue

        parent_id = forked_from.get("store_id") if isinstance(forked_from, dict) else forked_from
        if parent_id != session_id:
            continue

        store, _ = SessionStore._find_session(session["id"])
        messages = []
        if store:
            messages_path = store._messages_path(session["id"])
            if messages_path.exists():
                try:
                    with open(messages_path, "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                try:
                                    msg = json.loads(line)
                                    if msg.get("role") in ("user", "assistant"):
                                        messages.append({
                                            "role": msg.get("role"),
                                            "content": msg.get("content", ""),
                                            "timestamp": msg.get("timestamp"),
                                        })
                                except json.JSONDecodeError:
                                    pass
                except Exception as e:
                    logger.warning(f"Error reading thread messages: {e}")

        threads.append({
            "id": session["id"],
            "anchor": session.get("threadAnchor"),
            "status": "resolved" if session.get("resolved") else "active",
            "messages": messages,
            "total_cost": session.get("total_cost", 0),
            "created_at": session.get("created_at"),
            "last_activity": session.get("last_activity"),
        })

    threads.sort(key=lambda t: t.get("created_at", ""), reverse=True)

    return {"threads": threads, "count": len(threads)}
