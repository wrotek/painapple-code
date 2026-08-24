"""Codex app-server provider — the bidirectional JSON-RPC transport driver.

The session layer's stdin/stdout *line* protocol can't express the app-server
conversation: a turn is a multi-step handshake (`initialize` → `thread/start`|
`thread/resume` → `turn/start`) with id-correlated responses and server-initiated
requests. This driver owns that side. The session layer:

  * calls `initialize()` once after spawning the process,
  * routes every parsed stdout line through `intake()` first (which resolves our
    pending responses and answers server requests, returning False to swallow
    them — notifications return True and flow on to `translate_events`),
  * calls `send_turn(message)` to send one user turn, and
  * calls `interrupt()` to abort the in-flight turn.

It is deliberately pure plumbing: all Codex-specific param shaping lives on the
provider (`launch.py`), reached here via `self.provider`.
"""

from __future__ import annotations

import asyncio
import json
import logging

from painapple_code.session_store import SessionStore

logger = logging.getLogger("painapple_code")

# Default per-request timeout. The handshake and thread/turn acks return
# promptly; a turn's *content* streams as separate notifications, so awaiting an
# ack never blocks for the length of a turn.
_REQUEST_TIMEOUT = 60.0

# Defensive deny decisions, keyed by server-request method → the value for that
# request's `decision` field. Under `approvalPolicy="never"` (P1) the server
# resolves approvals itself and these never fire; if one arrives anyway we deny
# rather than silently auto-run something. Interactive approvals are a later
# phase that will replace this with a real UI round-trip.
_APPROVAL_DENY = {
    "execCommandApproval": {"decision": "denied"},
    "applyPatchApproval": {"decision": "denied"},
    "item/commandExecution/requestApproval": {"decision": "decline"},
    "item/fileChange/requestApproval": {"decision": "decline"},
}


def _client_version() -> str:
    try:
        from painapple_code import __version__
        return str(__version__)
    except Exception:
        return "0.0.0"


class JsonRpcTransport:
    """Drives one `codex app-server` process over JSON-RPC for one session."""

    def __init__(self, process, opts, session, provider):
        self.process = process
        self.opts = opts            # resolved LaunchOptions for this launch
        self.session = session      # owning AgentSession (cwd, session_id, store)
        self.provider = provider    # for param shaping (thread/turn_start_params)
        self._id = 0
        self._pending: dict = {}    # request id → Future awaiting its response
        self._initialized = False
        self._thread_id = None      # codex thread id (== session.session_id)
        self._active_turn_id = None  # in-flight turn id (turn/interrupt needs it)
        self._send_lock = asyncio.Lock()  # serialize handshake/thread/turn sends

    # --- low-level JSON-RPC I/O ------------------------------------------

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    async def _write(self, obj: dict) -> None:
        line = json.dumps(obj)
        self.process.stdin.write((line + "\n").encode("utf-8"))
        await self.process.stdin.drain()
        if self.session.store_id:
            SessionStore.log_raw(self.session.store_id, "in", line, obj)

    async def _request(self, method: str, params: dict, timeout: float = _REQUEST_TIMEOUT):
        """Send a request and await its response (resolved by `intake`)."""
        rid = self._next_id()
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending[rid] = fut
        await self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    async def _notify(self, method: str, params: dict | None = None) -> None:
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        await self._write(msg)

    # --- session-layer hooks ---------------------------------------------

    def intake(self, native: dict) -> bool:
        """Classify one inbound message. Returns False to swallow it.

        Response → resolve the matching future. Server-initiated request →
        answer it (scheduled, since the reply is async). Notification → True so
        the reader translates it into canonical events.
        """
        has_id = native.get("id") is not None
        has_method = "method" in native

        if has_id and has_method:           # server → client request
            asyncio.create_task(self._answer_server_request(native))
            return False
        if has_id and not has_method:        # response to one of our requests
            fut = self._pending.get(native["id"])
            if fut is not None and not fut.done():
                if "error" in native and native["error"] is not None:
                    fut.set_exception(RuntimeError(str(native["error"])))
                else:
                    fut.set_result(native.get("result"))
            return False
        # Notification — peek turn lifecycle for interrupt bookkeeping before
        # passing it on: `turn/interrupt` requires the ACTIVE turn's id
        # (`turnId` became a required field in codex 0.144), so track it from
        # turn/started and drop it once the turn settles (failed turns also
        # arrive as turn/completed with status="failed").
        method = native.get("method")
        if method == "turn/started":
            turn = (native.get("params") or {}).get("turn") or {}
            if turn.get("id"):
                self._active_turn_id = turn["id"]
        elif method == "turn/completed":
            self._active_turn_id = None
        return True                          # notification → translate

    async def initialize(self) -> None:
        """Run the `initialize` → `initialized` handshake (idempotent)."""
        if self._initialized:
            return
        try:
            await self._request("initialize", {
                "clientInfo": {"name": "painapple-code", "version": _client_version()},
            })
            await self._notify("initialized")
            self._initialized = True
        except Exception as e:
            logger.error(f"codex app-server initialize failed: {e}")
            raise

    async def send_turn(self, message: dict) -> bool:
        """Send one user turn — lazy thread start/resume, then `turn/start`."""
        async with self._send_lock:
            if not self._initialized:
                await self.initialize()
            if self._thread_id is None:
                await self._ensure_thread()
            input_items = self.provider.build_turn_input(message)
            params = self.provider.turn_start_params(self.opts, self._thread_id, input_items)
            res = await self._request("turn/start", params)
            # The ack echoes the created Turn (status=inProgress) — capture its
            # id immediately so an instant stop doesn't race the turn/started
            # notification (turn/interrupt requires turnId since codex 0.144).
            turn = res.get("turn") if isinstance(res, dict) else None
            if isinstance(turn, dict) and turn.get("id"):
                self._active_turn_id = turn["id"]
        return True

    async def interrupt(self) -> None:
        """Abort the in-flight turn, leaving the process alive for the next one."""
        if self._thread_id:
            params = {"threadId": self._thread_id}
            if self._active_turn_id:
                # Required field on codex ≥0.144; older servers ignore extras.
                params["turnId"] = self._active_turn_id
            try:
                await self._request("turn/interrupt", params, timeout=10.0)
            except Exception as e:
                logger.info(f"codex app-server turn/interrupt: {e}")

    # --- internals --------------------------------------------------------

    async def _ensure_thread(self) -> None:
        """Fork a source thread, resume the session's own, or start a fresh one.

        A forked session carries the source thread id on the launch opts
        (`fork_from_session_id`) while its own `session.session_id` is still None;
        `thread/fork` branches the source into a new persisted thread — the
        native equivalent of Claude's `--fork-session`, with no rollout copy.
        Once forked (or started) we adopt the returned thread id as the session's,
        so reconnects resume it rather than re-forking.
        """
        cwd = self.session.cwd or "."
        fork_from = self.opts.fork_from_session_id
        if fork_from and not self.session.session_id:
            res = await self._request(
                "thread/fork", self.provider.thread_fork_params(self.opts, fork_from, cwd))
            self._adopt_thread(self._thread_id_from_result(res))
            return
        if self.session.session_id:
            params = self.provider.thread_resume_params(self.opts, self.session.session_id, cwd)
            await self._request("thread/resume", params)
            self._thread_id = self.session.session_id
            return
        res = await self._request("thread/start", self.provider.thread_start_params(self.opts, cwd))
        self._adopt_thread(self._thread_id_from_result(res))

    def _adopt_thread(self, tid: str | None) -> None:
        """Make a freshly started/forked thread the session's own thread."""
        self._thread_id = tid
        if tid:
            self.session.session_id = tid
            if self.session.store_id:
                SessionStore.update_metadata(self.session.store_id, provider_session_id=tid)

    @staticmethod
    def _thread_id_from_result(res) -> str | None:
        if not isinstance(res, dict):
            return None
        thread = res.get("thread")
        if isinstance(thread, dict) and thread.get("id"):
            return thread["id"]
        return res.get("threadId")

    async def _answer_server_request(self, native: dict) -> None:
        method = native.get("method", "")
        rid = native.get("id")
        deny = _APPROVAL_DENY.get(method)
        if deny is not None:
            await self._write({"jsonrpc": "2.0", "id": rid, "result": deny})
        else:
            # Unknown server-initiated request — reply with an error so the
            # server doesn't wait on us (P1 handles no server requests).
            await self._write({
                "jsonrpc": "2.0", "id": rid,
                "error": {"code": -32601, "message": f"{method} not handled"},
            })
