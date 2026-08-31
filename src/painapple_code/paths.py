"""
Paths - Centralized path management for ~/.painapple-code/

All Painapple Code metadata is stored in ~/.painapple-code/:
    ~/.painapple-code/
    ├── config.json                      # Global settings
    └── projects/
        └── {project-hash}/              # SHA256(absolute path)[:12]
            ├── path                     # Original path for reverse lookup
            ├── config.json              # Project-specific overrides
            ├── shadow-git/              # File recovery repo
            ├── sessions/                # Session data
            └── cache/                   # Cached data

Identity model: one project per local working-copy path. Two clones of the
same repo at different paths are intentionally separate identities — the
shadow-git and DuckDB rows for one are not entangled with the other. A
future widget will let users manually merge/connect related projects.
"""

import hashlib
import json
import logging
import os
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from painapple_code import PACKAGE_DIR

logger = logging.getLogger("painapple-code.paths")

# Allow override via environment variable
DATA_HOME = Path(os.environ.get('PAINAPPLE_CODE_HOME', Path.home() / '.painapple-code'))

# Credentials/config home (XDG-style). Holds auth config and OAuth tokens.
CONFIG_HOME = Path(os.environ.get('PAINAPPLE_CODE_CONFIG', Path.home() / '.config' / 'painapple-code'))


def detect_environment() -> str:
    """Best-effort detection of the runtime environment.

    Returns one of: 'codespaces', 'devcontainer', 'kubernetes', 'docker',
    'podman', 'container', 'local'. Used by the login page to show an
    environment-appropriate "reveal password" command.

    Detection is env-var-only on a normal host. The filesystem probes that tell
    docker from podman are gated behind PAINAPPLE_IN_CONTAINER=1, the marker
    baked into our own image — so on a user's bare-metal machine we never
    stat() /.dockerenv or /run/.containerenv. No surprising filesystem access;
    we only probe once our own marker already says we're containerized.

    Ordering:
    - Codespaces / dev containers / Kubernetes match first via their definitive
      env vars (they *are* containers; the probes below would swallow them).
    - Then, only inside our image, /.dockerenv vs /run/.containerenv pick the
      provider. They're written at *runtime*, so they distinguish docker from
      podman even though the same image runs on both — a baked ENV cannot.
      Neither present (an exotic runtime) falls back to a generic 'container'.
    - A foreign container without our marker reports 'local' on purpose: the
      bare `awk` we then show works in that container's own shell, whereas a
      host-side `docker exec painapple-code …` would assume our image's name.
    - cgroup parsing (/proc/1/cgroup) is avoided: on cgroup v2 it is just
      "0::/", unreliable on modern/rootless hosts.
    """
    env = os.environ
    if env.get('CODESPACES') == 'true' or env.get('CODESPACE_NAME'):
        return 'codespaces'
    if env.get('REMOTE_CONTAINERS') == 'true' or env.get('DEVCONTAINER') == 'true':
        return 'devcontainer'
    if env.get('KUBERNETES_SERVICE_HOST'):
        return 'kubernetes'
    # Filesystem probes only when our own image says we're containerized.
    if env.get('PAINAPPLE_IN_CONTAINER') == '1':
        if Path('/.dockerenv').exists():
            return 'docker'
        if Path('/run/.containerenv').exists():
            return 'podman'
        return 'container'
    return 'local'

# Per-tier suffix for UI-state files (tab-state, shortcuts, presets, favorites,
# global config). Empty for the default (stable) tier. Co-located tiers — dev,
# test — run under the same OS user and $HOME, so without a suffix they'd share
# all of this state. Set once at startup via the server's --state-suffix flag,
# mirroring how --shadow-db / --log-dir already isolate the DuckDB and logs.
# Per-project state (projects/{hash}/...: sessions + shadow-git) deliberately
# stays shared and is NOT suffixed.
STATE_SUFFIX = ""


def init_state_suffix(suffix: Optional[str]) -> None:
    """Set the per-tier UI-state suffix. Call once at startup, before any
    state file is read or written.

    A leading separator is optional: 'dev' and '-dev' both yield
    tab-state-dev.json. Accepting the bare 'dev' form lets callers write
    `--state-suffix dev` instead of `--state-suffix=-dev` — a plain `-dev`
    value trips argparse, which reads the leading dash as a new option."""
    global STATE_SUFFIX
    if not suffix:
        STATE_SUFFIX = ""
    elif suffix[0] in "-_.":
        STATE_SUFFIX = suffix
    else:
        STATE_SUFFIX = "-" + suffix


def _state_file(stem: str, ext: str = "") -> Path:
    """DATA_HOME / f'{stem}{STATE_SUFFIX}{ext}' — applies the per-tier suffix
    to a UI-state file or directory name."""
    return DATA_HOME / f"{stem}{STATE_SUFFIX}{ext}"


def _path_hash(path: str) -> str:
    """First 12 hex chars of SHA256 of the resolved absolute path. 48 bits
    of entropy — collisions are not a concern at single-user/single-host
    scale, and short ids stay readable in paths and DB rows."""
    abs_path = str(Path(path).resolve())
    return hashlib.sha256(abs_path.encode()).hexdigest()[:12]


def get_project_hash(project_path: str) -> str:
    """SHA256 of the resolved absolute project path. Stable per-host."""
    return _path_hash(project_path)


def get_git_repo_hash(project_path: str) -> Optional[str]:
    """Stable hash identifying the git repository, resolving worktrees.

    All worktrees of the same repo return the same hash. Non-git directories
    return None.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(project_path), timeout=5
        )
        if result.returncode != 0:
            return None
        common = (Path(project_path) / result.stdout.strip()).resolve()
    except Exception:
        return None
    return _path_hash(str(common))


def get_project_dir(project_path: str) -> Path:
    """
    Get the ~/.painapple-code/projects/{hash}/ directory for a project.

    Args:
        project_path: Project directory path

    Returns:
        Path to project's data directory
    """
    return DATA_HOME / "projects" / get_project_hash(project_path)


def get_project_dir_by_hash(project_hash: str) -> Path:
    """
    Get the ~/.painapple-code/projects/{hash}/ directory by hash directly.

    Args:
        project_hash: SHA256 of the resolved project path

    Returns:
        Path to project's data directory
    """
    return DATA_HOME / "projects" / project_hash


def get_sessions_dir(project_path: str) -> Path:
    """
    Get sessions directory for a project.

    Args:
        project_path: Project directory path

    Returns:
        Path to ~/.painapple-code/projects/{hash}/sessions/
    """
    return get_project_dir(project_path) / "sessions"


def get_shadow_git_dir(project_path: str) -> Path:
    """
    Get shadow-git directory for a project.

    Args:
        project_path: Project directory path

    Returns:
        Path to ~/.painapple-code/projects/{hash}/shadow-git/
    """
    return get_project_dir(project_path) / "shadow-git"


def get_project_config_path(project_path: str) -> Path:
    """
    Get project-specific config file path.

    Args:
        project_path: Project directory path

    Returns:
        Path to ~/.painapple-code/projects/{hash}/config.json
    """
    return get_project_dir(project_path) / "config.json"


def get_global_config_path() -> Path:
    """
    Get global config file path.

    Returns:
        Path to ~/.painapple-code/config{suffix}.json (per-tier)
    """
    return _state_file("config", ".json")


def get_tab_state_path() -> Path:
    """Return the per-tier tab-state file path (open tabs + active tab)."""
    return _state_file("tab-state", ".json")


def get_shortcuts_path() -> Path:
    """Return the per-tier keyboard-shortcut overrides file path."""
    return _state_file("shortcuts", ".json")


def get_presets_dir() -> Path:
    """Return the per-tier ~/.painapple-code/presets{suffix}/ directory path."""
    return _state_file("presets")


def _load_default_presets() -> dict:
    """Load default presets from presets.defaults.json (ships with the project)."""
    defaults_file = PACKAGE_DIR / "data" / "presets.defaults.json"
    try:
        return json.loads(defaults_file.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error(f"Failed to load {defaults_file}: {e}")
        return {}


def ensure_presets_dir() -> Path:
    """Ensure ~/.painapple-code/presets/ exists, seed missing defaults from presets.defaults.json."""
    presets_dir = get_presets_dir()
    presets_dir.mkdir(parents=True, exist_ok=True)
    # Seed any missing default presets
    defaults = _load_default_presets()
    seeded = 0
    for preset_id, preset in defaults.items():
        path = presets_dir / f"{preset_id}.json"
        if not path.exists():
            path.write_text(json.dumps(preset, indent=2) + "\n", encoding="utf-8")
            seeded += 1
    if seeded:
        logger.info(f"Seeded {seeded} new default presets in {presets_dir}")
    return presets_dir


def load_all_presets() -> dict:
    """Load all presets from ~/.painapple-code/presets/*.json"""
    presets_dir = ensure_presets_dir()
    presets = {}
    for path in sorted(presets_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            preset_id = path.stem
            presets[preset_id] = data
        except Exception as e:
            logger.warning(f"Failed to load preset {path.name}: {e}")
    return presets


def _preset_file(preset_id: str) -> Path:
    """Resolve a preset id to its JSON file, contained to the presets dir.

    `preset_id` reaches the route as a single-segment FastAPI path param, so it
    can't hold a `/` — but that is a POSIX-only guarantee: on Windows a
    backslash survives the `[^/]+` convertor, so `..\\..\\evil` would land
    `<traversal>.json` outside the presets dir on a `write_text`/`unlink`. This
    is the one preset sink the WP-08 audit found with no explicit guard.

    Validate lexically (reject any separator, traversal, or NUL — checked for
    BOTH separators regardless of host OS, so the POSIX CI catches a
    Windows-only escape) and then confirm containment with `is_relative_to`
    after resolve() as the platform-correct backstop. Raises ValueError on a
    bad id; callers surface it as 400.
    """
    if (not preset_id
            or preset_id in (".", "..")
            or "/" in preset_id
            or "\\" in preset_id
            or "\x00" in preset_id
            or preset_id != Path(preset_id).name):
        raise ValueError(f"Invalid preset id: {preset_id!r}")
    presets_dir = get_presets_dir()
    resolved = (presets_dir / f"{preset_id}.json").resolve()
    if not resolved.is_relative_to(presets_dir.resolve()):
        raise ValueError(f"Preset id escapes the presets directory: {preset_id!r}")
    return resolved


def save_preset(preset_id: str, data: dict):
    """Save a single preset to ~/.painapple-code/presets/{id}.json"""
    ensure_presets_dir()
    path = _preset_file(preset_id)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def delete_preset(preset_id: str) -> bool:
    """Delete a preset file. Returns True if deleted."""
    path = _preset_file(preset_id)
    if path.exists():
        path.unlink()
        return True
    return False


def ensure_data_home() -> Path:
    """
    Ensure ~/.painapple-code/ exists.

    Returns:
        Path to ~/.painapple-code/
    """
    DATA_HOME.mkdir(parents=True, exist_ok=True)
    return DATA_HOME


def ensure_project_dir(project_path: str) -> Path:
    """
    Create project directory structure and write path file for reverse lookup.

    Args:
        project_path: Project directory path

    Returns:
        Path to the created/existing project directory
    """
    project_dir = get_project_dir(project_path)
    project_dir.mkdir(parents=True, exist_ok=True)

    # Write reverse lookup file
    path_file = project_dir / "path"
    abs_path = str(Path(project_path).resolve())

    if not path_file.exists():
        path_file.write_text(abs_path, encoding="utf-8")
        logger.debug(f"Created project dir: {project_dir} -> {abs_path}")
    elif path_file.read_text(encoding="utf-8").strip() != abs_path:
        # Path changed (shouldn't happen with hash, but handle gracefully)
        logger.warning(f"Project path mismatch: {path_file.read_text(encoding="utf-8").strip()} vs {abs_path}")
        path_file.write_text(abs_path, encoding="utf-8")

    return project_dir


def get_project_path_from_hash(project_hash: str) -> Optional[str]:
    """
    Reverse lookup: get original project path from hash.

    Args:
        project_hash: SHA256 of the resolved project path

    Returns:
        Original project path or None if not found
    """
    path_file = DATA_HOME / "projects" / project_hash / "path"
    if path_file.exists():
        return path_file.read_text(encoding="utf-8").strip()
    return None


def list_projects(include_unreachable: bool = False) -> list[dict]:
    """
    List all tracked projects.

    By default, projects whose original `path` is not a directory on the
    current host are skipped. This matters in Docker: ~/.painapple-code/
    survives across runs but the host paths it references may not be
    mounted into the current container.

    Args:
        include_unreachable: If True, include projects whose path no longer
            exists. Useful for archaeology/cleanup; the result dict's
            `reachable` field tells callers which ones are missing.

    Returns:
        List of dicts with: hash, path, sessions_dir, shadow_git_dir,
        session_count, has_sessions, has_shadow_git, reachable.
    """
    projects_dir = DATA_HOME / "projects"
    if not projects_dir.exists():
        return []

    result = []
    for hash_dir in projects_dir.iterdir():
        if not hash_dir.is_dir():
            continue
        path_file = hash_dir / "path"
        if not path_file.exists():
            continue

        project_path = path_file.read_text(encoding="utf-8").strip()
        reachable = Path(project_path).is_dir()

        if not reachable and not include_unreachable:
            continue

        sessions_dir = hash_dir / "sessions"
        shadow_git_dir = hash_dir / "shadow-git"

        # Count sessions
        session_count = 0
        if sessions_dir.exists():
            session_count = sum(1 for d in sessions_dir.iterdir()
                               if d.is_dir() and (d / "meta.json").exists())

        # Custom color, if the user assigned one (read straight from the
        # project's config.json — no global merge needed for a display field).
        custom_color = None
        cfg_file = hash_dir / "config.json"
        if cfg_file.exists():
            try:
                cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
                custom_color = _normalize_project_color(
                    cfg.get("display", {}).get("color")
                )
            except Exception:
                pass

        result.append({
            "hash": hash_dir.name,
            "path": project_path,
            "sessions_dir": str(sessions_dir),
            "shadow_git_dir": str(shadow_git_dir),
            "session_count": session_count,
            "has_sessions": sessions_dir.exists(),
            "has_shadow_git": shadow_git_dir.exists(),
            "reachable": reachable,
            "color": custom_color,
        })

    return result


# Don't auto-scan these dangerous parents — they're almost never what the user
# means by "workspace folder" and would surface huge noisy lists.
_WORKSPACE_ROOT_DENYLIST = {"/", "/home", "/Users", "/root", "/mnt", "/srv"}

# Windows equivalents. The exact-string set above can't cover these: a
# drive root is "C:\\" (any letter) and the user container is
# "C:\\Users" — so a `--workspace C:\` would have enumerated every
# top-level directory into the welcome screen, exactly what this guard
# exists to prevent.
_WIN_DENY_NAMES = {"users", "windows", "program files", "program files (x86)",
                   "programdata"}


def _is_denied_workspace_root(root_path: Path) -> bool:
    if str(root_path) in _WORKSPACE_ROOT_DENYLIST:
        return True
    if sys.platform != "win32":
        return False
    # A drive or UNC root is its own parent.
    if root_path.parent == root_path:
        return True
    return (root_path.parent == Path(root_path.anchor)
            and root_path.name.lower() in _WIN_DENY_NAMES)


_PROJECT_MARKERS = (
    ".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
    "setup.py", "requirements.txt", "Gemfile", "pom.xml", "build.gradle",
)


def _looks_like_project(child: Path) -> bool:
    """Heuristic: does this dir look like the root of a project?

    Cheap signal — any common manifest at the top level. .git matches both
    a normal repo (dir) and a git worktree (file pointing at the main repo).
    """
    for marker in _PROJECT_MARKERS:
        if (child / marker).exists():
            return True
    return False


def list_workspace_dirs(root: str, exclude_paths: Optional[list[str]] = None,
                        limit: int = 100) -> list[dict]:
    """List immediate sub-directories of a workspace root, excluding ones
    that are already tracked projects.

    Used by the welcome screen to surface sibling folders the user hasn't
    started a session in yet. Sorted with project-looking dirs (anything
    with a top-level .git, package.json, pyproject.toml, …) first, then
    by directory mtime descending so recently touched folders bubble up.

    Hidden directories (leading dot) and symlinks are skipped. The
    `_WORKSPACE_ROOT_DENYLIST` short-circuits dangerous roots like `/` so
    a misconfigured `--workspace` can't surface every top-level dir.

    Args:
        root: Absolute path to scan.
        exclude_paths: Resolved absolute paths to skip (e.g. existing
            project paths from list_projects()).
        limit: Max entries to return.

    Returns:
        List of {path, name, mtime, looks_like_project} sorted with
        project-looking dirs first, then by mtime descending.
    """
    try:
        root_path = Path(root).expanduser().resolve()
    except (OSError, RuntimeError):
        return []

    if not root_path.is_dir() or _is_denied_workspace_root(root_path):
        return []

    exclude_set: set[str] = set()
    for p in exclude_paths or []:
        try:
            exclude_set.add(str(Path(p).expanduser().resolve()))
        except (OSError, RuntimeError):
            continue

    candidates = []
    try:
        entries = list(root_path.iterdir())
    except (OSError, PermissionError):
        return []

    for child in entries:
        if child.name.startswith("."):
            continue
        # is_dir() follows symlinks; is_symlink() lets us reject those first.
        if child.is_symlink() or not child.is_dir():
            continue
        try:
            resolved = str(child.resolve())
        except (OSError, RuntimeError):
            continue
        if resolved in exclude_set:
            continue
        try:
            mtime = child.stat().st_mtime
        except OSError:
            continue
        candidates.append({
            "path": resolved,
            "name": child.name,
            "mtime": mtime,
            "looks_like_project": _looks_like_project(child),
        })

    # Project-looking dirs first (True > False), then most-recently-touched.
    candidates.sort(key=lambda x: (x["looks_like_project"], x["mtime"]), reverse=True)
    return candidates[:limit]


def load_global_config() -> dict:
    """
    Load global config from ~/.painapple-code/config.json.

    Returns:
        Config dict (empty dict if file doesn't exist)
    """
    config_path = get_global_config_path()
    if config_path.exists():
        try:
            return json.loads(config_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error(f"Failed to load global config: {e}")
    return {}


def save_global_config(config: dict):
    """
    Save global config to ~/.painapple-code/config.json.

    Args:
        config: Config dict to save
    """
    ensure_data_home()
    config_path = get_global_config_path()
    try:
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to save global config: {e}")


# ─── Shadow-git-helper subagent model ─────────────────────────────────────────

# The Claude Code subagent `model:` frontmatter field accepts "inherit" (reuse
# the main thread's model) or a full model ID — the real `claude -p` CLI honors
# full IDs (verified: a subagent pinned to claude-opus-4-8 ran on opus while the
# main thread ran Fable). So we offer the same picks as the main model selector
# (models.yaml `selectable`) plus "inherit", rather than the tier aliases —
# that's the only way to reach models like Fable, which has no `fable` alias.
# Persisted in the global config so it survives helper reinstalls
# (install-helpers.sh cp -f's the bundled default over the top; we re-apply this).
HELPER_AGENT_INHERIT = "inherit"
DEFAULT_HELPER_AGENT_MODEL = "claude-sonnet-5"


def get_helper_agent_options() -> list[str]:
    """Valid subagent-model picks: 'inherit' + the selectable model IDs."""
    ids = [m.get("id") for m in get_selectable_models() if m.get("id")]
    return [HELPER_AGENT_INHERIT] + ids


def get_helper_agent_model() -> str:
    """Return the configured shadow-git-helper subagent model (full ID or 'inherit').

    Reads leniently — a value stored before a model was removed from the
    selectable list is still honored; only writes are validated.
    """
    cfg = load_global_config()
    val = str(cfg.get("helper_agent_model", "") or "").strip()
    return val or DEFAULT_HELPER_AGENT_MODEL


def set_helper_agent_model(model: str) -> str:
    """Persist the shadow-git-helper subagent model.

    Accepts 'inherit' or a model ID present in the selectable list. Returns the
    normalized value. Raises ValueError for anything else.
    """
    val = str(model or "").strip()
    options = get_helper_agent_options()
    if val not in options:
        raise ValueError(
            f"Invalid helper agent model {model!r}; expected one of {options}"
        )
    cfg = load_global_config()
    cfg["helper_agent_model"] = val
    save_global_config(cfg)
    return val


# ─── Models config (models.yaml) ──────────────────────────────────────────────

_models_cache: dict = {}
_models_mtime: float = 0.0

def load_models_config() -> dict:
    """Load models.yaml from package data. Cached by file mtime."""
    global _models_cache, _models_mtime
    yaml_path = PACKAGE_DIR / "data" / "models.yaml"
    if not yaml_path.exists():
        return {"selectable": [], "summary_model": "claude-haiku-4-5"}
    mtime = yaml_path.stat().st_mtime
    if mtime == _models_mtime and _models_cache:
        return _models_cache
    import yaml
    with open(yaml_path, encoding="utf-8") as f:
        _models_cache = yaml.safe_load(f) or {}
    _models_mtime = mtime
    return _models_cache


def get_summary_model() -> str:
    """Model ID for shadow-git summary / auto-journal forks (Claude → Haiku)."""
    cfg = load_models_config()
    # Back-compat: the models.yaml key was `haiku:` before the rename.
    return cfg.get("summary_model") or cfg.get("haiku") or "claude-haiku-4-5"


def get_selectable_models() -> list:
    """Get the list of user-selectable models."""
    return load_models_config().get("selectable", [])


def get_default_models_config() -> dict:
    """Load the pristine default model list from models.defaults.yaml."""
    yaml_path = PACKAGE_DIR / "data" / "models.defaults.yaml"
    if not yaml_path.exists():
        return {"selectable": [], "summary_model": "claude-haiku-4-5"}
    import yaml
    with open(yaml_path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_models_config(config: dict) -> None:
    """Write models.yaml with the given config. Invalidates the cache."""
    global _models_cache, _models_mtime
    import yaml
    yaml_path = PACKAGE_DIR / "data" / "models.yaml"
    header = (
        "# models.yaml - Available Claude models (single source of truth)\n"
        "# Server serves this via GET /api/app/models\n"
        "# Edit via Settings → Providers, or by hand (both work).\n\n"
    )
    body = yaml.safe_dump(config, sort_keys=False, allow_unicode=True)
    yaml_path.write_text(header + body, encoding="utf-8")
    # Invalidate cache so next read picks up the change
    _models_cache = {}
    _models_mtime = 0.0


# ─── Per-provider new-session defaults ──────────────────────────────────────────
#
# Session defaults are per PROVIDER: each map is keyed by the provider's
# `models_key` namespace (driver pairs share — same convention as
# `models_disabled`). The flat legacy keys (`default_model`, `default_effort`,
# `default_token_profile`) remain as read fallbacks for configs written before
# the split; the provider-defaults PUT migrates them into the maps on first
# write and drops them.

def _provider_scoped_default(map_key: str, legacy_key: str, provider):
    cfg = load_global_config()
    scoped_map = cfg.get(map_key)
    ns = getattr(provider, "models_key", None) or provider.name
    scoped = scoped_map.get(ns) if isinstance(scoped_map, dict) else None
    if isinstance(scoped, str) and scoped:
        return scoped
    legacy = cfg.get(legacy_key)
    return legacy if isinstance(legacy, str) and legacy else None


def provider_default_model(provider):
    """The provider's default new-session model — always CONCRETE when the
    provider has a catalog.

    Resolution: per-provider map → legacy app-wide flat → **the provider's top
    enabled catalog model** (priority-first). The app owns the default; we no
    longer defer to the provider's own CLI config (the "Default" placeholder is
    gone). A configured value the provider can't serve — a legacy Claude flat
    key read by Codex, or a Settings-hidden id — is treated as unset and
    falls through to the top catalog model, so every provider with a catalog
    presents a real, in-catalog default.

    Membership is prefix-matched against `enabled_models()` (same as
    `preferred_model_survives`; catalog ids are the short canonical form,
    stored ids may carry date suffixes). Returns None only for a provider with
    NO catalog and no configured value — then the launch path lets the CLI
    use its own configured model (e.g. Codex with no models cache)."""
    value = _provider_scoped_default("default_models", "default_model", provider)
    enabled_ids = [m.get("id") for m in provider.enabled_models() if m.get("id")]
    if not enabled_ids:
        # No catalog to validate against — trust the value; launch decides.
        return value or None
    if value and any(value.startswith(mid) for mid in enabled_ids):
        return value
    # Unset / foreign / hidden → the provider's top (highest-priority) model.
    return enabled_ids[0]


def provider_default_effort(provider):
    """The provider's configured default effort, gated to its own vocabulary —
    a legacy `max` must not leak into a provider that caps at `high`."""
    value = _provider_scoped_default("default_efforts", "default_effort", provider)
    levels = provider.effort_levels() or []
    if value and levels and value not in levels:
        return None
    return value


def provider_default_token_profile(provider):
    """The provider's configured default account/token profile. None for
    providers without selectable accounts (profiles are meaningless there)."""
    if not provider.accounts():
        return None
    return _provider_scoped_default(
        "default_token_profiles", "default_token_profile", provider)


def get_shadow_git_defaults(global_config: dict = None) -> dict:
    """
    Get shadow git defaults from global config.

    Args:
        global_config: Optional pre-loaded global config

    Returns:
        Dict with enabled and rich_commits defaults
    """
    if global_config is None:
        global_config = load_global_config()

    defaults = global_config.get("shadow_git_defaults", {})
    return {
        "enabled": defaults.get("enabled", True),
        "rich_commits": defaults.get("rich_commits", True),
        # Files larger than this (MB) are never committed to shadow git;
        # 0 disables the cap. Overridable per project via shadow_git config.
        "max_file_size_mb": defaults.get("max_file_size_mb", 50),
    }


def load_project_config(project_path: str) -> dict:
    """
    Load project-specific config, merged with global config.
    Project config overrides global config.

    For shadow_git settings, applies defaults from shadow_git_defaults
    in global config, then project-specific overrides.

    Args:
        project_path: Project directory path

    Returns:
        Merged config dict with shadow_git settings resolved
    """
    global_config = load_global_config()

    # Start with global config (excluding shadow_git_defaults which is meta)
    result = {k: v for k, v in global_config.items() if k != "shadow_git_defaults"}

    # Apply shadow_git defaults
    sg_defaults = get_shadow_git_defaults(global_config)
    result["shadow_git"] = sg_defaults.copy()

    # Load project-specific config
    project_config_path = get_project_config_path(project_path)
    if project_config_path.exists():
        try:
            project_config = json.loads(project_config_path.read_text(encoding="utf-8"))

            # Deep merge shadow_git if present
            if "shadow_git" in project_config:
                result["shadow_git"].update(project_config["shadow_git"])

            # Merge other project config (overrides global)
            for k, v in project_config.items():
                if k != "shadow_git":
                    result[k] = v

        except Exception as e:
            logger.error(f"Failed to load project config: {e}")

    return result


def save_project_config(project_path: str, config: dict):
    """
    Save project-specific config.

    Args:
        project_path: Project directory path
        config: Config dict to save
    """
    ensure_project_dir(project_path)
    config_path = get_project_config_path(project_path)
    try:
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to save project config: {e}")


def get_project_display_name(project_path: str) -> str:
    """
    Get human-friendly display name for a project.

    Returns custom name from config if set, otherwise directory name.

    Args:
        project_path: Project directory path

    Returns:
        Display name string
    """
    config = load_project_config(project_path)
    custom_name = config.get("display", {}).get("name")
    if custom_name:
        return custom_name
    return Path(project_path).name


def set_project_display_name(project_path: str, name: str):
    """
    Set human-friendly display name for a project.

    Args:
        project_path: Project directory path
        name: Display name (empty string to clear)
    """
    config_path = get_project_config_path(project_path)

    # Load existing config
    existing = {}
    if config_path.exists():
        try:
            existing = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    # Update display.name
    if "display" not in existing:
        existing["display"] = {}

    if name:
        existing["display"]["name"] = name
    else:
        existing["display"].pop("name", None)
        # Clean up empty display dict
        if not existing["display"]:
            existing.pop("display", None)

    save_project_config(project_path, existing)


def _normalize_project_color(color: str) -> Optional[str]:
    """Validate + normalize a project color to a #rrggbb hex string.

    Accepts 3- or 6-digit hex with or without a leading '#'. Returns the
    lowercased #rrggbb form, or None if the value is empty/invalid (so
    callers can treat "invalid" the same as "clear").
    """
    if not color:
        return None
    c = str(color).strip().lstrip("#").lower()
    if len(c) == 3 and all(ch in "0123456789abcdef" for ch in c):
        c = "".join(ch * 2 for ch in c)
    if len(c) == 6 and all(ch in "0123456789abcdef" for ch in c):
        return f"#{c}"
    return None


def get_project_color(project_path: str) -> Optional[str]:
    """Get the user-assigned custom color for a project.

    Returns a normalized #rrggbb hex string, or None when no custom color
    is set (callers fall back to the deterministic client-side hash color).
    """
    config = load_project_config(project_path)
    return _normalize_project_color(config.get("display", {}).get("color"))


def set_project_color(project_path: str, color: str) -> Optional[str]:
    """Set (or clear) the custom color for a project.

    Stores under ``display.color`` to mirror ``display.name``. Pass an empty
    string / invalid value to clear the override. Returns the normalized
    color that was stored, or None when cleared.
    """
    config_path = get_project_config_path(project_path)

    existing = {}
    if config_path.exists():
        try:
            existing = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    if "display" not in existing:
        existing["display"] = {}

    normalized = _normalize_project_color(color)
    if normalized:
        existing["display"]["color"] = normalized
    else:
        existing["display"].pop("color", None)

    # Clean up an empty display dict so config stays tidy.
    if not existing.get("display"):
        existing.pop("display", None)

    save_project_config(project_path, existing)
    return normalized


def list_project_colors() -> dict:
    """Map of project path → custom color for every project that has one set.

    Powers a single client-side fetch so the synchronous ``getProjectColor``
    lookups across the UI can consult overrides without per-project requests.
    """
    return {
        p["path"]: p["color"]
        for p in list_projects(include_unreachable=True)
        if p.get("color")
    }


# ═══════════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════════
# Favorites System
# ═══════════════════════════════════════════════════════════════════════════

def get_favorites_path() -> Path:
    """
    Get favorites file path.

    Returns:
        Path to ~/.painapple-code/favorites{suffix}.json (per-tier)
    """
    return _state_file("favorites", ".json")


def get_drafts_path() -> Path:
    """
    Get prompt-drafts file path (explicit "save for later" prompts).

    Returns:
        Path to ~/.painapple-code/drafts{suffix}.json (per-tier)
    """
    return _state_file("drafts", ".json")


def load_drafts() -> dict:
    """
    Load prompt drafts from ~/.painapple-code/drafts.json.

    Returns:
        Dict with version and drafts list (newest first)
    """
    drafts_path = get_drafts_path()
    if drafts_path.exists():
        try:
            return json.loads(drafts_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error(f"Failed to load drafts: {e}")
    return {"version": 1, "drafts": []}


def save_drafts(data: dict) -> bool:
    """
    Save prompt drafts to ~/.painapple-code/drafts.json.

    Args:
        data: Drafts dict with version and drafts list

    Returns:
        True on success (drafts are user data — callers should surface failure)
    """
    ensure_data_home()
    drafts_path = get_drafts_path()
    try:
        drafts_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return True
    except Exception as e:
        logger.error(f"Failed to save drafts: {e}")
        return False


def load_favorites() -> dict:
    """
    Load favorites from ~/.painapple-code/favorites.json.

    Returns:
        Dict with version and favorites list
    """
    fav_path = get_favorites_path()
    if fav_path.exists():
        try:
            return json.loads(fav_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error(f"Failed to load favorites: {e}")
    return {"version": 1, "favorites": []}


def save_favorites(data: dict):
    """
    Save favorites to ~/.painapple-code/favorites.json.

    Args:
        data: Favorites dict with version and favorites list
    """
    ensure_data_home()
    fav_path = get_favorites_path()
    try:
        fav_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to save favorites: {e}")


def add_favorite(session_id: str, project_hash: str, note: str = None) -> bool:
    """
    Add a session to favorites.

    Args:
        session_id: Session ID to favorite
        project_hash: Project hash the session belongs to
        note: Optional note explaining why it's favorited

    Returns:
        True if added, False if already exists
    """


    data = load_favorites()
    favorites = data.get("favorites", [])

    # Check if already favorited
    for fav in favorites:
        if fav["session_id"] == session_id:
            return False

    # Add new favorite
    favorites.append({
        "session_id": session_id,
        "project_hash": project_hash,
        "note": note,
        "added_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })

    data["favorites"] = favorites
    save_favorites(data)
    return True


def remove_favorite(session_id: str) -> bool:
    """
    Remove a session from favorites.

    Args:
        session_id: Session ID to unfavorite

    Returns:
        True if removed, False if not found
    """
    data = load_favorites()
    favorites = data.get("favorites", [])

    original_len = len(favorites)
    favorites = [f for f in favorites if f["session_id"] != session_id]

    if len(favorites) == original_len:
        return False

    data["favorites"] = favorites
    save_favorites(data)
    return True


def update_favorite_note(session_id: str, note: str) -> bool:
    """
    Update the note on a favorite.

    Args:
        session_id: Session ID to update
        note: New note (can be empty string to clear)

    Returns:
        True if updated, False if not found
    """


    data = load_favorites()
    favorites = data.get("favorites", [])

    for fav in favorites:
        if fav["session_id"] == session_id:
            fav["note"] = note
            fav["updated_at"] = datetime.now(timezone.utc).isoformat()
            data["favorites"] = favorites
            save_favorites(data)
            return True

    return False


def is_favorite(session_id: str) -> bool:
    """
    Check if a session is favorited.

    Args:
        session_id: Session ID to check

    Returns:
        True if favorited, False otherwise
    """
    data = load_favorites()
    favorites = data.get("favorites", [])
    return any(f["session_id"] == session_id for f in favorites)


def get_favorite(session_id: str) -> Optional[dict]:
    """
    Get favorite data for a session.

    Args:
        session_id: Session ID to look up

    Returns:
        Favorite dict if found, None otherwise
    """
    data = load_favorites()
    favorites = data.get("favorites", [])
    for fav in favorites:
        if fav["session_id"] == session_id:
            return fav
    return None


# ═══════════════════════════════════════════════════════════════════════════
# Prompt Favorites System
# ═══════════════════════════════════════════════════════════════════════════

def get_prompt_favorites_path() -> Path:
    """
    Get prompt favorites file path.

    Returns:
        Path to ~/.painapple-code/prompt-favorites{suffix}.json (per-tier)
    """
    return _state_file("prompt-favorites", ".json")


def load_prompt_favorites() -> dict:
    """
    Load prompt favorites from ~/.painapple-code/prompt-favorites.json.

    Returns:
        Dict with version and prompts dict (prompt_id -> metadata)
    """
    fav_path = get_prompt_favorites_path()
    if fav_path.exists():
        try:
            return json.loads(fav_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error(f"Failed to load prompt favorites: {e}")
    return {"version": 1, "prompts": {}}


def save_prompt_favorites(data: dict):
    """
    Save prompt favorites to ~/.painapple-code/prompt-favorites.json.

    Args:
        data: Favorites dict with version and prompts
    """
    ensure_data_home()
    fav_path = get_prompt_favorites_path()
    try:
        fav_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to save prompt favorites: {e}")


def add_prompt_favorite(prompt_id: str, content_preview: str = "", note: str = "") -> bool:
    """
    Add a prompt to favorites.

    Args:
        prompt_id: Prompt ID (format: session_id:line_number)
        content_preview: First ~100 chars of prompt for display
        note: Optional user note

    Returns:
        True if added, False if already exists
    """


    data = load_prompt_favorites()
    prompts = data.get("prompts", {})

    if prompt_id in prompts:
        return False

    prompts[prompt_id] = {
        "content_preview": content_preview[:100] if content_preview else "",
        "note": note,
        "added_at": datetime.now(timezone.utc).isoformat(),
    }

    data["prompts"] = prompts
    save_prompt_favorites(data)
    return True


def remove_prompt_favorite(prompt_id: str) -> bool:
    """
    Remove a prompt from favorites.

    Args:
        prompt_id: Prompt ID to unfavorite

    Returns:
        True if removed, False if not found
    """
    data = load_prompt_favorites()
    prompts = data.get("prompts", {})

    if prompt_id not in prompts:
        return False

    del prompts[prompt_id]
    data["prompts"] = prompts
    save_prompt_favorites(data)
    return True


def is_prompt_favorite(prompt_id: str) -> bool:
    """
    Check if a prompt is favorited.

    Args:
        prompt_id: Prompt ID to check

    Returns:
        True if favorited, False otherwise
    """
    data = load_prompt_favorites()
    return prompt_id in data.get("prompts", {})


def get_prompt_favorite(prompt_id: str) -> Optional[dict]:
    """
    Get favorite metadata for a prompt.

    Args:
        prompt_id: Prompt ID to look up

    Returns:
        Favorite metadata dict if found, None otherwise
    """
    data = load_prompt_favorites()
    return data.get("prompts", {}).get(prompt_id)


def get_all_prompt_favorites() -> dict:
    """
    Get all favorited prompt IDs.

    Returns:
        Dict of prompt_id -> metadata
    """
    data = load_prompt_favorites()
    return data.get("prompts", {})


# One warning per path per process — a failed ACL tightening is worth
# saying loudly once, not on every ensure_config_file() call.
_ACL_WARNED: set = set()


def _current_user_sid() -> Optional[str]:
    """The calling process's user SID (``S-1-5-21-…``), or None if unreadable.

    icacls names a principal either by account name or, with a ``*`` prefix,
    by SID. Account names are the wrong currency here. The obvious spelling,
    ``%USERDOMAIN%\\%USERNAME%``, is actively wrong on a workgroup machine:
    USERDOMAIN is the literal string "WORKGROUP", which maps to no SID at
    all, so icacls fails with 1332 ("No mapping between account names and
    security IDs was done") and the hardening silently degrades to a warning.
    A bare username usually resolves, but not on a localized install where
    the account was renamed, and it can be ambiguous when a local and a
    domain account share a name.

    The SID sidesteps all of it: we read it straight off our own process
    token, so there is no name to resolve and no locale to get wrong.
    """
    import ctypes
    from ctypes import wintypes

    TOKEN_QUERY = 0x0008
    TOKEN_USER_CLASS = 1

    try:
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        # Declare signatures explicitly: ctypes defaults every return type to
        # C int, which truncates HANDLEs and pointers on 64-bit Windows.
        advapi32.OpenProcessToken.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        advapi32.OpenProcessToken.restype = wintypes.BOOL
        advapi32.GetTokenInformation.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD)]
        advapi32.GetTokenInformation.restype = wintypes.BOOL
        advapi32.ConvertSidToStringSidW.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
        advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(
                kernel32.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)):
            return None
        try:
            # First call sizes the buffer; it's expected to "fail" with
            # ERROR_INSUFFICIENT_BUFFER, so only the second return matters.
            size = wintypes.DWORD()
            advapi32.GetTokenInformation(
                token, TOKEN_USER_CLASS, None, 0, ctypes.byref(size))
            if not size.value:
                return None
            buf = ctypes.create_string_buffer(size.value)
            if not advapi32.GetTokenInformation(
                    token, TOKEN_USER_CLASS, buf, size, ctypes.byref(size)):
                return None
            # TOKEN_USER is a SID_AND_ATTRIBUTES, whose first pointer-sized
            # field is the PSID itself (the SID lives past the struct).
            sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p)).contents
            out = ctypes.c_wchar_p()
            if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(out)):
                return None
            try:
                return out.value
            finally:
                kernel32.LocalFree(out)
        finally:
            kernel32.CloseHandle(token)
    except (OSError, AttributeError, ValueError):
        return None


def _acl_principal() -> Optional[str]:
    """The icacls principal for the current user — SID first, name as backstop."""
    sid = _current_user_sid()
    if sid:
        return f"*{sid}"
    # Deliberately the BARE username, never %USERDOMAIN%\%USERNAME%: on a
    # workgroup machine that domain part is unresolvable (see above).
    return os.environ.get("USERNAME") or None


def _lock_mode_windows(path: Path, mode: int) -> None:
    """Owner-only DACL via icacls — the NTFS stand-in for chmod 0600/0700.

    On Windows `os.chmod` only toggles FILE_ATTRIBUTE_READONLY and
    RETURNS SUCCESS, so the POSIX path here was a silent no-op: the
    server password and the TLS private key were protected by nothing but
    whatever the user's profile happened to inherit, and the `except
    OSError` warning could never fire to say so. (Perversely, chmod 0600
    on an already-read-only file LOOSENS it by clearing that attribute.)

    icacls ships in every Windows install, so this needs no pywin32:
      /inheritance:r   drop inherited ACEs (the whole point — otherwise
                       a permissive parent keeps granting access)
      /grant:r USER:F  full control for just this user, replacing any
                       existing grant for them
    Modes with any group/other bits set (0o644) aren't "owner only" and
    are left alone rather than silently over-tightened.
    """
    if mode & 0o077:
        return
    key = str(path)
    principal = _acl_principal()
    if not principal:
        if key not in _ACL_WARNED:
            _ACL_WARNED.add(key)
            logger.warning(
                f"Cannot restrict {path}: the current user's SID and USERNAME "
                "are both unreadable, so no owner-only ACL was applied. This "
                "file is readable by any account that inherits access to its "
                "parent directory."
            )
        return
    try:
        result = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{principal}:F"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as e:
        result = None
        detail = f"{type(e).__name__}: {e}"
    else:
        detail = (result.stderr or result.stdout or "").strip()[:200]
    if result is None or result.returncode != 0:
        if key not in _ACL_WARNED:
            _ACL_WARNED.add(key)
            logger.warning(
                f"Could not restrict {path} to {principal} only ({detail}). "
                "Continuing — check it isn't readable by other accounts on "
                "this machine."
            )


def lock_mode(path, mode: int) -> None:
    """Tighten `path` to `mode`, tolerating a filesystem that won't have it.

    chmod needs OWNERSHIP, not write permission — it fails with EPERM,
    not EACCES, when you merely have write access. So a config dir
    bind-mounted from the host into a container raises here whenever the
    container's user isn't its owner, which used to take the whole server
    down on boot before it had served a single request.

    These modes are hardening on files the host user already controls and
    can chmod themselves, so a refusal is worth a loud warning rather
    than a dead server. The no-op case (already correct, by far the most
    common) doesn't call chmod at all, so it can't fail there either.

    On Windows the POSIX bits are meaningless, so this delegates to an
    icacls DACL — see _lock_mode_windows for why a no-op there was worse
    than it looks.
    """
    path = Path(path)
    if sys.platform == "win32":
        _lock_mode_windows(path, mode)
        return
    try:
        current = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        current = None
    if current == mode:
        return
    try:
        os.chmod(path, mode)
    except OSError as e:
        logger.warning(
            f"Could not set permissions on {path} to {mode:#o} "
            f"({type(e).__name__}: {e.strerror})"
            + (f"; it is {current:#o}" if current is not None else "")
            + ". Continuing — check it isn't readable by other users."
        )
