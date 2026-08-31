"""
Claude Code via the Claude Agent SDK — SDK-backed provider.

Same engine as `ClaudeProvider`, but the subprocess the server spawns is a
thin Python *driver* (`providers/claude_sdk/driver.py`) that runs
`ClaudeSDKClient` in-process instead of exec'ing `claude -p` directly:

    server ──stream-json lines──> driver ──SDK control protocol──> claude CLI

The driver tees the CLI's raw stream-json verbatim onto its own stdout and
forwards the server's canonical user messages from stdin into the SDK, so
from the session layer's point of view this provider is wire-identical to
`ClaudeProvider`: same "lines" transport, same events, same stderr strings,
same signal semantics (SIGINT/SIGTERM → clean exit). Everything Claude-shaped
(cost normalization, stderr classification, summary fork, /context probe,
models/accounts/permission vocab) is inherited unchanged.

What the extra hop buys is the SDK's control plane — a first-class seam for
interactive permissions (`can_use_tool`), native interrupt, and mid-session
mode/model changes. See docs-ai/plans/2026-07-07-agent-sdk-migration.md.

Selection: this is the default provider (DEFAULT_PROVIDER) — new sessions adopt
it, and sessions that record no provider fall back to it. Sessions persist
`provider: "claude-sdk"` in meta. A tier can pin the line-protocol `claude`
provider instead via the `default_provider` config key or the
`--default-provider` server flag.
"""

from __future__ import annotations

import sys
from dataclasses import replace

from painapple_code.providers.base import LaunchOptions
from painapple_code.providers.claude import ClaudeProvider


class ClaudeSdkProvider(ClaudeProvider):
    """Claude Code driven through `claude-agent-sdk` in a driver subprocess."""

    name = "claude-sdk"
    # Just "Claude Code" — the line-protocol driver this was once
    # distinguished from is no longer registered.
    display_name = "Claude Code"
    description = "Anthropic Claude Code via the Agent SDK — live controls, ask-mode cards"
    # The Claude driver — in the picker out of the box. (The plainer
    # line-protocol ClaudeProvider it subclasses is no longer registered at
    # all; it survives only as this class's base implementation.)
    default_enabled = True
    # Same engine, same feature surface as Claude — plus the SDK's
    # can_use_tool permission round-trip (driver ⇄ server ⇄ client) and its
    # control plane (live permission-mode/model switches, warm-process
    # interrupt) via control_request/control_done frames on the same pipe.
    capabilities = replace(ClaudeProvider.capabilities,
                           interactive_permissions=True,
                           live_controls=True)

    def permission_modes(self) -> list[dict]:
        # Claude's modes plus "Ask" (CLI mode `default`) — the manual-accept
        # mode: reads are auto-allowed, everything else surfaces a permission
        # card. Only offered here: on the line-protocol provider `default`
        # just auto-denies (nothing can answer the prompt), so exposing it
        # there would be a trap.
        modes = ClaudeProvider.permission_modes(self)
        ask = {"value": "default", "label": "Ask",
               "desc": "Approve each edit/command via permission card",
               "color": "#2dd4bf"}
        modes.insert(1, ask)  # right after Plan
        # The base `claude` provider's Accept Edits desc says "deny others" —
        # accurate for line-protocol `claude -p`, where there's no can_use_tool
        # gate so out-of-workspace ops hard-deny (surface as is_error results).
        # Here the SDK's can_use_tool gate is wired for acceptEdits too
        # (driver.py), so those ops surface an approve/deny card instead of
        # denying. Patch the one field the interactive-permissions seam made
        # stale, leaving the rest of the inherited vocab untouched.
        for m in modes:
            if m["value"] == "acceptEdits":
                m["desc"] = "Auto-approve workspace edits; others prompt for approval"
        return modes

    def default_permission_mode(self) -> str:
        # Ask, not the base "dontAsk". The SDK engine can actually answer a
        # prompt (can_use_tool → permission card), so the sane out-of-the-box
        # default is manual-accept — reads flow, edits/commands surface a card —
        # rather than auto-denying. (On the line-protocol provider "default"
        # would be a trap: nothing can answer, so every ask becomes a denial;
        # that's why the base stays "dontAsk".)
        return "default"

    def build_command(self, opts: LaunchOptions) -> list[str]:
        # The server's venv python, not "python" off PATH — the driver imports
        # both painapple_code and claude_agent_sdk from this environment.
        cmd = [
            sys.executable, "-u", "-m",
            "painapple_code.providers.claude_sdk.driver",
        ]
        # win32 + bare default: omit --cli-path so the SDK's _find_cli()
        # discovers the CLI — it prefers a native claude.exe (bundled or
        # installed) and refuses npm's claude.cmd shim with a curated
        # remediation (CVE-2024-27980 class); which-resolving "claude" here
        # would hand the SDK exactly the shim it's designed to reject.
        # POSIX keeps passing the resolved system binary unconditionally —
        # omitting it would let the SDK prefer its _bundled/ CLI over the
        # user's installed claude, a silent version switch.
        if sys.platform != "win32" or self.binary() != self.default_binary:
            cmd.extend(["--cli-path", self.binary()])

        if opts.model:
            cmd.extend(["--model", opts.model])

        if opts.fallback_model:
            cmd.extend(["--fallback-model", opts.fallback_model])

        # "high" is the CLI default; skip to avoid noise (mirrors launch.py).
        if opts.effort and opts.effort != "high":
            cmd.extend(["--effort", opts.effort])

        cmd.extend(["--permission-mode", opts.permission_mode or self.default_permission_mode()])

        if opts.fork_from_session_id:
            cmd.extend(["--resume", opts.fork_from_session_id, "--fork-session"])
        elif opts.session_id:
            cmd.extend(["--resume", opts.session_id])

        return cmd

    def binary_not_found_hint(self) -> str:
        return ("The SDK driver spawns the Claude CLI; install it and make "
                "sure it's on the server's PATH (or set claude_path in config).")

    def is_available(self) -> tuple[bool, str | None]:
        try:
            import claude_agent_sdk  # noqa: F401
        except ImportError:
            return False, ("claude-agent-sdk not installed in the server venv "
                           "(pip install claude-agent-sdk)")
        # SDK present — availability then hinges on the claude CLI, same as
        # the line-protocol provider.
        return super().is_available()


PROVIDERS = [ClaudeSdkProvider()]
