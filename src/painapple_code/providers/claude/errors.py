"""Claude provider — stderr classification and retry/termination policy."""

from __future__ import annotations

import re

from painapple_code.providers.base import StderrClass
from painapple_code.utils.agent_cli import NORMAL_TERMINATION_CODES

# Patterns that indicate retryable transient API errors (5xx, overloaded, etc.)
_RETRYABLE_ERROR_PATTERNS = [
    re.compile(r'API Error:\s*5\d{2}\b'),
    re.compile(r'"type":\s*"api_error"'),
    re.compile(r'overloaded', re.IGNORECASE),
    re.compile(r'Internal server error', re.IGNORECASE),
]

# Usage/rate/session limit. The CLI wording varies by limit kind: "hit your
# limit", "hit your session limit", "hit your weekly limit", … — one optional
# word covers them all without matching unrelated "limit" mentions.
_USAGE_LIMIT_RE = re.compile(r"hit your (?:\w+\s+)?limit", re.IGNORECASE)

# Patterns that indicate NON-retryable errors (checked first to avoid retrying)
_NON_RETRYABLE_PATTERNS = [
    _USAGE_LIMIT_RE,
    re.compile(r'authentication', re.IGNORECASE),
    re.compile(r'invalid.*api.*key', re.IGNORECASE),
    re.compile(r'credit', re.IGNORECASE),
]

# Patterns in a failed turn's result text that mean "re-login fixes this".
# Narrower than _NON_RETRYABLE_PATTERNS (no `credit` — a billing problem, not
# something `claude auth login` resolves).
_AUTH_ERROR_PATTERNS = [
    re.compile(r'failed to authenticate', re.IGNORECASE),
    re.compile(r'authentication_error', re.IGNORECASE),
    re.compile(r'invalid authentication', re.IGNORECASE),
    re.compile(r'oauth token (?:has )?expired', re.IGNORECASE),
    re.compile(r'invalid.*api.*key', re.IGNORECASE),
]


class _ErrorsMixin:
    """Maps Claude stderr/result text to the canonical error classes."""

    def classify_stderr(self, line: str) -> StderrClass:
        if "No conversation found with session ID" in line:
            return StderrClass.STALE_SESSION
        if "compacting" in line.lower():
            return StderrClass.COMPACTING
        if self.is_retryable_api_error(line):
            return StderrClass.RETRYABLE
        return StderrClass.NONE

    def is_retryable_api_error(self, text: str) -> bool:
        for pattern in _NON_RETRYABLE_PATTERNS:
            if pattern.search(text):
                return False
        for pattern in _RETRYABLE_ERROR_PATTERNS:
            if pattern.search(text):
                return True
        return False

    def is_auth_error(self, text: str, api_error_status=None) -> bool:
        if api_error_status == 401:
            return True
        return any(p.search(text) for p in _AUTH_ERROR_PATTERNS)

    def is_usage_limit(self, text: str) -> bool:
        # Genuine limit messages are one-liners (~50-85 chars: "Error during
        # compaction: You've hit your session limit · resets 4pm (…)"). The
        # length cap keeps the substring match from misfiring on long text
        # that merely QUOTES the phrase — an assistant reply discussing this
        # very bug, pasted logs inside an error string, etc.
        return bool(text) and len(text) <= 200 and bool(_USAGE_LIMIT_RE.search(text))

    @property
    def normal_termination_codes(self) -> frozenset:
        return NORMAL_TERMINATION_CODES
