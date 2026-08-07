"""
Bridge Session Prefs API Routes - per-user UI state.

These endpoints manage:
- Tab State (server-side persistence — iPadOS PWA localStorage is unreliable)
- Keyboard Shortcuts overrides
- User snippets / disabled agents
- Agent insertion patterns
- Shadow git defaults for new projects
"""

import json
import logging
from typing import Optional, Dict, List

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from painapple_code import bridge_paths

logger = logging.getLogger(__name__)

router = APIRouter(tags=["bridge:session-prefs"])


# ═══════════════════════════════════════════════════════════════════
# Tab State API  (server-side persistence — iPadOS PWA localStorage is unreliable)
# ═══════════════════════════════════════════════════════════════════

# NOTE: resolve the path per-call, not at import. The --state-suffix override
# is applied in server.main() AFTER this module is imported, so an import-time
# constant would capture the un-suffixed path and silently defeat tier isolation.


@router.get("/api/bridge/tabs")
async def get_tab_state():
    """Return the last-saved tab state (list of open sessions + active session)."""
    tab_state_file = bridge_paths.get_tab_state_path()
    if tab_state_file.exists():
        try:
            return json.loads(tab_state_file.read_text())
        except Exception:
            pass
    return {"sessions": [], "activeStoreId": None}


class TabStatePayload(BaseModel):
    sessions: List[Dict]   # [{storeId, name, cwd}, ...]
    activeStoreId: Optional[str] = None
    # v2 (unified strip): widget tabs + interleaved order + active pointer.
    # Optional so pre-v2 clients keep working.
    widgetTabs: Optional[List[Dict]] = None   # [{id, widgetId, title, ...}, ...]
    order: Optional[List[Dict]] = None        # [{kind:'session', storeId} | {kind:'widget', id}, ...]
    activeTab: Optional[Dict] = None          # {kind:'session', storeId} | {kind:'widget', id}


@router.post("/api/bridge/tabs")
async def save_tab_state(payload: TabStatePayload):
    """Persist current tab state to disk (called by client on every structural change)."""
    from datetime import datetime, timezone
    bridge_paths.ensure_bridge_home()
    data = {
        "sessions": [s for s in payload.sessions if s.get("storeId")],
        "activeStoreId": payload.activeStoreId,
        "savedAt": datetime.now(timezone.utc).isoformat(),
    }
    if payload.widgetTabs is not None:
        data["widgetTabs"] = [
            t for t in payload.widgetTabs if t.get("id") and t.get("widgetId")
        ]
    if payload.order is not None:
        data["order"] = payload.order
    if payload.activeTab is not None:
        data["activeTab"] = payload.activeTab
    try:
        bridge_paths.get_tab_state_path().write_text(json.dumps(data, indent=2))
    except Exception as e:
        logger.error(f"Failed to save tab state: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════
# Keyboard Shortcuts API  (server-side persistence for customizations)
# ═══════════════════════════════════════════════════════════════════

# Resolved per-call (see the tab-state note above) so --state-suffix applies.


@router.get("/api/bridge/shortcuts")
async def get_shortcut_overrides():
    """Return saved keyboard-shortcut overrides ({id: [keys]})."""
    shortcuts_file = bridge_paths.get_shortcuts_path()
    if shortcuts_file.exists():
        try:
            return json.loads(shortcuts_file.read_text())
        except Exception:
            pass
    return {"shortcuts": {}}


class ShortcutsPayload(BaseModel):
    shortcuts: Dict[str, List[str]]


@router.post("/api/bridge/shortcuts")
async def save_shortcut_overrides(payload: ShortcutsPayload):
    """Persist keyboard-shortcut overrides to disk."""
    from datetime import datetime, timezone
    bridge_paths.ensure_bridge_home()
    data = {
        "shortcuts": payload.shortcuts,
        "savedAt": datetime.now(timezone.utc).isoformat(),
    }
    try:
        bridge_paths.get_shortcuts_path().write_text(json.dumps(data, indent=2))
    except Exception as e:
        logger.error(f"Failed to save shortcut overrides: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════
# User Preferences API
# ═══════════════════════════════════════════════════════════════════

DEFAULT_AGENT_PATTERN = "Consult with agent {agent}: "


@router.get("/api/user/snippets")
async def get_user_snippets():
    """Get user's custom text snippets for # autocomplete + disabled-agents list."""
    config = bridge_paths.load_global_config()
    snippets = config.get("snippets")
    if snippets is None:
        snippets = config.get("favorites", [])
    return {
        "snippets": snippets,
        "disabled_agents": config.get("disabled_agents", [])
    }


@router.put("/api/user/snippets")
async def update_user_snippets(request: Request):
    """Update user's snippets and disabled agents."""
    body = await request.json()
    config = bridge_paths.load_global_config()

    if "snippets" in body:
        config["snippets"] = body["snippets"]
        config.pop("favorites", None)
    if "disabled_agents" in body:
        config["disabled_agents"] = body["disabled_agents"]

    bridge_paths.save_global_config(config)
    return await get_user_snippets()


@router.get("/api/user/agent-patterns")
async def get_agent_patterns():
    """Get agent insertion patterns."""
    config = bridge_paths.load_global_config()
    patterns = config.get("agent_patterns", {})
    return {
        "global": patterns.get("global", DEFAULT_AGENT_PATTERN),
        "agents": patterns.get("agents", {})
    }


@router.put("/api/user/agent-patterns")
async def update_agent_patterns(request: Request):
    """Update agent insertion patterns."""
    body = await request.json()
    config = bridge_paths.load_global_config()

    patterns = config.get("agent_patterns", {})

    if "global" in body:
        if body["global"] and body["global"] != DEFAULT_AGENT_PATTERN:
            patterns["global"] = body["global"]
        elif "global" in patterns:
            del patterns["global"]

    if "agents" in body:
        patterns["agents"] = body["agents"]

    config["agent_patterns"] = patterns
    bridge_paths.save_global_config(config)
    return await get_agent_patterns()


@router.get("/api/user/shadow-git-defaults")
async def get_shadow_git_defaults():
    """Get global shadow git defaults for new projects."""
    return bridge_paths.get_shadow_git_defaults()


@router.put("/api/user/shadow-git-defaults")
async def update_shadow_git_defaults(request: Request):
    """Update global shadow git defaults for new projects."""
    body = await request.json()
    config = bridge_paths.load_global_config()

    defaults = config.get("shadow_git_defaults", {})
    if "enabled" in body:
        defaults["enabled"] = body["enabled"]
    if "rich_commits" in body:
        defaults["rich_commits"] = body["rich_commits"]
    if "max_file_size_mb" in body:
        try:
            defaults["max_file_size_mb"] = max(0, float(body["max_file_size_mb"]))
        except (TypeError, ValueError):
            pass

    config["shadow_git_defaults"] = defaults
    bridge_paths.save_global_config(config)
    return await get_shadow_git_defaults()
