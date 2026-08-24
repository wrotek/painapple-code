"""Codex app-server provider — native rich-commit summary over JSON-RPC.

The sibling `codex` exec provider summarizes a turn by copying the thread's
rollout JSONL under a fresh id and running `codex exec resume` on the copy
(`codex exec resume` writes in place, so it can't summarize the real thread
without polluting it). The app-server needs no such file copy: it can
`thread/fork` the real thread into an *ephemeral* branch — a throwaway thread
that never persists to disk — and run one `turn/start` with a native
`outputSchema` to get the structured sections back. No rollout copy, no temp
schema/output files, no pollution of the user's thread.

Isolation: the summary runs on its OWN short-lived `codex app-server` process
(spawned by the shadow-git layer from `build_summary_fork`'s argv), not the
user's live session transport — so its turn notifications never interleave with
the user's chat stream. `drive_summary_fork` conducts that process's JSON-RPC
conversation and returns the structured sections + token usage.

On any failure it returns `(None, None)`: the turn still gets a basic shadow
commit, just without AI sections — exactly like any other unavailable fork.
Subclasses the exec summary mixin only to reuse `_strictify_schema` (the
app-server's `outputSchema` runs in the same OpenAI strict mode as exec's
`--output-schema`). Mixed into `CodexAppServerProvider`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from painapple_code import paths
from painapple_code.providers.base import SummaryForkPlan
from painapple_code.providers.codex.summary import _SummaryMixin as _CodexExecSummaryMixin

logger = logging.getLogger("painapple_code")

# Per-request waits. The handshake/fork/turn acks return promptly; the turn's
# content streams as notifications, so awaiting an ack never blocks turn-length.
_RPC_TIMEOUT = 60.0
# Whole-turn wait for the streamed result; the shadow-git layer also caps the
# entire fork at 300s, so this stays under that.
_TURN_TIMEOUT = 240.0


class _SummaryMixin(_CodexExecSummaryMixin):
    """Native app-server rich-commit fork — ephemeral thread/fork + outputSchema."""

    def build_summary_fork(
        self,
        *,
        session_id: str,
        fork_prompt: str,
        schema_json: str,
        cwd: str,
        token_profile: Optional[str] = None,
        session_model: Optional[str] = None,
    ) -> Optional[SummaryForkPlan]:
        """Plan a native (transport-driven) summary — no rollout copy.

        The plan's argv launches a throwaway `codex app-server`; its `payload`
        carries what `drive_summary_fork` needs: the source thread id to fork,
        the prompt, the (strict) output schema, an optional cheaper summary
        model, and the cwd. Nothing is copied to disk → empty `cleanup_paths`.
        """
        if not session_id:
            return None
        try:
            schema_obj = json.loads(self._strictify_schema(schema_json))
        except json.JSONDecodeError:
            return None
        # Optional cheaper summarizer model (seam-described override);
        # default inherits the thread's model.
        summary_model = self.get_summary_model_override()
        if summary_model and summary_model.startswith("claude"):
            summary_model = None
        return SummaryForkPlan(
            argv=[self.binary(), "app-server", "--stdio"],
            env=None,                       # codex uses ambient auth
            model=summary_model or "codex (app-server)",
            output_file=None,
            cleanup_paths=[],               # nothing copied — that's the win
            payload={
                "fork_from": session_id,
                "prompt": fork_prompt,
                "schema": schema_obj,
                "model": summary_model,
                "cwd": cwd,
            },
        )

    async def drive_summary_fork(self, proc, plan):
        """Conduct the throwaway app-server's JSON-RPC summary conversation.

        initialize → thread/fork{ephemeral} → turn/start{outputSchema} → collect
        the final structured agentMessage + token usage. Returns
        `(structured_data, cost)` or `(None, None)` on any failure (→ no AI
        sections this turn). Leaves the process terminated.
        """
        # Lazy import keeps the transport (and its asyncio plumbing) out of the
        # package's static-description import path — same reason `make_transport`
        # imports it lazily.
        from painapple_code.providers.codex_app_server.transport import (
            _APPROVAL_DENY, _client_version, JsonRpcTransport,
        )

        payload = plan.payload or {}
        fork_from = payload.get("fork_from")
        if not fork_from:
            return None, None

        client = _SummaryRpcClient(proc, deny_map=_APPROVAL_DENY)
        await client.start()
        try:
            await client.request("initialize", {
                "clientInfo": {"name": "painapple-code", "version": _client_version()},
            }, timeout=_RPC_TIMEOUT)
            await client.notify("initialized")

            fork_params = {
                "threadId": fork_from,
                "ephemeral": True,            # throwaway branch — never persisted
                "cwd": payload.get("cwd") or ".",
                "sandbox": "read-only",       # the summarizer must not touch files
                "approvalPolicy": "never",
            }
            if payload.get("model"):
                fork_params["model"] = payload["model"]
            res = await client.request("thread/fork", fork_params, timeout=_RPC_TIMEOUT)
            fork_id = JsonRpcTransport._thread_id_from_result(res)
            if not fork_id:
                return None, None

            turn_params = {
                "threadId": fork_id,
                "input": [{"type": "text", "text": payload.get("prompt") or ""}],
                "outputSchema": payload.get("schema"),
                "effort": "low",              # summarization needs no deep reasoning
            }
            if payload.get("model"):
                turn_params["model"] = payload["model"]
            await client.request("turn/start", turn_params, timeout=_RPC_TIMEOUT)

            structured, usage = await client.await_turn(timeout=_TURN_TIMEOUT)
            if not isinstance(structured, dict):
                return None, None
            cost = {
                "cost": 0.0,                  # app-server reports no USD cost
                "input_tokens": (usage or {}).get("inputTokens", 0) or 0,
                "output_tokens": (usage or {}).get("outputTokens", 0) or 0,
            }
            return structured, cost
        except Exception as e:
            logger.info(f"codex app-server summary fork failed: {e}")
            return None, None
        finally:
            await client.close()


class _SummaryRpcClient:
    """Minimal one-shot JSON-RPC client over a throwaway app-server process.

    Distinct from `JsonRpcTransport` (session-coupled, driven externally by the
    session's stdout reader): this owns its own read loop and collects only what
    a summary needs — the final `agentMessage` text (the structured JSON produced
    under `outputSchema`) and the latest token usage — resolving `await_turn` on
    `turn/completed`.
    """

    def __init__(self, proc, deny_map=None):
        self.proc = proc
        self._deny = deny_map or {}
        self._id = 0
        self._pending: dict = {}
        self._turn = None            # future resolved on turn/completed|error|EOF
        self._last_text = None       # last agentMessage text == the structured JSON
        self._usage: dict = {}
        self._reader = None

    async def start(self):
        self._reader = asyncio.create_task(self._read_loop())

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    async def _write(self, obj: dict):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        await self.proc.stdin.drain()

    async def request(self, method: str, params: dict, timeout: float = _RPC_TIMEOUT):
        rid = self._next_id()
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    async def notify(self, method: str, params: dict | None = None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        await self._write(msg)

    async def await_turn(self, timeout: float = _TURN_TIMEOUT):
        """Wait for turn/completed; return (structured_or_None, usage)."""
        self._turn = asyncio.get_running_loop().create_future()
        try:
            await asyncio.wait_for(self._turn, timeout)
        except asyncio.TimeoutError:
            return None, self._usage
        structured = None
        if self._last_text:
            try:
                structured = json.loads(self._last_text)
            except json.JSONDecodeError:
                structured = None
        return structured, self._usage

    async def _read_loop(self):
        stdout = self.proc.stdout
        while True:
            line = await stdout.readline()
            if not line:                          # EOF — process exited
                self._finish_turn()
                return
            try:
                msg = json.loads(line.decode(errors="replace").strip())
            except (json.JSONDecodeError, ValueError):
                continue
            self._dispatch(msg)

    def _dispatch(self, msg: dict):
        has_id = msg.get("id") is not None
        has_method = "method" in msg
        if has_id and has_method:                 # server → client request: decline
            asyncio.create_task(self._decline(msg))
            return
        if has_id and not has_method:             # response to one of our requests
            fut = self._pending.get(msg["id"])
            if fut is not None and not fut.done():
                if msg.get("error") is not None:
                    fut.set_exception(RuntimeError(str(msg["error"])))
                else:
                    fut.set_result(msg.get("result"))
            return
        method = msg.get("method")                # notification
        params = msg.get("params") or {}
        if method == "item/completed":
            item = params.get("item") or {}
            if item.get("type") == "agentMessage" and item.get("text"):
                self._last_text = item["text"]
        elif method == "thread/tokenUsage/updated":
            tu = params.get("tokenUsage") or {}
            self._usage = tu.get("last") or self._usage
        elif method in ("turn/completed", "error"):
            self._finish_turn()

    def _finish_turn(self):
        if self._turn is not None and not self._turn.done():
            self._turn.set_result(None)

    async def _decline(self, msg: dict):
        rid = msg.get("id")
        deny = self._deny.get(msg.get("method", ""))
        try:
            if deny is not None:
                await self._write({"jsonrpc": "2.0", "id": rid, "result": deny})
            else:
                await self._write({
                    "jsonrpc": "2.0", "id": rid,
                    "error": {"code": -32601, "message": "not handled"},
                })
        except Exception:
            pass

    async def close(self):
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
        if self.proc.returncode is None:
            try:
                self.proc.kill()
                await self.proc.wait()
            except Exception:
                pass
