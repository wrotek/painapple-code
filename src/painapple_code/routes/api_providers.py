"""
Providers API — the engine catalog behind the per-session provider picker.

One read endpoint: every registered provider's `describe()` (display name,
capabilities, availability + fix hint, models, efforts, permission modes)
plus which engine new sessions currently default to. The registry is the
single source of truth — a drop-in provider (module `PROVIDERS` export or
`painapple_code.providers` entry point) appears here automatically; nothing
is hardcoded per engine.
"""

import logging

from fastapi import APIRouter, Request

from painapple_code.providers import all_providers
from painapple_code.routes.dependencies import (
    effective_default_provider,
    provider_enabled_map,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["providers"])


@router.get("/api/providers")
async def list_providers(request: Request):
    """Engine catalog for the picker UI.

    Returns each provider's full `describe()` dict — the UI greys out
    unavailable engines (showing `unavailable_reason` as the fix hint) and
    uses `capabilities` to gate per-engine chrome (model chip, fork/Discuss,
    cost display, /context). `default` is the engine a new session gets when
    the picker isn't touched (--default-provider flag → `default_provider`
    config key → registry default).
    """
    bridge = getattr(request.app.state, "bridge", None)
    enabled = provider_enabled_map(request.app)
    return {
        # `enabled` (Settings toggles, default engine always on) gates which
        # rows the picker offers; a session already bound to a disabled engine
        # still renders it. `default_enabled` is the provider's own pre-
        # override default, shown in Settings as "what Reset returns to".
        "providers": [
            {**p.describe(), "enabled": enabled.get(p.name, True)}
            for p in all_providers()
        ],
        "default": effective_default_provider(request.app).name,
        # A --default-provider server flag outranks the config key — the UI
        # disables its "set as default" affordance while pinned.
        "default_pinned_by_flag": bool(getattr(bridge, "default_provider", None)),
    }
