"""Claude provider — the rich-commit summary fork.

Forks the live `claude -p` session with Haiku to write structured commit
sections, then pulls `structured_output` + usage out of the wrapper JSON. Mixed
into `ClaudeProvider`.
"""

from __future__ import annotations

import json
from typing import Optional

from painapple_code.providers.base import SummaryForkPlan


class _SummaryMixin:
    """Fork the live session with Haiku and read back the structured sections."""

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
        """Fork the live session with Haiku to write structured commit sections.

        `--fork-session` branches a throwaway session off the real one, so the
        summary turn never touches the user's conversation; `--json-schema`
        forces the structured shape and `--output-format json` wraps it with
        cost/usage on stdout.

        The prompt is fed over stdin (bare `-p`, no positional) rather than as an
        argv element: the journey + tools prompt can be large, so this keeps it
        clear of ARG_MAX and out of `ps`. The generic spawner writes
        `stdin_input` before reading stdout.
        """
        from painapple_code.bridge_paths import get_summary_model
        from painapple_code.utils.token_profiles import build_env as build_token_env

        # Always plain haiku — the [1m] variant hangs with --fork-session from
        # opus[1m] sessions (every fork times out at 300s even for 30k context).
        summary_model = get_summary_model()
        return SummaryForkPlan(
            argv=[
                self.binary(),
                "--resume", session_id,
                "--fork-session",
                "--model", summary_model,
                "--tools", "",                  # disable all tools
                "--no-session-persistence",
                "-p",                            # print mode; prompt arrives on stdin
                "--output-format", "json",      # wrapper JSON carries cost/usage
                "--json-schema", schema_json,   # force structured output
            ],
            env=build_token_env(token_profile),
            model=summary_model,
            output_file=None,                   # structured_output is on stdout
            stdin_input=fork_prompt,            # feed the prompt via stdin (not argv)
        )

    def parse_summary_fork(
        self,
        *,
        plan: SummaryForkPlan,
        returncode: int,
        stdout: bytes,
        stderr: bytes,
    ) -> tuple[Optional[dict], Optional[dict]]:
        """Pull `structured_output` + usage out of the wrapper JSON on stdout."""
        if returncode != 0:
            return None, None
        try:
            result = json.loads(stdout.decode())
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, None
        structured = result.get("structured_output")
        if not isinstance(structured, dict):
            return None, None
        usage = result.get("usage") or {}
        cost = {
            "cost": result.get("total_cost_usd", 0.0) or 0.0,
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
        }
        return structured, cost
