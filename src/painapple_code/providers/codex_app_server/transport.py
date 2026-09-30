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
import re

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


# MCP tool approvals. Codex asks before running an MCP tool that isn't
# annotated read-only — even under `approvalPolicy="never"`, which only governs
# shell/patch escalations — by sending an `mcpServer/elicitation/request` whose
# `_meta.codex_approval_kind` is "mcp_tool_call". An unanswered/errored request
# makes codex reject the call ("user rejected MCP tool call"), so these are
# round-tripped to the client's permission card instead. `_meta.persist` lists
# the remember-scopes codex will honour ("session", "always"); echoing one back
# in the accept response's `_meta.persist` stops it asking again.
_MCP_APPROVAL_KIND = "mcp_tool_call"
_MCP_TOOL_RE = re.compile(r'run tool "([^"]+)"')
# codex persist scope → the permission card's suggestion `destination`
# (reusing the addRules row shape the Claude card already renders/labels).
_PERSIST_DESTINATION = {"session": "session", "always": "userSettings"}


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
        # Set by the session layer: async callable(permission_request dict) that
        # surfaces an approval card to the client. None → approvals are declined.
        self.on_permission_request = None
        # permission request_id → (JSON-RPC request id, [persist scope per
        # suggestion index]) for approvals awaiting the user's decision.
        self._pending_approvals: dict = {}

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
        elif method == "serverRequest/resolved":
            # Codex settled a request itself (turn interrupted / thread closed)
            # — retire any approval card still waiting on it.
            rid = (native.get("params") or {}).get("requestId")
            request_id = f"codex-mcp-{rid}"
            if request_id in self._pending_approvals:
                asyncio.create_task(self._expire_approval(request_id))
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
        if method == "mcpServer/elicitation/request":
            await self._handle_elicitation(rid, native.get("params") or {})
            return
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

    # --- MCP tool approvals ------------------------------------------------

    async def _handle_elicitation(self, rid, params: dict) -> None:
        """Surface an MCP tool approval as a permission card.

        Only codex's own tool-call approvals are routed to the user. A genuine
        MCP-server elicitation (a form/URL the server wants filled in) has no
        UI here yet, so it's declined — explicitly, so codex doesn't hang.
        """
        meta = params.get("_meta") or {}
        if (meta.get("codex_approval_kind") != _MCP_APPROVAL_KIND
                or self.on_permission_request is None):
            logger.info(f"codex elicitation from {params.get('serverName')!r} "
                        f"declined (kind={meta.get('codex_approval_kind')!r})")
            await self._write({"jsonrpc": "2.0", "id": rid,
                               "result": {"action": "decline", "content": None}})
            return

        server = params.get("serverName") or "mcp"
        message = params.get("message") or ""
        m = _MCP_TOOL_RE.search(message)
        tool_name = f"mcp__{server}__{m.group(1)}" if m else f"mcp__{server}"
        persist = [p for p in (meta.get("persist") or []) if p in _PERSIST_DESTINATION]
        request_id = f"codex-mcp-{rid}"
        self._pending_approvals[request_id] = (rid, persist)
        tool_input = meta.get("tool_params")
        await self.on_permission_request({
            "type": "permission_request",
            "request_id": request_id,
            "tool_name": tool_name,
            "input": tool_input if isinstance(tool_input, dict) else {},
            "description": message or None,
            "suggestions": [
                {"type": "addRules", "rules": [{"tool_name": tool_name}],
                 "destination": _PERSIST_DESTINATION[p]}
                for p in persist
            ],
        })

    async def _expire_approval(self, request_id: str) -> None:
        self._pending_approvals.pop(request_id, None)
        self.session._pending_permission_requests.pop(request_id, None)
        # ok=False → the client marks the card expired (same as a dead process).
        await self.session.safe_send({"type": "permission_resolved",
                                      "request_id": request_id, "ok": False})

    def owns_permission(self, request_id) -> bool:
        return request_id in self._pending_approvals

    async def respond_permission(self, request_id: str, data: dict) -> bool:
        """Answer a pending MCP approval with the user's decision."""
        entry = self._pending_approvals.pop(request_id, None)
        if entry is None:
            return False
        rid, persist = entry
        if data.get("behavior") == "allow":
            result: dict = {"action": "accept", "content": None}
            idx = data.get("suggestion_index")
            if isinstance(idx, int) and 0 <= idx < len(persist):
                result["_meta"] = {"persist": persist[idx]}
        else:
            result = {"action": "decline", "content": None}
        await self._write({"jsonrpc": "2.0", "id": rid, "result": result})
        return True
