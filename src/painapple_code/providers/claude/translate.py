"""Claude provider — wire adaptation + output normalization.

Claude's stream-json *is* the canonical internal event shape, so the wire
methods here (`frame_input`, `session_id_from_event`) are the identity readings
of that schema, and the base `translate_events` identity is inherited unchanged.
The one real transform Claude needs is `normalize_result`: the CLI's `result`
cost/usage fields are cumulative across the persistent `claude -p` process, and
the server stores them per-turn. Mixed into `ClaudeProvider`.
"""

from __future__ import annotations

from typing import Optional

from painapple_code.providers.base import CostState

# Cumulative `modelUsage` fields tracked for the per-turn delta conversion.
_CUM_USAGE_FIELDS = (
    "costUSD", "inputTokens", "outputTokens",
    "cacheReadInputTokens", "cacheCreationInputTokens",
    "webSearchRequests",
)


class _TranslateMixin:
    """Identity wire methods + per-turn delta conversion for the cumulative result."""

    def frame_input(self, message: dict) -> dict:
        # Identity: the canonical user-message envelope is exactly what the
        # `claude -p --input-format stream-json` stdin protocol expects
        # ({"type": "user", "message": {...}}).
        return message

    def session_id_from_event(self, event: dict) -> Optional[str]:
        # Present on every stream-json line the CLI emits.
        return event.get("session_id")

    def normalize_result(self, msg: dict, state: CostState) -> None:
        """Convert CLI `result` fields from per-process cumulative to per-turn delta.

        The Claude CLI emits `result` messages whose `total_cost_usd` and
        `modelUsage[*]` fields are running totals across the lifetime of the
        subprocess (across multiple user prompts within one `claude -p`
        invocation). Painapple stores these per-turn, so summing them
        double-counts. This rewrites `msg` in place: cumulative values become
        per-turn deltas (subtracting the previous cumulative seen on this
        subprocess, tracked in `state`).

        Resilient to out-of-order or negative deltas: if a value somehow drops
        (shouldn't happen within a process, but defensive), treat it as a fresh
        count from zero.
        """
        cum_cost = msg.get("total_cost_usd", 0) or 0.0
        delta_cost = cum_cost - state.cum_cost
        if delta_cost < 0:
            delta_cost = cum_cost
        msg["total_cost_usd"] = delta_cost
        state.cum_cost = cum_cost

        mu = msg.get("modelUsage") or {}
        if not isinstance(mu, dict):
            return
        prev = state.cum_usage or {}
        new_prev = {}
        for model, info in list(mu.items()):
            if not isinstance(info, dict):
                continue
            prev_info = prev.get(model, {})
            new_prev[model] = {f: info.get(f, 0) or 0 for f in _CUM_USAGE_FIELDS}
            for f in _CUM_USAGE_FIELDS:
                cur = info.get(f, 0) or 0
                d = cur - (prev_info.get(f, 0) or 0)
                info[f] = d if d >= 0 else cur
        state.cum_usage = new_prev
