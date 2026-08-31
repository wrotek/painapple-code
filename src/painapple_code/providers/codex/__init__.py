"""
Codex family — shared base mixins for the `codex-app-server` provider.

This package used to define `CodexProvider`, the `codex exec --json` driver
(one throwaway process per turn, prompt as a positional argv). It was removed
from the engine registry — and its exec-only code (`launch.py`, the
rollout-copy summary fork) deleted — because `codex exec` accepts its prompt
ONLY as a command-line argument: every turn's prompt was readable in `ps` /
`/proc/<pid>/cmdline` by any local account for the life of the turn (see
SECURITY.md, "Prompts reach `ps` on the `codex` engine", and the
`Capabilities.prompt_in_argv` seam that disclosed it). The app-server driver
speaks JSON-RPC over stdio and has no such leak, and had already superseded
exec on every other axis (native fork, live interrupt, real context window).

What remains here is the CLI-shaped knowledge both drivers always shared —
same binary, same `$CODEX_HOME` layout, same event vocabulary — inherited by
`codex_app_server`:

    capabilities.py  → _CapabilitiesMixin  binary, availability, models cache,
                                            effort/perm vocabularies,
                                            skill/agent/plugin roots
    translate.py     → _TranslateMixin      canonical-event builders
                                            (_assistant/_tool_use/…)
    errors.py        → _ErrorsMixin          stderr classification / retry policy

No `PROVIDERS` export: the package scanner registers nothing from here.
Sessions persisted with provider="codex" resolve to codex-app-server via the
legacy-alias map in providers/__init__.py `get_provider()` — both drivers
store threads in the same `$CODEX_HOME/sessions` rollouts, so an old exec
session's thread id resumes natively under the app-server.
"""
