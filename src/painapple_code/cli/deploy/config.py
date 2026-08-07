"""Docker-mode settings: the key model + validation for containerized
deployments.

There is no separate docker config file anymore. Docker-mode settings
live in the unified profile store (``profiles/NAME/profile.yaml`` with
``mode: docker`` — see cli/profiles.py), and the ad-hoc
``painapple --in-docker`` run assembles its settings from the global
serve defaults (serve.yaml ``runtime``/``runtime_flags``/``image``)
plus the serve flags of that invocation.

``DockerSettings`` keeps the KEY-based ``assign()`` validation so
scripted writers (``painapple profile set``) and the desktop launcher
accept/reject the same inputs the wizard does.
"""

import re
from pathlib import Path

from painapple_code.cli.serve_config import root_home

UPSTREAM_IMAGE = "wrotek/painapple-code"
DEFAULT_IMAGE = "painapple-code:latest"

WORKSPACE_MODES = ("project", "parent", "multi")
TLS_MODES = ("auto", "on", "off")
ACCENT_NAMES = ("blue", "green", "red", "orange", "purple", "cyan")
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_IPV4_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$")

# Order = order printed by scripted `get` with no args.
CONFIG_KEYS = (
    "RUNTIME", "RUNTIME_FLAGS", "WORKSPACE", "WORKSPACE_MODE",
    "CLAUDE_HOME", "CLAUDE_JSON", "DATA_VOLUME", "CONFIG_VOLUME",
    "IMAGE", "CONTAINER", "PORT", "LISTEN_HOST", "TLS_MODE",
    "INSTANCE_NAME", "ACCENT",
)

# profile.yaml uses the shared serve-key names where a docker setting
# is the same concept: LISTEN_HOST ↔ host (the bind), TLS_MODE ↔ tls.
_YAML_NAME = {"LISTEN_HOST": "host", "TLS_MODE": "tls"}


def _expand(value):
    if value in ("~",) or value.startswith("~/"):
        return str(Path(value).expanduser())
    return value


class ConfigError(ValueError):
    """Bad key or value in a settings assignment. Message is user-facing."""


class DockerSettings:
    """One containerized deployment's settings, with per-profile
    collision-free defaults (container name, data volume, bridge config
    dir). CLAUDE_HOME defaults to the shared isolated dir for every
    profile, so one ``claude login`` serves all sandboxes."""

    def __init__(self, profile=None):
        home = root_home()
        shared = home / "shared"
        suffix = f"-{profile}" if profile else ""
        cfg_dirname = f"docker-{profile}" if profile else "shared"
        self.runtime = ""            # empty = auto-detect; may be a binary path
        self.runtime_flags = ""
        self.workspace = ""
        self.workspace_mode = "project"
        self.workspaces = []         # multi mode only
        self.claude_home = str(shared / ".claude")
        self.claude_json = ""        # empty = derive ${claude_home}.json
        self.data_volume = f"painapple-data{suffix}"
        self.config_volume = str(
            Path(f"~/.config/painapple-code/{cfg_dirname}").expanduser())
        self.image = DEFAULT_IMAGE
        self.container = f"painapple-code{suffix}"
        self.port = 8765
        self.listen_host = "127.0.0.1"
        self.tls_mode = "auto"
        self.instance_name = ""
        self.accent = ""

    # ── Derived values ──────────────────────────────────────────────────

    def effective_claude_json(self):
        return self.claude_json or f"{self.claude_home}.json"

    def effective_tls(self):
        """Resolve tls_mode 'auto' against the real reachability
        (listen_host), since the server always binds 0.0.0.0 in-container."""
        if self.tls_mode != "auto":
            return self.tls_mode
        return "off" if self.listen_host in ("127.0.0.1", "::1", "localhost") else "on"

    def data_is_bind(self):
        return self.data_volume.startswith("/")

    def config_is_bind(self):
        return self.config_volume.startswith("/")

    def container_workspace(self):
        """In-container mount path — the path hash keys project identity."""
        if self.workspace_mode in ("parent", "multi"):
            return "/workspace"
        return f"/workspace/{Path(self.workspace).name}"

    # ── get/set by KEY ──────────────────────────────────────────────────

    _FIELD_BY_KEY = {k: k.lower() for k in CONFIG_KEYS}

    def get(self, key):
        if key not in CONFIG_KEYS:
            raise ConfigError(f"Unknown key: {key}")
        value = getattr(self, self._FIELD_BY_KEY[key])
        return str(value)

    def assign(self, key, value):
        """Validate and set one field. Raises ConfigError with a
        user-facing message on bad key/value."""
        if key == "RUNTIME":
            if value and value not in ("docker", "podman"):
                # Custom binary: an explicit path must exist + be a file.
                expanded = _expand(value)
                if not (expanded.startswith("/") and Path(expanded).is_file()):
                    raise ConfigError(
                        "RUNTIME must be 'docker', 'podman', an absolute path "
                        f"to a runtime binary, or empty to auto-detect: {value}")
                value = expanded
            self.runtime = value
        elif key == "RUNTIME_FLAGS":
            self.runtime_flags = value
        elif key == "WORKSPACE":
            value = _expand(value)
            if value and not Path(value).is_dir():
                raise ConfigError(f"WORKSPACE does not exist: {value}")
            self.workspace = str(Path(value).resolve()) if value else ""
        elif key == "WORKSPACE_MODE":
            if value not in WORKSPACE_MODES:
                raise ConfigError(
                    f"WORKSPACE_MODE must be 'project', 'parent', or 'multi': {value}")
            self.workspace_mode = value
        elif key == "CLAUDE_HOME":
            value = _expand(value)
            if not value:
                raise ConfigError("CLAUDE_HOME can't be empty")
            # If CLAUDE_JSON was implicitly tracking the previous
            # CLAUDE_HOME, reset it so it re-derives against the new one.
            if self.claude_json == f"{self.claude_home}.json":
                self.claude_json = ""
            self.claude_home = value
        elif key == "CLAUDE_JSON":
            # Empty is meaningful: "derive from CLAUDE_HOME".
            self.claude_json = _expand(value)
        elif key in ("DATA_VOLUME", "CONFIG_VOLUME"):
            value = _expand(value)
            if not value:
                raise ConfigError(f"{key} can't be empty")
            setattr(self, key.lower(), value)
        elif key in ("IMAGE", "CONTAINER"):
            if not value:
                raise ConfigError(f"{key} can't be empty")
            setattr(self, key.lower(), value)
        elif key == "PORT":
            if not value.isdigit() or not 1 <= int(value) <= 65535:
                raise ConfigError(f"PORT must be 1–65535: {value}")
            self.port = int(value)
        elif key == "LISTEN_HOST":
            if value == "localhost":
                value = "127.0.0.1"
            if not _IPV4_RE.match(value):
                raise ConfigError(
                    f"LISTEN_HOST must be an IPv4 address (or 'localhost'): {value}")
            self.listen_host = value
        elif key == "TLS_MODE":
            if value not in TLS_MODES:
                raise ConfigError(f"TLS_MODE must be 'auto', 'on', or 'off': {value}")
            self.tls_mode = value
        elif key == "INSTANCE_NAME":
            if len(value) > 12:
                raise ConfigError(f"INSTANCE_NAME too long ({len(value)} chars, max 12)")
            self.instance_name = value
        elif key == "ACCENT":
            if value and value not in ACCENT_NAMES and not _HEX_RE.match(value):
                raise ConfigError(
                    "ACCENT must be empty, a named color "
                    f"({'|'.join(ACCENT_NAMES)}), or hex (#RGB / #RRGGBB)")
            self.accent = value
        else:
            raise ConfigError(f"Unknown key: {key}")


def flag_to_key(flag):
    """--listen-host → LISTEN_HOST. Returns None for unknown/non-flags."""
    if not flag.startswith("--"):
        return None
    key = flag[2:].replace("-", "_").upper()
    return key if key in CONFIG_KEYS else None


# ──── profile.yaml (docker mode) mapping ─────────────────────────────────

def settings_to_data(cfg):
    """DockerSettings → the docker-mode key subset of profile.yaml
    (shared names for shared concepts: host = bind, tls = tls mode)."""
    return {
        "runtime": cfg.runtime,
        "runtime_flags": cfg.runtime_flags,
        "workspace": cfg.workspace,
        "workspace_mode": cfg.workspace_mode,
        "workspaces": list(cfg.workspaces),
        "claude_home": cfg.claude_home,
        "claude_json": cfg.claude_json,
        "data_volume": cfg.data_volume,
        "config_volume": cfg.config_volume,
        "image": cfg.image,
        "container": cfg.container,
        "port": cfg.port,
        "host": cfg.listen_host,
        "tls": cfg.tls_mode,
        "instance_name": cfg.instance_name,
        "accent": cfg.accent,
    }


def settings_from_data(data, profile=None):
    """profile.yaml data (or a legacy docker.yaml dict) → DockerSettings.
    Accepts both the unified names (host/tls) and the legacy ones
    (listen_host/tls_mode). Stale values (e.g. a WORKSPACE dir that no
    longer exists) are kept verbatim so status/list still show them and
    an actual start fails with a clear error."""
    data = data or {}
    cfg = DockerSettings(profile=profile)
    aliases = {"host": "LISTEN_HOST", "listen_host": "LISTEN_HOST",
               "tls": "TLS_MODE", "tls_mode": "TLS_MODE"}
    for name, raw in data.items():
        if name == "workspaces":
            if isinstance(raw, list):
                cfg.workspaces = [str(w) for w in raw]
            continue
        key = aliases.get(name) or (name.upper() if name.upper() in CONFIG_KEYS
                                    else None)
        if key is None or raw in (None, ""):
            continue
        try:
            cfg.assign(key, str(raw))
        except ConfigError:
            if key == "PORT":
                try:
                    cfg.port = int(raw)
                except (TypeError, ValueError):
                    pass
            else:
                setattr(cfg, key.lower(), str(raw))
    return cfg
