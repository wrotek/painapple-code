"""
WebSocket /chat endpoint — agent (provider) interaction protocol.

Handles connection setup, session resolution (load existing or create
pending), the per-message-type dispatch (user_message / ping / stop /
clear_session / tool_answer / set_permission_mode), and disconnect
cleanup. Per-message-type handlers are private async helpers in this
module so the route function stays a thin connection lifecycle + dispatch.

Public surface:
- `router` — APIRouter included by `server.py`.
"""

import base64
import json
import logging
import time
import traceback
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from painapple_code import paths
from painapple_code.auth_middleware import (
    _client_identity,
    check_websocket_auth,
    check_websocket_origin,
    record_auth_identity,
)
from painapple_code.providers import get_provider, provider_names
from painapple_code.routes.dependencies import provider_is_locked
from painapple_code.server_logging import log_websocket_event
from painapple_code.session_store import SessionStore
from painapple_code.utils.agent_cli import get_max_thinking_tokens
from painapple_code.utils.file_paths import extract_file_links, safe_resolve

logger = logging.getLogger(__name__)
# Grab the singleton only — setup_logging() in main() attaches the file handler.
# Calling get_access_logger() here would create the log dir + open access.log as
# an import side effect (e.g. on `--help`).
access_logger = logging.getLogger("painapple-code.access")

router = APIRouter(tags=["chat"])


@router.websocket("/chat")
async def websocket_chat(websocket: WebSocket, cwd: str = None, session: str = None,
                         provider: str = None):
    """
    WebSocket endpoint for agent (provider) interaction.

    Sessions are bound to store_id and persist beyond WebSocket connections.
    If you reconnect to a session where the agent is still running, you
    resume receiving output. If the agent finished, it will be restarted.

    Protocol:
    - Client sends: {"type": "user_message", "content": "..."}
    - Server sends: {"type": "agent_message", "data": {...}}
    - Server sends: {"type": "session_ended", "reason": "..."}

    Query params:
    - cwd: Working directory for Claude (used when creating new session)
    - session: Server-side session ID (to join/resume existing session)
    - provider: Provider for a NEW session (picker choice). Ignored on resume —
      a session is bound to its provider at creation (its provider_session_id
      only means anything to that provider). Unknown names fall back to the
      default rather than failing the connect.
    """
    # Read the manager from app.state — `from server import agents` would grab
    # a second copy of the server module where `agents` stays None (server.py
    # runs as __main__, so a `server` re-import re-runs module-level code
    # without main() and never sets it).
    await websocket.accept()
    agents = websocket.app.state.agents

    state = websocket.app.state
    # Origin boundary: WS bypasses CORS, so a cross-origin browser page could
    # otherwise open this socket with the user's ambient cookie.
    if not check_websocket_origin(websocket, getattr(state, "allowed_origins", None)):
        await websocket.close(code=1008, reason="forbidden origin")
        return
    cookie_token = getattr(state, "auth_cookie_token", None)
    api_token = getattr(state, "auth_api_token", None)
    if not cookie_token or not api_token or not check_websocket_auth(websocket, cookie_token, api_token):
        await websocket.close(code=1008, reason="unauthorized")
        return
    record_auth_identity("ws", *_client_identity(websocket.scope))

    # Get client IP for logging
    client_ip = websocket.client.host if websocket.client else "unknown"
    log_websocket_event(access_logger, "CONNECT", session_id=session, client_ip=client_ip)

    # Step 1: Get or create the store (persistent storage)
    # For new sessions, we create metadata but DON'T persist to disk yet.
    # Session is only persisted when first message is sent (avoids empty sessions in history).
    store_data = None
    already_persisted = False
    if session:
        store_data = SessionStore.load(session)
        if not store_data:
            await websocket.send_json({
                "type": "error",
                "message": f"Session not found: {session}"
            })
            await websocket.close()
            return
        resolved_cwd = store_data["cwd"]
        provider_session_id = store_data.get("provider_session_id")
        # Check if this is a forked session that hasn't been started yet
        forked_from = store_data.get("forked_from")
        fork_from_session_id = None
        if forked_from and not provider_session_id:
            # This is a fresh fork - use the source session ID for --fork-session
            # (back-compat: nested forked_from predates the provider_session_id rename)
            fork_from_session_id = forked_from.get("provider_session_id") or forked_from.get("claude_session_id")
            logger.info(f"Session {session} is a fork, will use --fork-session from {fork_from_session_id}")
        # Check if this is a comment thread (skip shadow git)
        is_comment_thread = store_data.get("isCommentThread", False)
        token_profile = store_data.get("token_profile")
        provider_name = store_data.get("provider")  # None → default (Claude)
        already_persisted = True  # Loaded from disk
    else:
        # Create pending session (not persisted to disk yet)
        resolved_cwd = agents.default_cwd
        if cwd:
            resolved_cwd = str(safe_resolve(cwd))
        store_data = SessionStore.create_pending(resolved_cwd)
        provider_session_id = None
        fork_from_session_id = None
        is_comment_thread = False  # New sessions are never comment threads
        token_profile = None  # Set via API before first message
        # Provider selection, most specific wins: the client's picker choice
        # (?provider= on this connect), then the box-wide default
        # (--default-provider flag / `default_provider` config key). The result
        # is recorded in meta so the session stays on that provider across
        # reconnects; when nothing is set, provider_name stays None and the
        # session falls back to DEFAULT_PROVIDER (claude-sdk) at spawn. An
        # unknown picker value degrades to the default flow instead of failing
        # the connect (mirrors get_provider()'s stale-meta tolerance).
        requested_provider = None
        if provider:
            if provider in provider_names():
                requested_provider = provider
            else:
                logger.warning(f"Ignoring unknown provider {provider!r} on session create")
        provider_name = (requested_provider
                         or agents.default_provider
                         or paths.load_global_config().get("default_provider"))
        if provider_name:
            store_data["provider"] = provider_name
            # Bind-time permission anchoring: when the app-wide default level
            # isn't in this provider's vocabulary, stamp the provider's own
            # default so meta, UI, and launch agree from the first frame.
            from painapple_code.routes.dependencies import bind_permission_level
            anchored = bind_permission_level(None, get_provider(provider_name))
            if anchored:
                store_data["permission_level"] = anchored
        already_persisted = False

    store_id = store_data["id"]

    # Step 2: Get or create the runtime session (keyed by store_id)
    existing_session = agents.get_session(store_id)

    # Determine if this is a reconnect:
    # - If session param was provided in URL, user is returning to existing session
    # - OR if session exists in memory registry
    # This handles both page refresh (registry hit) and server restart (URL param)
    is_reconnect = session is not None or existing_session is not None

    if existing_session:
        agent_session = existing_session
        # Attach additively — every connected client receives the broadcast
        # stream. The old takeover (close the previous socket, error toast
        # "Another client connected") silently starved whichever tab/device/
        # token lost the slot: it kept its dead view, missed the turn's result
        # frame, and stayed stuck on "working" with no reason to reconnect.
        agent_session.attach_websocket(websocket)
    else:
        # Create new session (with pending metadata if not persisted)
        agent_session = agents.get_or_create_session(
            store_id=store_id,
            cwd=resolved_cwd,
            store_meta=store_data if not already_persisted else None,
            already_persisted=already_persisted,
            session_id=provider_session_id,
            fork_from_session_id=fork_from_session_id,
            is_comment_thread=is_comment_thread,
            token_profile=token_profile,
            provider_name=provider_name,
        )
        agent_session.attach_websocket(websocket)

    # Persist new sessions to disk immediately on WebSocket connect.
    # This ensures they appear on the welcome screen, survive refreshes,
    # and the browser gets a storeId to save in localStorage.
    if not already_persisted:
        agent_session.ensure_persisted()
        already_persisted = True

    logger.info(f"WebSocket {'reconnected' if is_reconnect else 'connected'}, "
                f"store_id={store_id}, cwd={agent_session.cwd}, "
                f"is_running={agent_session.is_running}, process={agent_session.process is not None}")

    try:
        # Step 3: DON'T start Claude automatically for new sessions
        # Claude starts when the user sends first message.

        # Step 4: Send connection status
        is_actively_processing = agent_session.is_running and not agent_session.is_idle
        if is_reconnect and is_actively_processing:
            status_msg = "Reconnected to running session"
        elif is_reconnect:
            status_msg = "Reconnected to session"
        else:
            status_msg = "Ready"  # New session, Claude will start on first message

        try:
            workspace_path = str(safe_resolve(agents.default_cwd))
        except Exception:
            workspace_path = agents.default_cwd
        # The session's provider identity + capabilities ride the connected
        # payload so the client can badge the tab and gate per-provider chrome
        # (model chip, fork/Discuss, USD cost, /context) without a second
        # round-trip. agent_session.provider is set at runtime-session
        # creation; the get_provider fallback covers the theoretical gap.
        session_provider = agent_session.provider or get_provider(provider_name)
        connected_msg = {
            "type": "connected",
            "message": status_msg,
            "cwd": agent_session.cwd,
            "home": str(Path.home()),
            "workspace": workspace_path,
            "session_id": store_id,
            "is_reconnect": is_reconnect,
            "agent_running": agent_session.is_running and not agent_session.is_idle,
            "is_compacting": agent_session.is_compacting,
            "provider": session_provider.name,
            "provider_display_name": session_provider.display_name,
            "provider_caps": asdict(session_provider.capabilities),
            # Provider still switchable? Locks permanently after the first turn.
            "provider_locked": provider_is_locked(store_data or {}),
        }
        # Include turn start time so client can show accurate elapsed timer on reconnect
        if is_actively_processing and agent_session.turn_tracker and agent_session.turn_tracker.turn_start:
            connected_msg["turn_start"] = agent_session.turn_tracker.turn_start
        if store_data:
            connected_msg["name"] = store_data.get("name")
        await websocket.send_json(connected_msg)

        # Replay any permission ask the provider is still blocked on, so a
        # reconnecting client re-renders the approve/deny card (the original
        # frame died with the previous WebSocket).
        for pending_req in list(agent_session._pending_permission_requests.values()):
            await websocket.send_json({
                "type": "permission_request",
                **{k: v for k, v in pending_req.items() if k != "type"},
                "replay": True,
            })

        # Step 5: Main message loop
        while True:
            try:
                data = await websocket.receive_json()
                msg_type = data.get("type")
                agent_session.touch()  # Update activity timestamp

                if msg_type == "user_message":
                    await _handle_user_message(websocket, agent_session, store_id, data, agents)
                elif msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                elif msg_type == "stop":
                    await _handle_stop(websocket, agent_session, agents)
                elif msg_type == "clear_session":
                    await _handle_clear_session(websocket, agent_session, store_id, agents)
                elif msg_type == "tool_answer":
                    await _handle_tool_answer(websocket, agent_session, store_id, data, agents)
                elif msg_type == "permission_response":
                    await _handle_permission_response(websocket, agent_session, data, agents)
                elif msg_type == "set_permission_mode":
                    await _handle_set_permission_mode(websocket, agent_session, store_id, data, agents)
                else:
                    logger.warning(f"Unknown message type: {msg_type}")

            except json.JSONDecodeError:
                await websocket.send_json({
                    "type": "error",
                    "message": "Invalid JSON"
                })

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for session {store_id}")
        log_websocket_event(access_logger, "DISCONNECT", session_id=store_id, client_ip=client_ip)
    except Exception as e:
        logger.error(f"WebSocket error for session {store_id}: {e}")
        log_websocket_event(access_logger, "ERROR", session_id=store_id, client_ip=client_ip, details=str(e))
        # Log to session's raw.jsonl with full traceback
        if store_id:
            SessionStore.log_raw_error(
                store_id,
                f"server_error: WebSocket handler error: {e}",
                traceback.format_exc()
            )
    finally:
        # Just detach WebSocket - don't stop Claude!
        # Claude will continue running and output will be saved to store.
        # Client can reconnect and resume receiving output.
        # Pass our specific websocket so a takeover's new ws isn't nuked.
        agent_session.detach_websocket(websocket)
        logger.info(f"WebSocket detached from session {store_id}, "
                    f"Claude still running: {agent_session.is_running}")


# ───────────────────────────────────────────────────────────────────────
# Per-message-type handlers
# ───────────────────────────────────────────────────────────────────────

async def _handle_user_message(websocket, agent_session, store_id, data, agents) -> None:
    """Handle a `user_message` from the client.

    Records the prompt in SessionStore + Shadow DB, applies any token-profile
    or model overrides delivered with this turn, ensures Claude is running,
    and forwards the message (text + images) to the subprocess.
    """
    # Lazy imports to keep module-load cheap and avoid pulling DuckDB if
    # the chat WS is never opened.
    from painapple_code.shadow_db import get_shadow_db

    content = data.get("content", "")
    images = data.get("images", [])  # List of image objects from /api/upload-image
    # For storage: use displayContent if provided (original without stash prefix)
    display_content = data.get("displayContent", content)
    stash_refs = data.get("stashRefs")  # Array of stash items for display
    file_paths = data.get("files") or []  # Uploaded file paths attached to this prompt
    plan_mode = data.get("planMode", False)  # True if sent in plan mode
    mark_as_favorite = data.get("markAsFavorite", False)  # Mark prompt as favorite

    # Build message content - can be string or array with text+images
    if images:
        # Multi-part message with images
        message_content = []
        if content:
            message_content.append({"type": "text", "text": content})
        for img in images:
            # img should be the "image" object from upload response
            message_content.append(img)
        agent_msg = {
            "type": "user",
            "message": {
                "role": "user",
                "content": message_content
            }
        }
    else:
        # Simple text message
        agent_msg = {
            "type": "user",
            "message": {
                "role": "user",
                "content": content
            }
        }

    # Save images to disk for persistence
    image_files = []
    if images:
        try:
            uploads_dir = SessionStore.get_uploads_path(store_id)
            for i, img in enumerate(images):
                source = img.get("source", {})
                if source.get("type") == "base64" and source.get("data"):
                    media_type = source.get("media_type", "image/jpeg")
                    ext = "jpg" if "jpeg" in media_type else media_type.split("/")[-1]
                    filename = f"img_{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}.{ext}"
                    img_data = base64.b64decode(source["data"])
                    (uploads_dir / filename).write_bytes(img_data)
                    image_files.append(filename)
        except Exception as e:
            logger.warning(f"Failed to save images for session {store_id}: {e}")

    # Use display_content for storage (original without stash prefix)
    # Get thinking tokens for this session
    session_meta = SessionStore.load_meta(store_id)
    thinking_tokens = None
    if session_meta:
        thinking_tokens = session_meta.get("max_thinking_tokens")
    if thinking_tokens is None:
        thinking_tokens = get_max_thinking_tokens()

    # Extract verified file paths for linkification
    verified_files = {}
    if agent_session.cwd and display_content:
        for link in extract_file_links(display_content, agent_session.cwd):
            verified_files[link['path']] = link['resolved']

    user_msg = {
        "role": "user",
        "content": display_content,
        "has_images": len(images) > 0,
        "image_count": len(images),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "thinking_tokens": thinking_tokens if thinking_tokens > 0 else None,
    }
    if image_files:
        user_msg["image_files"] = image_files
    # Uploaded file attachments. The paths live in the model-facing `content`
    # only; `display_content` is the user's own text, so without this the
    # reloaded bubble would lose the "[N files attached]" indicator that the
    # live one shows.
    if file_paths:
        user_msg["has_files"] = True
        user_msg["file_count"] = len(file_paths)
        user_msg["file_paths"] = file_paths
    if verified_files:
        user_msg["verifiedFiles"] = verified_files
    # Include stash refs if present (for display in message bubble)
    if stash_refs:
        user_msg["hasRefs"] = True
        user_msg["refCount"] = len(stash_refs)
        user_msg["stashRefs"] = stash_refs
    # Include plan mode flag if message was sent in plan mode
    if plan_mode:
        user_msg["planMode"] = True
    line_number = SessionStore.add_message(store_id, user_msg)

    # Broadcast the stored prompt to every attached client. Peer tabs/devices
    # on the same session see it live instead of waiting for their next sync
    # (where the old content-window dedup could swallow it entirely — the
    # missing-second-/compact bug). `line` lets clients derive the stable sid
    # ("{store_id}:{line}", same scheme as promptId/api_logs); the sender's
    # own local copy adopts it idempotently instead of duplicating.
    if line_number > 0:
        await agent_session.safe_send({
            "type": "message_stored",
            "message": user_msg,
            "line": line_number,
        })

    # Construct prompt_id for client-side favorite support
    prompt_id = f"{store_id}:{line_number}" if line_number > 0 else None

    # Mark as favorite if requested
    if mark_as_favorite and prompt_id:
        paths.add_prompt_favorite(
            prompt_id,
            content_preview=display_content[:100] if display_content else ""
        )

    # Send prompt_id back to client for favorite button support
    if prompt_id:
        is_favorite = mark_as_favorite or paths.is_prompt_favorite(prompt_id)
        stored_msg = {
            "type": "user_message_stored",
            "promptId": prompt_id,
            "isFavorite": is_favorite,
        }
        if verified_files:
            stored_msg["verifiedFiles"] = verified_files
        await websocket.send_json(stored_msg)

    # Shadow Git: Set prompt for this turn and reset tracker
    agent_session.turn_tracker.reset()
    agent_session.turn_tracker.set_prompt(content)
    agent_session._ask_tool_id = None  # Reset AskUserQuestion retry suppression

    # Shadow DB: Record turn start (prompt is never lost)
    try:
        if agent_session.cwd:
            db = get_shadow_db()
            # Get git branch cheaply for turn metadata
            git_branch = None
            try:
                import subprocess as _sp
                git_branch = _sp.run(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=agent_session.cwd, capture_output=True,
                    text=True, encoding="utf-8", errors="replace", timeout=2
                ).stdout.strip() or None
            except Exception:
                pass
            db_turn_id = db.start_turn(
                session_id=store_id,
                project_hash=paths.get_project_hash(agent_session.cwd),
                # display_content, NOT `display_content or content`: the two
                # are different KINDS of value — display_content is what the
                # user typed, content is the composed, model-facing text with
                # the stash block prepended. The falsy fallback only ever fired
                # on a stash-only send (typed text empty), which is exactly the
                # case where it swapped in the composed blob — so messages.jsonl
                # recorded "" while this column recorded the full stash text for
                # the same turn. One rule now: user_prompt is what the user
                # typed. The composed text is still preserved in the shadow-git
                # commit body via the turn_tracker.set_prompt(content) above.
                # (An empty user_prompt is already a normal state here — an
                # image-only send has produced one since long before stash.)
                user_prompt=display_content,
                # turn_number moves on finalize, so the turn being opened is
                # the NEXT one (the column sat NULL on every row before this).
                turn_number=agent_session.turn_number + 1,
                has_images=len(images) > 0,
                git_branch=git_branch,
                git_repo_hash=paths.get_git_repo_hash(agent_session.cwd),
                is_plan=plan_mode,
                provider=agent_session.provider.name,
            )
            agent_session.turn_tracker.db_turn_id = db_turn_id
    except Exception as e:
        logger.warning(f"Shadow DB start_turn failed: {e}")

    # Apply token profile from message (sent with every prompt)
    msg_token_profile = data.get("token_profile")  # string or absent
    if msg_token_profile != agent_session.token_profile:
        agent_session.token_profile = msg_token_profile
        SessionStore.update_metadata(store_id, token_profile=msg_token_profile)
        # Kill idle process so start_agent respawns with new token
        # Note: is_idle (not `not is_running`) — is_running stays True while
        # the stream-json process is alive between turns.  is_idle is set
        # by _finalize_turn after each turn completes.
        if agent_session.is_idle and agent_session.process:
            agent_session._interrupting = True  # suppress session_ended WS msg
            await agents.stop_session(agent_session)
            logger.info(f"Killed idle process for {store_id} (token profile changed to: {msg_token_profile})")

    # Apply preferred model from message (sent with every prompt)
    msg_model = data.get("preferred_model")  # string or absent
    if msg_model != agent_session.preferred_model:
        agent_session.preferred_model = msg_model
        SessionStore.update_metadata(store_id, preferred_model=msg_model)
        # Live apply (capabilities.live_controls): switch the warm provider's
        # model in place (None = revert to the CLI/account default). Awaited
        # before send_to_agent below, so this very turn already runs on the
        # new model — and it works mid-turn too, where the old path silently
        # deferred the change to some future respawn. Nack/timeout falls back
        # to the kill+respawn.
        switched_live = False
        if (agent_session.provider.capabilities.live_controls
                and agent_session.process and agent_session.is_running):
            switched_live = await agents.send_control(
                agent_session, "set_model", {"model": msg_model})
            if switched_live:
                logger.info(f"Model live-applied for {store_id}: {msg_model}")
        if not switched_live and agent_session.is_idle and agent_session.process:
            agent_session._interrupting = True
            await agents.stop_session(agent_session)
            logger.info(f"Killed idle process for {store_id} (model changed to: {msg_model})")

    # One-shot effort override (Ctrl+Shift+' on the client): apply for THIS
    # turn only, stash the prior persistent value, and kill the idle process
    # so the respawn picks up the new --effort flag. _finalize_turn restores
    # the prior value and kills again so the next turn reverts. Distinct
    # from preferred_model above: we do NOT persist to meta.
    msg_effort = data.get("effort_level")
    if msg_effort and msg_effort != agent_session.effort_level:
        # Only stash on the first one-shot of a turn — don't overwrite if
        # somehow re-armed mid-turn (shouldn't happen, but be safe).
        if agent_session._oneshot_revert_effort == "_UNSET":
            agent_session._oneshot_revert_effort = agent_session.effort_level
        agent_session.effort_level = msg_effort
        if agent_session.is_idle and agent_session.process:
            agent_session._interrupting = True
            await agents.stop_session(agent_session)
            logger.info(f"Killed idle process for {store_id} (one-shot effort: {msg_effort})")

    # Apply a permission mode forwarded with the message. The picker normally
    # persists via PUT /permission-mode + a set_permission_mode WS message, but a
    # brand-new session has no store_id (and no WS) when the user picks, so that
    # path is skipped and the choice rides along on the first user_message
    # instead. Honour it here so the selected mode survives the first turn rather
    # than falling through to the global default. Stored literally (no
    # bypassPermissions→None collapse) so it sticks for the rest of the session.
    msg_permission_mode = data.get("permission_mode")  # string or absent
    if msg_permission_mode and msg_permission_mode != agent_session.permission_mode:
        agent_session.permission_mode = msg_permission_mode
        SessionStore.update_metadata(store_id, permission_level=msg_permission_mode)
        logger.info(f"Applied permission mode from message for {store_id}: {msg_permission_mode}")

    # Apply permission mode: if it changed since the live process launched, kill
    # the idle process so start_agent (below) respawns with the new mode. A
    # running turn is left alone — the new mode takes effect on the next turn.
    if agent_session.permission_mode != agent_session._launched_permission_mode:
        if agent_session.is_idle and agent_session.process:
            agent_session._interrupting = True
            await agents.stop_session(agent_session)
            logger.info(f"Killed idle process for {store_id} (permission mode changed to: {agent_session.permission_mode})")

    # Ephemeral providers (e.g. Codex) run one subprocess per turn with the
    # prompt in argv — there is no persistent stdin to stream into. Stash the
    # turn's prompt/images for start_agent to embed, then spawn. A fresh spawn
    # also picks up any model/effort/permission change for free, so the lazy
    # "kill idle process" dance above is a no-op for them (process is None
    # between turns).
    if not agent_session.provider.capabilities.persistent_process:
        if agent_session.is_running:
            # One process == one turn; can't inject a prompt mid-turn.
            await websocket.send_json({
                "type": "error",
                "message": f"A {agent_session.provider.display_name} turn is already running"
            })
            return
        agent_session._pending_prompt = content
        agent_session._pending_images = images
        agent_session._last_agent_msg = agent_msg
        if not await agents.start_agent(agent_session):
            await websocket.send_json({
                "type": "error",
                "message": agent_session.start_error
                           or f"Failed to start {agent_session.provider.display_name}"
            })
        return

    # Start Claude if not running (may have finished)
    if not agent_session.is_running:
        if not await agents.start_agent(agent_session):
            await websocket.send_json({
                "type": "error",
                "message": agent_session.start_error or "Failed to start Claude Code"
            })
            return

    # Send user message to Claude
    if not await agents.send_to_agent(agent_session, agent_msg):
        await websocket.send_json({
            "type": "error",
            "message": "Failed to send message to Claude"
        })


async def _handle_stop(websocket, agent_session, agents) -> None:
    """Handle a `stop` request — interrupt Claude if running."""
    if await agents.interrupt_agent(agent_session):
        logger.info("Claude interrupted by user request")
        await websocket.send_json({
            "type": "stopped",
            "message": "Stopped by user"
        })
    else:
        await websocket.send_json({
            "type": "error",
            "message": "Could not interrupt Claude (not running)"
        })


async def _handle_clear_session(websocket, agent_session, store_id, agents) -> None:
    """Handle a `clear_session` request — wipe conversation, restart fresh."""
    logger.info(f"Clearing session: {store_id}")

    # Stop current Claude process
    await agents.stop_session(agent_session)

    # Clear server-side store (removes provider_session_id and messages)
    SessionStore.clear_conversation(store_id)

    # Reset runtime session
    agent_session.session_id = None

    # Restart Claude (will start fresh, no --resume)
    if await agents.start_agent(agent_session):
        await websocket.send_json({
            "type": "session_cleared",
            "message": "Session cleared. Starting fresh conversation."
        })
    else:
        await websocket.send_json({
            "type": "error",
            "message": agent_session.start_error or "Failed to restart Claude after clear"
        })


async def _handle_tool_answer(websocket, agent_session, store_id, data, agents) -> None:
    """Handle a `tool_answer` — user responded to AskUserQuestion via the workaround.

    Headless Claude (`-p` mode) auto-denies AskUserQuestion in every permission
    mode, so we always relay the user's answers as a plain text follow-up
    message rather than injecting a tool_result. The text format mirrors what
    the model would have seen had the tool worked.
    """
    tool_use_id = data.get("tool_use_id")
    answers = data.get("answers", {})
    questions = data.get("questions", [])  # Original questions for context
    # Optional free-text comment the user adds alongside (or instead of) the
    # picked options — relayed to Claude regardless of which options were chosen.
    comment = (data.get("comment") or "").strip()

    if not answers and not comment:
        await websocket.send_json({
            "type": "error",
            "message": "No answers provided"
        })
        return

    # Format answers as readable text message
    answer_lines = []
    for q in questions:
        header = q.get("header", "Question")
        question_text = q.get("question", "")
        answer_value = answers.get(header, "No answer")
        if question_text and question_text != header:
            answer_lines.append(f"**{header}** ({question_text}): {answer_value}")
        else:
            answer_lines.append(f"**{header}**: {answer_value}")

    if not answer_lines and answers:
        answer_lines = [f"**{k}**: {v}" for k, v in answers.items()]

    parts = []
    if answer_lines:
        parts.append("Here are my answers to your questions:\n\n" + "\n".join(answer_lines))
    if comment:
        parts.append(f"Additional comment: {comment}")
    answer_text = "\n\n".join(parts)

    agent_msg = {
        "type": "user",
        "message": {
            "role": "user",
            "content": answer_text
        }
    }
    logger.info(f"Sending question answers as text: {answer_text[:100]}...")

    # Start Claude if not running (auto-denial stops process)
    if not agent_session.is_running:
        if not await agents.start_agent(agent_session):
            await websocket.send_json({
                "type": "error",
                "message": agent_session.start_error or "Failed to start Claude Code"
            })
            return

    # Send to Claude
    if not await agents.send_to_agent(agent_session, agent_msg):
        await websocket.send_json({
            "type": "error",
            "message": "Failed to send answers to Claude"
        })
        return

    # Log to session store
    if store_id:
        SessionStore.add_message(store_id, {
            "role": "user",
            "content": answer_text,
            "is_question_answer": True,
            "tool_use_id": tool_use_id,
            "answers": answers,
            "comment": comment,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })


async def _handle_permission_response(websocket, agent_session, data, agents) -> None:
    """Handle a `permission_response` — the user's allow/deny for an
    interactive permission ask (capabilities.interactive_permissions).

    Relays the decision to the provider process, which is blocked in its
    `can_use_tool` callback. A False return means the request expired (the
    process restarted or died) — tell the client so it retires the card.
    """
    ok = await agents.respond_permission(agent_session, data)
    # Broadcast (not just to the answering socket): with multi-client attach,
    # every peer tab shows the same pending card — all of them must retire it
    # when any one client answers.
    resolved = {
        "type": "permission_resolved",
        "request_id": data.get("request_id"),
        "behavior": data.get("behavior"),
        "ok": ok,
    }
    if not await agent_session.safe_send(resolved):
        await websocket.send_json(resolved)


async def _handle_set_permission_mode(websocket, agent_session, store_id, data, agents) -> None:
    """Handle a `set_permission_mode` request — record the mode and apply it.

    Records the desired mode and echoes it to the client (so the permission
    button updates immediately). Providers with `capabilities.live_controls`
    (claude-sdk) get the mode applied to the *running* provider in place — even
    mid-turn — via a control frame; the reply carries `applied: "live"`. All
    other cases keep the lazy path: `_handle_user_message` respawns the idle
    process on the next message when the mode differs from what it launched
    with (the same universal path used for token-profile / model changes),
    and the reply says `applied: "next_turn"`.
    """
    mode = data.get("mode")  # a Claude mode, a provider-native mode (e.g. Codex
    # workspace-write), or None. Validated against the registry so the active
    # session's provider vocabulary is accepted, not just Claude's.
    from painapple_code.providers import valid_permission_values
    valid_modes = valid_permission_values() | {None}
    if mode not in valid_modes:
        await websocket.send_json({
            "type": "error",
            "message": f"Invalid permission mode: {mode}. Valid: {valid_modes}"
        })
        return

    logger.info(f"Setting permission mode to: {mode} for session {store_id}")

    # Set desired permission mode (None = use bypassPermissions default)
    agent_session.permission_mode = mode if mode != "bypassPermissions" else None

    # Arm the plan-approval SIGINT gate when entering plan mode; disarm otherwise.
    # Without this, ExitPlanMode would never trigger an approval card (or would
    # trigger one stale after the user left plan mode for another mode).
    agent_session._plan_sigint_armed = (mode == "plan")

    # Live apply (capabilities.live_controls): switch the running provider in
    # place — even mid-turn — instead of waiting for the lazy respawn. The
    # launched-mode bookkeeping is updated ONLY on ack, so a failed control
    # leaves the lazy check armed and the next message respawns exactly as
    # before. Guard: a process launched in bypassPermissions has no
    # can_use_tool gate attached (claude_sdk/driver.py) — a live switch out
    # of bypass would leave an ask-capable mode with nothing to answer
    # prompts, so that direction must take the respawn path.
    applied = "next_turn"
    if (agent_session.provider
            and agent_session.provider.capabilities.live_controls
            and agent_session.process and agent_session.is_running
            and agent_session._launched_resolved_mode != "bypassPermissions"):
        target = mode or "bypassPermissions"
        if await agents.send_control(agent_session, "set_permission_mode",
                                     {"mode": target}):
            # Only the desired-mode snapshot moves; _launched_resolved_mode
            # stays at the launch value — gate attachment is a spawn-time
            # property, so a live switch INTO bypass must not block a later
            # live switch back out (the gate is still attached).
            agent_session._launched_permission_mode = agent_session.permission_mode
            applied = "live"
            logger.info(f"Permission mode live-applied for {store_id}: {target}")

    # Notify client of mode change (updates the permission button immediately)
    await websocket.send_json({
        "type": "permission_mode_changed",
        "mode": mode or "bypassPermissions",
        "applied": applied,
        "message": f"Permission mode set to: {mode or 'bypassPermissions'}"
    })
