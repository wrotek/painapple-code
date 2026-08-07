"""Persistent global serve defaults — the store behind ``painapple setup``.

``$PAINAPPLE_CODE_HOME/serve.yaml`` (default ``~/.painapple-code/
serve.yaml``) holds the *global* defaults for a bare ``painapple
[serve]`` invocation:

* network: ``host``, ``port``, ``tls`` (argparse dests, layered via
  ``parser.set_defaults()`` — built-ins < serve.yaml < explicit flags)
* container runtime: ``runtime``, ``runtime_flags``, ``image`` — read
  by the ``--in-docker`` launch path, never by the host server.

Workspace and cosmetics (``workspace``, ``instance_name``,
``accent``) are PROFILE-ONLY concepts since the CLI
unification: a bare ``painapple`` always serves the current directory,
and a label/accent only makes sense on a named deployment
(``painapple setup NAME`` — see cli/profiles.py). Those keys in the
root serve.yaml are ignored with a warning; in a profile's
``profile.yaml`` they're first-class.

Deliberately NOT read by the fast gate in ``cli.main()`` — the gate
only validates flag syntax, values don't matter there — so this module
(and its yaml import) stays off the ``-v``/``--help`` fast path.
``server.main()`` applies the file right before its re-parse.
"""

import os
import re
from pathlib import Path

# KEEP IN SYNC with COLOR_PRESETS in server.py (the --accent vocabulary).
ACCENT_PRESETS = ("blue", "green", "red", "orange", "purple", "cyan",
                  "gray", "grey", "yellow", "pink", "teal", "indigo", "lime")
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

TLS_MODES = ("auto", "on", "off")
INSTANCE_NAME_MAX = 12

# Full host-mode key vocabulary (validated by _check). Profile files may
# carry all of these; the ROOT serve.yaml only honors GLOBAL_KEYS.
HOST_KEYS = ("workspace", "host", "port", "tls",
             "instance_name", "accent")
KEYS = HOST_KEYS  # historical alias

GLOBAL_KEYS = ("host", "port", "tls")
DEPLOY_KEYS = ("runtime", "runtime_flags", "image")   # --in-docker defaults
ROOT_KEYS = GLOBAL_KEYS + DEPLOY_KEYS
PROFILE_ONLY_KEYS = ("workspace", "instance_name", "accent")

# Unified profile store directory (see cli/profiles.py) + the two legacy
# generations it adopts. Constants live HERE (import-light) so the
# fast-path callers (list_cmd name defaulting, activate nesting guard)
# don't need cli/profiles.py.
PROFILES_DIR = "profiles"
LEGACY_SERVE_PROFILES_DIR = "serve-profiles"
LEGACY_DOCKER_PROFILES_DIR = "docker-profiles"
PROFILE_PARENT_DIRS = (PROFILES_DIR, LEGACY_SERVE_PROFILES_DIR)
_PROFILE_PARENT_DIRS = PROFILE_PARENT_DIRS  # internal alias


def home_root():
    """The data home THIS process uses — env override or
    ``~/.painapple-code``. Under an activated profile this IS the
    profile's home; use :func:`root_home` for the box-wide root."""
    return Path(os.environ.get("PAINAPPLE_CODE_HOME",
                               "~/.painapple-code")).expanduser()


def root_home():
    """The box-wide root data home, climbing out of an activated
    profile's home (``…/profiles/NAME`` → ``…``). Shared resources
    (the profile store itself, shared/.claude) always live here."""
    home = home_root()
    if home.parent.name in _PROFILE_PARENT_DIRS:
        return home.parent.parent
    return home


def serve_yaml_path():
    return home_root() / "serve.yaml"


def valid_profile_name(name):
    return bool(_PROFILE_RE.match((name or "").strip()))


_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")


def extract_profile(argv):
    """``(profile, rest)``: strip ``--profile NAME`` / ``--profile=NAME``
    from anywhere in ``argv`` (before or after a subcommand), falling back
    to ``$PAINAPPLE_PROFILE``. ``profile`` is None when absent. Raises
    ValueError on a dangling ``--profile`` with no value."""
    prof, rest, i = None, [], 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--profile":
            if i + 1 >= len(argv):
                raise ValueError("Missing value for --profile")
            prof, i = argv[i + 1], i + 2
        elif arg.startswith("--profile="):
            prof, i = arg.split("=", 1)[1], i + 1
        else:
            rest.append(arg)
            i += 1
    if prof is None:
        prof = os.environ.get("PAINAPPLE_PROFILE") or None
    return prof, rest


def _check(key, value):
    """Normalized value, or raises ValueError with a human reason."""
    if key == "port":
        if isinstance(value, str) and value.isdigit():
            value = int(value)
        if not (isinstance(value, int) and not isinstance(value, bool)
                and 1 <= value <= 65535):
            raise ValueError(f"port must be a number 1-65535, got {value!r}")
        return value
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string, got {value!r}")
    value = value.strip()
    if key == "tls" and value not in TLS_MODES:
        raise ValueError(f"tls must be one of {'/'.join(TLS_MODES)}, got {value!r}")
    if key == "instance_name" and len(value) > INSTANCE_NAME_MAX:
        raise ValueError(f"instance_name too long ({len(value)} chars, "
                         f"max {INSTANCE_NAME_MAX})")
    if key == "accent" and value not in ACCENT_PRESETS and not _HEX_RE.match(value):
        raise ValueError(f"accent must be a preset "
                         f"({', '.join(ACCENT_PRESETS[:6])}, …) or a hex "
                         f"color like #f87171, got {value!r}")
    if key == "runtime" and value not in ("docker", "podman"):
        expanded = str(Path(value).expanduser())
        if not (expanded.startswith("/") and Path(expanded).is_file()):
            raise ValueError(
                "runtime must be 'docker', 'podman', or an absolute path "
                f"to a runtime binary, got {value!r}")
        return expanded
    return value


def load(path=None, recognized=None):
    """(values, problems): the file's valid key→value pairs, plus a list
    of human-readable strings for anything skipped. Missing/unreadable
    file → ({}, []) and ({}, [reason]) respectively — never raises.
    ``path`` overrides the default location (`painapple list` resolves a
    per-process config from each server's own PAINAPPLE_CODE_HOME);
    ``recognized`` narrows the accepted key set (default: everything)."""
    path = path or serve_yaml_path()
    if not path.is_file():
        return {}, []
    import yaml
    try:
        data = yaml.safe_load(path.read_text())
    except (OSError, yaml.YAMLError) as e:
        return {}, [f"unreadable ({e}) — using built-in defaults"]
    if data is None:
        return {}, []
    if not isinstance(data, dict):
        return {}, ["not a key: value mapping — using built-in defaults"]
    recognized = recognized or (HOST_KEYS + DEPLOY_KEYS)
    values, problems = {}, []
    for key, value in data.items():
        if key == "mode":
            continue  # profile.yaml marker — not a serve value
        if key not in recognized:
            problems.append(f"unknown key {key!r} ignored")
            continue
        try:
            values[key] = _check(key, value)
        except ValueError as e:
            problems.append(f"{e} — key ignored")
    return values, problems


def save(values):
    """Write the ROOT serve.yaml from the recognized, non-empty entries
    of ``values`` (global keys only — profile settings go through
    cli/profiles.py). Returns the path written. An empty mapping removes
    the file — bare ``painapple`` goes back to built-in defaults."""
    import yaml
    path = serve_yaml_path()
    kept = {k: _check(k, values[k]) for k in ROOT_KEYS
            if values.get(k) not in (None, "")}
    if not kept:
        path.unlink(missing_ok=True)
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    body = yaml.safe_dump(kept, default_flow_style=False, sort_keys=False)
    path.write_text(
        "# Global serve defaults written by `painapple setup` — editable by hand.\n"
        "# A bare `painapple` starts with these; explicit flags override.\n"
        "# Named deployments live in profiles/NAME/profile.yaml (painapple setup NAME).\n"
        + body)
    return path


def _active_profile_config_path():
    """The config file an ACTIVATED profile's server should layer:
    ``<home>/profile.yaml`` (unified store), falling back to the legacy
    ``<home>/serve.yaml`` for a not-yet-migrated profile home. None when
    no profile is active."""
    home = home_root()
    prof = (os.environ.get("PAINAPPLE_PROFILE") or "").strip()
    is_profile_home = home.parent.name in _PROFILE_PARENT_DIRS
    if not (prof and prof != "default") and not is_profile_home:
        return None
    if (home / "profile.yaml").is_file():
        return home / "profile.yaml"
    return home / "serve.yaml"


def apply_to_parser(parser):
    """Install saved defaults as parser defaults. Returns the same
    (values, problems) pair as :func:`load` so the caller can log what
    was applied/skipped.

    Root invocation: global serve.yaml, GLOBAL_KEYS only — a workspace
    or cosmetics key left over from pre-unification files is reported
    and skipped (bare ``painapple`` always serves the cwd).
    Activated profile: the profile's own config, full host vocabulary.
    """
    profile_cfg = _active_profile_config_path()
    if profile_cfg is not None:
        values, problems = load(profile_cfg, recognized=HOST_KEYS)
        prof = (os.environ.get("PAINAPPLE_PROFILE") or "").strip()
        if not prof or prof == "default":
            prof = home_root().name
        if prof and "instance_name" not in values:
            # Default the UI label to the profile name so co-running
            # profiles are distinguishable.
            values = {**values, "instance_name": prof[:INSTANCE_NAME_MAX]}
        if values:
            parser.set_defaults(**values)
        return values, problems

    values, problems = load(recognized=HOST_KEYS + DEPLOY_KEYS)
    for key in PROFILE_ONLY_KEYS:
        if key in values:
            values.pop(key)
            problems.append(
                f"key {key!r} is profile-only now (painapple setup NAME) — "
                "ignored for the bare serve")
    for key in DEPLOY_KEYS:
        values.pop(key, None)  # --in-docker settings, not server flags
    if values:
        parser.set_defaults(**values)
    return values, problems
