"""
Bridge API Routes - residual: server info, bridge config, helper install.

These endpoints expose:
- Server identity (home, cwd, workspace)
- Global bridge configuration (raw get/put)
- Helper installation (shadow-git CLI + agent template)

Other former sections of this module have moved:
- Quick action presets, claude path, max thinking tokens, API auto-retry,
  default permissions, token profiles, models, default effort, session
  timeouts          -> routes/api_bridge_config.py
- Tab state, keyboard shortcuts, user snippets, agent patterns, shadow-git
  defaults          -> routes/api_bridge_session_prefs.py
- Commit sections   -> routes/api_bridge_commit_sections.py
- Project config, project rename, project commands (and the CLI command
  description cache used by routes/api_commands.py) -> routes/api_project_config.py
- Agent discovery   -> routes/api_agents.py
"""

import asyncio
import logging
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from painapple_code import bridge_paths
from painapple_code import helpers as helpers_module
from painapple_code.utils.file_paths import safe_resolve

logger = logging.getLogger(__name__)

router = APIRouter(tags=["bridge"])

# Pinned at boot by capture_boot_version(); this is the code the process
# actually imported. Never recomputed — that's the whole point.
_boot_version: dict | None = None

# Live worktree reading, refreshed at most every _DISK_TTL seconds.
_disk_version: tuple[float, str | None] | None = None
_DISK_TTL = 10.0


def _describe_checkout() -> str | None:
    """`git describe` the source tree we're importing from, or None.

    Only meaningful for an editable install, where REPO_ROOT is a real
    checkout and the files on disk ARE the running code. Wheel/Docker
    installs land in site-packages with no .git, and return None.
    """
    from painapple_code import REPO_ROOT

    if not (REPO_ROOT / ".git").exists():
        return None
    try:
        out = subprocess.run(
            # Same tag filter as [tool.setuptools_scm] in pyproject.toml,
            # so this agrees with what a rebuild would produce.
            ["git", "describe", "--dirty", "--tags", "--long", "--match", "v[0-9]*"],
            cwd=str(REPO_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=2,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None

    raw = out.stdout.strip()  # v1.0.0-rc25-3-gabc1234[-dirty]
    dirty = raw.endswith("-dirty")
    if dirty:
        raw = raw[: -len("-dirty")]
    parts = raw.rsplit("-", 2)
    if len(parts) != 3:
        return None
    tag, distance, _hash = parts

    label = tag
    if distance.isdigit() and int(distance) > 0:
        label += f" +{distance}"
    if dirty:
        label += " (modified)"
    return label


def capture_boot_version() -> dict:
    """Pin the running version, once, at server startup.

    Three different things can be called "the version", and conflating
    them is how this went wrong twice:

    1. `__version__` from _version.py — setuptools-scm's BUILD-time
       constant. Exact for a wheel or Docker image (the build IS the
       install); frozen at the last `pip install -e .` for an editable
       checkout. deploy.fish never reinstalls, so stable reported rc7
       from July while serving rc25, 167 commits later.
    2. `git describe` of the worktree — what's on DISK right now.
    3. What this process actually imported — disk as it was at BOOT.

    The About row wants (3). Reading (2) at request time silently
    substitutes it for (3), which is wrong in the other direction: after
    a fast-forward without a restart it reports the new code while
    serving the old, hiding exactly the restart-needed case. So we snapshot
    at startup, before anything can change underneath us, and diff against
    (2) separately to detect that case.
    """
    global _boot_version
    from painapple_code import __version__

    described = _describe_checkout()
    _boot_version = (
        {"version": described, "version_source": "git"} if described
        else {"version": f"v{__version__}", "version_source": "package"}
    )
    # Deliberately NOT this module's `logger`: server_logging attaches its
    # file handlers to the "painapple-code" logger (hyphen), while
    # getLogger(__name__) lands under "painapple_code.routes" (underscore) —
    # a separate tree with no handlers, so those records never reach
    # server.log. Which version booted is exactly the line you want in the
    # log when a deploy looks wrong, so log it where it'll actually appear.
    logging.getLogger("painapple-code").info(
        f"Running version: {_boot_version['version']} "
        f"(source: {_boot_version['version_source']})"
    )
    return _boot_version


def _current_disk_version() -> str | None:
    """What `git describe` says about the worktree *now*, TTL-cached.

    Differs from the boot snapshot exactly when the checkout moved under a
    running process — i.e. a restart is pending.
    """
    global _disk_version
    import time

    now = time.monotonic()
    if _disk_version is None or (now - _disk_version[0]) > _DISK_TTL:
        _disk_version = (now, _describe_checkout())
    return _disk_version[1]


def _version_payload() -> dict:
    """Running version, plus the on-disk version when a restart is pending."""
    running = _boot_version if _boot_version is not None else capture_boot_version()
    payload = dict(running)

    # Only meaningful for a checkout — a wheel/Docker install can't change
    # underneath the process, so there's nothing to compare against.
    if running["version_source"] == "git":
        disk = _current_disk_version()
        if disk and disk != running["version"]:
            payload["disk_version"] = disk
            payload["restart_needed"] = True
    return payload


# ═══════════════════════════════════════════════════════════════════
# Server Info
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/info")
async def get_server_info(request: Request):
    """Server identity: OS home, server CWD, and the bridge's --workspace.

    The frontend uses `workspace` (when present) as the project base for the
    file explorer and path autocomplete — inside Docker the OS home is
    /home/app, which is not what the user wants as their working area.

    Reads workspace from app.state because `from server import bridge` loads
    a separate `server` module from the running `__main__`, where bridge is
    still None — app.state survives that split because the FastAPI app
    object is the singleton used to register routes.

    Also reports version identity, surfaced in the help dialog's About
    section: `version` is what this process is RUNNING (pinned at boot —
    see capture_boot_version) with `version_source` naming where it came
    from, plus `disk_version`/`restart_needed` when the checkout has moved
    on since. `static_build` is the newest static-asset mtime — the same
    value used as the `?v=` cache-bust on /app, so the client can compare
    it against the build it actually loaded and flag a stale page.

    The two are the same idea one layer apart: loaded-vs-current assets
    means reload, booted-vs-current code means restart.
    """
    import os

    raw_ws = getattr(request.app.state, "workspace", None)
    workspace = None
    if raw_ws:
        try:
            workspace = str(safe_resolve(raw_ws))
        except Exception:
            workspace = raw_ws

    # Imported lazily: server.py imports this module at load time, so a
    # module-level import would be circular. By request time it's cached.
    try:
        from painapple_code.server import _get_static_mtime
        static_build = _get_static_mtime()
    except Exception:
        static_build = None

    return {
        "home": str(Path.home()),
        "cwd": os.getcwd(),
        "workspace": workspace,
        "static_build": static_build,
        **_version_payload(),
    }


# ═══════════════════════════════════════════════════════════════════
# Bridge Config
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/config")
async def get_bridge_config():
    """Get global bridge configuration."""
    return bridge_paths.load_global_config()


@router.put("/api/bridge/config")
async def update_bridge_config(config: dict):
    """Update global bridge configuration."""
    bridge_paths.save_global_config(config)
    return bridge_paths.load_global_config()


# ═══════════════════════════════════════════════════════════════════
# Helper Install (shadow-git CLI + agent template)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/bridge/helpers/status")
async def get_helpers_status():
    """Return install + freshness state for bundled helpers."""
    return helpers_module.helpers_status()


@router.post("/api/bridge/helpers/install")
async def install_helpers():
    """
    Run tools/install-helpers.sh --update on the bridge server's filesystem.
    Returns 200 with {ok, exit_code, stdout, stderr} regardless of script outcome
    so the frontend can read the result without HTTP error handling.
    """
    try:
        # In-process now (helpers.install_helpers) rather than `bash
        # tools/install-helpers.sh --update`: bash isn't present on a stock
        # Windows box, and uninstall was already pure Python — the two
        # halves of the same feature no longer disagree about their
        # requirements. Still off the event loop: it's blocking file IO.
        result = await asyncio.to_thread(helpers_module.install_helpers, True)
        # The install overwrites the bundled agent file (model: sonnet
        # default); re-apply the user's persisted subagent-model choice on top.
        try:
            helpers_module.apply_agent_model_from_config()
        except Exception:
            logger.exception("failed to re-apply helper agent model after install")
        return result
    except Exception as e:
        logger.exception("helper install failed to run")
        return {"ok": False, "exit_code": -1, "stdout": "", "stderr": str(e)}


@router.post("/api/bridge/helpers/uninstall")
async def uninstall_helpers():
    """
    Remove the installed helper files from the bridge server's filesystem.
    Does not touch journal data or shadow-git config — only deletes the
    CLI binary and agent template that `install-helpers.sh` puts in place.
    """
    return helpers_module.uninstall_helpers()


@router.post("/api/bridge/helpers/agent-model")
async def set_helper_agent_model(payload: dict):
    """Set the model the shadow-git-helper subagent runs on.

    Persists the choice to the global config and applies it to the installed
    agent file immediately when present. Body:
    ``{"model": "inherit|haiku|sonnet|opus"}``.
    """
    try:
        model = bridge_paths.set_helper_agent_model((payload or {}).get("model"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    applied = helpers_module.apply_agent_model(model)
    return {"ok": True, "model": model, "applied": applied}
