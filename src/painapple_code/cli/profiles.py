"""Unified profile store — named deployments with a run mode.

A profile is a named, independent deployment at
``~/.painapple-code/profiles/NAME/profile.yaml`` whose ``mode`` says
HOW it runs:

* ``mode: host``   — a local server. The profile dir IS its data home
  (sessions, shadow DB, logs, config.json) — isolation is mandatory,
  not cosmetic, since DuckDB is single-writer. Running it repoints
  ``PAINAPPLE_CODE_HOME`` at the dir before the server boots
  (:func:`activate`); every path helper follows for free.
* ``mode: docker`` — a container sandbox. Only ``profile.yaml`` lives
  in the profile dir; data lives in the container's volume (``/data``).
  ``claude_home`` defaults to the shared ``shared/.claude`` so one
  login serves every sandbox.

Shared keys use the serve vocabulary (``host`` = bind, ``tls``,
``port``, ``workspace``, ``instance_name``, ``accent``); docker mode
adds its own (image, container, volumes, workspace_mode, …) — see
cli/deploy/config.py for that half of the model.

Migration: :func:`ensure_migrated` adopts the two pre-unification
stores — ``serve-profiles/NAME/serve.yaml`` (moved wholesale; a
symlink is left behind so hand-written service units keep working) and
``docker-profiles/NAME/docker.yaml`` — plus the root ``docker.yaml``
(runtime defaults merge into serve.yaml; the deployment itself is
adopted as a profile only if its container/volume actually exists).
Idempotent and loud.
"""

import os
import re
import shutil
from pathlib import Path

from painapple_code.cli import serve_config
from painapple_code.cli.serve_config import (
    HOST_KEYS, LEGACY_DOCKER_PROFILES_DIR, LEGACY_SERVE_PROFILES_DIR,
    PROFILES_DIR, root_home,
)

PROFILE_FILE = "profile.yaml"
MODES = ("host", "docker")

_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")

# 'default' means the flag-less root deployment in every verb — a
# profile by that name could never be addressed.
_RESERVED_NAMES = {"default"}


def valid_name(name):
    name = (name or "").strip()
    return bool(_PROFILE_RE.match(name)) and name not in _RESERVED_NAMES


def profiles_root(root=None):
    return (root or root_home()) / PROFILES_DIR


def profile_home(name, root=None):
    return profiles_root(root) / name


def profile_path(name, root=None):
    return profile_home(name, root) / PROFILE_FILE


def exists(name, root=None):
    return profile_path(name, root).is_file()


def list_profiles(root=None):
    """Named profiles that have a profile.yaml on disk (sorted)."""
    base = profiles_root(root)
    if not base.is_dir():
        return []
    return sorted(p.name for p in base.iterdir()
                  if p.is_dir() and (p / PROFILE_FILE).is_file())


class Profile:
    """One loaded profile: ``name``, ``mode``, raw ``data`` dict, and
    the load ``problems`` list (unknown/bad values, reported not fatal)."""

    def __init__(self, name, mode, data, problems=None):
        self.name = name
        self.mode = mode
        self.data = data
        self.problems = problems or []

    @property
    def is_docker(self):
        return self.mode == "docker"

    def home(self, root=None):
        return profile_home(self.name, root)

    def host_values(self):
        """Validated host-vocabulary subset (what the server layers /
        what list & lifecycle read for a host profile)."""
        values = {}
        for key in HOST_KEYS:
            raw = self.data.get(key)
            if raw in (None, ""):
                continue
            try:
                values[key] = serve_config._check(key, raw)
            except ValueError:
                continue
        return values

    def docker_settings(self):
        """DockerSettings for a docker-mode profile (lazy import — keeps
        this module light for the activation path)."""
        from painapple_code.cli.deploy.config import settings_from_data
        return settings_from_data(self.data, profile=self.name)

    def label(self):
        return self.data.get("instance_name") or self.name


def load(name, root=None):
    """Load ``profiles/NAME/profile.yaml`` → :class:`Profile`. Returns
    None when the profile doesn't exist. Never raises on bad content —
    problems are collected on the returned object."""
    path = profile_path(name, root)
    if not path.is_file():
        return None
    import yaml
    problems = []
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as e:
        return Profile(name, "host", {}, [f"unreadable ({e})"])
    if not isinstance(data, dict):
        return Profile(name, "host", {}, ["not a key: value mapping"])
    mode = str(data.pop("mode", "host") or "host").strip()
    if mode not in MODES:
        problems.append(f"unknown mode {mode!r} — treating as 'host'")
        mode = "host"
    return Profile(name, mode, data, problems)


def save(name, mode, data, root=None):
    """Write ``profiles/NAME/profile.yaml``. ``data`` keys with empty
    values are dropped. Returns the path written."""
    if not valid_name(name):
        raise ValueError(
            f"Bad profile name: {name!r} (letters/digits/._- only, max 32 chars)")
    if mode not in MODES:
        raise ValueError(f"Bad profile mode: {mode!r}")
    import yaml
    path = profile_path(name, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    kept = {"mode": mode}
    for key, value in data.items():
        if value in (None, "", []):
            continue
        kept[key] = value
    body = yaml.safe_dump(kept, default_flow_style=False, sort_keys=False)
    path.write_text(
        f"# Profile '{name}' — written by `painapple setup {name}`, editable by hand.\n"
        "# mode: host (local server; this dir is its data home) or docker (container).\n"
        + body, encoding="utf-8")
    from painapple_code.bridge_paths import lock_mode
    lock_mode(path, 0o600)  # icacls on win32; chmod is a no-op there
    return path


def resolve_home(name, root):
    """The data home ``--profile NAME`` resolves to, given the launching
    process's own PAINAPPLE_CODE_HOME (``root``). Pure path arithmetic,
    creating nothing — :func:`activate` uses it for this process, and the
    fleet-view scan uses it to reproduce the same answer for SOMEONE
    ELSE's process from its argv. Unusable names fall back to ``root``.
    """
    name = (name or "").strip()
    root = Path(root)
    if name in ("", "default") or not valid_name(name):
        return root
    if root.name == name and root.parent.name in (PROFILES_DIR,
                                                  LEGACY_SERVE_PROFILES_DIR):
        # PAINAPPLE_CODE_HOME already points AT this profile's home (a
        # spawner — `painapple start`, a service unit — exported both
        # env vars). Re-appending profiles/NAME would nest a second home
        # inside the first; adopt the given home instead.
        return root
    return root / PROFILES_DIR / name


def activate(name):
    """Repoint PAINAPPLE_CODE_HOME at a HOST profile's data home
    (created if absent) and record the name in PAINAPPLE_PROFILE, so
    every downstream path helper — and the config layering — targets
    the profile. ``''``/``default`` is a no-op (the root deployment).
    Returns the home Path. Raises ValueError on a bad name."""
    name = (name or "").strip()
    if name in ("", "default"):
        return serve_config.home_root()
    if not valid_name(name):
        raise ValueError(
            f"Bad profile name: {name!r} (letters/digits/._- only, max 32 chars)")
    home = resolve_home(name, serve_config.home_root())
    home.mkdir(parents=True, exist_ok=True)
    os.environ["PAINAPPLE_CODE_HOME"] = str(home)
    os.environ["PAINAPPLE_PROFILE"] = name
    return home


# ──── Migration (serve-profiles/ + docker-profiles/ + root docker.yaml) ──

_migrated_this_process = False


def _free_name(name, taken):
    if name not in taken and not exists(name):
        return name
    for candidate in (f"{name}-docker", *(f"{name}-{i}" for i in range(2, 20))):
        if candidate not in taken and not exists(candidate):
            return candidate
    return None


def _adopt_serve_profile(root, name, notes):
    src = root / LEGACY_SERVE_PROFILES_DIR / name
    if exists(name, root):
        notes.append(f"'{name}': profiles/{name} already exists — "
                     f"left {src} untouched")
        return
    dst = profile_home(name, root)
    dst.parent.mkdir(parents=True, exist_ok=True)
    import yaml
    try:
        data = yaml.safe_load((src / "serve.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as e:
        notes.append(f"'{name}': unreadable serve.yaml ({e}) — skipped")
        return
    if not isinstance(data, dict):
        data = {}
    # Move the WHOLE dir — it's the profile's data home (sessions,
    # DuckDB, logs ride along).
    shutil.move(str(src), str(dst))
    (dst / "serve.yaml").unlink(missing_ok=True)
    save(name, "host", data, root)
    # Leave a symlink so hand-written service units / scripts that
    # exported PAINAPPLE_CODE_HOME=…/serve-profiles/NAME keep working.
    try:
        src.symlink_to(Path("..") / PROFILES_DIR / name)
    except OSError:
        pass
    notes.append(f"adopted serve profile '{name}' → profiles/{name} (mode: host)")


def _adopt_docker_profile(root, name, notes):
    src = root / LEGACY_DOCKER_PROFILES_DIR / name
    legacy_yaml = src / "docker.yaml"
    if not legacy_yaml.is_file():
        notes.append(f"'{name}': wrapper.conf-only docker profile — not "
                     f"adopted (re-create with: painapple setup {name})")
        return
    target = _free_name(name, set())
    if target is None:
        notes.append(f"'{name}': no free profile name — skipped")
        return
    import yaml
    try:
        data = yaml.safe_load(legacy_yaml.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as e:
        notes.append(f"'{name}': unreadable docker.yaml ({e}) — skipped")
        return
    from painapple_code.cli.deploy.config import (
        settings_from_data, settings_to_data)
    settings = settings_from_data(data, profile=name)
    save(target, "docker", settings_to_data(settings), root)
    for leftover in ("docker.yaml", "wrapper.conf"):
        (src / leftover).unlink(missing_ok=True)
    try:
        src.rmdir()
    except OSError:
        pass  # stray files — leave the dir
    suffix = "" if target == name else f" (renamed — '{name}' was taken)"
    notes.append(f"adopted docker profile '{name}' → profiles/{target} "
                 f"(mode: docker){suffix}")


def _adopt_root_docker(root, notes):
    legacy_yaml = root / "docker.yaml"
    if not legacy_yaml.is_file():
        return
    import yaml
    try:
        data = yaml.safe_load(legacy_yaml.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as e:
        notes.append(f"root docker.yaml unreadable ({e}) — left in place")
        return
    if not isinstance(data, dict):
        data = {}

    # 1. Runtime/image defaults → the global serve.yaml (the
    #    `--in-docker` defaults), only where serve.yaml doesn't already
    #    have a value.
    current, _ = serve_config.load()
    merged = dict(current)
    took = []
    for key in serve_config.DEPLOY_KEYS:
        if merged.get(key) in (None, "") and data.get(key) not in (None, ""):
            merged[key] = str(data[key])
            took.append(key)
    if took:
        try:
            serve_config.save(merged)
            notes.append("root docker.yaml: merged "
                         f"{', '.join(took)} into serve.yaml (--in-docker defaults)")
        except ValueError as e:
            notes.append(f"root docker.yaml: could not merge defaults ({e})")

    # 2. The deployment itself becomes a profile only if it was real —
    #    a container or volume with its configured names exists.
    from painapple_code.cli.deploy.config import (
        settings_from_data, settings_to_data)
    settings = settings_from_data(data, profile=None)
    live = False
    if shutil.which("docker") or shutil.which("podman") or settings.runtime:
        try:
            from painapple_code.cli.deploy.runtime import Runtime
            rt = Runtime(settings)
            live = (rt.container_exists(settings.container)
                    or (not settings.data_is_bind()
                        and rt.volume_exists(settings.data_volume)))
        except (SystemExit, OSError):
            live = False
    if live:
        target = _free_name("docker", set())
        if target:
            save(target, "docker", settings_to_data(settings), root)
            notes.append(f"adopted the root docker deployment → "
                         f"profiles/{target} (mode: docker)")

    # os.replace: a re-run after a partial migration already left a
    # .migrated file behind — Path.rename would raise on win32 then.
    os.replace(legacy_yaml, legacy_yaml.with_suffix(".yaml.migrated"))
    notes.append("root docker.yaml → docker.yaml.migrated (superseded by "
                 "serve.yaml + profiles)")


def ensure_migrated(announce=None):
    """Adopt pre-unification stores into ``profiles/``. Idempotent;
    cheap when there's nothing to do. ``announce`` is called with one
    human line per action (default: cli.ui.info)."""
    global _migrated_this_process
    if _migrated_this_process:
        return []
    _migrated_this_process = True

    root = root_home()
    serve_dir = root / LEGACY_SERVE_PROFILES_DIR
    docker_dir = root / LEGACY_DOCKER_PROFILES_DIR
    serve_names = []
    if serve_dir.is_dir():
        serve_names = sorted(
            p.name for p in serve_dir.iterdir()
            if p.is_dir() and not p.is_symlink() and (p / "serve.yaml").is_file())
    docker_names = []
    if docker_dir.is_dir():
        docker_names = sorted(
            p.name for p in docker_dir.iterdir()
            if p.is_dir() and ((p / "docker.yaml").is_file()
                               or (p / "wrapper.conf").is_file()))
    has_root_docker = (root / "docker.yaml").is_file()
    if not serve_names and not docker_names and not has_root_docker:
        return []

    notes = []
    for name in serve_names:          # host profiles first: name wins
        _adopt_serve_profile(root, name, notes)
    for name in docker_names:
        _adopt_docker_profile(root, name, notes)
    if has_root_docker:
        _adopt_root_docker(root, notes)

    if notes:
        if announce is None:
            from painapple_code.cli.ui import info
            announce = info
        announce("Migrating to the unified profile store "
                 f"({profiles_root(root)}):")
        for note in notes:
            announce(f"  {note}")
    return notes
