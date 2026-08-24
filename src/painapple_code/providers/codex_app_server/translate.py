"""Codex app-server provider — JSON-RPC notifications → canonical Claude shape.

The app-server emits the same *conceptual* events as `codex exec`, but as
JSON-RPC notifications with **camelCase** methods/fields (`item/completed` with
an `agentMessage`/`commandExecution`/`fileChange` item) rather than exec's
snake_case lines. So the item-translation is rewritten here for the camelCase
schema; only the canonical-event *builders* (`_assistant`/`_tool_use`/
`_tool_result`/`_error_result`) are shared, inherited from the exec translate
mixin.

    thread/started               → system/init  (+ session id)
    turn/started                 → (nothing)
    item/completed reasoning     → assistant {thinking}
    item/completed agentMessage  → assistant {text}
    item/* commandExecution      → assistant {tool_use Bash} + user {tool_result}
    item/completed fileChange    → assistant {tool_use Edit/Write} + user {tool_result}
    item/completed webSearch     → assistant {tool_use WebSearch} + user {tool_result}
    item/* mcpToolCall           → assistant {tool_use mcp__…} + user {tool_result}
    thread/tokenUsage/updated    → (stashed in state for the result + context meter)
    turn/completed               → result  (tokens only; no USD cost)
    error willRetry:true         → system/api_retry  (non-terminal reconnect)
    error / turn.failed          → result  (is_error=True; deduped so the
                                   willRetry:false error + turn.failed pair
                                   yields ONE result)

Streaming deltas (item/agentMessage/delta, item/reasoning/textDelta, …) are
ignored in P1 — the full item arrives on item/completed. Wiring deltas for live
token streaming is a later phase.
"""

from __future__ import annotations

import json
from typing import Optional

# Reuse the canonical-event builders (_assistant/_tool_use/_tool_result/
# _error_result) — they're schema-agnostic. Everything else is overridden below.
from painapple_code.providers.codex.translate import _TranslateMixin as _CodexExecTranslateMixin


class _TranslateMixin(_CodexExecTranslateMixin):
    """Codex app-server JSON-RPC notifications → canonical Claude-shaped events."""

    def session_id_from_event(self, event: dict) -> Optional[str]:
        if event.get("method") == "thread/started":
            thread = (event.get("params") or {}).get("thread") or {}
            return thread.get("id")
        return None

    def translate_events(self, event: dict, state: dict) -> list[dict]:
        method = event.get("method")
        params = event.get("params") or {}

        if method == "thread/started":
            thread = params.get("thread") or {}
            init = {"type": "system", "subtype": "init",
                    "session_id": thread.get("id")}
            model = state.get("model")
            if model and not model.startswith("claude"):
                init["model"] = model
            return [init]

        if method == "turn/started":
            state.pop("error_result_sent", None)
            return []

        if method == "thread/tokenUsage/updated":
            # No usage on the Turn object — it arrives here. Stash this turn's
            # usage (`last`) and the real context window for the result + meter.
            tu = params.get("tokenUsage") or {}
            state["token_usage"] = tu.get("last") or {}
            window = tu.get("modelContextWindow")
            if window:
                state["context_window"] = window
            return []

        if method == "turn/completed":
            turn = params.get("turn") or {}
            already_reported = state.pop("error_result_sent", None)
            if turn.get("status") == "failed":
                if already_reported:
                    # The terminal `error` notification (willRetry:false) already
                    # produced this turn's canonical error result — a second one
                    # would finalize a phantom empty turn.
                    return []
                err = turn.get("error") or {}
                message = err.get("message") if isinstance(err, dict) else None
                return [self._error_result(message or "Codex turn failed", state)]
            return [self._result_from_state(state)]

        if method == "error":
            err = params.get("error") or params
            message = err.get("message") if isinstance(err, dict) else str(err)
            if params.get("willRetry"):
                # NON-terminal: the app-server retries the transport itself
                # ("Reconnecting... N/5", a WebSocket wave then an HTTPS-fallback
                # wave) and reports every attempt as an `error` notification.
                # Map those to the CLI-retry system shape the server already
                # treats as a heartbeat — NOT a turn-ending result (each one
                # used to finalize its own phantom empty turn). Carrying the
                # HTTP status lets the server's 401 fast-path surface the
                # re-login card and cut a doomed retry loop short.
                return [{"type": "system", "subtype": "api_retry",
                         "error_status": self._error_http_status(err),
                         "message": message or ""}]
            state["error_result_sent"] = True
            return [self._error_result(message or "Codex error", state)]

        if method in ("item/started", "item/completed"):
            return self._translate_item(method, params.get("item") or {}, state)

        # item/updated, *delta, and other notifications — ignored in P1.
        return []

    # --- item translation (camelCase app-server schema) -------------------

    def _translate_item(self, method: str, item: dict, state: dict) -> list[dict]:
        itype = item.get("type")
        item_id = item.get("id") or ""
        completed = method == "item/completed"
        started = method == "item/started"

        if itype == "reasoning" and completed:
            # No text → no bubble. Reasoning items arrive EMPTY unless the turn
            # opted into summaries (turn/start `summary`), and even then some
            # turns produce reasoning items with no summary parts — an empty
            # collapsed "Thinking" block is pure noise.
            text = self._reasoning_text(item)
            return [self._assistant([{"type": "thinking",
                                      "thinking": text}])] if text else []

        if itype == "agentMessage" and completed:
            text = item.get("text", "")
            state["last_text"] = text  # surfaced as result.result
            return [self._assistant([{"type": "text", "text": text}])]

        if itype == "commandExecution":
            if started:
                return [self._tool_use(item_id, "Bash",
                                       {"command": item.get("command", "")})]
            if completed:
                out = item.get("aggregatedOutput", "")
                exit_code = item.get("exitCode")
                if exit_code not in (None, 0):
                    out = f"{out}\n[exit code: {exit_code}]"
                return [self._tool_result(item_id, out)]
            return []

        if itype == "fileChange" and completed:
            msgs: list[dict] = []
            for i, change in enumerate(item.get("changes") or []):
                path = change.get("path", "")
                kind = change.get("kind")
                # kind is an object {type: add|delete|update} in the app-server schema.
                kind_type = kind.get("type") if isinstance(kind, dict) else (kind or "update")
                tool = "Write" if kind_type == "add" else "Edit"
                cid = f"{item_id}_{i}"
                msgs.append(self._tool_use(cid, tool, {"file_path": path}))
                msgs.append(self._tool_result(cid, f"{kind_type}: {path}"))
            return msgs

        if itype == "webSearch" and completed:
            return [
                self._tool_use(item_id, "WebSearch", {"query": item.get("query", "")}),
                self._tool_result(item_id, "Search completed."),
            ]

        if itype == "mcpToolCall":
            name = f"mcp__{item.get('server', '')}__{item.get('tool', '')}"
            if started:
                return [self._tool_use(item_id, name, item.get("arguments") or {})]
            if completed:
                result = item.get("result")
                err = item.get("error")
                content = err if err else json.dumps(result) if result is not None else "(no result)"
                return [self._tool_result(item_id, str(content))]
            return []

        if itype == "plan" and completed:
            # App-server's planning item (no TodoWrite analogue here) — surface
            # its text as an assistant message.
            text = item.get("text", "")
            return [self._assistant([{"type": "text", "text": text}])] if text else []

        return []

    # --- helpers ----------------------------------------------------------

    @staticmethod
    def _error_http_status(err) -> Optional[int]:
        """HTTP status from a codex error payload's `codexErrorInfo` variants.

        The reconnect notifications carry it as e.g.
        `{"codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": 401}}}`.
        """
        if not isinstance(err, dict):
            return None
        info = err.get("codexErrorInfo")
        if isinstance(info, dict):
            for variant in info.values():
                if isinstance(variant, dict) and variant.get("httpStatusCode"):
                    return variant["httpStatusCode"]
        return None

    @staticmethod
    def _reasoning_text(item: dict) -> str:
        """Pull thinking text from a reasoning item.

        The app-server puts it in `summary` and/or `content` arrays of text
        parts (rather than a flat `text`), so collect any string `text` fields.
        """
        if item.get("text"):
            return item["text"]
        parts: list[str] = []
        for key in ("summary", "content"):
            seq = item.get(key)
            if isinstance(seq, list):
                for el in seq:
                    if isinstance(el, dict) and el.get("text"):
                        parts.append(el["text"])
                    elif isinstance(el, str):
                        parts.append(el)
        return "\n".join(parts)

    def _result_from_state(self, state: dict) -> dict:
        """Build the canonical `result` from the stashed token usage.

        The app-server reports no USD cost (left at 0) and carries usage via the
        tokenUsage notification (stashed in `state`), not on the Turn object.
        """
        tu = state.get("token_usage") or {}
        in_tok = tu.get("inputTokens", 0) or 0
        out_tok = tu.get("outputTokens", 0) or 0
        cache_read = tu.get("cachedInputTokens", 0) or 0
        result = {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0,
            "duration_ms": 0,       # finalize_turn derives this from turn_start
            "num_turns": 1,
            "result": state.get("last_text", ""),
            "usage": {
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": 0,
            },
        }
        window = state.get("context_window")
        if window:
            # Carried for context_from_result — the real server-reported window.
            result["usage"]["context_window"] = window
        model = state.get("model")
        if model and not model.startswith("claude"):
            result["modelUsage"] = {model: {
                "costUSD": 0,
                "inputTokens": in_tok,
                "outputTokens": out_tok,
                "cacheReadInputTokens": cache_read,
                "cacheCreationInputTokens": 0,
            }}
        return result
