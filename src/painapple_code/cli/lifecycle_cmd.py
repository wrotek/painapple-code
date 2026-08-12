"""``painapple start/stop/restart`` — background lifecycle for local
host-mode instances (the action verbs next to ``painapple list``).

There is no daemon or PID registry — a painapple server process IS the
instance — so these commands reuse ``list_cmd``'s process-table
discovery to find the target, and plain signals to stop it:

    painapple start [NAME]     spawn detached (logs to <home>/logs/),
                               wait until the port accepts, print the
                               login URL
    painapple stop [NAME]      SIGTERM → poll → SIGKILL
    painapple restart [NAME]   stop (if running), then start

``NAME`` resolves in order: a saved serve profile (``painapple setup
NAME``) → a running instance's label (exact, then case-insensitive) →
its PID → its port — so anything `painapple list` prints is a valid
target. Omitted (or ``default``) targets the flag-less root deployment.

Profile targets restart from their saved serve.yaml. A label/pid/port
target has no saved config — it was launched ad hoc with flags — so
``restart`` recaptures the live process's own command line, working
directory, and environment (via psutil, so on all three platforms) and
respawns it verbatim.

Extra serve flags after the name are forwarded to the spawned server
(``painapple start work --port 9001``; on an ad-hoc restart they're
appended, and argparse last-wins makes them override) — they apply to
THIS start only, they are not saved.

Matching a profile to a running process mirrors ``list_cmd.serve_profiles``:
exact data-home match (psutil ``environ()``) first, port match as the
fallback for processes whose environment isn't readable.
"""

import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from painapple_code.cli import profiles, serve_config
from painapple_code.cli.ui import BOLD, DIM, GREEN, RESET, err, info, ok, say, warn
from painapple_code.utils.proc import pid_alive

START_TIMEOUT = 20   # seconds for the port to start accepting
STOP_TIMEOUT = 10    # seconds after SIGTERM before escalating to SIGKILL


# ──── Target resolution ──────────────────────────────────────────────────

def _resolve(prof):
    """{profile, label, home, host, port} for a SAVED HOST target: a
    profile name that exists on disk, or None = the root deployment."""
    if prof:
        home = profiles.profile_home(prof)
        loaded = profiles.load(prof)
        vals = loaded.host_values() if loaded else {}
    else:
        home = serve_config.home_root()
        vals, _ = serve_config.load(home / "serve.yaml")
    return {
        "profile": prof,
        "label": prof or "default",
        "home": home,
        "host": vals.get("host", "127.0.0.1"),
        "port": int(vals.get("port", 8765)),
    }


def _match(running, target):
    """PID of the running server for this saved target, or None — the
    same home/port matching `painapple list` uses to fill its rows, so
    what the fleet view calls running is exactly what stop targets."""
    from painapple_code.cli.list_cmd import match_process
    return match_process(running, target["home"], target["port"])


def _match_running(token):
    """(row, problem) — the running local server `token` names, by
    instance label (exact, then case-insensitive), PID, or port.
    (None, None) when nothing matches; (None, message) when the token is
    ambiguous."""
    from painapple_code.cli.list_cmd import local_servers
    rows = local_servers()
    matches = [r for r in rows if r["name"] and r["name"] == token]
    if not matches:
        matches = [r for r in rows
                   if r["name"] and r["name"].lower() == token.lower()]
    if not matches and token.isdigit():
        matches = ([r for r in rows if str(r["pid"]) == token]
                   or [r for r in rows if r["port"] == token])
    if len(matches) > 1:
        listing = ", ".join(f"{r['name'] or '—'} (pid {r['pid']}, "
                            f"port {r['port']})" for r in matches)
        return None, f"{token!r} is ambiguous — matches {listing}. Use the pid."
    return (matches[0] if matches else None), None


def _row_label(row):
    return row["name"] or f"pid {row['pid']}"


# ──── stop ───────────────────────────────────────────────────────────────

def _wait_gone(pid, timeout):
    # pid_alive is psutil, not os.kill(pid, 0): the POSIX idiom lies on
    # Windows (sig 0 is CTRL_C_EVENT and succeeds even for dead pids).
    # Same contract: exists → True, including other users' processes.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.2)
    return not pid_alive(pid)


def _kill(label, pid):
    # psutil, not raw signals: SIGKILL doesn't exist on win32 and os.kill
    # semantics differ there; terminate() is SIGTERM on POSIX and
    # TerminateProcess on Windows.
    import psutil
    from painapple_code.utils.proc import kill_pid
    try:
        psutil.Process(pid).terminate()
    except psutil.NoSuchProcess:
        say(f"{DIM}{label}: not running{RESET}")
        return 0
    except psutil.AccessDenied:
        err(f"{label}: pid {pid} belongs to another user — can't stop it")
        return 1
    if not _wait_gone(pid, STOP_TIMEOUT):
        warn(f"{label}: pid {pid} ignored SIGTERM for "
             f"{STOP_TIMEOUT}s — sending SIGKILL")
        kill_pid(pid)
        if not _wait_gone(pid, 3):
            err(f"{label}: pid {pid} would not die")
            return 1
    ok(f"Stopped {label} (pid {pid})")
    return 0


def _stop(target):
    from painapple_code.cli.list_cmd import local_servers
    pid = _match(local_servers(), target)
    if pid is None:
        say(f"{DIM}{target['label']}: not running{RESET}")
        return 0
    return _kill(target["label"], pid)


# ──── start ──────────────────────────────────────────────────────────────

def _spawn_env(target):
    """Child environment: the profile's data home exported explicitly
    (so `painapple list` can home-match it via /proc/<pid>/environ) and
    PAINAPPLE_PROFILE stamped for the instance-name default. The child's
    activate() recognizes an already-profile-shaped home and doesn't
    nest it (see profiles.activate)."""
    env = {k: v for k, v in os.environ.items() if k != "PAINAPPLE_PROFILE"}
    if target["profile"]:
        env["PAINAPPLE_CODE_HOME"] = str(target["home"])
        env["PAINAPPLE_PROFILE"] = target["profile"]
    return env


def _print_login_url(*logs):
    """Echo the login URL so a background start is as usable as a
    foreground one.

    Scans each log in turn: the URL lives in the startup box on stdout
    (console.log), with server.log kept as a fallback for older builds
    that logged it as an INFO line instead. Non-loopback binds hide the
    ?tkn= URL from their own stdout by default, so when only the bare
    box URL is found we rebuild the full login URL from the auth config
    — `painapple start` runs as the operator on this box, who can read
    that file anyway (it's exactly what `painapple password` prints)."""
    bare = None
    for log in logs:
        try:
            text = log.read_text(encoding="utf-8", errors="replace")[-8000:]
        except OSError:
            continue
        for line in reversed(text.splitlines()):
            m = re.search(r"https?://\S+\?tkn=\S+", line)
            if m:
                say(f"  {BOLD}Log in:{RESET} {BOLD}{GREEN}{m.group(0)}{RESET}")
                return
            if bare is None and "pAInapple Code:" in line:
                b = re.search(r"https?://\S+", line)
                if b:
                    bare = b.group(0).rstrip("/")
    if bare:
        from painapple_code.cli.manage_cmd import _host_password_value
        pw = _host_password_value()
        url = f"{bare}/?tkn={pw}" if pw else f"{bare}/"
        say(f"  {BOLD}Log in:{RESET} {BOLD}{GREEN}{url}{RESET}")


def _tail(path, n=15):
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
    except OSError:
        return
    for line in lines:
        say(f"  {DIM}{line}{RESET}")


def _spawn_and_wait(label, argv, *, env, cwd, home, host, port):
    """Detached spawn + port-readiness wait + login-URL echo — shared by
    profile starts and ad-hoc restarts. env/cwd None = inherit ours."""
    logs = Path(home).expanduser() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    console = logs / "console.log"
    with open(console, "ab") as out:
        out.write(f"\n--- painapple start {label} ---\n".encode())
        out.flush()
        from painapple_code.utils.proc import popen_kwargs_detached
        proc = subprocess.Popen(
            argv, stdout=out, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, env=env, cwd=cwd,
            **popen_kwargs_detached(fully_detached=True))

    info(f"Starting {label} (pid {proc.pid}) on {host}:{port} …")
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    deadline = time.monotonic() + START_TIMEOUT
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            err(f"{label} exited during startup "
                f"(code {proc.returncode}) — last output:")
            _tail(console)
            return 1
        try:
            with socket.create_connection((probe_host, port), timeout=1):
                pass
        except OSError:
            time.sleep(0.3)
            continue
        # Something answers — but make sure it's OUR child and not a
        # foreign listener that was already there (ours would have died
        # on its own bind pre-flight, a moment after this connect).
        time.sleep(0.3)
        if proc.poll() is None:
            break
        err(f"{label} exited during startup (code {proc.returncode}) — "
            f"something else is answering on {probe_host}:{port}. "
            f"Last output:")
        _tail(console)
        return 1
    else:
        warn(f"{label}: pid {proc.pid} is up but {probe_host}:{port} "
             f"didn't accept within {START_TIMEOUT}s — check {console}")
        return 1

    ok(f"{label} running — pid {proc.pid} on {host}:{port}")
    _print_login_url(console, logs / "server.log")
    return 0


def _start(target, extra):
    from painapple_code.cli.list_cmd import local_servers
    running = local_servers()
    pid = _match(running, target)
    if pid is not None:
        warn(f"{target['label']} is already running (pid {pid}) — "
             f"use: painapple restart {target['profile'] or ''}".rstrip())
        return 1

    # Validate forwarded serve flags HERE (same import-light parser the
    # serve gate uses) so a typo fails loudly instead of inside a
    # detached child. parse_args exits 2 with usage on a bad flag.
    if extra:
        from painapple_code.cli.serve_args import build_parser
        build_parser().parse_args(extra)

    host = _cli_flag(extra, "--host") or target["host"]
    port = int(_cli_flag(extra, "--port") or target["port"])

    # Bind test, not a scan of our own process table — a port held by
    # ANYTHING (another painapple, a stray dev server) must fail here,
    # loudly, rather than inside a detached child nobody is watching.
    from painapple_code.cli.netinfo import port_holder, port_taken
    reason = port_taken(host, port)
    if reason:
        holder = port_holder(port)
        err(f"Port {port} on {host} is already in use — {reason}"
            + (f" (held by {holder})" if holder else ""))
        return 1

    return _spawn_and_wait(
        target["label"], [sys.executable, "-m", "painapple_code", *extra],
        env=_spawn_env(target), cwd=None, home=target["home"],
        host=host, port=port)


def _cli_flag(args, name):
    for i, tok in enumerate(args):
        if tok == name and i + 1 < len(args):
            return args[i + 1]
        if tok.startswith(name + "="):
            return tok.split("=", 1)[1]
    return None


# ──── Ad-hoc targets (label / pid / port of a flag-launched server) ──────

def _respawn_spec(row):
    """(argv, cwd, env) to faithfully relaunch this running server, or None.

    psutil for all three fields — the same wrappers `painapple list`
    already uses. The hand-rolled /proc cmdline/cwd/environ reader this
    replaces was the PREFERRED branch and Linux-only, so the platforms
    this branch adds fell through to `return list(argv), None, None` and
    respawned WITHOUT the process's working directory or environment:
    lossy on exactly the hosts nobody exercises locally.

    Each field is best-effort on its own — AccessDenied reading environ()
    must not cost us the argv — and the process-scan argv stays as the
    fallback for cmdline().
    """
    import psutil

    from painapple_code.cli.list_cmd import _proc_environ

    pid = row["pid"]
    argv = list(row.get("argv") or [])
    cwd = None
    env = _proc_environ(pid)          # None = unreadable → inherit ours
    try:
        proc = psutil.Process(pid)
        argv = list(proc.cmdline()) or argv
        cwd = proc.cwd()
    except Exception:
        pass  # other-user/vanished process — the kill will refuse anyway
    return (argv, cwd, env) if argv else None


def _restart_adhoc(row, extra):
    """Restart a running instance that has NO saved profile: recapture
    its command line BEFORE killing it, then respawn verbatim (+ any
    forwarded flags, which argparse last-wins into overrides)."""
    label = _row_label(row)
    spec = _respawn_spec(row)
    if spec is None:
        err(f"{label}: can't recover the process command line to respawn it")
        return 1
    if extra:
        from painapple_code.cli.serve_args import build_parser
        build_parser().parse_args(extra)
    argv, cwd, env = spec
    rc = _kill(label, row["pid"])
    if rc:
        return rc
    host = _cli_flag(extra, "--host") or row["host"]
    port = int(_cli_flag(extra, "--port") or row["port"])
    home = row.get("home") or os.environ.get("PAINAPPLE_CODE_HOME",
                                             "~/.painapple-code")
    return _spawn_and_wait(label, argv + list(extra), env=env, cwd=cwd,
                           home=home, host=host, port=port)


# ──── Command ────────────────────────────────────────────────────────────

def main(cmd, argv):
    """Dispatch target for start/stop/restart. The target is a leading
    positional (``painapple restart work`` / ``STAGING`` / a pid / a
    port), ``--profile NAME``, or $PAINAPPLE_PROFILE; nothing targets
    the root deployment."""
    try:
        prof, rest = serve_config.extract_profile(list(argv or []))
    except ValueError as e:
        err(str(e))
        return 2
    if rest and not rest[0].startswith("-"):
        if prof and prof != rest[0]:
            err(f"Profile given twice: {rest[0]!r} and --profile {prof!r}")
            return 2
        prof, rest = rest[0], rest[1:]
    if prof in ("", "default"):
        prof = None
    if cmd == "stop" and rest:
        err(f"stop takes no flags (got: {' '.join(rest)})")
        return 2

    profiles.ensure_migrated()

    # A saved DOCKER profile: the container runtime already is the
    # background lifecycle — start = run -d, stop = container stop.
    if prof and profiles.exists(prof):
        loaded = profiles.load(prof)
        if loaded is not None and loaded.is_docker:
            return _docker_lifecycle(cmd, loaded, rest)

    # Not a saved profile → try what `painapple list` shows: a running
    # instance's label, pid, or port.
    if prof and not profiles.exists(prof):
        row, problem = _match_running(prof)
        if problem:
            err(problem)
            return 1
        if row is not None:
            if cmd == "stop":
                return _kill(_row_label(row), row["pid"])
            if cmd == "restart":
                return _restart_adhoc(row, rest)
            warn(f"{_row_label(row)} is already running (pid {row['pid']}) — "
                 f"use: painapple restart {prof}")
            return 1
        err(f"{prof!r} matches no saved profile and no running instance "
            f"(label, pid, or port).")
        if profiles.valid_name(prof):
            say(f"  {DIM}Create a profile with:{RESET} painapple setup {prof}")
        return 1

    target = _resolve(prof)
    if cmd == "stop":
        return _stop(target)
    if cmd == "restart":
        rc = _stop(target)
        if rc:
            return rc
    return _start(target, rest)


def _docker_lifecycle(cmd, loaded, rest):
    """start/stop/restart for a docker-mode profile — delegates to the
    container runtime (detached runs are durable: --restart
    unless-stopped)."""
    from painapple_code.cli.deploy.container import (
        remove_container, stop_container)
    from painapple_code.cli.deploy.launch import profile_settings
    try:
        cfg = profile_settings(loaded, rest)
        if cmd == "stop":
            return stop_container(cfg, profile=loaded.name)
        if cmd == "restart":
            remove_container(cfg)
        from painapple_code.cli.deploy.container import run_container
        return run_container(cfg, detach=True, profile=loaded.name)
    except KeyboardInterrupt:
        say()
        return 130
