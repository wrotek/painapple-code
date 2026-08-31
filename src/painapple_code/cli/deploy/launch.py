"""Launch assembly for ``painapple --in-docker`` and docker-mode
profiles — turns global defaults / profile data / explicit serve flags
into DockerSettings and hands off to container.run_container().
"""

from pathlib import Path

from painapple_code.cli import serve_config
from painapple_code.cli.ui import DIM, RESET, info, warn
from painapple_code.cli.deploy.config import ConfigError, DockerSettings
from painapple_code.cli.deploy.container import run_container


def _flag(argv, *names):
    """Value of an explicitly passed ``--flag value`` / ``--flag=value``,
    or None. Used to tell an explicit flag from an argparse default."""
    for i, tok in enumerate(argv):
        for name in names:
            if tok == name and i + 1 < len(argv):
                return argv[i + 1]
            if tok.startswith(name + "="):
                return tok.split("=", 1)[1]
    return None


def _try_assign(cfg, key, value, source):
    try:
        cfg.assign(key, str(value))
    except ConfigError as e:
        warn(f"{source}: {e} — keeping {cfg.get(key)!r}")


def _apply_serve_flags(cfg, argv):
    """Explicit serve flags override whatever the settings came from —
    same precedence story as host mode (defaults < saved < flags)."""
    overrides = (("--host", "LISTEN_HOST"), ("--port", "PORT"),
                 ("--tls", "TLS_MODE"), ("--instance-name", "INSTANCE_NAME"),
                 ("--accent", "ACCENT"))
    for flag, key in overrides:
        value = _flag(argv, flag)
        if value is not None:
            _try_assign(cfg, key, value, flag)
    # The container invocation is assembled from DockerSettings, not the
    # host argv, so the password-visibility flags don't forward. That's
    # fine for --no-password: the container binds non-loopback internally,
    # so its startup box hides credentials by default anyway. --show-password
    # would need forwarding to have any effect — warn instead of silently
    # dropping it (the host-side bootstrap block prints the URL regardless).
    if "--show-password" in argv:
        warn("--show-password is not forwarded into the container; its "
             "startup box hides credentials (non-loopback bind). The "
             "login URL is printed host-side after start, or via "
             "`painapple password`.")
    ws = _flag(argv, "--workspace", "--cwd")
    if ws is not None:
        _try_assign(cfg, "WORKSPACE", ws, "--workspace")
        return True
    return False


def _forced_project_flag(argv):
    """--project / --no-project from raw argv: True / False / None (auto).
    Last occurrence wins, matching argparse BooleanOptionalAction."""
    forced = None
    for tok in argv:
        if tok == "--project":
            forced = True
        elif tok == "--no-project":
            forced = False
    return forced


def _auto_workspace_mode(cfg, argv=()):
    """Mode pick for the mount layer. --project/--no-project force it;
    otherwise zero-config: a git checkout → 'project', anything else
    → 'parent' — matching "I'm in a repo" vs "I opened a folder of
    repos" without asking. (.git can be a dir or a worktree file.)
    The serve flag itself is NOT forwarded into the container — project
    mode is realized by the one-level-down mount (container_mount());
    build_run_argv adds --no-project only where the container's own
    auto-detect would wrongly flip a parent-mode git mount."""
    ws = Path(cfg.workspace or ".")
    forced = _forced_project_flag(argv)
    if forced is True:
        mode, reason = "project", "forced by --project"
    elif forced is False:
        mode, reason = "parent", "forced by --no-project"
    else:
        mode = "project" if (ws / ".git").exists() else "parent"
        reason = "found .git" if mode == "project" else "no .git"
    cfg.workspace_mode = mode
    info(f"{ws} → {mode} mode {DIM}({reason}){RESET}")


def docker_settings_with_globals(prof):
    """A docker-mode profile's settings with the GLOBAL runtime/image
    defaults filled in wherever the profile doesn't pin its own (the
    wizard leaves them unset by default)."""
    cfg = prof.docker_settings()
    gvalues, _ = serve_config.load(serve_config.root_home() / "serve.yaml")
    for key, cfg_key in (("runtime", "RUNTIME"),
                         ("runtime_flags", "RUNTIME_FLAGS"),
                         ("image", "IMAGE")):
        if not prof.data.get(key) and gvalues.get(key) not in (None, ""):
            _try_assign(cfg, cfg_key, gvalues[key], "serve.yaml")
    return cfg


def adhoc_settings(argv):
    """DockerSettings for a bare ``painapple --in-docker``: global
    serve.yaml defaults (network + runtime/image) + explicit serve
    flags, cwd as the workspace."""
    cfg = DockerSettings(profile=None)
    values, problems = serve_config.load()
    for problem in problems:
        warn(f"serve.yaml: {problem}")
    for key, cfg_key in (("runtime", "RUNTIME"), ("runtime_flags", "RUNTIME_FLAGS"),
                         ("image", "IMAGE"), ("host", "LISTEN_HOST"),
                         ("port", "PORT"), ("tls", "TLS_MODE")):
        if values.get(key) not in (None, ""):
            _try_assign(cfg, cfg_key, values[key], "serve.yaml")

    explicit_ws = _apply_serve_flags(cfg, argv)
    if not explicit_ws:
        cfg.workspace = str(Path.cwd())
    _auto_workspace_mode(cfg, argv)
    return cfg


def run_adhoc(argv):
    """``painapple --in-docker``: the cwd (or --workspace) as a
    foreground container sandbox. Ctrl-C stops it, --rm cleans up."""
    from painapple_code.cli import profiles
    profiles.ensure_migrated()
    cfg = adhoc_settings(argv)
    return run_container(cfg, detach=False, profile=None)


def profile_settings(prof, argv=()):
    """DockerSettings for a profile + explicit flag overrides.

    ``mode: docker`` profiles carry the full settings themselves. A
    ``mode: host`` profile forced into docker (--in-docker override)
    maps its host values onto container settings — its data home rides
    along as a bind-mounted /data, so it stays the same deployment."""
    if prof.is_docker:
        cfg = docker_settings_with_globals(prof)
    else:
        cfg = DockerSettings(profile=prof.name)
        values = prof.host_values()
        for key, cfg_key in (("host", "LISTEN_HOST"), ("port", "PORT"),
                             ("tls", "TLS_MODE"), ("instance_name", "INSTANCE_NAME"),
                             ("accent", "ACCENT"), ("workspace", "WORKSPACE")):
            if values.get(key) not in (None, ""):
                _try_assign(cfg, cfg_key, values[key], f"profile {prof.name}")
        # Same deployment, containerized: the profile's data home IS the
        # container's /data.
        cfg.data_volume = str(prof.home())
        if not cfg.instance_name:
            cfg.instance_name = prof.name[:12]
        # Global --in-docker defaults still supply runtime/image.
        gvalues, _ = serve_config.load(serve_config.root_home() / "serve.yaml")
        for key, cfg_key in (("runtime", "RUNTIME"),
                             ("runtime_flags", "RUNTIME_FLAGS"),
                             ("image", "IMAGE")):
            if gvalues.get(key) not in (None, ""):
                _try_assign(cfg, cfg_key, gvalues[key], "serve.yaml")

    explicit_ws = _apply_serve_flags(cfg, list(argv))
    if not cfg.workspace and cfg.workspace_mode != "multi":
        cfg.workspace = str(Path.cwd())
        _auto_workspace_mode(cfg, argv)
    elif explicit_ws and prof.is_docker is False:
        _auto_workspace_mode(cfg, argv)
    return cfg


def run_profile(prof, argv=(), detach=False):
    """Run a profile as a container (its own mode, or forced by
    --in-docker). Foreground unless ``detach``."""
    if not prof.is_docker:
        warn(f"Profile '{prof.name}' is mode: host — running it in docker for "
             f"this launch (--in-docker). Make it permanent with: "
             f"painapple setup {prof.name}")
    cfg = profile_settings(prof, argv)
    return run_container(cfg, detach=detach, profile=prof.name)
