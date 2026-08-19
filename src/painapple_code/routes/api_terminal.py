"""
Terminal API Routes - PTY terminal WebSocket and management

These endpoints provide:
- Interactive PTY terminal via WebSocket
- Terminal session management (list, kill)
- Active Claude session listing
- Claude subprocess instance tracking
"""

import asyncio
import json
import logging
import re
import time

from painapple_code.utils.proc import pid_alive
from painapple_code.utils.pty_backend import spawn_pty
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException

from painapple_code.auth_middleware import check_websocket_auth, check_websocket_origin
from painapple_code.session_store import SessionStore
from painapple_code.subprocess_registry import agent_subprocesses
from painapple_code.utils.file_paths import safe_resolve

logger = logging.getLogger(__name__)

router = APIRouter(tags=["terminal"])

# Store active terminal sessions (keyed by session_id)
terminal_sessions: dict[str, dict] = {}

# Maximum scrollback buffer size per terminal (in bytes)
TERMINAL_SCROLLBACK_SIZE = 100 * 1024  # 100KB

# OSC 52 is the clipboard-write sequence (ESC ] 52 ; Ps ; Pt ST) that lets a
# program inside the terminal — vim's `y`, tmux — put text on the user's
# system clipboard. It is passed through untouched on the LIVE stream; that
# is the feature (see static/js/widgets/terminal/osc52.js).
#
# It must never survive into a scrollback REPLAY. The ring below is re-sent
# verbatim on every (re)connect, and iPad PWAs reconnect constantly after
# suspend — so without this, a yank from an hour ago would silently re-hijack
# the clipboard every time the tab woke up.
#
# Both terminators are matched (BEL and ESC \). The payload is base64 plus
# ';' plus Ps, so it can contain neither, which also keeps this bounded.
_OSC52_RE = re.compile(rb'\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)')


@router.websocket("/ws/terminal")
async def terminal_websocket(websocket: WebSocket, session: str = None, cwd: str = None):
    """
    WebSocket endpoint for interactive terminal (PTY).

    Each session gets its own persistent terminal that survives disconnects.
    """
    await websocket.accept()

    state = websocket.app.state
    if not check_websocket_origin(websocket, getattr(state, "allowed_origins", None)):
        await websocket.close(code=1008, reason="forbidden origin")
        return
    cookie_token = getattr(state, "auth_cookie_token", None)
    api_token = getattr(state, "auth_api_token", None)
    if not cookie_token or not api_token or not check_websocket_auth(websocket, cookie_token, api_token):
        await websocket.close(code=1008, reason="unauthorized")
        return

    session_id = session or "default"

    # Get CWD from session store if available
    resolved_cwd = None
    if session:
        store_data = SessionStore.load(session)
        if store_data:
            resolved_cwd = store_data.get("cwd")

    if not resolved_cwd and cwd:
        resolved_cwd = str(safe_resolve(cwd))

    if not resolved_cwd:
        # Fall back to the bridge's --workspace (stashed on app.state by main()).
        # `from server import bridge` looks at a different module instance than
        # the running __main__, so bridge is None there — Path.home() inside
        # Docker is /home/app which is not the project base the user wants.
        ws = getattr(state, "workspace", None)
        if ws:
            try:
                resolved_cwd = str(safe_resolve(ws))
            except Exception:
                resolved_cwd = ws
        else:
            resolved_cwd = str(Path.home())

    logger.info(f"Terminal WebSocket connected: session={session_id}, cwd={resolved_cwd}")

    # Check if we have an existing terminal session
    term_session = terminal_sessions.get(session_id)

    if term_session:
        term = term_session["pty"]
        pid = term.pid

        try:
            if not pid_alive(pid):
                raise ProcessLookupError(f"terminal pid {pid} gone")
            was_inactive = not term_session.get("active")
            logger.info(f"Reconnecting to existing terminal: pid={pid}, was_inactive={was_inactive}")

            old_read_task = term_session.get("read_task")
            old_heartbeat_task = term_session.get("heartbeat_task")
            if old_read_task and not old_read_task.done():
                old_read_task.cancel()
                try:
                    await old_read_task
                except asyncio.CancelledError:
                    pass
            if old_heartbeat_task and not old_heartbeat_task.done():
                old_heartbeat_task.cancel()
                try:
                    await old_heartbeat_task
                except asyncio.CancelledError:
                    pass

            term_session["active"] = True
        except OSError:
            logger.info(f"Terminal process {pid} died, creating new one")
            term.close()
            del terminal_sessions[session_id]
            term_session = None

    if not term_session:
        term = spawn_pty(resolved_cwd, rows=24, cols=80)

        term_session = {
            "pty": term,
            "cwd": resolved_cwd,
            "active": True,
            "scrollback": bytearray(),
        }
        terminal_sessions[session_id] = term_session

        logger.info(f"Created new terminal: pid={term.pid}, cwd={resolved_cwd}")

    term = term_session["pty"]
    pid = term.pid
    scrollback = term_session.get("scrollback", bytearray())

    await websocket.send_json({
        "type": "connected",
        "session": session_id,
        "cwd": resolved_cwd,
        "home": str(Path.home()),
        "pid": pid,
        "has_scrollback": len(scrollback) > 0,
    })

    if scrollback:
        try:
            replay = _OSC52_RE.sub(b'', bytes(scrollback))
            await websocket.send_text(replay.decode('utf-8', errors='replace'))
            logger.info(f"Replayed {len(replay)} bytes of scrollback for session {session_id}")
        except Exception as e:
            logger.error(f"Failed to replay scrollback: {e}")

    async def read_pty():
        loop = asyncio.get_event_loop()
        exit_code = None
        ws_disconnected = False
        try:
            while True:
                # Reap first: a shell that exits without closing the pty
                # (or was killed) is noticed here rather than hanging the
                # loop on a read that will never return.
                exit_code = term.poll()
                if exit_code is not None:
                    break

                # Backend contract: None = nothing yet, b"" = pty closed.
                # The blocking wait (select on POSIX, queue on Windows)
                # runs off-loop so the event loop stays responsive.
                data = await loop.run_in_executor(None, term.read, 0.1)
                if data is None:
                    continue
                if data == b"":
                    # Give the child a moment to be reapable, then take
                    # whatever poll() reports (0 if it was already reaped).
                    exit_code = term.poll()
                    if exit_code is None:
                        await asyncio.sleep(0.05)
                        exit_code = term.poll()
                    if exit_code is None:
                        exit_code = -1
                    break

                scrollback.extend(data)
                if len(scrollback) > TERMINAL_SCROLLBACK_SIZE:
                    scrollback[:] = scrollback[-TERMINAL_SCROLLBACK_SIZE:]
                try:
                    await websocket.send_text(data.decode('utf-8', errors='replace'))
                except Exception as ws_err:
                    logger.info(f"Terminal WebSocket disconnected (session={session_id}): {ws_err}")
                    ws_disconnected = True
                    break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"PTY read error: {e}")
            ws_disconnected = True

        if exit_code is not None:
            try:
                await websocket.send_json({"type": "exit", "code": exit_code})
                logger.info(f"Terminal exited: session={session_id}, code={exit_code}")
            except Exception:
                pass
            if session_id in terminal_sessions:
                term_session["active"] = False
                term.close()
                del terminal_sessions[session_id]
        elif ws_disconnected:
            logger.info(f"Terminal WebSocket gone, PTY kept alive for reconnect: session={session_id}, pid={pid}")
            if session_id in terminal_sessions:
                term_session["active"] = False

    read_task = asyncio.create_task(read_pty())

    async def heartbeat():
        # 5s cadence so iOS half-dead WebSockets are detected within ~5s
        # on resume, instead of the previous 30s window where the terminal
        # appeared frozen until the next ping failed.
        try:
            while True:
                await asyncio.sleep(5)
                try:
                    await websocket.send_json({"type": "heartbeat"})
                except Exception:
                    logger.info(f"Terminal heartbeat failed, WebSocket dead: session={session_id}")
                    break
        except asyncio.CancelledError:
            pass

    heartbeat_task = asyncio.create_task(heartbeat())

    term_session["read_task"] = read_task
    term_session["heartbeat_task"] = heartbeat_task

    try:
        while True:
            data = await websocket.receive()

            if data["type"] == "websocket.disconnect":
                break

            if data["type"] == "websocket.receive":
                if "text" in data:
                    text = data["text"]

                    if text.startswith("{"):
                        try:
                            msg = json.loads(text)
                            msg_type = msg.get("type")

                            if msg_type == "resize":
                                rows = msg.get("rows", 24)
                                cols = msg.get("cols", 80)
                                try:
                                    term.set_size(rows, cols)
                                except (OSError, ValueError) as e:
                                    logger.debug(f"Terminal resize failed: {e}")
                                continue

                            if msg_type == "ping":
                                await websocket.send_json({"type": "pong"})
                                continue

                        except json.JSONDecodeError:
                            pass

                    try:
                        term.write(text.encode('utf-8'))
                    except EOFError:
                        break

                elif "bytes" in data:
                    try:
                        term.write(data["bytes"])
                    except (EOFError, OSError):
                        break

    except WebSocketDisconnect:
        logger.info(f"Terminal WebSocket disconnected: session={session_id}")
    except Exception as e:
        logger.error(f"Terminal WebSocket error: {e}")
    finally:
        read_task.cancel()
        heartbeat_task.cancel()
        try:
            await read_task
        except asyncio.CancelledError:
            pass
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass

        logger.info(f"Terminal WebSocket closed, process {pid} still running")


@router.delete("/api/terminal/{session_id:path}")
async def kill_terminal(session_id: str):
    """Kill a terminal session."""
    term_session = terminal_sessions.get(session_id)
    if not term_session:
        raise HTTPException(status_code=404, detail="Terminal session not found")

    term = term_session.get("pty")

    if term:
        term.terminate()
        await asyncio.sleep(0.5)
        term.terminate(force=True)
        term.close()

    del terminal_sessions[session_id]
    logger.info(f"Killed terminal session: {session_id}")

    return {"killed": True, "session": session_id}


@router.get("/api/terminal-cwd")
async def get_terminal_cwd(session: str):
    """Live working directory of a terminal's shell process.

    Asks the backend where the shell process actually is, so the result
    tracks the user's `cd`s in real time; falls back to the spawn cwd
    where that isn't available (macOS has no /proc, the shell exited,
    or — on Windows — PowerShell's `cd` moves only its provider location
    and never the process CWD). Query param instead of a path param
    because terminal session IDs contain slashes
    (`session:<id>:/path/to/cwd`).
    """
    term_session = terminal_sessions.get(session)
    if not term_session:
        raise HTTPException(status_code=404, detail="Terminal session not found")

    term = term_session.get("pty")
    live_cwd = term.live_cwd() if term else None

    return {"cwd": live_cwd or term_session.get("cwd"), "live": bool(live_cwd)}


@router.get("/api/terminals")
async def list_terminals():
    """List active terminal sessions."""
    result = []
    for session_id, term_session in terminal_sessions.items():
        term = term_session.get("pty")
        pid = term.pid if term else None
        alive = pid_alive(pid) if pid else False

        result.append({
            "session": session_id,
            "pid": pid,
            "cwd": term_session.get("cwd"),
            "alive": alive,
        })
    return {"terminals": result}


# ═══════════════════════════════════════════════════════════════════
# Active Sessions
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/active-sessions")
async def list_active_sessions():
    """List all currently running Claude sessions with real-time status.

    Also includes recent stored sessions (not yet connected to this server
    instance) so the widget isn't empty after a server restart.
    """
    from painapple_code.server import bridge

    result = []
    now = time.time()
    live_store_ids = set()

    if not bridge:
        bridge_sessions = {}
    else:
        bridge_sessions = bridge.sessions

    for store_id, session in bridge_sessions.items():
        live_store_ids.add(store_id)

        # Validate process state
        if session.is_running:
            process_alive = bool(session.process) and pid_alive(session.process.pid)

            if not process_alive:
                logger.warning(
                    f"Session {store_id} has stale is_running=True but process is dead, fixing"
                )
                session.is_running = False
                session.process = None

        session_info = {
            "store_id": store_id,
            "cwd": session.cwd,
            "is_running": session.is_running,
            "is_idle": session.is_idle,
            "has_websocket": session.ws_connected,
            "created_at": datetime.fromtimestamp(session.created_at).isoformat() + "Z",
            "last_activity": datetime.fromtimestamp(session.last_activity).isoformat() + "Z",
            "idle_seconds": int(now - session.last_activity),
            "turn_number": session.turn_number,
            "process_pid": None,
            "provider_session_id": session.session_id,
        }

        if session.process and session.is_running:
            session_info["process_pid"] = session.process.pid

        if session.is_running:
            if session.is_idle:
                session_info["status"] = "idle"
            elif session.in_thinking_mode:
                session_info["status"] = "thinking"
            elif session.active_tasks:
                task_names = [t.description for t in session.active_tasks.values() if t.description]
                session_info["status"] = "tasks"
                session_info["active_tasks"] = task_names[:3]
            elif session.turn_tracker and session.turn_tracker.has_activity:
                session_info["status"] = "tools"
            else:
                session_info["status"] = "streaming"
        elif session.is_compacting:
            session_info["status"] = "compacting"
        else:
            session_info["status"] = "idle"

        if session.turn_tracker:
            tracker = session.turn_tracker
            session_info["current_turn"] = {
                "has_activity": tracker.has_activity,
                "tool_count": len(tracker.tools_used),
                "tools_summary": tracker.get_tools_summary(),
                "modified_files": len(tracker.modified_files),
                "prompt_preview": tracker.user_prompt[:80] if tracker.user_prompt else None,
            }

        meta = SessionStore.load_meta(store_id)
        if meta:
            session_info["name"] = meta.get("name")
            session_info["model"] = meta.get("model")
            session_info["total_cost"] = meta.get("total_cost", 0)
            session_info["message_count"] = meta.get("message_count", 0)

        result.append(session_info)

    # Supplement with recent stored sessions not in bridge.sessions.
    # This makes the widget useful after server restarts, showing recent
    # sessions as "disconnected" until the browser reconnects.
    try:
        all_stored = SessionStore.list_all()
        for stored in all_stored[:20]:  # Check top 20 most recent
            sid = stored.get("id", "")
            if sid in live_store_ids:
                continue
            # Only include sessions active in last 24h
            last_act = stored.get("last_activity", "")
            if not last_act:
                continue
            try:
                from datetime import timezone
                act_dt = datetime.fromisoformat(last_act.replace("Z", "+00:00"))
                age_seconds = (datetime.now(timezone.utc) - act_dt).total_seconds()
                if age_seconds > 86400:  # Skip sessions older than 24h
                    continue
            except (ValueError, TypeError):
                continue

            result.append({
                "store_id": sid,
                "cwd": stored.get("cwd", ""),
                "is_running": False,
                "is_idle": True,
                "has_websocket": False,
                "created_at": stored.get("created_at", ""),
                "last_activity": last_act,
                "idle_seconds": int(age_seconds),
                "turn_number": 0,
                "process_pid": None,
                "provider_session_id": stored.get("provider_session_id"),
                "status": "disconnected",
                "name": stored.get("name"),
                "model": stored.get("model"),
                "total_cost": stored.get("total_cost", 0),
                "message_count": stored.get("message_count", 0),
            })
    except Exception as e:
        logger.debug(f"Failed to load stored sessions for active-sessions: {e}")

    result.sort(key=lambda s: (
        0 if s["is_running"] else (1 if s["status"] != "disconnected" else 2),
        # For live sessions: most recently active first (-idle → ascending)
        # For disconnected/stored: same (most recent first)
        s.get("idle_seconds", 0)
    ))

    running_count = sum(1 for s in result if s["is_running"] and not s.get("is_idle", True))

    agent_subprocesses.prune_dead_processes()
    subprocess_data = agent_subprocesses.to_api_response()

    return {
        "sessions": result,
        "count": len(result),
        "running_count": running_count,
        "agent_instances": subprocess_data["instances"],
        "agent_instances_count": subprocess_data["count"],
        "agent_instances_by_type": subprocess_data["by_type"],
    }


@router.get("/api/agent-instances")
async def get_agent_instances():
    """Get full Claude subprocess data including history and statistics."""
    agent_subprocesses.prune_dead_processes()
    return agent_subprocesses.to_full_api_response()
