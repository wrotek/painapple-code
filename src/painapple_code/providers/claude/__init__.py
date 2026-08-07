"""
Claude Code CLI provider.

The reference implementation. Bodies here were moved (not rewritten) out of
`services/agent_session.py` and `utils/agent_cli.py`, so behavior is
identical — this is purely the relocation of Claude-specific logic behind the
`Provider` seam.

Claude's stream-json schema *is* the canonical internal event shape, so this
adapter is a near-identity: it inherits the base `translate_events` and only
normalizes cumulative cost to per-turn deltas. It's
assembled from focused mixins (this file is the combiner — see session_store.py
/ shadow_git.py for the same pattern):

    capabilities.py  → _CapabilitiesMixin  binary, accounts, models, effort/perm
                                            vocabularies, fetch_context,
                                            skill/agent/plugin roots
    launch.py        → _LaunchMixin         build_command (`claude -p …`)
    translate.py     → _TranslateMixin      normalize_result (cumulative → delta)
    summary.py       → _SummaryMixin         rich-commit summary fork (--fork-session)
    errors.py        → _ErrorsMixin          stderr classification / retry policy
"""

from __future__ import annotations

from painapple_code.providers.base import Provider, Capabilities
from painapple_code.providers.claude.capabilities import _CapabilitiesMixin
from painapple_code.providers.claude.launch import _LaunchMixin
from painapple_code.providers.claude.translate import _TranslateMixin
from painapple_code.providers.claude.summary import _SummaryMixin
from painapple_code.providers.claude.errors import _ErrorsMixin


class ClaudeProvider(
    _CapabilitiesMixin,
    _LaunchMixin,
    _TranslateMixin,
    _SummaryMixin,
    _ErrorsMixin,
    Provider,
):
    """Adapter for the Claude Code CLI (`claude -p ... --output-format stream-json`).

    The behaviour lives in the mixins above; this class only carries the static
    identity + capability flags and the MRO that composes them (mixins first, so
    their overrides win over the `Provider` defaults).
    """

    name = "claude"
    display_name = "Claude Code"
    description = "Anthropic Claude Code CLI — line-protocol driver"
    # Same engine as claude-sdk but the plainer driver (no live controls, no
    # ask-mode cards) — kept out of the picker by default so Claude appears
    # once. Flip it on in Settings → Engines.
    default_enabled = False
    capabilities = Capabilities(
        resume=True,
        fork=True,
        permission_modes=True,
        effort=True,
        thinking_display=True,
        context_command=True,
        cumulative_cost=True,
        rich_commit_summaries=True,
        persistent_process=True,   # one `claude -p` process serves many turns
        forward_plain_stderr=True,
    )


# Instances this module contributes to the registry. The package scanner
# (providers/__init__.py) collects every module's PROVIDERS list, so adding a
# provider is "drop a file that exports PROVIDERS" — no core edit. (A subpackage
# is discovered exactly like a flat module.)
PROVIDERS = [ClaudeProvider()]
