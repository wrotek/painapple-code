"""Top-level CLI dispatch for the ``painapple`` command.

``painapple`` is the sole console script (the old ``painapple-code``
name was retired; ``python -m painapple_code`` still works everywhere).

Backward compatibility is the design constraint: bare invocations like
``painapple --port 8880 --cwd …`` are baked into systemd units,
start.sh, deploy.fish, and docker-entrypoint.sh, so they must keep
working unchanged. Dispatch peeks at the first argument — a known
subcommand routes to its handler, anything else falls through to the
server's flat argument parser exactly as before. The one deliberate
exception: a *leading* ``-h``/``--help`` shows the curated command
overview below instead of the server's flag dump (``painapple serve
--help`` still prints the full flag reference).

Docker is not a command group — it's a run mode. ``--in-docker`` runs
the same serve invocation in a container; profiles carry a ``mode:
host|docker`` and every verb (start/stop/logs/…) dispatches on it.
The old ``painapple docker`` group prints a "moved" pointer.

Subcommands:
    serve         explicit alias for the default server invocation
    setup [NAME]  global defaults wizard / profile wizard (creates NAME)
    list          the fleet view: every deployment + unmanaged processes
    start/stop/restart [NAME]   background lifecycle (mode-aware)
    status [NAME] one deployment's detail — bare, it IS the fleet view
    logs [NAME]   follow output (host: console.log · docker: container)
    password [NAME]  show the bridge auth URL + password
    pull          fetch the prebuilt container image
    shell/extract/claude-login [NAME]   docker-mode utilities
    help          curated overview (also -h/--help as the first argument)
    version       the version string (also -v/--version as a flag)
"""

import sys

SUBCOMMANDS = ("serve", "setup", "list", "start", "stop", "restart",
               "status", "logs", "password", "pull", "shell", "extract",
               "claude-login", "help", "version")

_LIST_ALIASES = ("list", "ls", "instances", "profiles")
_MANAGE_VERBS = {
    "status": "status", "ps": "status",
    "logs": "logs", "log": "logs",
    "password": "password", "show-password": "password",
    "url": "password", "token": "password",
    "pull": "pull",
    "shell": "shell", "sh": "shell",
    "extract": "extract", "export": "extract",
    "claude-login": "claude-login", "login": "claude-login",
    "profile": "profile",  # scripted get/set (desktop launcher)
}


def _help():
    """Command overview — the front door. Full serve-flag reference
    stays on `painapple serve --help` (argparse)."""
    from painapple_code import __version__
    from painapple_code.cli.ui import BOLD, DIM, GREEN, RESET, say
    p = "painapple"
    say(f"""{BOLD}{p}{RESET} — Claude Code in your browser: self-hosted bridge + web client  {DIM}v{__version__}{RESET}

{BOLD}Usage:{RESET}
  {p} {DIM}[flags…]{RESET}               Serve the current directory {DIM}(same as: {p} serve){RESET}
  {p} {GREEN}--in-docker{RESET}            …the same, inside a container {DIM}(Docker/Podman){RESET}
  {p} {GREEN}setup{RESET}                  Global defaults {DIM}(network · container runtime){RESET}
  {p} {GREEN}setup{RESET} {DIM}NAME{RESET}             Create/edit a named deployment {DIM}(host or docker mode){RESET}
  {p} {GREEN}list{RESET}                   Every instance on this machine
  {p} {GREEN}start{RESET}|{GREEN}stop{RESET}|{GREEN}restart{RESET} {DIM}[NAME]{RESET}  Run/stop in the background {DIM}(NAME = profile · label · pid · port){RESET}

{BOLD}First run:{RESET}
  cd ~/code/my-project && {p}     {DIM}# → http://127.0.0.1:8765 — login URL printed{RESET}
  {p} {GREEN}pull{RESET} && {p} {GREEN}--in-docker{RESET}     {DIM}# same, sandboxed in the prebuilt image{RESET}

{BOLD}Common serve flags:{RESET}  {DIM}(all of them: {p} serve --help){RESET}
  --port N               Port to bind {DIM}(default 8765){RESET}
  --host IP              Host interface {DIM}(default 127.0.0.1 · 0.0.0.0 = reachable on your LAN){RESET}
  --workspace PATH       Root dir holding your projects {DIM}(default: current dir){RESET}
  --tls auto|on|off      TLS {DIM}(auto = on for non-loopback binds; self-signed cert){RESET}
  --in-docker            Run it containerized instead

{BOLD}Profiles (multiple deployments):{RESET}
  {p} {GREEN}setup{RESET} work                 {DIM}# create 'work' — pick host mode or docker mode{RESET}
  {p} {GREEN}start{RESET} work                 {DIM}# run it in the background — own port/data, isolated{RESET}
  {p} {GREEN}restart{RESET} work · {GREEN}stop{RESET} work    {DIM}# manage it ({p} --profile work runs it in the foreground){RESET}
  {p} {GREEN}status{RESET} work · {GREEN}logs{RESET} work · {GREEN}password{RESET} work

{BOLD}Everything running:{RESET}
  {p} {GREEN}list{RESET} {DIM}(= {p} {GREEN}status{RESET}{DIM}){RESET}    Deployments (host + docker) and unmanaged processes
  {p} {GREEN}status{RESET} {DIM}NAME{RESET}            One deployment in detail {DIM}(NAME = profile · label · pid · port){RESET}

{BOLD}Container extras:{RESET}
  {p} {GREEN}pull{RESET} [TAG]             Fetch the prebuilt image
  {p} {GREEN}shell{RESET}|{GREEN}extract{RESET}|{GREEN}claude-login{RESET} {DIM}[NAME]{RESET}   Inside-the-sandbox utilities
  {p} {GREEN}password{RESET}|{GREEN}logs{RESET} {GREEN}--in-docker{RESET}   {DIM}…for the ad-hoc sandbox (it has no NAME){RESET}

{BOLD}Docs:{RESET} https://painapple.ai/""")
    return 0


def _docker_moved():
    from painapple_code.cli.ui import DIM, GREEN, RESET, err, say
    err("`painapple docker` moved — docker is a run mode now, not a "
        "command group.")
    say(f"""
  painapple {GREEN}--in-docker{RESET}          {DIM}run the current dir in a container (was: docker quick){RESET}
  painapple {GREEN}setup NAME{RESET}           {DIM}create a docker-mode profile (was: docker setup){RESET}
  painapple {GREEN}start{RESET}|{GREEN}stop{RESET}|{GREEN}restart NAME{RESET}  {DIM}(was: docker up -d / stop / restart){RESET}
  painapple {GREEN}pull{RESET} · {GREEN}logs{RESET} · {GREEN}password{RESET} · {GREEN}status{RESET} · {GREEN}shell{RESET} · {GREEN}extract{RESET} · {GREEN}claude-login{RESET} {DIM}[NAME]{RESET}
  painapple {GREEN}list{RESET}                 {DIM}every deployment (was: docker list){RESET}

{DIM}Existing docker profiles are adopted automatically on the next
profile-aware command (painapple list).{RESET}""")
    return 2


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)

    if argv and argv[0] in ("help", "-h", "--help"):
        return _help()

    if argv and argv[0] in ("version", "--version", "-v"):
        # Verb form of the flag — same string, no server import.
        from painapple_code import __version__
        print(f"painapple {__version__}")
        return 0

    if argv and argv[0] == "docker":
        return _docker_moved()

    if argv and argv[0] == "setup":
        from painapple_code.cli.setup_cmd import main as setup_main
        return setup_main(argv[1:])

    if argv and argv[0] in _LIST_ALIASES:
        from painapple_code.cli.list_cmd import main as list_main
        return list_main(argv[1:])

    if argv and argv[0] in ("start", "stop", "restart"):
        from painapple_code.cli.lifecycle_cmd import main as lifecycle_main
        return lifecycle_main(argv[0], argv[1:])

    if argv and argv[0] in _MANAGE_VERBS:
        from painapple_code.cli.manage_cmd import main as manage_main
        return manage_main(_MANAGE_VERBS[argv[0]], argv[1:])

    if argv and argv[0] == "serve":
        argv = argv[1:]

    # Optional --profile NAME: a named deployment run in the foreground.
    # Stripped here so the flags-only serve parser never sees it.
    # serve_config is import-light (no yaml/fastapi).
    from painapple_code.cli import serve_config
    try:
        prof, argv = serve_config.extract_profile(argv)
    except ValueError as e:
        from painapple_code.cli.ui import err
        err(str(e))
        return 2

    # Fast gate: validate flags BEFORE paying the ~300ms server import —
    # bad flags exit 2, -v / --help exit 0, all in ~40ms. Import stays
    # inside this branch so setup/list/help skip it.
    from painapple_code.cli.serve_args import build_parser
    ns = build_parser().parse_args(argv)

    if prof:
        # Named deployment: adopt legacy stores, then dispatch on mode.
        from painapple_code.cli import profiles
        try:
            profiles.ensure_migrated()
            loaded = profiles.load(prof)
            if loaded is not None and (loaded.is_docker or ns.in_docker):
                from painapple_code.cli.deploy.launch import run_profile
                try:
                    return run_profile(loaded, argv)
                except KeyboardInterrupt:
                    return 130
            if loaded is None and ns.in_docker:
                from painapple_code.cli.ui import err
                err(f"Profile {prof!r} doesn't exist — create it with "
                    f"`painapple setup {prof}`, or drop --profile for an "
                    "ad-hoc --in-docker run.")
                return 2
            profiles.activate(prof)
        except ValueError as e:
            from painapple_code.cli.ui import err
            err(str(e))
            return 2
    elif ns.in_docker:
        from painapple_code.cli.deploy.launch import run_adhoc
        try:
            return run_adhoc(argv)
        except KeyboardInterrupt:
            return 130

    # Parse succeeded → boot. server.main() re-parses with the same
    # builder (~1ms) so its signature and behavior stay unchanged.
    from painapple_code.server import main as serve_main
    return serve_main(argv)
