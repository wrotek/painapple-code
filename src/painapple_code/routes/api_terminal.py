"""
Terminal API Routes - PTY terminal WebSocket and management

These endpoints provide:
- Interactive PTY terminal via WebSocket
- Terminal session management (list, kill)
- Active Claude session listing
- Claude subprocess instance tracking
"""

import asyncio
import errno
import fcntl
import json
import logging
import os
import pty
import re
import select
import signal
import struct
import termios
import time

from painapple_code.utils.proc import pid_alive
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException

from painapple_code.auth_middleware import check_websocket_auth, check_websocket_origin
from painapple_code.session_store import SessionStore
from painapple_code.subprocess_registry import agent_subprocesses

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


def set_terminal_size(fd: int, rows: int, cols: int):
    """Set the terminal size using ioctl."""
    size = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)


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
    password = getattr(state, "auth_password", None)
    cookie_token = getattr(state, "auth_cookie_token", None)
    if not password or not cookie_token or not check_websocket_auth(websocket, password, cookie_token):
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
        resolved_cwd = str(Path(cwd).expanduser().resolve())

    if not resolved_cwd:
        # Fall back to the bridge's --workspace (stashed on app.state by main()).
        # `from server import bridge` looks at a different module instance than
        # the running __main__, so bridge is None there — Path.home() inside
        # Docker is /home/app which is not the project base the user wants.
        ws = getattr(state, "workspace", None)
        if ws:
            try:
                resolved_cwd = str(Path(ws).expanduser().resolve())
            except Exception:
                resolved_cwd = ws
        else:
            resolved_cwd = str(Path.home())

    logger.info(f"Terminal WebSocket connected: session={session_id}, cwd={resolved_cwd}")

    # Check if we have an existing terminal session
    term_session = terminal_sessions.get(session_id)

    if term_session:
        master_fd = term_session["master_fd"]
        pid = term_session["pid"]

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
            try:
                os.close(master_fd)
            except OSError:
                pass
            del terminal_sessions[session_id]
            term_session = None

    if not term_session:
        master_fd, slave_fd = pty.openpty()

        set_terminal_size(master_fd, 24, 80)

        pid = os.fork()

        if pid == 0:
            # Child process
            os.close(master_fd)
            os.setsid()

            try:
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            except (OSError, AttributeError):
                pass

            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)

            if slave_fd > 2:
                os.close(slave_fd)

            try:
                os.chdir(resolved_cwd)
            except OSError:
                pass

            os.environ['TERM'] = 'xterm-256color'
            os.environ['COLORTERM'] = 'truecolor'

            shell = os.environ.get('SHELL', '/bin/bash')
            os.execvp(shell, [shell, '-i'])

        # Parent process
        os.close(slave_fd)

        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        term_session = {
            "master_fd": master_fd,
            "pid": pid,
            "cwd": resolved_cwd,
            "active": True,
            "scrollback": bytearray(),
        }
        terminal_sessions[session_id] = term_session

        logger.info(f"Created new terminal: pid={pid}, cwd={resolved_cwd}")

    master_fd = term_session["master_fd"]
    pid = term_session["pid"]
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
                try:
                    result_pid, status = os.waitpid(pid, os.WNOHANG)
                    if result_pid == pid:
                        if os.WIFEXITED(status):
                            exit_code = os.WEXITSTATUS(status)
                        elif os.WIFSIGNALED(status):
                            exit_code = -os.WTERMSIG(status)
                        else:
                            exit_code = -1
                        break
                except ChildProcessError:
                    exit_code = 0
                    break

                try:
                    readable, _, _ = await loop.run_in_executor(
                        None, lambda: select.select([master_fd], [], [], 0.1)
                    )

                    if master_fd in readable:
                        data = os.read(master_fd, 4096)
                        if not data:
                            try:
                                _, status = os.waitpid(pid, 0)
                                if os.WIFEXITED(status):
                                    exit_code = os.WEXITSTATUS(status)
                                else:
                                    exit_code = -1
                            except ChildProcessError:
                                exit_code = 0
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
                except OSError as e:
                    if e.errno == errno.EIO:
                        try:
                            _, status = os.waitpid(pid, 0)
                            if os.WIFEXITED(status):
                                exit_code = os.WEXITSTATUS(status)
                            else:
                                exit_code = -1
                        except ChildProcessError:
                            exit_code = 0
                        break
                    raise
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
                try:
                    os.close(master_fd)
                except OSError:
                    pass
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
                                set_terminal_size(master_fd, rows, cols)
                                os.kill(pid, signal.SIGWINCH)
                                continue

                            if msg_type == "ping":
                                await websocket.send_json({"type": "pong"})
                                continue

                        except json.JSONDecodeError:
                            pass

                    try:
                        os.write(master_fd, text.encode('utf-8'))
                    except OSError as e:
                        if e.errno == errno.EIO:
                            break
                        raise

                elif "bytes" in data:
                    try:
                        os.write(master_fd, data["bytes"])
                    except OSError:
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

    pid = term_session.get("pid")
    master_fd = term_session.get("master_fd")

    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
            await asyncio.sleep(0.5)
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        except OSError:
            pass

    if master_fd:
        try:
            os.close(master_fd)
        except OSError:
            pass

    del terminal_sessions[session_id]
    logger.info(f"Killed terminal session: {session_id}")

    return {"killed": True, "session": session_id}


@router.get("/api/terminal-cwd")
async def get_terminal_cwd(session: str):
    """Live working directory of a terminal's shell process.

    Reads /proc/<pid>/cwd so the result tracks the user's `cd`s in real
    time; falls back to the spawn cwd where /proc isn't available (macOS)
    or the shell has exited. Query param instead of a path param because
    terminal session IDs contain slashes (`session:<id>:/path/to/cwd`).
    """
    term_session = terminal_sessions.get(session)
    if not term_session:
        raise HTTPException(status_code=404, detail="Terminal session not found")

    pid = term_session.get("pid")
    live_cwd = None
    if pid:
        try:
            live_cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            pass

    return {"cwd": live_cwd or term_session.get("cwd"), "live": bool(live_cwd)}


@router.get("/api/terminals")
async def list_terminals():
    """List active terminal sessions."""
    result = []
    for session_id, term in terminal_sessions.items():
        pid = term.get("pid")
        alive = pid_alive(pid) if pid else False

        result.append({
            "session": session_id,
            "pid": pid,
            "cwd": term.get("cwd"),
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
