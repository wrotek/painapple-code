"""Codex family — schema-agnostic canonical-event builders.

The exec driver's full event translation (snake_case `codex exec --json`
lines) was deleted with the exec provider; what both drivers always shared —
and what `codex_app_server/translate.py` inherits — are these builders for the
canonical Claude-shaped events. They know nothing about either wire schema,
only the canonical output shape.
"""

from __future__ import annotations


class _TranslateMixin:
    """Canonical-event builders shared by the codex family."""

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
