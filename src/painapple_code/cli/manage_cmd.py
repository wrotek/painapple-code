"""Management verbs — ``painapple status/logs/password/pull/shell/
extract/claude-login`` and the scripted ``painapple profile`` channel.

Every verb takes an optional NAME (positional or ``--profile``) and
dispatches on the target's mode:

* host   — data home / process / server logs / bridge config file
* docker — container runtime (same bodies as `--in-docker`)

No NAME targets the root deployment: the global defaults for
status/logs/password, the ad-hoc ``--in-docker`` container for the
docker-only verbs (shell/extract/claude-login).

``painapple profile`` is the non-interactive scripting surface (used
by the desktop launcher): get/set/path/list against profile.yaml with
the same validation the wizard applies.
"""

import os
import sys
import time
from pathlib import Path

from painapple_code.cli import profiles, serve_config
from painapple_code.cli.netinfo import detect_local_ips
from painapple_code.cli.ui import (
    BOLD, DIM, GREEN, RESET, die, err, info, ok, say, warn,
)

DOCKER_ONLY = ("shell", "extract", "claude-login")


def _resolve_target(argv, allow_positional=True):
    """(name|None, rest): ``--profile NAME`` anywhere, or a leading
    positional. '' / 'default' → None (root)."""
    prof, rest = serve_config.extract_profile(list(argv or []))
    if allow_positional and rest and not rest[0].startswith("-"):
        if prof and prof != rest[0]:
            raise ValueError(
                f"Profile given twice: {rest[0]!r} and --profile {prof!r}")
        prof, rest = rest[0], rest[1:]
    if prof in ("", "default"):
        prof = None
    return prof, rest


def _named_root(argv):
    """True when the caller explicitly typed the root deployment's name
    (``painapple status default``). ``_resolve_target`` folds 'default'
    into None, and status needs the distinction: a bare `status` is the
    fleet view, `status default` is the root's own detail block."""
    try:
        prof, rest = serve_config.extract_profile(list(argv or []))
    except ValueError:
        return False
    token = prof or (rest[0] if rest and not rest[0].startswith("-") else "")
    return token == "default"


def _pop_in_docker(rest):
    """(rest, wanted): strip ``--in-docker`` — the root deployment's mode
    selector. A profile already carries `mode:`; only the nameless ad-hoc
    sandbox needs to be asked for explicitly."""
    if "--in-docker" in rest:
        return [a for a in rest if a != "--in-docker"], True
    return rest, False


def _adhoc_container_running():
    """True if the ad-hoc ``--in-docker`` container is up. Fails soft —
    no runtime, no image, an unreachable daemon all just mean 'no'
    (auto_detect die()s, hence SystemExit in the catch)."""
    try:
        from painapple_code.cli.deploy.runtime import Runtime
        cfg = _root_docker_settings()
        return Runtime(cfg).container_running(cfg.container)
    except (Exception, SystemExit):
        return False


def _root_docker_settings():
    """DockerSettings for the root/ad-hoc deployment: package defaults +
    the global serve.yaml runtime/image/network keys."""
    from painapple_code.cli.deploy.config import ConfigError, DockerSettings
    cfg = DockerSettings(profile=None)
    values, _ = serve_config.load(serve_config.root_home() / "serve.yaml")
    for key, cfg_key in (("runtime", "RUNTIME"), ("runtime_flags", "RUNTIME_FLAGS"),
                         ("image", "IMAGE"), ("host", "LISTEN_HOST"),
                         ("port", "PORT"), ("tls", "TLS_MODE")):
        if values.get(key) not in (None, ""):
            try:
                cfg.assign(cfg_key, str(values[key]))
            except ConfigError:
                pass
    return cfg


def _docker_settings_for(prof):
    if prof is None:
        return _root_docker_settings()
    from painapple_code.cli.deploy.launch import docker_settings_with_globals
    return docker_settings_with_globals(prof)


# ──── Host-mode helpers ──────────────────────────────────────────────────

def _auth_config_path():
    return Path(os.environ.get("XDG_CONFIG_HOME",
                               "~/.config")).expanduser() / "painapple-code" / "config.yaml"


def _host_password_value():
    path = _auth_config_path()
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("password:"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return ""


def _host_urls(vals):
    host = vals.get("host", "127.0.0.1")
    port = vals.get("port", 8765)
    tls = vals.get("tls", "auto")
    loopback = host in ("127.0.0.1", "::1", "localhost")
    scheme = "https" if tls == "on" or (tls == "auto" and not loopback) else "http"
    hosts = ([ip for ip, _ in detect_local_ips()] + ["127.0.0.1"]
             if host == "0.0.0.0" else [host])
    return [f"{scheme}://{h}:{port}" for h in hosts]


def _host_password(vals, label):
    pw = _host_password_value()
    if not pw:
        start = f"painapple start {label}" if label else "painapple start"
        die(f"No password found at {_auth_config_path()}. "
            f"Has the bridge ever started?  ({start})",
            None if label else
            f"  {DIM}Running it containerized?  painapple password --in-docker{RESET}")
    label_prefix = f"{BOLD}URL:{RESET}      "
    for url in _host_urls(vals):
        say(f"{label_prefix}{url}/?tkn={pw}")
        label_prefix = "          "
    say(f"{BOLD}Password:{RESET} {pw}")
    say(f"{DIM}  Open the URL once; the cookie keeps you logged in after that.{RESET}")
    return 0


def _host_running_pid(name, home):
    """PID of the running server for a host target (exact home match,
    port fallback restricted to unknown-home rows)."""
    from painapple_code.cli.lifecycle_cmd import _match, _resolve
    from painapple_code.cli.list_cmd import local_servers
    return _match(local_servers(), _resolve(name))


def _follow_file(path, last_lines=50, poll=0.5):
    """`tail -n N -F` in pure Python.

    Replaces os.execvp("tail", …): there's no tail on Windows and no
    exec-replace semantics either (execvp there spawns a NEW process and
    returns, so the parent would fall through to die() below while a
    detached tail scribbled over the same console). -F semantics are kept
    — reopen when the file is rotated or truncated.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        # Seek back far enough to hold N lines without reading the whole file.
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - 64 * 1024))
        tail = f.read().splitlines()[-last_lines:]
        for line in tail:
            print(line, flush=True)
        inode = os.fstat(f.fileno()).st_ino
        while True:
            chunk = f.read()
            if chunk:
                print(chunk, end="", flush=True)
                continue
            time.sleep(poll)
            try:
                st = os.stat(path)
            except OSError:
                continue  # rotated away; wait for it to come back
            # Rotation (new file) or truncation (log reset) — reopen.
            if st.st_ino != inode or st.st_size < f.tell():
                try:
                    new = open(path, "r", encoding="utf-8", errors="replace")
                except OSError:
                    continue
                f.close()
                f = new
                inode = os.fstat(f.fileno()).st_ino


def _host_logs(home):
    logs = Path(home) / "logs"
    for candidate in (logs / "server.log", logs / "console.log"):
        if candidate.is_file():
            say(f"{DIM}Following {candidate} — Ctrl-C to stop{RESET}")
            try:
                _follow_file(candidate)
            except KeyboardInterrupt:
                return 0
            except OSError as e:
                die(f"Cannot read {candidate}: {e}")
    die(f"No logs yet under {logs} — has this deployment ever started?")


# ──── status ─────────────────────────────────────────────────────────────

def _host_status(name, prof):
    home = prof.home() if prof else serve_config.home_root()
    vals = prof.host_values() if prof else serve_config.load()[0]
    label = name or "default"
    say(f"{BOLD}{label}{RESET}  {DIM}[host]{RESET}")
    say(f"  Data home : {home}")
    say(f"  Workspace : {vals.get('workspace') or DIM + '(current dir at start)' + RESET}")
    say(f"  Network   : {vals.get('host', '127.0.0.1')}:{vals.get('port', 8765)}, "
        f"TLS {vals.get('tls', 'auto')}")
    if prof and (prof.data.get("instance_name") or prof.data.get("accent")):
        say(f"  Cosmetics : label {prof.data.get('instance_name') or ''} "
            f"accent {prof.data.get('accent') or ''}".rstrip())
    pid = _host_running_pid(name, home)
    if pid:
        ok(f"Running (pid {pid})")
        for url in _host_urls(vals):
            say(f"  → {url}/")
    else:
        warn(f"Not running. Start with: painapple start {name or ''}".rstrip())
    return 0


def _docker_status(name, cfg):
    from painapple_code.cli.deploy.container import get_password, listen_scope
    from painapple_code.cli.deploy.runtime import Runtime
    rt = Runtime(cfg)
    label = name or cfg.container
    say(f"{BOLD}{label}{RESET}  {DIM}[docker]{RESET}")
    flags = f" {DIM}({cfg.runtime_flags}){RESET}" if cfg.runtime_flags else ""
    say(f"  Runtime    : {rt.name}{flags}")
    unset = f"{DIM}(unset — run: painapple setup {name or ''}){RESET}".replace(" )", ")")
    if cfg.workspace_mode == "multi":
        first = cfg.workspaces[0] if cfg.workspaces else unset
        say(f"  Workspaces : {first} {DIM}({cfg.workspace_mode}){RESET}")
        for ws in cfg.workspaces[1:]:
            say(f"               {ws}")
    else:
        say(f"  Workspace  : {cfg.workspace or unset} {DIM}({cfg.workspace_mode}){RESET}")
    say(f"  .claude    : {cfg.claude_home}")
    say(f"  .claude.json: {cfg.effective_claude_json()}")
    say(f"  Data       : {cfg.data_volume} {DIM}({'bind' if cfg.data_is_bind() else 'volume'}){RESET}")
    say(f"  Config     : {cfg.config_volume} {DIM}({'bind' if cfg.config_is_bind() else 'volume'}){RESET}")
    say(f"  Image      : {cfg.image}")
    say(f"  Container  : {cfg.container}")
    say(f"  Listen     : {cfg.listen_host}:{cfg.port} {DIM}→ container :8765{RESET}")
    say(f"               {DIM}host bind — {listen_scope(cfg)}{RESET}")
    say(f"  TLS        : {cfg.tls_mode}")
    if cfg.instance_name:
        say(f"  Instance   : {cfg.instance_name}")
    if cfg.accent:
        say(f"  Accent     : {cfg.accent}")
    say()

    pw = get_password(cfg, rt) if cfg.config_is_bind() else ""
    status = rt.container_status(cfg.container)
    if status:
        scheme = "https" if cfg.effective_tls() == "on" else "http"
        url_host = "127.0.0.1" if cfg.listen_host == "0.0.0.0" else cfg.listen_host
        ok(f"Running ({status})")
        say(f"  → {scheme}://{url_host}:{cfg.port}/")
        if pw:
            say(f"  Password: {BOLD}{pw}{RESET}")
    else:
        warn(f"Container is not running. Start with: "
             f"painapple start {name or ''}".rstrip()
             if name else "Container is not running. Start with: painapple --in-docker")
        if pw:
            say(f"  {DIM}Password (persisted, reused on next start):{RESET} {BOLD}{pw}{RESET}")
    return 0


def _process_status(row):
    """Detail block for a running server that belongs to no deployment —
    launched directly with its own flags, so its config isn't on disk
    anywhere: everything shown here is read off the live process."""
    label = row["name"] or f"pid {row['pid']}"
    tls = _flag_of(row, "--tls") or "auto"
    say(f"{BOLD}{label}{RESET}  {DIM}[process]{RESET}")
    say(f"  Data home : {row.get('home') or DIM + '(not readable)' + RESET}")
    say(f"  Workspace : {row.get('workspace') or DIM + '(unknown)' + RESET}")
    say(f"  Network   : {row['host']}:{row['port']}, TLS {tls}")
    ok(f"Running (pid {row['pid']})")
    for url in _host_urls({"host": row["host"], "port": row["port"], "tls": tls}):
        say(f"  → {url}/")
    say(f"  {DIM}Started directly — no saved deployment owns it. "
        f"stop/restart/logs take this name;{RESET}")
    say(f"  {DIM}painapple setup {row['name'] or 'NAME'} would make it "
        f"a profile.{RESET}")
    return 0


def _flag_of(row, name):
    from painapple_code.cli.list_cmd import _flag
    return _flag((row.get("command") or "").split(), name)


def _status(name, rest, detail=False):
    if name:
        prof = profiles.load(name)
        if prof is None:
            err(f"No profile named {name!r}. See: painapple list")
            return 1
        for problem in prof.problems:
            warn(f"profile.yaml: {problem}")
        if prof.is_docker:
            return _docker_status(name, _docker_settings_for(prof))
        return _host_status(name, prof)

    # `painapple status default` — the root deployment's own detail block.
    if detail:
        return _host_status(None, None)

    # Bare `painapple status` IS the fleet view (same renderer as
    # `painapple list`) — one overview, reachable by either name.
    from painapple_code.cli.list_cmd import main as fleet_view
    return fleet_view(rest)


# ──── profile (scripting: get/set/path/list) ─────────────────────────────

def _profile_usage():
    say(f"""{BOLD}painapple profile{RESET} — scripted profile access (the wizard: painapple setup NAME)

  painapple profile {GREEN}list{RESET}                     names, one per line
  painapple profile {GREEN}get{RESET} NAME [KEY …]         all keys (KEY=VALUE) or specific values
  painapple profile {GREEN}set{RESET} NAME KEY=VALUE …     validate + write (creates NAME; --mode host|docker)
  painapple profile {GREEN}path{RESET} NAME                profile.yaml location
  painapple profile {GREEN}delete{RESET} NAME              remove the profile config{DIM} (host data home / volumes stay){RESET}""")
    return 1


def _profile_keys(prof):
    """The (yaml_key → printable) ordering for get with no args."""
    if prof.is_docker:
        from painapple_code.cli.deploy.config import settings_to_data
        data = settings_to_data(prof.docker_settings())
    else:
        data = {k: prof.data.get(k, "") for k in serve_config.HOST_KEYS}
    return data


def _profile_cmd(argv):
    sub = argv[0] if argv else ""
    args = argv[1:]
    if sub in ("", "help", "-h", "--help"):
        return _profile_usage()

    if sub in ("list", "ls"):
        for name in profiles.list_profiles():
            prof = profiles.load(name)
            say(f"{name}\t{prof.mode if prof else '?'}")
        return 0

    if not args:
        return _profile_usage()
    name, rest = args[0], args[1:]

    if sub == "path":
        say(str(profiles.profile_path(name)))
        return 0

    if sub == "delete":
        if not profiles.exists(name):
            err(f"No profile named {name!r}")
            return 1
        prof = profiles.load(name)
        profiles.profile_path(name).unlink()
        if prof and prof.is_docker:
            try:
                profiles.profile_home(name).rmdir()
            except OSError:
                pass  # host data or stray files — leave the dir
            ok(f"Profile '{name}' removed (container/volume left as-is)")
        else:
            ok(f"Profile '{name}' removed (data home kept: "
               f"{profiles.profile_home(name)})")
        return 0

    if sub == "get":
        prof = profiles.load(name)
        if prof is None:
            err(f"No profile named {name!r}")
            return 1
        data = _profile_keys(prof)
        if not rest:
            say(f"mode={prof.mode}")
            for key, value in data.items():
                if key == "workspaces":
                    continue
                say(f"{key}={value}")
            if data.get("workspaces"):
                say("workspaces=" + os.pathsep.join(data["workspaces"]))
            return 0
        for key in rest:
            if key == "mode":
                say(prof.mode)
            elif key in data:
                value = data[key]
                say(os.pathsep.join(value) if isinstance(value, list) else str(value))
            else:
                err(f"Unknown key for a {prof.mode} profile: {key}")
                return 1
        return 0

    if sub == "set":
        return _profile_set(name, rest)

    err(f"Unknown profile subcommand: {sub}")
    return _profile_usage()


def _profile_set(name, args):
    if not profiles.valid_name(name):
        err(f"Bad profile name: {name!r}")
        return 1
    mode = None
    pairs = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--mode",):
            if i + 1 >= len(args):
                die("Missing value for --mode")
            mode, i = args[i + 1], i + 2
            continue
        if arg.startswith("--mode="):
            mode, i = arg.split("=", 1)[1], i + 1
            continue
        if arg.startswith("--"):
            if "=" in arg:
                flag, value = arg.split("=", 1)
                i += 1
            else:
                flag = arg
                if i + 1 >= len(args):
                    die(f"Missing value for {flag}")
                value = args[i + 1]
                i += 2
            pairs.append((flag[2:].replace("-", "_"), value))
            continue
        if "=" in arg:
            key, value = arg.split("=", 1)
            pairs.append((key, value))
            i += 1
            continue
        die(f"Expected KEY=VALUE or --key value, got: {arg}")

    prof = profiles.load(name)
    if prof is None:
        # Scripted creation (the desktop launcher's path) — docker by
        # default, that's what non-interactive callers manage.
        prof = profiles.Profile(name, mode or "docker", {})
    elif mode and mode != prof.mode:
        if mode not in profiles.MODES:
            die(f"Bad mode: {mode!r} (host or docker)")
        prof = profiles.Profile(name, mode, prof.data)

    if prof.is_docker:
        from painapple_code.cli.deploy.config import (
            ConfigError, settings_to_data)
        cfg = prof.docker_settings()
        for key, value in pairs:
            upper = key.upper()
            upper = {"HOST": "LISTEN_HOST", "TLS": "TLS_MODE"}.get(upper, upper)
            try:
                cfg.assign(upper, value)
            except ConfigError as e:
                err(str(e))
                return 1
            ok(f"{key} = {cfg.get(upper)}")
        data = settings_to_data(cfg)
    else:
        data = dict(prof.data)
        for key, value in pairs:
            # Accept the docker half's uppercase spelling too, so one
            # vocabulary drives both modes for scripted callers.
            key = {"listen_host": "host", "tls_mode": "tls"}.get(
                key.lower(), key.lower())
            if key not in serve_config.HOST_KEYS:
                err(f"Unknown key for a host profile: {key}")
                return 1
            try:
                data[key] = serve_config._check(key, value)
            except ValueError as e:
                err(str(e))
                return 1
            ok(f"{key} = {data[key]}")
    path = profiles.save(name, prof.mode, data)
    ok(f"Saved to {path}")
    return 0


# ──── Entry ───────────────────────────────────────────────────────────────

def main(verb, argv):
    profiles.ensure_migrated()

    try:
        if verb == "profile":
            return _profile_cmd(list(argv or []))

        if verb == "pull":
            # Positionals are the TAG here; --profile targets a profile's
            # image (rarely needed — image tags are usually global).
            name, rest = _resolve_target(argv, allow_positional=False)
            prof = profiles.load(name) if name else None
            if name and prof is None:
                err(f"No profile named {name!r}. See: painapple list")
                return 1
            from painapple_code.cli.deploy.container import cmd_pull
            return cmd_pull(_docker_settings_for(prof), rest) or 0

        name, rest = _resolve_target(argv)
        prof = profiles.load(name) if name else None
        if name and prof is None:
            # Not a saved profile — but `painapple list` also shows
            # unmanaged processes, and start/stop/restart already target
            # those by label/pid/port. status/logs follow suit rather
            # than claiming a thing on screen doesn't exist.
            row = None
            if verb in ("status", "logs"):
                from painapple_code.cli.lifecycle_cmd import _match_running
                row, problem = _match_running(name)
                if problem:
                    err(problem)
                    return 1
            if row is None:
                err(f"No profile named {name!r}. See: painapple list")
                if profiles.valid_name(name):
                    say(f"  {DIM}Create it with:{RESET} painapple setup {name}")
                return 1
            if verb == "status":
                return _process_status(row)
            _host_logs(row.get("home") or serve_config.home_root())
            return 0

        if verb == "status":
            return _status(name, rest, detail=_named_root(argv))

        rest, want_container = _pop_in_docker(rest)
        if want_container and prof:
            err(f"--in-docker doesn't apply to profile {name!r} — a profile "
                f"carries its own mode, and this one is "
                f"mode: {'docker' if prof.is_docker else 'host'}.")
            say(f"  {DIM}Just:{RESET} painapple {verb} {name}")
            return 1

        is_docker = (prof.is_docker if prof
                     else want_container or verb in DOCKER_ONLY)

        if verb == "logs":
            if is_docker:
                from painapple_code.cli.deploy.container import cmd_logs
                cmd_logs(_docker_settings_for(prof))
                return 0
            home = prof.home() if prof else serve_config.home_root()
            _host_logs(home)
            return 0

        if verb == "password":
            if is_docker:
                from painapple_code.cli.deploy.container import cmd_password
                return cmd_password(_docker_settings_for(prof), profile=name) or 0
            # Root, and no host bridge has ever written a config: before
            # dying with "has the bridge ever started?", check whether the
            # ad-hoc sandbox is what they mean — it IS started, and its
            # login page is what sent them here. Only on the empty path,
            # so the common case never pays for a runtime probe.
            if (prof is None and not _host_password_value()
                    and _adhoc_container_running()):
                from painapple_code.cli.deploy.container import cmd_password
                return cmd_password(_root_docker_settings()) or 0
            vals = prof.host_values() if prof else serve_config.load()[0]
            return _host_password(vals, name)

        if verb in DOCKER_ONLY:
            if prof and not prof.is_docker:
                err(f"'{verb}' is a docker-mode verb, and profile {name!r} "
                    f"is mode: host.")
                if verb == "shell":
                    say(f"  {DIM}A host deployment is just this machine — "
                        f"open a terminal in its workspace.{RESET}")
                return 1
            from painapple_code.cli.deploy import container
            cfg = _docker_settings_for(prof)
            if verb == "shell":
                container.cmd_shell(cfg, profile=name)
                return 0
            if verb == "claude-login":
                container.cmd_claude_login(cfg, profile=name)
                return 0
            if verb == "extract":
                return container.cmd_extract(cfg, rest, profile=name) or 0

        err(f"Unknown verb: {verb}")
        return 2
    except ValueError as e:
        err(str(e))
        return 2
    except KeyboardInterrupt:
        say()
        return 130
