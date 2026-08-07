"""
OpenAI Codex provider over the **app-server** protocol (`codex app-server`).

The sibling `codex` provider drives `codex exec --json` — one throwaway process
*per turn*, prompt in argv, newline-JSON to stdout, exit. That's the
lowest-common-denominator path; it's why that provider declares `fork=False`,
`context_command=False`, no real model list, and a hardcoded context window.

This provider instead speaks the **persistent JSON-RPC protocol** the official
Codex IDE extension uses (`codex app-server --stdio`): one long-lived process
serves many threads and turns, streaming events as JSON-RPC notifications. It
unlocks native fork, a real (server-reported) context window, token deltas, and
— later — interactive approvals, none of which `codex exec` can express. It is
marked experimental in the CLI, so it ships *alongside* the stable `codex`
provider rather than replacing it; users pick which they want.

Because the wire is JSON-RPC rather than one-way lines, this provider sets
`transport="jsonrpc"`: the session layer hands the spawned process to a
transport driver (see `transport.py`) that owns the bidirectional conversation —
the `initialize` handshake, lazy `thread/start`/`thread/resume`, `turn/start`,
id-correlated responses, and server-initiated approval requests. The read side
is unchanged: each notification still flows through `parse_line` +
`translate_events`.

Assembled from focused mixins (this file is the combiner — see `codex/` and
`claude/` for the same layout):

    capabilities.py  → _CapabilitiesMixin  binary/auth, effort/perm vocab,
                                            skill/agent/plugin roots, real
                                            context window from token usage
    launch.py        → _LaunchMixin         build_command (`codex app-server`)
    transport.py     → JsonRpcTransport      the bidirectional JSON-RPC driver
    translate.py     → _TranslateMixin      JSON-RPC notifications → Claude shape
    summary.py       → _SummaryMixin         native rich-commit fork
                                             (ephemeral thread/fork + outputSchema)
    errors.py        → _ErrorsMixin          stderr classification / retry policy

The rich-commit summary is native here — an *ephemeral* `thread/fork` plus a
`turn/start` with `outputSchema`, no rollout-file copy (see `summary.py`). Only
stderr classification is reused verbatim from the `codex` exec provider (the
binary is the same, so its diagnostics are identical).
"""

from __future__ import annotations

from painapple_code.providers.base import Provider, Capabilities
from painapple_code.providers.codex_app_server.capabilities import _CapabilitiesMixin
from painapple_code.providers.codex_app_server.launch import _LaunchMixin
from painapple_code.providers.codex_app_server.translate import _TranslateMixin
# Native app-server summary (ephemeral thread/fork + outputSchema; no rollout
# copy). Errors are reused verbatim from the exec provider — identical stderr.
from painapple_code.providers.codex_app_server.summary import _SummaryMixin
from painapple_code.providers.codex.errors import _ErrorsMixin


class CodexAppServerProvider(
    _CapabilitiesMixin,
    _LaunchMixin,
    _TranslateMixin,
    _SummaryMixin,
    _ErrorsMixin,
    Provider,
):
    """Adapter for the OpenAI Codex CLI over the app-server JSON-RPC protocol.

    The behaviour lives in the mixins + the transport driver; this class carries
    the static identity + capability flags and the MRO that composes them (mixins
    first, so their overrides win, with `super()` calls — e.g. `is_available` —
    still reaching the base implementation).
    """

    name = "codex-app-server"
    display_name = "Codex (app-server)"
    description = "OpenAI Codex app-server — persistent JSON-RPC, native fork"
    capabilities = Capabilities(
        resume=True,
        fork=True,                 # native thread/fork (transport branches the
                                   # source thread; no rollout copy)
        permission_modes=True,
        effort=True,
        thinking_display=True,     # native reasoning items
        context_command=False,     # metered from thread/tokenUsage, not a probe
        cumulative_cost=False,     # per-turn usage, no USD figure
        rich_commit_summaries=True,
        persistent_process=True,   # one app-server process, many turns
        forward_plain_stderr=False,  # app-server logs human progress to stderr
        transport="jsonrpc",       # the session layer drives a transport driver
    )

    def make_transport(self, process, opts, session):
        # Imported lazily so the package import stays cheap and asyncio stays out
        # of the static provider description.
        from painapple_code.providers.codex_app_server.transport import JsonRpcTransport
        return JsonRpcTransport(process, opts, session, self)


# Registry contribution — discovered exactly like a flat module
# (pkgutil.iter_modules lists subpackages too), so adding this provider needed
# no edit to providers/__init__.py.
PROVIDERS = [CodexAppServerProvider()]
