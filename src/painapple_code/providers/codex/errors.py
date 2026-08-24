"""Codex provider — stderr classification and retry/termination policy."""

from __future__ import annotations

from painapple_code.providers.base import StderrClass

# Retryable transient-error substrings on Codex stderr / result text.
_RETRYABLE_SUBSTRINGS = (
    "rate limit", "429", "stream error", "503", "502", "500",
    "overloaded", "timed out", "connection reset",
)
# Codex resume of a thread that no longer exists.
_STALE_SUBSTRINGS = ("no rollout found", "session not found", "thread not found")

# ChatGPT-plan / API usage-limit one-liners on turn.failed / error events.
_USAGE_LIMIT_SUBSTRINGS = ("usage limit", "hit your limit", "rate limit reached")

# Auth failures the user can fix by re-logging in (`codex login`).
_AUTH_SUBSTRINGS = (
    "401", "unauthorized", "token expired", "not logged in",
    "login required", "invalid api key", "authentication",
)


class _ErrorsMixin:
    """Maps Codex stderr/result text to the canonical error classes."""

    def classify_stderr(self, line: str) -> StderrClass:
        low = line.lower()
        if any(s in low for s in _STALE_SUBSTRINGS):
            return StderrClass.STALE_SESSION
        if any(s in low for s in _RETRYABLE_SUBSTRINGS):
            return StderrClass.RETRYABLE
        return StderrClass.NONE

    def is_retryable_api_error(self, text: str) -> bool:
        low = text.lower()
        # Auth failures need a re-login, not a resend — without this guard a
        # message containing both ("401 ... stream error") would raise the
        # re-login card AND kick off a doomed server-level retry loop.
        if any(s in low for s in _AUTH_SUBSTRINGS):
            return False
        return any(s in low for s in _RETRYABLE_SUBSTRINGS)

    def is_usage_limit(self, text: str) -> bool:
        # Genuine limit reports are one-liners; the length gate keeps prose that
        # merely quotes a limit phrase from ever matching (same contract as the
        # Claude provider's matcher).
        if not text or len(text) > 200:
            return False
        low = text.lower()
        return any(s in low for s in _USAGE_LIMIT_SUBSTRINGS)

    def is_auth_error(self, text: str, api_error_status=None) -> bool:
        if api_error_status == 401:
            return True
        if not text or len(text) > 300:
            return False
        low = text.lower()
        return any(s in low for s in _AUTH_SUBSTRINGS)

    def binary_not_found_hint(self) -> str:
        return ("Install the Codex CLI (`npm i -g @openai/codex`) or point the "
                "CLI path at it in Settings → Engines (`codex_path` config key).")

    @property
    def normal_termination_codes(self) -> frozenset:
        # A finished `codex exec` turn exits 0; SIGINT/SIGTERM stops map to
        # 130/143 like any subprocess.
        return frozenset({0, 130, 143})
