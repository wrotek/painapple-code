"""
Bridge Config API Routes - bridge-wide settings.

These endpoints manage:
- Quick Action Presets (~/.painapple-code/presets/*.json)
- Engine CLI binary paths (per-provider, self-described config keys)
- Max thinking tokens
- API auto-retry max
- Default permission levels
- Token profiles
- Models (selectable list + summary_model)
- Default effort level
- Session timeout settings
"""

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from painapple_code import bridge_paths

logger = logging.getLogger(__name__)

router = APIRouter(tags=["bridge:config"])

# Default max thinking tokens (31999 to stay under limit, 63999 is Opus 4.5 max)
DEFAULT_MAX_THINKING_TOKENS = 31999


# ═══════════════════════════════════════════════════════════════════
# Quick Action Presets  (~/.painapple-code/presets/*.json)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/presets")
async def get_presets():
    """List all quick-action presets (one JSON file per preset)."""
    return bridge_paths.load_all_presets()


@router.put("/api/bridge/presets/{preset_id}")
async def save_preset(preset_id: str, data: dict):
    """Create or update a preset."""
    bridge_paths.save_preset(preset_id, data)
    return bridge_paths.load_all_presets()


@router.delete("/api/bridge/presets/{preset_id}")
async def delete_preset(preset_id: str):
    """Delete a preset file."""
    deleted = bridge_paths.delete_preset(preset_id)
    return {"deleted": deleted, "presets": bridge_paths.load_all_presets()}


# ═══════════════════════════════════════════════════════════════════
# Engine CLI paths (per-provider binary override, self-described key)
# ═══════════════════════════════════════════════════════════════════

def _provider_or_404(name: str):
    from painapple_code.providers import get_provider, provider_names
    if name not in provider_names():
        raise HTTPException(status_code=404, detail=f"Unknown provider: {name}")
    return get_provider(name)


async def _engine_path_payload(p) -> dict:
    """Current binary override + resolution/version probe for one engine.

    ``path`` is the raw config value (None = unset → ``default_binary`` from
    PATH). Same-engine driver variants share a config key (both providers
    self-describe the same one), so the payload is identical across them.
    """
    if not p.path_config_key:
        return {"provider": p.name, "configurable": False}
    config = bridge_paths.load_global_config()
    configured = config.get(p.path_config_key)
    current = configured or p.default_binary
    resolved = current if Path(current).is_absolute() else shutil.which(current)

    version = None
    if resolved:
        try:
            # Off the event loop — a hung `<cli> --version` would otherwise
            # block every other request for up to 5s.
            result = await asyncio.to_thread(
                subprocess.run,
                # `resolved`, not `current`: on win32 a bare npm-shim name
                # ("claude" → claude.cmd) isn't spawnable, but the full
                # path shutil.which returned is.
                [resolved, "--version"],
                capture_output=True,
                text=True, encoding="utf-8", errors="replace",
                timeout=5,
            )
            if result.returncode == 0:
                version = result.stdout.strip()
        except Exception:
            pass

    return {
        "provider": p.name,
        "configurable": True,
        "path": configured,
        "default_binary": p.default_binary,
        "resolved": resolved,
        "version": version,
    }


@router.get("/api/bridge/engine-path/{provider_name}")
async def get_engine_path(provider_name: str):
    """Configured CLI binary for one engine (provider self-describes the
    config key — nothing per-engine is hardcoded here)."""
    return await _engine_path_payload(_provider_or_404(provider_name))


@router.put("/api/bridge/engine-path/{provider_name}")
async def set_engine_path(provider_name: str, request: Request):
    """Set (or clear with null/empty) an engine's CLI binary path.

    Explicit paths must exist and be files; clearing always succeeds (falls
    back to ``default_binary`` on PATH — availability just reflects reality,
    so a stale override can be removed even with the CLI uninstalled).
    """
    p = _provider_or_404(provider_name)
    if not p.path_config_key:
        raise HTTPException(
            status_code=400,
            detail=f"{p.display_name} has no configurable CLI path")

    body = await request.json()
    new_path = (body.get("path") or "").strip()

    if new_path and new_path != p.default_binary:
        if not Path(new_path).exists():
            raise HTTPException(status_code=400, detail=f"Path does not exist: {new_path}")
        if not Path(new_path).is_file():
            raise HTTPException(status_code=400, detail=f"Path is not a file: {new_path}")

    config = bridge_paths.load_global_config()
    if not new_path or new_path == p.default_binary:
        config.pop(p.path_config_key, None)
    else:
        config[p.path_config_key] = new_path

    bridge_paths.save_global_config(config)
    logger.info(f"Engine path for {p.name} ({p.path_config_key}) updated to: {new_path or '(default)'}")

    return await _engine_path_payload(p)


# ═══════════════════════════════════════════════════════════════════
# Engine model visibility (per-model show/hide, self-described namespace)
# ═══════════════════════════════════════════════════════════════════

def _engine_models_payload(p) -> dict:
    """One engine's FULL catalog with per-model `enabled` flags merged in.

    Settings needs the unfiltered list (hidden models render with their
    toggle off) — unlike /api/providers, which serves `enabled_models()`
    so pickers only see what the user kept listed. `disabled` is the raw
    stored set: it may carry ids not in the current catalog (CLI-owned
    catalogs churn); those are preserved, not pruned.
    """
    disabled = p.disabled_model_ids()
    return {
        "provider": p.name,
        "models_key": p.models_key or p.name,
        "editable": p.models_editable,
        "models": [
            {**m, "enabled": m.get("id") not in disabled} for m in p.models()
        ],
        "disabled": sorted(disabled),
    }


@router.get("/api/bridge/engine-models/{provider_name}")
async def get_engine_models(provider_name: str):
    """Full model catalog + visibility flags for one engine."""
    return _engine_models_payload(_provider_or_404(provider_name))


@router.put("/api/bridge/engine-models/{provider_name}")
async def set_engine_models(provider_name: str, request: Request):
    """Replace the hidden-model set for one engine: ``{disabled: [ids]}``.

    Stored under the provider's `models_key` namespace, so driver variants
    sharing a catalog (claude/claude-sdk, codex/codex-app-server) share the
    curation. An empty list clears the key. Ids are stored verbatim — no
    catalog-membership pruning, so a preference survives a CLI catalog
    refresh that temporarily drops the model.
    """
    p = _provider_or_404(provider_name)
    body = await request.json()
    disabled = body.get("disabled")
    if not isinstance(disabled, list) or not all(isinstance(x, str) for x in disabled):
        raise HTTPException(status_code=400, detail="disabled must be a list of model ids")

    key = p.models_key or p.name
    cleaned = sorted({x.strip() for x in disabled if x.strip()})

    config = bridge_paths.load_global_config()
    overrides = dict(config.get("models_disabled") or {})
    if cleaned:
        overrides[key] = cleaned
    else:
        overrides.pop(key, None)
    if overrides:
        config["models_disabled"] = overrides
    else:
        config.pop("models_disabled", None)

    bridge_paths.save_global_config(config)
    logger.info(f"Hidden models for {key}: {cleaned or '(none)'}")

    return _engine_models_payload(p)


# ═══════════════════════════════════════════════════════════════════
# Engine CLI auth (login-status probe, self-described commands)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/engine-auth/{provider_name}")
async def get_engine_auth(provider_name: str):
    """Login status for one engine's CLI (Settings → Engines auth row).

    Runs the provider's self-described `auth_status_args` probe against the
    configured binary and returns its parsed verdict plus `login_command` —
    the full interactive login invocation the client drops into a PTY
    terminal tab. `logged_in: null` = probe couldn't run (binary missing,
    timeout); `supported: false` = the provider describes no auth probe.
    """
    from painapple_code.utils.proc import shell_join

    p = _provider_or_404(provider_name)
    if not p.auth_status_args:
        return {"provider": p.name, "supported": False}

    config = bridge_paths.load_global_config()
    configured = config.get(p.path_config_key) if p.path_config_key else None
    current = configured or p.default_binary
    resolved = current if Path(current).is_absolute() else shutil.which(current)
    login_command = (
        shell_join([current, *p.auth_login_args]) if p.auth_login_args else None
    )

    logged_in, detail = None, ""
    if resolved:
        try:
            # Off the event loop — a hung status probe must not block requests.
            result = await asyncio.to_thread(
                subprocess.run,
                # `resolved` for the same reason as the version probe:
                # bare .cmd shim names aren't spawnable on win32.
                [resolved, *p.auth_status_args],
                capture_output=True,
                text=True, encoding="utf-8", errors="replace",
                timeout=10,
            )
            parsed = p.parse_auth_status(
                result.returncode, result.stdout or "", result.stderr or "")
            logged_in = parsed.get("logged_in")
            detail = parsed.get("detail") or ""
        except Exception:
            pass

    return {
        "provider": p.name,
        "supported": True,
        "logged_in": logged_in,
        "detail": detail,
        "login_command": login_command,
    }


# ═══════════════════════════════════════════════════════════════════
# Engine session defaults (per-engine model / effort / account / journal)
# ═══════════════════════════════════════════════════════════════════
#
# Maps in the global config keyed by the provider's `models_key` namespace
# (driver pairs share, same as `models_disabled`):
#   default_models / default_efforts / default_token_profiles
# The flat legacy keys survive as read fallbacks; the first PUT folds them
# into map entries for every engine that can speak the value, then drops
# them — so clearing a per-engine default actually sticks.

_DEFAULTS_FIELDS = [
    # (request/response field, config map key, legacy flat key)
    ("default_model", "default_models", "default_model"),
    ("default_effort", "default_efforts", "default_effort"),
    ("token_profile", "default_token_profiles", "default_token_profile"),
]


def _engine_speaks_default(p, field: str, value: str) -> bool:
    """Whether an engine can hold `value` as its default for `field`."""
    if field == "default_model":
        return any(
            value.startswith(m["id"])
            for m in p.enabled_models() if m.get("id"))
    if field == "default_effort":
        levels = p.effort_levels()
        return not levels or value in levels
    if field == "token_profile":
        return bool(p.accounts())
    return False


def _migrate_legacy_default(config: dict, field: str, map_key: str, legacy_key: str) -> None:
    """Fold a legacy flat default into per-engine map entries, then drop it.

    Seeds every engine namespace that can speak the value and has no
    explicit entry — behavior is unchanged the moment the flat key
    disappears, and per-engine clears stop resurrecting it."""
    legacy = config.get(legacy_key)
    if not isinstance(legacy, str) or not legacy:
        config.pop(legacy_key, None)
        return
    from painapple_code.providers import get_provider, provider_names
    overrides = dict(config.get(map_key) or {})
    seen = set()
    for name in provider_names():
        p = get_provider(name)
        ns = p.models_key or p.name
        if ns in seen:
            continue
        seen.add(ns)
        if ns not in overrides and _engine_speaks_default(p, field, legacy):
            overrides[ns] = legacy
    if overrides:
        config[map_key] = overrides
    config.pop(legacy_key, None)


def _engine_defaults_payload(p) -> dict:
    return {
        "provider": p.name,
        "models_key": p.models_key or p.name,
        "default_model": bridge_paths.engine_default_model(p),
        "default_effort": bridge_paths.engine_default_effort(p),
        "token_profile": bridge_paths.engine_default_token_profile(p),
        "efforts": p.effort_levels(),
        "accounts": p.accounts(),
        "summary_supported": p.summary_model_editable(),
        "summary_model": (
            p.get_summary_model_override() if p.summary_model_editable() else None),
        "summary_placeholder": p.summary_model_placeholder or "",
    }


@router.get("/api/bridge/engine-defaults/{provider_name}")
async def get_engine_defaults(provider_name: str):
    """One engine's new-session defaults + auto-journal model."""
    return _engine_defaults_payload(_provider_or_404(provider_name))


@router.put("/api/bridge/engine-defaults/{provider_name}")
async def set_engine_defaults(provider_name: str, request: Request):
    """Set any subset of one engine's defaults.

    Body: ``{default_model?, default_effort?, token_profile?, summary_model?}``
    — null/empty clears a key (model/effort/profile fall back to the engine's
    own default; the journal override falls back per engine: Codex inherits
    the session model, Claude resets to the shipped summary model).
    """
    p = _provider_or_404(provider_name)
    body = await request.json()
    ns = p.models_key or p.name

    config = bridge_paths.load_global_config()
    maps_changed = False
    for field, map_key, legacy_key in _DEFAULTS_FIELDS:
        if field not in body:
            continue
        raw = body.get(field)
        if raw is not None and not isinstance(raw, str):
            raise HTTPException(status_code=400, detail=f"{field} must be a string or null")
        value = (raw or "").strip()

        if value and field == "default_effort":
            levels = p.effort_levels()
            if levels and value not in levels:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid effort for {p.display_name}: {value}. Valid: {levels}")
        if value and field == "token_profile":
            from painapple_code.utils.token_profiles import list_profiles
            if not p.accounts():
                raise HTTPException(
                    status_code=400,
                    detail=f"{p.display_name} has no selectable accounts")
            if value not in {x["name"] for x in list_profiles()}:
                raise HTTPException(status_code=400, detail=f"Token profile not found: {value}")

        _migrate_legacy_default(config, field, map_key, legacy_key)
        overrides = dict(config.get(map_key) or {})
        if value:
            overrides[ns] = value
        else:
            overrides.pop(ns, None)
        if overrides:
            config[map_key] = overrides
        else:
            config.pop(map_key, None)
        maps_changed = True

    if maps_changed:
        bridge_paths.save_global_config(config)
        logger.info(f"Engine defaults for {ns} updated")

    # After the config save — the provider setter re-reads/writes its own
    # store (global config for Codex, models.yaml for Claude).
    if "summary_model" in body:
        raw = body.get("summary_model")
        if raw is not None and not isinstance(raw, str):
            raise HTTPException(status_code=400, detail="summary_model must be a string or null")
        if not p.summary_model_editable():
            raise HTTPException(
                status_code=400,
                detail=f"{p.display_name} has no journal-model setting")
        p.set_summary_model_override(raw)
        logger.info(f"Journal model for {p.name} set to: {(raw or '').strip() or '(engine default)'}")

    return _engine_defaults_payload(p)


@router.get("/api/bridge/max-thinking-tokens")
async def get_max_thinking_tokens_api():
    """Get the max thinking tokens setting."""
    config = bridge_paths.load_global_config()
    current = config.get("max_thinking_tokens", DEFAULT_MAX_THINKING_TOKENS)

    return {
        "max_thinking_tokens": current,
        "default": DEFAULT_MAX_THINKING_TOKENS,
        "max": 63999,
    }


@router.put("/api/bridge/max-thinking-tokens")
async def set_max_thinking_tokens_api(request: Request):
    """Set the max thinking tokens."""
    body = await request.json()
    value = body.get("max_thinking_tokens")

    if value is None:
        raise HTTPException(status_code=400, detail="max_thinking_tokens is required")

    try:
        value = int(value)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="max_thinking_tokens must be an integer")

    if value < 0:
        raise HTTPException(status_code=400, detail="max_thinking_tokens cannot be negative")

    if value > 63999:
        raise HTTPException(status_code=400, detail="max_thinking_tokens cannot exceed 63999 (Opus 4.5 limit)")

    config = bridge_paths.load_global_config()
    if value == DEFAULT_MAX_THINKING_TOKENS:
        config.pop("max_thinking_tokens", None)
    else:
        config["max_thinking_tokens"] = value

    bridge_paths.save_global_config(config)
    logger.info(f"Max thinking tokens updated to: {value}")

    return await get_max_thinking_tokens_api()


# ═══════════════════════════════════════════════════════════════════
# API Auto-Retry
# ═══════════════════════════════════════════════════════════════════

DEFAULT_API_RETRY_MAX = 3


@router.get("/api/bridge/api-retry-max")
async def get_api_retry_max():
    """Get the API auto-retry max setting."""
    config = bridge_paths.load_global_config()
    return {
        "api_retry_max": config.get("api_retry_max", DEFAULT_API_RETRY_MAX),
        "default": DEFAULT_API_RETRY_MAX,
        "min": 0,
        "max": 10,
    }


@router.put("/api/bridge/api-retry-max")
async def set_api_retry_max(request: Request):
    """Set the API auto-retry max."""
    body = await request.json()
    value = body.get("api_retry_max")

    if value is None:
        raise HTTPException(status_code=400, detail="api_retry_max is required")

    try:
        value = int(value)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="api_retry_max must be an integer")

    if value < 0 or value > 10:
        raise HTTPException(status_code=400, detail="api_retry_max must be between 0 and 10")

    config = bridge_paths.load_global_config()
    if value == DEFAULT_API_RETRY_MAX:
        config.pop("api_retry_max", None)
    else:
        config["api_retry_max"] = value

    bridge_paths.save_global_config(config)
    logger.info(f"API retry max updated to: {value}")

    return await get_api_retry_max()


# ═══════════════════════════════════════════════════════════════════
# Stop Claude on AskUserQuestion (SIGINT)
# ═══════════════════════════════════════════════════════════════════

SIGINT_ON_ASK_DEFAULT = True


@router.get("/api/bridge/sigint-on-ask")
async def get_sigint_on_ask():
    """Get whether Claude is SIGINT-stopped when it calls AskUserQuestion."""
    config = bridge_paths.load_global_config()
    return {
        "sigint_on_ask": bool(config.get("sigint_on_ask", SIGINT_ON_ASK_DEFAULT)),
        "default": SIGINT_ON_ASK_DEFAULT,
    }


@router.put("/api/bridge/sigint-on-ask")
async def set_sigint_on_ask(request: Request):
    """Toggle SIGINT-on-AskUserQuestion.

    Persists to the global config and updates the live bridge instance so the
    change takes effect on the next turn without a restart.
    """
    body = await request.json()
    value = body.get("sigint_on_ask")

    if not isinstance(value, bool):
        raise HTTPException(status_code=400, detail="sigint_on_ask must be a boolean")

    config = bridge_paths.load_global_config()
    # Store only when it differs from the default; pop to fall back to default.
    if value == SIGINT_ON_ASK_DEFAULT:
        config.pop("sigint_on_ask", None)
    else:
        config["sigint_on_ask"] = value
    bridge_paths.save_global_config(config)

    # Apply to the running bridge so the toggle is live, not restart-gated.
    bridge = getattr(request.app.state, "bridge", None)
    if bridge is not None:
        bridge.sigint_on_ask = value

    logger.info(f"sigint_on_ask updated to: {value}")
    return {"sigint_on_ask": value, "default": SIGINT_ON_ASK_DEFAULT}


# ═══════════════════════════════════════════════════════════════════
# Default Permission Levels
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/default-permissions")
async def get_default_permissions(request: Request, provider: str = None):
    """Get the global default permission level, plus the mode vocabulary of the
    engine new sessions run on (the effective default provider — the
    --default-provider flag / `default_provider` config key, not always Claude).

    `provider` overrides which engine's vocabulary is returned — the picker
    uses it so a pre-connect tab that chose a different engine shows that
    engine's modes, not the box default's. The stored global level only
    applies when it's valid in the resolved engine's own vocabulary (a Claude
    `acceptEdits` default means nothing to Codex's sandbox tiers)."""
    from painapple_code.providers import get_provider, provider_names
    from painapple_code.routes.dependencies import effective_default_provider
    if provider and provider in provider_names():
        dp = get_provider(provider)
    else:
        dp = effective_default_provider(request.app)
    config = bridge_paths.load_global_config()
    valid = {m["value"] for m in dp.permission_modes()}
    level = config.get("default_permission_level")
    if level not in valid:
        level = dp.default_permission_mode()
    return {
        "default_level": level,
        "modes": dp.permission_modes(),
    }


@router.put("/api/bridge/default-permissions")
async def set_default_permissions(request: Request):
    """Set the global default permission level for normal sessions."""
    body = await request.json()
    value = body.get("permission_level")

    # The global default feeds the effective default engine's sessions, so
    # validate against that provider's own modes (not a hardcoded set) and
    # treat its own default as the "unset" sentinel.
    from painapple_code.routes.dependencies import effective_default_provider
    dp = effective_default_provider(request.app)
    valid = {m["value"] for m in dp.permission_modes()}
    if value not in valid:
        raise HTTPException(status_code=400, detail=f"Invalid permission level: {value}. Valid: {valid}")

    config = bridge_paths.load_global_config()
    if value == dp.default_permission_mode():
        config.pop("default_permission_level", None)
    else:
        config["default_permission_level"] = value

    bridge_paths.save_global_config(config)
    logger.info(f"Default permission level updated to: {value}")

    return await get_default_permissions(request)


# ═══════════════════════════════════════════════════════════════════
# Token Profiles
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/token-profiles")
async def get_token_profiles(request: Request):
    """List available token profiles and the default engine's default."""
    from painapple_code.routes.dependencies import effective_default_provider
    from painapple_code.utils.token_profiles import list_profiles
    profiles = list_profiles()
    # Legacy shape; the default shown is the DEFAULT ENGINE's configured
    # profile (per-engine `default_token_profiles` map, flat key fallback).
    default = bridge_paths.engine_default_token_profile(
        effective_default_provider(request.app))
    return {
        "profiles": profiles,
        "default_profile": default,
    }


@router.put("/api/bridge/default-token-profile")
async def set_default_token_profile(request: Request):
    """Legacy wrapper: set the DEFAULT ENGINE's default token profile."""
    from painapple_code.routes.dependencies import effective_default_provider
    from painapple_code.utils.token_profiles import list_profiles
    p = effective_default_provider(request.app)
    body = await request.json()
    value = body.get("token_profile")

    # Validate profile exists (or null to clear)
    if value is not None:
        profile_names = {x["name"] for x in list_profiles()}
        if value not in profile_names:
            raise HTTPException(status_code=400, detail=f"Token profile not found: {value}")

    config = bridge_paths.load_global_config()
    _migrate_legacy_default(
        config, "token_profile", "default_token_profiles", "default_token_profile")
    overrides = dict(config.get("default_token_profiles") or {})
    ns = p.models_key or p.name
    if value is None:
        overrides.pop(ns, None)
    else:
        overrides[ns] = value
    if overrides:
        config["default_token_profiles"] = overrides
    else:
        config.pop("default_token_profiles", None)

    bridge_paths.save_global_config(config)
    logger.info(f"Default token profile for {ns} updated to: {value}")

    return await get_token_profiles(request)


# ═══════════════════════════════════════════════════════════════════
# Models
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/models")
async def get_models():
    """Get available models from models.yaml."""
    return {
        "selectable": bridge_paths.get_selectable_models(),
        "summary_model": bridge_paths.get_summary_model(),
    }


@router.put("/api/bridge/models")
async def put_models(request: Request):
    """Replace models.yaml with the posted config. Body: {selectable: [...], summary_model: "..."}"""
    body = await request.json()
    selectable = body.get("selectable", [])
    # Back-compat: older clients sent the key as `haiku`.
    summary_model = body.get("summary_model") or body.get("haiku", "")

    if not isinstance(selectable, list):
        raise HTTPException(status_code=400, detail="selectable must be a list")
    if not isinstance(summary_model, str) or not summary_model.strip():
        raise HTTPException(status_code=400, detail="summary_model must be a non-empty string")

    # Validate each selectable entry has required fields
    cleaned = []
    for i, m in enumerate(selectable):
        if not isinstance(m, dict) or not m.get("id"):
            raise HTTPException(status_code=400, detail=f"selectable[{i}] must have an id")
        cleaned.append({
            "id": str(m["id"]).strip(),
            "label": str(m.get("label", "")).strip() or str(m["id"]).strip(),
            "desc": str(m.get("desc", "")).strip(),
        })

    bridge_paths.save_models_config({"selectable": cleaned, "summary_model": summary_model.strip()})
    logger.info(f"Models config updated: {len(cleaned)} selectable, summary_model={summary_model}")
    return {"selectable": cleaned, "summary_model": summary_model.strip()}


@router.post("/api/bridge/models/reset")
async def reset_models():
    """Restore models.yaml to the shipped defaults."""
    defaults = bridge_paths.get_default_models_config()
    bridge_paths.save_models_config(defaults)
    logger.info(f"Models config reset to defaults: {len(defaults.get('selectable', []))} selectable")
    return {
        "selectable": bridge_paths.get_selectable_models(),
        "summary_model": bridge_paths.get_summary_model(),
    }


# ═══════════════════════════════════════════════════════════════════
# Default Provider (engine for new sessions)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/default-provider")
async def get_default_provider(request: Request):
    """The engine NEW sessions get when the picker isn't touched.

    `effective` is the resolved answer (--default-provider flag →
    `default_provider` config key → registry default). `configured` is the
    raw config-key value (None = unset). `pinned_by_flag` tells the UI the
    server flag overrides whatever it writes via PUT."""
    from painapple_code.routes.dependencies import effective_default_provider
    bridge = getattr(request.app.state, "bridge", None)
    config = bridge_paths.load_global_config()
    return {
        "effective": effective_default_provider(request.app).name,
        "configured": config.get("default_provider"),
        "pinned_by_flag": bool(getattr(bridge, "default_provider", None)),
    }


@router.put("/api/bridge/default-provider")
async def set_default_provider(request: Request):
    """Set (or clear with null) the `default_provider` config key. Validated
    against the live registry; note a --default-provider server flag still
    wins over this key until the server restarts without it."""
    from painapple_code.providers import provider_names
    body = await request.json()
    value = body.get("default_provider")  # string or null to clear

    if value is not None and value not in provider_names():
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {value}. Valid: {provider_names()}",
        )

    config = bridge_paths.load_global_config()
    if value is None:
        config.pop("default_provider", None)
    else:
        config["default_provider"] = value

    bridge_paths.save_global_config(config)
    logger.info(f"Default provider updated to: {value}")

    return await get_default_provider(request)


# ═══════════════════════════════════════════════════════════════════
# Providers enabled (which engines the picker offers)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/providers-enabled")
async def get_providers_enabled(request: Request):
    """Per-engine picker visibility.

    `effective` is what the picker uses ({name: bool}; config override →
    provider's own `default_enabled`, with the default engine forced on).
    `configured` is the raw `providers_enabled` config map (only names the
    user has explicitly toggled)."""
    from painapple_code.routes.dependencies import provider_enabled_map
    config = bridge_paths.load_global_config()
    return {
        "effective": provider_enabled_map(request.app),
        "configured": config.get("providers_enabled") or {},
    }


@router.put("/api/bridge/providers-enabled")
async def set_provider_enabled(request: Request):
    """Toggle one engine in/out of the picker: `{provider, enabled}`.

    `enabled: null` clears the override (back to the provider's own
    `default_enabled`). Disabling affects only the picker listing — bound
    sessions and explicit API selection keep working; the effective default
    engine reads back enabled regardless."""
    from painapple_code.providers import provider_names
    body = await request.json()
    name = body.get("provider")
    enabled = body.get("enabled")  # bool, or null to clear the override

    if name not in provider_names():
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {name}. Valid: {provider_names()}",
        )

    config = bridge_paths.load_global_config()
    overrides = dict(config.get("providers_enabled") or {})
    if enabled is None:
        overrides.pop(name, None)
    else:
        overrides[name] = bool(enabled)

    if overrides:
        config["providers_enabled"] = overrides
    else:
        config.pop("providers_enabled", None)

    bridge_paths.save_global_config(config)
    logger.info(f"Provider {name} picker visibility set to: {enabled}")

    return await get_providers_enabled(request)


@router.get("/api/bridge/default-model")
async def get_default_model(request: Request):
    """Legacy wrapper: the DEFAULT ENGINE's configured new-session model.

    Storage moved to the per-engine `default_models` map (see
    engine-defaults); this endpoint stays for old callers and reads/writes
    through the default engine's entry.
    """
    from painapple_code.routes.dependencies import effective_default_provider
    p = effective_default_provider(request.app)
    return {"default_model": bridge_paths.engine_default_model(p)}


@router.put("/api/bridge/default-model")
async def set_default_model(request: Request):
    """Legacy wrapper: set the DEFAULT ENGINE's new-session model."""
    from painapple_code.routes.dependencies import effective_default_provider
    p = effective_default_provider(request.app)
    body = await request.json()
    value = body.get("default_model")  # string or null

    config = bridge_paths.load_global_config()
    _migrate_legacy_default(config, "default_model", "default_models", "default_model")
    overrides = dict(config.get("default_models") or {})
    ns = p.models_key or p.name
    if value:
        overrides[ns] = value
    else:
        overrides.pop(ns, None)
    if overrides:
        config["default_models"] = overrides
    else:
        config.pop("default_models", None)

    bridge_paths.save_global_config(config)
    logger.info(f"Default model for {ns} updated to: {value}")

    return await get_default_model(request)


# ═══════════════════════════════════════════════════════════════════
# Default Effort Level
# ═══════════════════════════════════════════════════════════════════

VALID_EFFORT_LEVELS = {"low", "medium", "high", "xhigh", "max"}
DEFAULT_EFFORT = "high"


@router.get("/api/bridge/default-effort")
async def get_default_effort(request: Request):
    """Legacy wrapper: the DEFAULT ENGINE's configured default effort.

    Storage moved to the per-engine `default_efforts` map (see
    engine-defaults); this stays for old callers (effort popup fallback).
    """
    from painapple_code.routes.dependencies import effective_default_provider
    p = effective_default_provider(request.app)
    return {
        "default_effort": bridge_paths.engine_default_effort(p) or DEFAULT_EFFORT,
        "valid_levels": p.effort_levels() or sorted(VALID_EFFORT_LEVELS),
        "default": DEFAULT_EFFORT,
    }


@router.put("/api/bridge/default-effort")
async def set_default_effort(request: Request):
    """Legacy wrapper: set the DEFAULT ENGINE's default effort."""
    from painapple_code.routes.dependencies import effective_default_provider
    p = effective_default_provider(request.app)
    body = await request.json()
    value = body.get("default_effort")

    valid = set(p.effort_levels() or VALID_EFFORT_LEVELS)
    if value not in valid:
        raise HTTPException(status_code=400, detail=f"Invalid effort level: {value}. Valid: {sorted(valid)}")

    config = bridge_paths.load_global_config()
    _migrate_legacy_default(config, "default_effort", "default_efforts", "default_effort")
    overrides = dict(config.get("default_efforts") or {})
    ns = p.models_key or p.name
    if value == DEFAULT_EFFORT:
        overrides.pop(ns, None)
    else:
        overrides[ns] = value
    if overrides:
        config["default_efforts"] = overrides
    else:
        config.pop("default_efforts", None)

    bridge_paths.save_global_config(config)
    logger.info(f"Default effort for {ns} updated to: {value}")

    return await get_default_effort(request)


# ═══════════════════════════════════════════════════════════════════
# Session Timeout Settings
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/session-timeouts")
async def get_session_timeouts():
    """Get session timeout settings (in minutes)."""
    from painapple_code.services.agent_session import AgentBridge
    config = bridge_paths.load_global_config()
    return {
        "session_idle_timeout_minutes": config.get(
            "session_idle_timeout_minutes",
            AgentBridge.DEFAULT_SESSION_IDLE_TIMEOUT // 60
        ),
        "orphan_process_timeout_minutes": config.get(
            "orphan_process_timeout_minutes",
            AgentBridge.DEFAULT_ORPHAN_PROCESS_TIMEOUT // 60
        ),
        "defaults": {
            "session_idle_timeout_minutes": AgentBridge.DEFAULT_SESSION_IDLE_TIMEOUT // 60,
            "orphan_process_timeout_minutes": AgentBridge.DEFAULT_ORPHAN_PROCESS_TIMEOUT // 60,
        }
    }


@router.put("/api/bridge/session-timeouts")
async def set_session_timeouts(request: Request):
    """Update session timeout settings (in minutes)."""
    from painapple_code.services.agent_session import AgentBridge
    body = await request.json()
    config = bridge_paths.load_global_config()

    for key in ("session_idle_timeout_minutes", "orphan_process_timeout_minutes"):
        if key in body:
            value = body[key]
            try:
                value = int(value)
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail=f"{key} must be an integer")
            if value < 1:
                raise HTTPException(status_code=400, detail=f"{key} must be at least 1 minute")
            if value > 1440:
                raise HTTPException(status_code=400, detail=f"{key} cannot exceed 1440 minutes (24 hours)")

            default_minutes = getattr(AgentBridge, f"DEFAULT_{key.upper().replace('_MINUTES', '')}") // 60
            if value == default_minutes:
                config.pop(key, None)
            else:
                config[key] = value

    bridge_paths.save_global_config(config)
    logger.info(f"Session timeouts updated: {body}")
    return await get_session_timeouts()
