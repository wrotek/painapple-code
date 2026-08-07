"""
OpenAI Codex CLI provider (`codex exec --json`).

Unlike Claude (one persistent `claude -p` process streaming stream-json over
stdin/stdout across many turns), Codex runs **one `codex exec` process per
turn**: the prompt is a positional argv, the run emits newline-delimited JSON
events to stdout, and the process exits when the turn ends. Continuation is a
fresh `codex exec resume <thread_id> "<prompt>"`. So this provider declares
`persistent_process=False` and the session layer drives a per-turn spawn loop.

The adapter is assembled from focused mixins (this file is the combiner — see
`session_store.py` / `shadow_git.py` for the same pattern in this codebase):

    capabilities.py  → _CapabilitiesMixin  binary, availability, effort/perm
                                            vocabularies, skill/agent/plugin
                                            roots, context metering
    launch.py        → _LaunchMixin         build_command + image materialization
    translate.py     → _TranslateMixin      Codex events → canonical Claude shape
    summary.py       → _SummaryMixin         rich-commit summary fork (rollout copy)
    errors.py        → _ErrorsMixin          stderr classification / retry policy

Codex reports token counts but no per-turn USD cost, so result cost is left at 0
(see the step-two plan: tokens-only, cost null). Token usage is per-turn already,
so no cumulative→delta conversion is needed.
"""

from __future__ import annotations

from painapple_code.providers.base import Provider, Capabilities
from painapple_code.providers.codex.capabilities import _CapabilitiesMixin
from painapple_code.providers.codex.launch import _LaunchMixin
from painapple_code.providers.codex.translate import _TranslateMixin
from painapple_code.providers.codex.summary import _SummaryMixin
from painapple_code.providers.codex.errors import _ErrorsMixin


class CodexProvider(
    _CapabilitiesMixin,
    _LaunchMixin,
    _TranslateMixin,
    _SummaryMixin,
    _ErrorsMixin,
    Provider,
):
    """Adapter for the OpenAI Codex CLI (`codex exec --json`).

    The behaviour lives in the mixins above; this class only carries the static
    identity + capability flags and the MRO that composes them (mixins first, so
    their overrides win over the `Provider` defaults, with `super()` calls — e.g.
    `is_available` — still reaching the base implementation).
    """

    name = "codex"
    display_name = "Codex CLI"
    description = "OpenAI Codex CLI — one exec process per turn"
    # Same engine as codex-app-server but the plainer per-turn exec driver
    # (no native fork, no live interrupt) — kept out of the picker by default
    # so Codex appears once. Flip it on in Settings → Engines.
    default_enabled = False
    capabilities = Capabilities(
        resume=True,
        fork=False,                # no --fork-session equivalent
        permission_modes=True,
        effort=True,
        thinking_display=True,     # native `reasoning` items
        context_command=False,     # no /context equivalent in exec mode
        cumulative_cost=False,     # per-turn usage, and no USD figure at all
        # The post-turn fork summarizes the turn with Codex itself (see
        # summary.py / build_summary_fork). Codex has no `--fork-session`, and
        # `codex exec resume` writes in place, so the fork copies the thread's
        # rollout under a fresh id and resumes the copy — branching like Claude's
        # --fork-session without polluting the user's real thread.
        rich_commit_summaries=True,
        persistent_process=False,  # one `codex exec` per turn
        forward_plain_stderr=False,  # codex prints human progress to stderr
    )


# Registry contribution — see providers/claude.py for the convention. The
# package scanner in providers/__init__.py discovers this exactly like a flat
# module (pkgutil.iter_modules lists subpackages too).
PROVIDERS = [CodexProvider()]
