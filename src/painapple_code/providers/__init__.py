"""
CLI AI provider abstraction.

The server runs a headless CLI agent as a subprocess and streams its JSON
output to WebSocket clients. Historically this was hardwired to the Claude Code
CLI (`claude -p --output-format stream-json`). This package introduces a
`Provider` seam so other CLI agents (codex, gemini-cli, …) can be added as new
adapter modules rather than as cross-cutting edits.

Step one ships only the working `ClaudeProvider`; the canonical internal/wire
event shape *is* Claude's stream-json schema, so `ClaudeProvider` is a
near-identity adapter and the rest of the app is unchanged. Future providers
translate their output *into* this canonical shape.

Adding a provider is drop-in — no edit to this file:

  * Create `providers/foo.py` with a `FooProvider(Provider)` subclass and a
    module-level `PROVIDERS = [FooProvider()]`. The package scanner below
    discovers it automatically.

Registry usage:

    from painapple_code.providers import get_provider
    provider = get_provider("claude")          # default
    cmd = provider.build_command(LaunchOptions(model="claude-opus-5"))
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from importlib.metadata import entry_points

from painapple_code.providers.base import (
    Provider,
    Capabilities,
    LaunchOptions,
    CostState,
    StderrClass,
)
# Re-exported for callers that import adapter classes directly. The live
# registry is built by discovery below, not from these names.
from painapple_code.providers.claude import ClaudeProvider
from painapple_code.providers.codex import CodexProvider
from painapple_code.providers.codex_app_server import CodexAppServerProvider

logger = logging.getLogger(__name__)

# Default provider for new sessions, and the fallback when a session records no
# provider (pre-field sessions were all created against the Claude CLI). The
# `claude-sdk` driver is wire-compatible — it drives the same CLI with the same
# `--resume`, teeing its raw stream-json verbatim — so legacy sessions resume
# under it unchanged while gaining the SDK control plane (interactive permission
# cards, native interrupt). Overridable per-tier via `--default-provider` or the
# `default_provider` config key. Also wins any name collision and sorts first in
# the picker.
DEFAULT_PROVIDER = "claude-sdk"


def _register(found: dict[str, Provider], provider: Provider, *, source: str) -> None:
    """Add a discovered provider, keeping the first registration for a name.

    First-wins means in-tree adapters can't be silently shadowed by a later
    (e.g. third-party) module claiming the same name — a collision is logged
    instead.
    """
    name = getattr(provider, "name", None)
    if not name:
        logger.warning("Ignoring provider from %s with no name: %r", source, provider)
        return
    if name in found:
        logger.warning(
            "Duplicate provider name %r from %s ignored (kept %s)",
            name, source, type(found[name]).__module__,
        )
        return
    found[name] = provider


def _discover_providers() -> dict[str, Provider]:
    """Build the registry by scanning this package for modules that export a
    module-level ``PROVIDERS`` list of ready instances.

    A module that exports no ``PROVIDERS`` (base, stub, this file) contributes
    nothing, so the framework modules need no special-casing. A module that
    fails to import is logged and skipped rather than wedging the whole
    registry — one broken adapter can't take down the others.
    """
    found: dict[str, Provider] = {}
    for info in pkgutil.iter_modules(__path__):
        try:
            mod = importlib.import_module(f"{__name__}.{info.name}")
        except Exception:
            logger.exception("Failed to import provider module %r", info.name)
            continue
        for provider in getattr(mod, "PROVIDERS", ()):
            _register(found, provider, source=f"module {info.name!r}")
    _load_entry_point_providers(found)
    return _ordered(found)


# Entry-point group an external pip package declares to ship a provider without
# touching this repo, e.g. in its pyproject.toml:
#
#     [project.entry-points."painapple_code.providers"]
#     foo = "painapple_foo:PROVIDERS"   # -> a Provider, a subclass, or a list
_ENTRY_POINT_GROUP = "painapple_code.providers"


def _coerce_providers(obj, *, source: str) -> list[Provider]:
    """Normalize whatever an entry point resolves to into Provider instances.

    Accepts a Provider instance, a Provider subclass (instantiated no-arg), or
    an iterable of either — so external packages can point an entry point at the
    same ``PROVIDERS`` list they'd use for the in-tree convention.
    """
    if isinstance(obj, Provider):
        return [obj]
    if isinstance(obj, type) and issubclass(obj, Provider):
        return [obj()]
    if isinstance(obj, (list, tuple, set)):
        out: list[Provider] = []
        for item in obj:
            out.extend(_coerce_providers(item, source=source))
        return out
    logger.warning("Entry point %s resolved to non-provider %r; ignoring", source, obj)
    return []


def _load_entry_point_providers(found: dict[str, Provider]) -> None:
    """Load providers shipped by external packages via the
    ``painapple_code.providers`` entry-point group into ``found``.

    Runs after the in-tree scan, so first-wins means a third-party package can
    *add* an engine but never shadow a built-in name (e.g. ``claude``). A
    failing entry point is logged and skipped — a broken plugin can't take down
    the registry.
    """
    try:
        eps = entry_points(group=_ENTRY_POINT_GROUP)
    except Exception:  # pragma: no cover - defensive against metadata oddities
        logger.exception("Failed to enumerate %r entry points", _ENTRY_POINT_GROUP)
        return
    for ep in eps:
        source = f"entry point {ep.name!r}"
        try:
            obj = ep.load()
        except Exception:
            logger.exception("Failed to load provider %s", source)
            continue
        for provider in _coerce_providers(obj, source=source):
            _register(found, provider, source=source)


def _ordered(found: dict[str, Provider]) -> dict[str, Provider]:
    """Deterministic picker order: the default first, then alphabetical — so the
    engine list is stable regardless of filesystem/import order."""
    names = sorted(found, key=lambda n: (n != DEFAULT_PROVIDER, n))
    return {n: found[n] for n in names}


# Provider singletons. Providers are stateless (per-process cost tracking lives
# in a per-session CostState), so a single shared instance per name is correct.
_PROVIDERS: dict[str, Provider] = _discover_providers()


def get_provider(name: str | None = None) -> Provider:
    """Resolve a provider by name, falling back to the default (Claude).

    Unknown names fall back to the default provider with no error so a stale or
    typo'd persisted `provider` field can never wedge a session.
    """
    if not name:
        name = DEFAULT_PROVIDER
    return _PROVIDERS.get(name, _PROVIDERS[DEFAULT_PROVIDER])


def provider_names() -> list[str]:
    """All registered provider names."""
    return list(_PROVIDERS)


def all_providers() -> list[Provider]:
    """All registered provider singletons, in registration order.

    Each carries its capabilities/availability/accounts via
    `Provider.describe()`.
    """
    return list(_PROVIDERS.values())


def valid_permission_values() -> set[str]:
    """Every permission value any provider accepts — the union of every
    provider's registered ``permission_modes()`` (Claude included; it's just
    another provider). No engine is special-cased.

    The permission endpoints validate against this so each provider's own
    vocabulary (Claude's plan/dontAsk/…, Codex's read-only/workspace-write/…) is
    accepted. Adding a provider widens the allowlist automatically.
    """
    values: set[str] = set()
    for provider in all_providers():
        values.update(
            m["value"] for m in provider.permission_modes() if m.get("value")
        )
    return values


__all__ = [
    "Provider",
    "Capabilities",
    "LaunchOptions",
    "CostState",
    "StderrClass",
    "ClaudeProvider",
    "CodexProvider",
    "CodexAppServerProvider",
    "DEFAULT_PROVIDER",
    "get_provider",
    "provider_names",
    "all_providers",
    "valid_permission_values",
]
