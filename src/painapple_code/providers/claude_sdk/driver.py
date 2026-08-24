"""
Agent-SDK driver subprocess for the `claude-sdk` provider.

The server spawns this module (`python -u -m painapple_code.providers.claude_sdk.driver`)
exactly where it would spawn `claude -p`, and speaks the same wire protocol to
it: canonical stream-json user messages in on stdin, canonical stream-json
events out on stdout, CLI diagnostics on stderr. Internally it drives the
Claude Code CLI through `ClaudeSDKClient` and *tees the raw stream-json dicts
off the SDK transport verbatim*, so the bytes the server reads are the CLI's
own output, not a lossy reconstruction from the SDK's typed objects — event
parity with the line-protocol provider holds by construction.

Signal contract (matches what the session layer expects of the CLI):
  SIGINT  → abort the turn, shut the SDK client down, exit 130
  SIGTERM → shut down, exit 143
  stdin EOF (server died/closed) → shut down, exit 0
Closing the client terminates the CLI child, so no orphan is left behind.

stdout is protocol-only — never print anything else to it. Driver-side
diagnostics go to stderr, where the server's stderr reader forwards/classifies
them like any CLI stderr line.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import itertools
import json
import os
import shutil
import signal
import sys
import threading
from collections.abc import AsyncIterator
from typing import Any

# Matches the server reader's MAX_LINE_SIZE ceiling (utils/agent_cli.py); the
# stdin limit is higher because pasted/uploaded base64 images ride in the user
# message envelope.
MAX_EVENT_SIZE = 10 * 1024 * 1024
MAX_STDIN_LINE = 64 * 1024 * 1024

# Stream event types forwarded to the server. Everything else on the transport
# (control_request/control_response handshakes, keep-alives) is SDK plumbing
# the server must not see.
_STREAM_TYPES = frozenset({"system", "assistant", "user", "result"})

# Tools whose "ask" the server already handles with its own chat-UI flow
# (question wizard / plan-approval card + SIGINT auto-stop). Deny them here
# with a steering message instead of surfacing a permission card, so both
# providers keep the identical UX for these two.
_UI_FLOW_TOOLS = frozenset({"AskUserQuestion", "ExitPlanMode"})
_UI_FLOW_DENY = ("The user will respond through the chat UI. Stop and wait "
                 "for their reply instead of retrying this tool.")


def _jsonable(obj: Any) -> Any:
    """Best-effort conversion of SDK dataclasses/enums for the wire."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _jsonable(v) for k, v in dataclasses.asdict(obj).items() if v is not None}
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


def _emit(msg: dict) -> None:
    """Write one canonical event line to the server."""
    sys.stdout.write(json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _note(text: str) -> None:
    """Driver-side diagnostic → server stderr reader."""
    print(f"claude-sdk driver: {text}", file=sys.stderr, flush=True)


def _make_tee_transport(options):
    """Subclass the SDK's subprocess transport to tee raw dicts to stdout.

    Built lazily inside a function so importing this module never hard-requires
    the SDK internals; version drift in `SubprocessCLITransport` surfaces here
    as a loud startup error, not a wedged session.
    """
    from claude_agent_sdk._internal.transport.subprocess_cli import (
        SubprocessCLITransport,
    )

    class _TeeTransport(SubprocessCLITransport):
        def read_messages(self) -> AsyncIterator[dict[str, Any]]:
            return self._tee(super().read_messages())

        @staticmethod
        async def _tee(inner: AsyncIterator[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
            async for msg in inner:
                if msg.get("type") in _STREAM_TYPES:
                    _emit(msg)
                yield msg

    async def _pending() -> AsyncIterator[dict[str, Any]]:
        # Never yields; marks streaming-input mode so the CLI's stdin stays
        # open for the queries we write per server message.
        return
        yield {}  # pragma: no cover

    return _TeeTransport(prompt=_pending(), options=options)


async def _amain(args: argparse.Namespace) -> int:
    from claude_agent_sdk import (
        ClaudeAgentOptions,
        ClaudeSDKClient,
        PermissionResultAllow,
        PermissionResultDeny,
    )

    loop = asyncio.get_running_loop()

    # Interactive permissions: `can_use_tool` fires whenever the CLI's
    # permission flow resolves to a prompt. We round-trip the decision to the
    # server as a `permission_request` stdout line and await the matching
    # `permission_response` stdin line (routed by the stdin loop below).
    pending_permissions: dict[str, asyncio.Future] = {}
    request_ids = (f"perm-{n}" for n in itertools.count(1))

    async def on_permission(tool_name: str, tool_input: dict, context) -> Any:
        if tool_name in _UI_FLOW_TOOLS:
            return PermissionResultDeny(message=_UI_FLOW_DENY)
        req_id = next(request_ids)
        fut: asyncio.Future = loop.create_future()
        pending_permissions[req_id] = fut
        suggestions = list(getattr(context, "suggestions", []) or [])
        _emit({
            "type": "permission_request",
            "request_id": req_id,
            "tool_name": tool_name,
            "input": _jsonable(tool_input),
            "tool_use_id": getattr(context, "tool_use_id", None),
            "title": getattr(context, "title", None),
            "description": getattr(context, "description", None),
            "display_name": getattr(context, "display_name", None),
            "decision_reason": _jsonable(getattr(context, "decision_reason", None)),
            "blocked_path": getattr(context, "blocked_path", None),
            "suggestions": _jsonable(suggestions),
        })
        try:
            resp = await fut
        finally:
            pending_permissions.pop(req_id, None)
        if resp.get("behavior") == "allow":
            # "Always allow": the client picked one of the CLI's own permission
            # suggestions (addRules / addDirectories / setMode). Hand the
            # original PermissionUpdate object back and the CLI applies it —
            # rule persistence is entirely engine-side, nothing reimplemented.
            updated_permissions = None
            idx = resp.get("suggestion_index")
            if isinstance(idx, int) and 0 <= idx < len(suggestions):
                updated_permissions = [suggestions[idx]]
            return PermissionResultAllow(
                updated_input=resp.get("updated_input"),
                updated_permissions=updated_permissions,
            )
        # Attribute the guidance to the user explicitly — a bare denial string
        # in an error-shaped tool result reads like injected tool output and
        # the model may distrust it.
        guidance = resp.get("message")
        return PermissionResultDeny(
            message=(f"The user denied this tool call and said: {guidance}"
                     if guidance else "The user denied this tool call."),
            interrupt=bool(resp.get("interrupt")),
        )

    # bypassPermissions (YOLO) auto-approves every tool call before can_use_tool
    # is ever consulted, so wiring the callback does nothing except trip the
    # SDK's CanUseToolShadowedWarning — which the server's stderr reader surfaces
    # as a scary (but harmless) error line. Only attach the permission gate for
    # modes that can actually prompt.
    gate = None if args.permission_mode == "bypassPermissions" else on_permission

    options = ClaudeAgentOptions(
        can_use_tool=gate,
        model=args.model,
        fallback_model=args.fallback_model,
        effort=args.effort,
        permission_mode=args.permission_mode,
        resume=args.resume,
        fork_session=args.fork_session,
        # The server already sets cwd on the driver process; pin the CLI to it.
        cwd=os.getcwd(),
        # None → the SDK's _find_cli() discovers (and on win32 vets) the CLI;
        # an explicit config value is which-resolved as before.
        cli_path=(shutil.which(args.cli_path) or args.cli_path) if args.cli_path else None,
        # Restore thinking summaries on all models (see providers/claude/launch.py).
        extra_args={"thinking-display": "summarized"},
        # Mirror CLI stderr onto ours so the server's classifier sees the exact
        # strings it matches today (stale session, API 5xx, compaction, …).
        stderr=lambda line: print(line, file=sys.stderr, flush=True),
        max_buffer_size=MAX_EVENT_SIZE,
    )

    stop = asyncio.Event()
    exit_code = 0

    def _shutdown(code: int) -> None:
        nonlocal exit_code
        exit_code = code
        stop.set()

    if sys.platform == "win32":
        # Proactor has no add_signal_handler (NotImplementedError — a Windows 11
        # probe). signal.signal works: CPython's wakeup channel rouses the
        # loop, and call_soon_threadsafe hops back onto it. The server's
        # interrupt_process() sends CTRL_BREAK → SIGBREAK here (SIGTERM is
        # undeliverable on win32; parent terminate() covers that path).
        def _sig_handler(signum, frame):
            loop.call_soon_threadsafe(
                _shutdown, 130 if signum == signal.SIGINT else 143
            )
        signal.signal(signal.SIGINT, _sig_handler)
        signal.signal(signal.SIGBREAK, _sig_handler)
    else:
        loop.add_signal_handler(signal.SIGINT, _shutdown, 130)
        loop.add_signal_handler(signal.SIGTERM, _shutdown, 143)

    # With a custom transport, ClaudeSDKClient skips its own
    # `permission_prompt_tool_name="stdio"` injection (it only applies it to
    # the transport it would have built itself), so set it on the *transport's*
    # options copy here. It must NOT go on the client's options — the client
    # rejects it alongside `can_use_tool`. Pair it with the gate: in bypass mode
    # there's nothing to route to stdio, so keep that path a clean pass-through.
    transport_opts = dataclasses.replace(options, can_use_tool=None)
    if gate is not None:
        transport_opts = dataclasses.replace(transport_opts, permission_prompt_tool_name="stdio")
    transport = _make_tee_transport(transport_opts)
    client = ClaudeSDKClient(options=options, transport=transport)
    try:
        await client.connect()
    except Exception as e:
        _note(f"failed to start Claude CLI via SDK: {e}")
        return 1

    async def stdin_loop() -> None:
        """Forward each canonical user-message line from the server into the SDK."""
        if sys.platform == "win32":
            # connect_read_pipe on an inherited stdin HALF-works under
            # Proactor: it connects, then the first read dies with
            # OSError WinError 6 and leaves stdin unusable (a Windows 11 probe
            # 3). Don't attempt it — a daemon thread doing blocking
            # readline feeds the loop through an asyncio queue instead.
            queue: asyncio.Queue = asyncio.Queue()

            def _pump() -> None:
                try:
                    while True:
                        raw = sys.stdin.buffer.readline()
                        loop.call_soon_threadsafe(queue.put_nowait, raw)
                        if not raw:  # EOF — server closed our stdin
                            return
                except Exception:
                    loop.call_soon_threadsafe(queue.put_nowait, b"")

            threading.Thread(target=_pump, daemon=True, name="stdin-pump").start()

            async def _readline() -> bytes:
                return await queue.get()
        else:
            reader = asyncio.StreamReader(limit=MAX_STDIN_LINE)
            await loop.connect_read_pipe(
                lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
            )

            async def _readline() -> bytes:
                return await reader.readline()

        while True:
            line = await _readline()
            if not line:
                # Server closed stdin. Mirror `claude -p` one-shot semantics:
                # close the CLI's stdin and let it finish in-flight work; the
                # drain loop shuts us down when the CLI exits.
                try:
                    await transport.end_input()
                except Exception:
                    _shutdown(0)
                return
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                _note("dropping non-JSON stdin line")
                continue

            # Server frames ride the same pipe: permission decisions resolve
            # the future the matching can_use_tool callback is awaiting.
            if msg.get("type") == "permission_response":
                fut = pending_permissions.get(msg.get("request_id"))
                if fut and not fut.done():
                    fut.set_result(msg)
                else:
                    _note(f"permission_response for unknown request "
                          f"{msg.get('request_id')!r}")
                continue

            # Control plane (Capabilities.live_controls): live mode/model
            # switches and warm-process interrupt via the SDK client. Every
            # request is acked with `control_done` — the server treats a
            # nack/timeout as "fall back to kill+respawn", so failing loudly
            # here is always safe. Ordering with user messages is enforced
            # server-side (it awaits the ack before writing the message).
            if msg.get("type") == "control_request":
                action = msg.get("action")
                ok, err = True, None
                try:
                    if action == "interrupt":
                        # Unblock pending can_use_tool callbacks first so they
                        # unwind as clean user denials instead of being
                        # cancelled mid-await by the abort.
                        for fut in list(pending_permissions.values()):
                            if not fut.done():
                                fut.set_result({"behavior": "deny", "interrupt": True})
                        await client.interrupt()
                    elif action == "set_permission_mode":
                        await client.set_permission_mode(msg.get("mode"))
                    elif action == "set_model":
                        # None = revert to the CLI/account default model.
                        await client.set_model(msg.get("model"))
                    else:
                        ok, err = False, f"unknown control action {action!r}"
                except Exception as e:
                    ok, err = False, str(e)
                    _note(f"control {action} failed: {e}")
                _emit({
                    "type": "control_done",
                    "control_id": msg.get("control_id"),
                    "action": action,
                    "ok": ok,
                    "error": err,
                })
                continue

            async def _one(m=msg) -> AsyncIterator[dict[str, Any]]:
                yield m

            await client.query(_one())

    async def drain_loop() -> None:
        """Keep the SDK's parsed-message queue drained (the tee already emitted
        the raw dicts); surface transport/process failures as an exit."""
        try:
            async for _ in client.receive_messages():
                pass
            _shutdown(0)
        except Exception as e:
            _note(str(e))
            code = getattr(e, "exit_code", None)
            _shutdown(code if isinstance(code, int) and code > 0 else 1)

    tasks = [asyncio.create_task(stdin_loop()), asyncio.create_task(drain_loop())]
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await client.disconnect()  # terminates the CLI child
        except Exception as e:
            _note(f"error during shutdown: {e}")
    return exit_code


def main() -> None:
    if sys.platform == "win32":
        # stdout is the wire to the server and emit() uses ensure_ascii=False —
        # a cp1252 pipe would corrupt the first non-ASCII assistant token.
        from painapple_code.utils.proc import force_utf8_stdio
        force_utf8_stdio()
    parser = argparse.ArgumentParser(description="painapple-code Agent SDK driver")
    parser.add_argument("--cli-path", default=None)  # None → SDK _find_cli()
    parser.add_argument("--model", default=None)
    parser.add_argument("--fallback-model", default=None)
    parser.add_argument("--effort", default=None)
    parser.add_argument("--permission-mode", default=None)
    parser.add_argument("--resume", default=None)
    parser.add_argument("--fork-session", action="store_true")
    args = parser.parse_args()
    code = asyncio.run(_amain(args))
    if sys.platform == "win32":
        # The win32 stdin pump is a daemon thread parked in a blocking
        # readline(), so it owns the <stdin> BufferedReader lock at exit.
        # Normal interpreter finalization waits for that lock and instead
        # aborts with "Fatal Python error: _enter_buffered_busy" on stderr —
        # which the server forwards verbatim, painting three red error
        # bubbles into the chat on every AskUserQuestion auto-stop.
        # _amain's finally already disconnected the CLI child and cancelled
        # the loop tasks, so finalization has nothing left to do; skip it
        # rather than lose a race it cannot win. os._exit does not flush.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(code)
    sys.exit(code)


if __name__ == "__main__":
    main()
