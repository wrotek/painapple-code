"""Codex app-server provider — declarative surface.

Everything the app-server declares about itself — binary/auth, effort &
permission vocabularies, skill/agent/plugin roots — is identical to the `codex`
exec provider (same CLI, same `$CODEX_HOME` layout), so this inherits the exec
capability mixin wholesale and overrides only context metering: the app-server
reports the *real* model context window (via the tokenUsage notification, stashed
onto the result by translate.py), so we meter against that instead of exec's
hardcoded family default.
"""

from __future__ import annotations

from typing import Optional

from painapple_code.providers.codex.capabilities import (
    _CapabilitiesMixin as _CodexExecCapabilitiesMixin,
    _DEFAULT_CONTEXT_WINDOW,
)


class _CapabilitiesMixin(_CodexExecCapabilitiesMixin):
    """Reuses the exec provider's self-description; real context window."""

    def context_from_result(self, result_msg: dict, model: Optional[str] = None) -> Optional[dict]:
        # input_tokens is the full conversation context fed to the model this
        # turn — the live window occupancy. Unlike exec, the app-server tells us
        # the actual window (carried on usage.context_window by translate.py); we
        # fall back to the exec family default only if it's somehow absent.
        usage = (result_msg or {}).get("usage") or {}
        in_tok = usage.get("input_tokens") or 0
        if not in_tok:
            return None
        window = usage.get("context_window") or _DEFAULT_CONTEXT_WINDOW
        return {
            "contextTokens": in_tok,
            "contextWindow": window,
            "percentage": round(in_tok / window * 100, 1) if window else None,
            "breakdown": None,
            "memoryFiles": None,
        }
