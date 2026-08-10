"""Plugins Manager API.

Endpoints for browsing the plugin marketplace and managing installed plugins.

Backed by the `claude plugins` CLI:
  claude plugins list --available --json   → { installed: [...], available: [...] }
  claude plugins install <id>
  claude plugins uninstall <id>
  claude plugins enable <id>
  claude plugins disable <id>

Component inventory (skills/agents/commands/hooks) is computed by walking the
marketplace directory on disk, since `claude plugins details` has no --json.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/plugins", tags=["plugins"])

# Forbid a leading '-'/'.' so a plugin id can't smuggle a CLI option.
PLUGIN_ID_RE = re.compile(r"^(?![-.])[a-zA-Z0-9_./-]+@[a-zA-Z0-9_./-]+$")
CLI_TIMEOUT_SEC = 120  # install pulls from git; allow some slack


# ---------- helpers ---------------------------------------------------------


def _validate_plugin_id(plugin_id: str) -> None:
    """Reject anything that isn't shaped like `<plugin>@<marketplace>`."""
    if not PLUGIN_ID_RE.match(plugin_id):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid plugin id {plugin_id!r}",
        )


async def _run_claude(*args: str) -> tuple[int, str, str]:
    """Spawn `claude` with the given args; return (returncode, stdout, stderr)."""
    try:
        from painapple_code.utils.proc import resolve_binary
        proc = await asyncio.create_subprocess_exec(
            resolve_binary("claude"), *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(
            proc.communicate(), timeout=CLI_TIMEOUT_SEC
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail=f"claude plugins {args[0]} timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="`claude` CLI not on PATH")
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _plugin_dir(plugin_id: str) -> Optional[Path]:
    """Return the marketplace directory for `<plugin>@<marketplace>`, or None."""
    name, _, marketplace = plugin_id.partition("@")
    if not name or not marketplace:
        return None
    candidate = (
        Path.home() / ".claude" / "plugins" / "marketplaces"
        / marketplace / "plugins" / name
    )
    return candidate if candidate.is_dir() else None


def _component_inventory(plugin_dir: Path) -> dict[str, int]:
    """Count plugin components by walking the on-disk plugin directory.

    Mirrors how Claude Code itself discovers components — folder-form skills,
    flat `.md` agents/commands, and a single `hooks.json` or `hooks/hooks.json`.
    """
    counts = {"skills": 0, "agents": 0, "commands": 0, "hooks": 0, "mcp_servers": 0}

    skills_dir = plugin_dir / "skills"
    if skills_dir.is_dir():
        counts["skills"] = sum(
            1 for d in skills_dir.iterdir()
            if d.is_dir() and (d / "SKILL.md").is_file()
        )

    for kind, subdir, suffix in (
        ("agents", "agents", ".md"),
        ("commands", "commands", ".md"),
    ):
        d = plugin_dir / subdir
        if d.is_dir():
            counts[kind] = sum(
                1 for f in d.iterdir()
                if f.is_file() and f.suffix == suffix and not f.name.startswith(".")
            )

    for hooks_path in (plugin_dir / "hooks.json", plugin_dir / "hooks" / "hooks.json"):
        if hooks_path.is_file():
            try:
                data = json.loads(hooks_path.read_text("utf-8"))
                hooks = data.get("hooks") if isinstance(data, dict) else None
                if isinstance(hooks, list):
                    counts["hooks"] = len(hooks)
                elif isinstance(hooks, dict):
                    counts["hooks"] = sum(
                        len(v) if isinstance(v, list) else 1
                        for v in hooks.values()
                    )
            except (OSError, json.JSONDecodeError):
                pass
            break

    mcp_path = plugin_dir / ".mcp.json"
    if mcp_path.is_file():
        try:
            data = json.loads(mcp_path.read_text("utf-8"))
            servers = data.get("mcpServers") if isinstance(data, dict) else None
            if isinstance(servers, dict):
                counts["mcp_servers"] = len(servers)
        except (OSError, json.JSONDecodeError):
            pass

    return counts


def _plugin_manifest(plugin_dir: Path) -> dict[str, Any]:
    """Read `plugin.json` for author/version/license info."""
    for path in (
        plugin_dir / ".claude-plugin" / "plugin.json",
        plugin_dir / "plugin.json",
    ):
        if path.is_file():
            try:
                return json.loads(path.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
    return {}


# ---------- endpoints -------------------------------------------------------


@router.get("")
async def list_plugins(available: bool = True):
    """Return installed + (optionally) available plugins, with components inventory.

    Default includes the marketplace catalog so the widget can render a unified
    list with install/uninstall buttons. Set `?available=false` to skip the
    catalog fetch (faster — no remote refresh).
    """
    args = ["plugins", "list", "--json"]
    if available:
        args.insert(2, "--available")
    rc, out, err = await _run_claude(*args)
    if rc != 0:
        raise HTTPException(status_code=502, detail=f"claude plugins list failed: {err.strip() or out.strip()}")

    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"unparseable CLI output: {e}")

    # --available returns {installed, available}; without it returns a flat list
    if available and isinstance(data, dict):
        installed = data.get("installed") or []
        available_list = data.get("available") or []
    else:
        installed = data if isinstance(data, list) else []
        available_list = []

    installed_by_id: dict[str, dict[str, Any]] = {it["id"]: it for it in installed if "id" in it}

    def _enrich(item: dict[str, Any], is_installed: bool) -> dict[str, Any]:
        # `available` items use `pluginId`, installed items use `id`. Normalize.
        plugin_id = item.get("id") or item.get("pluginId") or ""
        plugin_dir = _plugin_dir(plugin_id) if plugin_id else None
        components = _component_inventory(plugin_dir) if plugin_dir else {
            "skills": 0, "agents": 0, "commands": 0, "hooks": 0, "mcp_servers": 0,
        }
        manifest = _plugin_manifest(plugin_dir) if plugin_dir else {}
        inst = installed_by_id.get(plugin_id, {})
        return {
            "id": plugin_id,
            "name": item.get("name") or plugin_id.split("@", 1)[0],
            "description": item.get("description") or manifest.get("description") or "",
            "marketplace": item.get("marketplaceName") or (plugin_id.split("@", 1)[1] if "@" in plugin_id else ""),
            "source": item.get("source"),
            "install_count": item.get("installCount"),
            "installed": is_installed,
            "enabled": inst.get("enabled") if is_installed else None,
            "version": inst.get("version") or manifest.get("version"),
            "scope": inst.get("scope"),
            "installed_at": inst.get("installedAt"),
            "install_path": inst.get("installPath"),
            "author": manifest.get("author"),
            "components": components,
        }

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    # Installed first (so they sort to the top before any UI-side reorder)
    for it in installed:
        pid = it.get("id")
        if not pid:
            continue
        items.append(_enrich(it, is_installed=True))
        seen.add(pid)
    for it in available_list:
        pid = it.get("pluginId") or it.get("id")
        if not pid or pid in seen:
            continue
        items.append(_enrich(it, is_installed=False))

    return {
        "plugins": items,
        "counts": {
            "installed": sum(1 for p in items if p["installed"]),
            "enabled": sum(1 for p in items if p.get("enabled")),
            "available": len(items),
        },
    }


class PluginActionBody(BaseModel):
    plugin_id: str


async def _plugin_action(verb: str, plugin_id: str) -> dict[str, Any]:
    """Run `claude plugins <verb> <plugin_id>` and surface stdout/stderr."""
    _validate_plugin_id(plugin_id)
    rc, out, err = await _run_claude("plugins", verb, plugin_id)
    ok = rc == 0
    if not ok:
        raise HTTPException(
            status_code=400,
            detail={
                "verb": verb,
                "plugin_id": plugin_id,
                "stdout": out.strip(),
                "stderr": err.strip(),
                "returncode": rc,
            },
        )
    return {
        "ok": True,
        "verb": verb,
        "plugin_id": plugin_id,
        "stdout": out.strip(),
        "stderr": err.strip(),
    }


@router.post("/install")
async def install_plugin(payload: PluginActionBody):
    return await _plugin_action("install", payload.plugin_id)


@router.post("/uninstall")
async def uninstall_plugin(payload: PluginActionBody):
    return await _plugin_action("uninstall", payload.plugin_id)


@router.post("/enable")
async def enable_plugin(payload: PluginActionBody):
    return await _plugin_action("enable", payload.plugin_id)


@router.post("/disable")
async def disable_plugin(payload: PluginActionBody):
    return await _plugin_action("disable", payload.plugin_id)
