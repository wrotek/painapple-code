"""Codex provider — event translation into the canonical Claude-shaped stream.

`translate_events` maps Codex's native event schema into the canonical
Claude-shaped events (`system`/`assistant`/`user`/`result`) the session handlers
and the frontend already understand:

    thread.started        → system/init   (+ session id via session_id_from_event)
    turn.started          → (nothing)
    item.completed reasoning      → assistant {thinking}
    item.completed agent_message  → assistant {text}
    item.* command_execution      → assistant {tool_use Bash} + user {tool_result}
    item.completed file_change    → assistant {tool_use Edit/Write} + user {tool_result}
    item.completed web_search     → assistant {tool_use WebSearch} + user {tool_result}
    item.* mcp_tool_call          → assistant {tool_use mcp__…} + user {tool_result}
    item.completed todo_list      → assistant {tool_use TodoWrite} + user {tool_result}
    turn.completed        → result   (tokens only; no USD cost)
    turn.failed / error   → result   (is_error=True)

Codex reports token counts but no per-turn USD cost, so result cost is left at 0.
Token usage is per-turn already, so no cumulative→delta conversion is needed.
"""

from __future__ import annotations

import json
from typing import Optional


class _TranslateMixin:
    """Codex native events → canonical Claude-shaped events."""

    def session_id_from_event(self, event: dict) -> Optional[str]:
        if event.get("type") == "thread.started":
            return event.get("thread_id")
        return None

    def translate_events(self, event: dict, state: dict) -> list[dict]:
        etype = event.get("type")

        if etype == "thread.started":
            init = {"type": "system", "subtype": "init",
                    "session_id": event.get("thread_id")}
            model = state.get("model")
            if model and not model.startswith("claude"):
                init["model"] = model
            return [init]

        if etype == "turn.started":
            return []

        if etype == "turn.completed":
            return [self._result_from_usage(event.get("usage") or {}, state)]

        if etype in ("turn.failed", "error"):
            err = event.get("error") or {}
            message = err.get("message") if isinstance(err, dict) else None
            message = message or event.get("message") or "Codex turn failed"
            return [self._error_result(message, state)]

        if etype in ("item.started", "item.updated", "item.completed"):
            return self._translate_item(etype, event.get("item") or {}, state)

        # Unknown event — ignore rather than surfacing noise.
        return []

    # --- item translation -------------------------------------------------

    def _translate_item(self, etype: str, item: dict, state: dict) -> list[dict]:
        itype = item.get("type")
        item_id = item.get("id") or ""
        completed = etype == "item.completed"
        started = etype == "item.started"

        if itype == "reasoning" and completed:
            return [self._assistant([{"type": "thinking",
                                      "thinking": item.get("text", "")}])]

        if itype == "agent_message" and completed:
            text = item.get("text", "")
            state["last_text"] = text  # surfaced as result.result
            return [self._assistant([{"type": "text", "text": text}])]

        if itype == "command_execution":
            if started:
                return [self._tool_use(item_id, "Bash",
                                       {"command": item.get("command", "")})]
            if completed:
                out = item.get("aggregated_output", "")
                exit_code = item.get("exit_code")
                if exit_code not in (None, 0):
                    out = f"{out}\n[exit code: {exit_code}]"
                return [self._tool_result(item_id, out)]
            return []

        if itype == "file_change" and completed:
            msgs: list[dict] = []
            for i, change in enumerate(item.get("changes") or []):
                path = change.get("path", "")
                kind = change.get("kind", "update")
                tool = "Write" if kind == "add" else "Edit"
                cid = f"{item_id}_{i}"
                msgs.append(self._tool_use(cid, tool, {"file_path": path}))
                msgs.append(self._tool_result(cid, f"{kind}: {path}"))
            return msgs

        if itype == "web_search" and completed:
            return [
                self._tool_use(item_id, "WebSearch", {"query": item.get("query", "")}),
                self._tool_result(item_id, "Search completed."),
            ]

        if itype == "mcp_tool_call":
            name = f"mcp__{item.get('server', '')}__{item.get('tool', '')}"
            if started:
                return [self._tool_use(item_id, name, item.get("arguments") or {})]
            if completed:
                result = item.get("result")
                err = item.get("error")
                content = err if err else json.dumps(result) if result is not None else "(no result)"
                return [self._tool_result(item_id, str(content))]
            return []

        if itype == "todo_list" and completed:
            todos = [
                {"content": t.get("text", ""),
                 "status": "completed" if t.get("completed") else "pending",
                 "activeForm": t.get("text", "")}
                for t in (item.get("items") or [])
            ]
            return [
                self._tool_use(item_id, "TodoWrite", {"todos": todos}),
                self._tool_result(item_id, "Todos updated."),
            ]

        if itype == "error" and completed:
            return [self._assistant([{"type": "text",
                                      "text": f"⚠️ {item.get('message', '')}"}])]

        return []

    # --- canonical-event builders ----------------------------------------

    @staticmethod
    def _assistant(blocks: list[dict]) -> dict:
        return {"type": "assistant",
                "message": {"role": "assistant", "content": blocks}}

    @staticmethod
    def _tool_use(tool_id: str, name: str, tool_input: dict) -> dict:
        return {"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": tool_id, "name": name, "input": tool_input},
        ]}}

    @staticmethod
    def _tool_result(tool_id: str, content: str) -> dict:
        return {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": content},
        ]}}

    @staticmethod
    def _result_from_usage(usage: dict, state: dict) -> dict:
        in_tok = usage.get("input_tokens", 0) or 0
        out_tok = usage.get("output_tokens", 0) or 0
        cache_read = usage.get("cached_input_tokens", 0) or 0
        result = {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0,   # Codex reports no USD cost
            "duration_ms": 0,      # finalize_turn derives this from turn_start
            "num_turns": 1,
            "result": state.get("last_text", ""),
            "usage": {
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": 0,
            },
        }
        # Only record a model breakdown under an OpenAI-shaped id — the seeded
        # state model may be the Claude default that build_command dropped.
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

    @staticmethod
    def _error_result(message: str, state: dict) -> dict:
        return {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "total_cost_usd": 0,
            "duration_ms": 0,
            "num_turns": 1,
            "result": message,
            "usage": {},
        }
