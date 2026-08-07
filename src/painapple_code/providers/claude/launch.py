"""Claude provider — command building.

Turns a `LaunchOptions` into the persistent `claude -p … --output-format
stream-json` argv (model, effort, permission mode, resume/fork). Mixed into
`ClaudeProvider`.
"""

from __future__ import annotations

from painapple_code.providers.base import LaunchOptions


class _LaunchMixin:
    """Builds the `claude -p` command line."""

    def build_command(self, opts: LaunchOptions) -> list[str]:
        cmd = [
            self.binary(),
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            # Opus 4.7 changed the thinking-block default from "summarized"
            # to "omitted" (empty text, signature only). Restore summaries
            # on all models — the flag is a no-op where display was already
            # "summarized". See anthropics/claude-code#8477 comment 4269024077.
            "--thinking-display", "summarized",
        ]

        if opts.model:
            cmd.extend(["--model", opts.model])

        if opts.fallback_model:
            cmd.extend(["--fallback-model", opts.fallback_model])

        # "high" is the CLI default; skip to avoid noise.
        if opts.effort and opts.effort != "high":
            cmd.extend(["--effort", opts.effort])

        # Fall back to this provider's own default when no mode was resolved.
        cmd.extend(["--permission-mode", opts.permission_mode or self.default_permission_mode()])

        # Fork from another session (new session with conversation history),
        # else resume an existing one.
        if opts.fork_from_session_id:
            cmd.extend(["--resume", opts.fork_from_session_id, "--fork-session"])
        elif opts.session_id:
            cmd.extend(["--resume", opts.session_id])

        return cmd
