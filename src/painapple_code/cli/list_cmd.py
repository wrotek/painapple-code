"""The fleet view — every instance on this machine, local + docker.

Reached as ``painapple list`` (and its aliases) or as a bare
``painapple status``; ``painapple status NAME`` is the per-deployment
detail block in manage_cmd. One renderer, two entry points.

Two sections, and the split is the point:

* **Deployments** — the things the verbs target: the flag-less root
  deployment (``default``) plus every saved profile, each matched to a
  running process (host) or container (docker).
* **Unmanaged processes** — painapple servers in the process table that
  belong to NO deployment: launched by hand or by a service unit with
  their own flags. Their name is just their ``--instance-name`` label.

Local servers have no registry — a bare ``painapple [serve]`` process IS
the instance — so they're discovered by scanning the process table and
parsing the serve flags out of each command line.
"""

import os
import sys
from pathlib import Path

from painapple_code.cli.ui import BOLD, DIM, GREEN, RESET, say


# ──── Local server discovery (process scan) ──────────────────────────────

def _iter_processes():
    """(pid, command) for every visible process. `ps ax` syntax works on
    both procps (Linux) and BSD ps (macOS)."""
    import subprocess
    try:
        out = subprocess.run(["ps", "ax", "-o", "pid=,command="],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return
    for line in out.splitlines():
        pid, _, command = line.strip().partition(" ")
        if pid.isdigit() and command:
            yield int(pid), command.strip()


def _is_python(tok):
    """Does this argv[0] name a Python interpreter? Case-INSENSITIVE on
    purpose: a Homebrew/python.org framework build's binary is literally
    named `Python` (…/Python.framework/…/Python.app/Contents/MacOS/Python),
    and that's the shebang interpreter pipx bakes into the console script
    on macOS. A case-sensitive test made every pipx-installed `painapple`
    on macOS invisible to the scan — `painapple list` reported the
    deployment stopped while the server was serving."""
    return Path(tok).name.lower().startswith("python")


def _serve_args(command):
    """If `command` is a painapple SERVER process, return its flag tail;
    None for anything else (other programs, subcommand invocations like
    `painapple start work`, this very `painapple list`)."""
    tokens = command.split()
    rest = None
    for i, tok in enumerate(tokens):
        # `python [-u …] -m painapple_code` — the interpreter must be
        # argv[0]. Without that anchor, a WRAPPER whose argument text
        # merely contains the string (`sh -c 'python -m painapple_code
        # --port …'`, an editor, a pager) ghosts in as a second row for
        # the same instance.
        if (tok == "painapple_code" and i >= 2 and tokens[i - 1] == "-m"
                and _is_python(tokens[0])
                and all(t.startswith("-") for t in tokens[1:i - 1])):
            rest = tokens[i + 1:]
            break
        # Console script — as argv[0] or behind its shebang interpreter,
        # possibly with interpreter options (`/path/python -E /path/bin/
        # painapple --port …`). The interpreter guard keeps e.g.
        # `grep foo …/painapple-code` from matching.
        if (Path(tok).name in ("painapple", "painapple-code")
                and (i == 0
                     or (_is_python(tokens[0])
                         and all(t.startswith("-") for t in tokens[1:i])))):
            rest = tokens[i + 1:]
            break
    if rest is None:
        return None
    # The server parser is flags-only; a leading non-flag is a subcommand.
    if rest and not rest[0].startswith("-"):
        if rest[0] != "serve":
            return None
        rest = rest[1:]
    return rest


def _flag(rest, *names, default=None):
    for i, tok in enumerate(rest):
        for name in names:
            if tok == name and i + 1 < len(rest):
                return rest[i + 1]
            if tok.startswith(name + "="):
                return tok.split("=", 1)[1]
    return default


def _in_container(pid):
    """Linux: rootless-podman containers show up in the host's process
    table — filter them out (they're the docker section's rows). macOS
    containers live in a VM and never appear, so no check needed.

    Environment markers first: our own image sets PAINAPPLE_IN_CONTAINER,
    podman sets `container=podman`. The /proc/<pid>/root check is the
    fallback — under --userns=keep-id that link reads back as '/' from
    the host, which used to list every containerized bridge twice (once
    as a phantom ad-hoc process on the container's own port)."""
    if not sys.platform.startswith("linux"):
        return False
    try:
        environ = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        environ = b""
    for entry in environ.split(b"\0"):
        if entry.startswith((b"PAINAPPLE_IN_CONTAINER=", b"container=")):
            return True
    try:
        return os.readlink(f"/proc/{pid}/root") != "/"
    except OSError:
        return False  # other user's process — can't tell, assume host


def _home_of(pid):
    """This process's data home (PAINAPPLE_CODE_HOME) as a resolved path
    string — readable from /proc/<pid>/environ for same-user Linux
    processes; '' when unknown (other user, macOS). Readable-but-unset
    resolves to the default home, so it can be matched against a profile
    home."""
    if not sys.platform.startswith("linux"):
        return ""
    try:
        environ = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return ""
    for entry in environ.split(b"\0"):
        if entry.startswith(b"PAINAPPLE_CODE_HOME="):
            raw = entry.split(b"=", 1)[1].decode("utf-8", "replace")
            return str(Path(raw).expanduser().resolve()) if raw else ""
    return str(Path("~/.painapple-code").expanduser().resolve())  # unset


def _saved_defaults(pid, cache):
    """The serve.yaml values THIS process booted with. Its own
    PAINAPPLE_CODE_HOME decides which file applies — readable from
    /proc/<pid>/environ for same-user processes on Linux; when it isn't
    (other user, macOS), fall back to our own environment's view."""
    home = os.environ.get("PAINAPPLE_CODE_HOME", "")
    if sys.platform.startswith("linux"):
        try:
            environ = Path(f"/proc/{pid}/environ").read_bytes()
        except OSError:
            pass  # not ours to read — keep the fallback
        else:
            home = ""  # readable and unset → the default home
            for entry in environ.split(b"\0"):
                if entry.startswith(b"PAINAPPLE_CODE_HOME="):
                    home = entry.split(b"=", 1)[1].decode("utf-8", "replace")
                    break
    if home not in cache:
        from painapple_code.cli.serve_config import load
        base = Path(home or "~/.painapple-code").expanduser()
        # A PROFILE home keeps its serve values in profile.yaml — there is
        # no serve.yaml beside it. Without this a profile instance reads
        # back as built-in defaults (port 8765, cwd as workspace).
        path = base / "profile.yaml"
        if not path.is_file():
            path = base / "serve.yaml"
        cache[home] = load(path)[0]
    return cache[home]


def _workspace_of(pid, rest, saved):
    ws = _flag(rest, "--workspace", "--cwd")
    if ws and ws != ".":
        return ws
    # No flag → the saved default (serve.yaml) if any, else the
    # process's cwd — readable on Linux for same-user processes.
    if saved.get("workspace"):
        return saved["workspace"]
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return ws or ""


def local_servers():
    """[{pid, host, port, name, workspace}] for every running local
    (non-container) painapple server process. Flag-less values fall back
    to the saved serve defaults (each process's own serve.yaml), then
    the built-ins — the same layering the server itself applies."""
    me = os.getpid()
    rows = []
    cache = {}
    for pid, command in _iter_processes():
        if pid == me:
            continue
        rest = _serve_args(command)
        if rest is None or _in_container(pid):
            continue
        saved = _saved_defaults(pid, cache)
        home = _home_of(pid)
        name = _flag(rest, "--instance-name",
                     default=saved.get("instance_name", ""))
        if not name:
            # Mirror the server's own defaulting: a profile instance
            # without an explicit label uses its profile name.
            from painapple_code.cli.serve_config import (
                INSTANCE_NAME_MAX, PROFILE_PARENT_DIRS)
            p = Path(home)
            if p.parent.name in PROFILE_PARENT_DIRS:
                name = p.name[:INSTANCE_NAME_MAX]
        rows.append({
            "pid": pid,
            "host": _flag(rest, "--host", default=saved.get("host", "127.0.0.1")),
            "port": _flag(rest, "--port", default=str(saved.get("port", 8765))),
            "name": name,
            "workspace": _workspace_of(pid, rest, saved),
            "home": home,
            "command": command,  # raw ps line — lifecycle_cmd respawn fallback
        })
    rows.sort(key=lambda r: int(r["port"]) if r["port"].isdigit() else 0)
    return rows


def match_process(running, home, port, exclude=()):
    """PID of the running server that belongs to the host deployment at
    `home` listening on `port`, or None.

    Order matters — a data home can legitimately hold more than one
    process (someone started a second server out of it with --port), and
    the deployment's OWN row is the one whose port also matches:

      1. same data home AND same port  — unambiguous
      2. same data home               — a port override of that deployment
      3. UNKNOWN home, same port      — macOS / other-user rows, where the
         home can't be read at all. Restricted to unknown-home rows on
         purpose: a row with a known, DIFFERENT home is a different
         deployment that happens to sit on this port and must never be
         claimed (or, in lifecycle_cmd, stopped) in its place.
    """
    home_res = str(Path(home).expanduser().resolve())
    port = str(port)
    rows = [r for r in running if r["pid"] not in exclude]
    for test in (lambda r: r.get("home") == home_res and r["port"] == port,
                 lambda r: r.get("home") == home_res,
                 lambda r: not r.get("home") and r["port"] == port):
        pid = next((r["pid"] for r in rows if test(r)), None)
        if pid is not None:
            return pid
    return None


def _host_detail(pid, running, name):
    """The parenthetical for a matched host row: the pid, plus the
    running process's own --instance-name when it differs from the row
    name (the root deployment is very often labelled something else)."""
    if not pid:
        return ""
    hit = next((r for r in running if r["pid"] == pid), {})
    label = hit.get("name") or ""
    return f"pid {pid} · {label}" if label and label != name else f"pid {pid}"


def root_row(running, exclude=()):
    """The flag-less root deployment as a deployment row — the target of
    every verb called without a NAME. Always present: it's what a bare
    `painapple` runs, whether or not it has ever been started."""
    from painapple_code.cli.serve_config import load, root_home
    home = root_home()
    vals, _ = load(home / "serve.yaml")
    port = str(vals.get("port", 8765))
    pid = match_process(running, home, port, exclude)
    hit = next((r for r in running if r["pid"] == pid), None) if pid else None
    return {"name": "default", "mode": "host", "pid": pid,
            "host": vals.get("host", "127.0.0.1"), "port": port,
            "home": str(home),
            # No saved workspace at the root — a bare `painapple` serves
            # whatever directory it's launched from.
            "workspace": (hit or {}).get("workspace") or "(cwd at launch)",
            "detail": _host_detail(pid, running, "default")}


def deployment_rows(running):
    """Every named target, root deployment first: [{name, mode, pid,
    host, port, workspace, detail}]. Profiles are matched before the
    root row so a profile never loses its process to it."""
    rows = profile_rows(running)
    claimed = {r["pid"] for r in rows if r.get("pid")}
    return [root_row(running, claimed), *rows]


def profile_rows(running):
    """[{name, mode, host, port, workspace, state}] for every saved
    profile (profiles/NAME/profile.yaml). Host profiles match a running
    local server by data home (exact, Linux) else by port; docker
    profiles ask the container runtime."""
    import shutil
    from painapple_code.cli import profiles as profmod

    probe = bool(shutil.which("docker") or shutil.which("podman"))
    rows = []
    for name in profmod.list_profiles():
        prof = profmod.load(name)
        if prof is None:
            continue
        if prof.is_docker:
            cfg = prof.docker_settings()
            status = None
            if probe or cfg.runtime:  # avoid auto_detect()'s die()
                try:
                    from painapple_code.cli.deploy.runtime import Runtime
                    status = Runtime(cfg).container_status(cfg.container)
                except (SystemExit, OSError):
                    status = None
            ws = (f"{len(cfg.workspaces)} workspaces"
                  if cfg.workspace_mode == "multi"
                  else cfg.workspace or "(no workspace)")
            rows.append({"name": name, "mode": "docker", "pid": None,
                         "host": cfg.listen_host, "port": str(cfg.port),
                         "home": "", "workspace": ws, "detail": status or ""})
            continue
        vals = prof.host_values()
        port = str(vals.get("port", 8765))
        home = prof.home()
        pid = match_process(running, home, port)
        rows.append({"name": name, "mode": "host", "pid": pid,
                     "host": vals.get("host", "127.0.0.1"), "port": port,
                     "home": str(home),
                     "workspace": vals.get("workspace")
                     or vals.get("instance_name") or "",
                     "detail": _host_detail(pid, running, name)})
    return rows


def adhoc_container_row():
    """The flag-less ``painapple --in-docker`` sandbox (container
    'painapple-code'), when the runtime knows it. None otherwise."""
    import shutil
    if not (shutil.which("docker") or shutil.which("podman")):
        return None
    try:
        from painapple_code.cli.deploy.config import DockerSettings
        from painapple_code.cli.deploy.runtime import Runtime
        cfg = DockerSettings(profile=None)
        rt = Runtime(cfg)
        if not rt.container_exists(cfg.container):
            return None
        status = rt.container_status(cfg.container)
        return {"name": cfg.container, "host": cfg.listen_host,
                "port": str(cfg.port), "detail": status or ""}
    except (SystemExit, OSError):
        return None


# ──── Command ─────────────────────────────────────────────────────────────

def _state(detail):
    return (f"{GREEN}running{RESET} {DIM}({detail}){RESET}"
            if detail else f"{DIM}stopped{RESET}")


def main(argv=None):
    from painapple_code.cli import profiles as profmod
    profmod.ensure_migrated()

    say(f"{BOLD}Painapple Code instances{RESET}")
    say()

    locals_ = local_servers()
    rows = deployment_rows(locals_)
    claimed = {r["pid"] for r in rows if r.get("pid")}
    # Servers in the process table that belong to no deployment: started
    # directly (by hand, a service unit) with their own flags, so their
    # name is just their --instance-name and no NAME verb targets them.
    unmanaged = [r for r in locals_ if r["pid"] not in claimed]
    saved = [r for r in rows if r["name"] != "default"]

    say(f"{BOLD}Deployments{RESET} {DIM}(named targets — "
        f"painapple start/stop/status NAME){RESET}")
    width = max(len(r["name"]) for r in rows)
    mwidth = max(len(r["mode"]) for r in rows) + 2  # brackets
    for r in rows:
        badge = f"[{r['mode']}]"
        say((f"  {BOLD}{r['name']:<{width}}{RESET}  "
             f"{DIM}{badge}{RESET}{'':<{mwidth - len(badge)}}"
             f"  {r['host']}:{r['port']}  {_state(r['detail'])}"
             f"  {DIM}{r['workspace']}{RESET}").rstrip())
    if not saved:
        say(f"  {DIM}default = what a bare `painapple` runs; add named ones "
            f"with: painapple setup NAME{RESET}")

    if unmanaged:
        say()
        say(f"{BOLD}Unmanaged processes{RESET} {DIM}(started directly — "
            f"not from a saved deployment){RESET}")
        width = max(len(r["name"] or "—") for r in unmanaged)
        for r in unmanaged:
            say((f"  {BOLD}{r['name'] or '—':<{width}}{RESET}"
                 f"  {r['host']}:{r['port']}"
                 f"  {GREEN}running{RESET} {DIM}(pid {r['pid']}){RESET}"
                 f"  {DIM}{r['workspace']}{RESET}").rstrip())
        say(f"  {DIM}their name is just the --instance-name label; "
            f"stop/restart/status take it too{RESET}")

    adhoc = adhoc_container_row()
    if adhoc:
        say()
        say(f"{BOLD}Ad-hoc container{RESET} {DIM}(painapple --in-docker){RESET}")
        say(f"  {BOLD}{adhoc['name']}{RESET}  {adhoc['host']}:{adhoc['port']}"
            f"  {_state(adhoc['detail'])}")

    say()
    say(f"{BOLD}Address{RESET} {DIM}= the host it binds to{RESET}")
    say(f"  {'0.0.0.0':<9}  {DIM}all interfaces — reachable from the LAN{RESET}")
    say(f"  {'127.0.0.1':<9}  {DIM}localhost only{RESET}")

    say()
    if saved:
        # Past first run: one pointer, not a seven-line cheat sheet.
        say(f"{DIM}Details for one:{RESET} painapple status NAME   "
            f"{DIM}·  full help:{RESET} painapple help")
    else:
        say(f"{BOLD}Commands{RESET} {DIM}(NAME = a deployment above; omit it "
            f"to target `default`){RESET}")
        hints = [
            ("painapple setup NAME", "create or reconfigure a profile"),
            ("painapple start NAME", "run it in the background"),
            ("painapple stop NAME", "stop it"),
            ("painapple restart NAME", "stop, then start again"),
            ("painapple status NAME", "running or not, address, workspace"),
            ("painapple logs NAME", "tail its log"),
            ("painapple password NAME", "print its login URL"),
        ]
        width = max(len(cmd) for cmd, _ in hints)
        for cmd, desc in hints:
            say(f"  {cmd:<{width}}  {DIM}{desc}{RESET}")
    return 0
