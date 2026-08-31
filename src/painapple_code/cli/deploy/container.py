"""Containerized deployment bodies — run/stop/logs/shell/password/
extract/pull for docker-mode profiles and the ad-hoc ``--in-docker``
sandbox.

Everything here takes explicit ``(cfg: DockerSettings, profile_name)``
arguments — no module-level config loads — so the same bodies serve a
named profile, the root ad-hoc sandbox, and tests.
"""

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from painapple_code.cli.netinfo import detect_local_ips
from painapple_code.cli.ui import (
    BOLD, DIM, GREEN, RESET, die, err, info, ok, print_credentials, say, warn,
)
from painapple_code.cli.deploy.config import DEFAULT_IMAGE, UPSTREAM_IMAGE
from painapple_code.cli.deploy.runtime import Runtime


# The ad-hoc `--in-docker` sandbox is the one deployment with no name to
# select it by, so its management commands carry the mode flag instead.
# Without it `painapple password` resolves to the HOST deployment and
# prints the wrong password (or dies claiming nothing has ever started)
# — and that string is what the container's own login page tells the
# user to run. Verbs absent here have no ad-hoc form and keep the plain
# root command.
_ADHOC_HINTS = {
    "start": "painapple --in-docker",
    "password": "painapple password --in-docker",
    "logs": "painapple logs --in-docker",
}


def hint(verb, profile=None):
    """The command a user types to do ``verb`` against this deployment —
    profile verbs carry the name (`painapple logs work`), the ad-hoc
    sandbox carries `--in-docker`."""
    if profile:
        return f"painapple {verb} {profile}"
    return _ADHOC_HINTS.get(verb, f"painapple {verb}")


# ──── Network helpers ─────────────────────────────────────────────────────

def bootstrap_hosts(cfg):
    """Hosts to print bootstrap URLs for. 0.0.0.0 = every interface, so
    list LAN IPs first (what a phone would use), loopback last."""
    if cfg.listen_host == "0.0.0.0":
        return [ip for ip, _ in detect_local_ips()] + ["127.0.0.1"]
    return [cfg.listen_host]


def listen_scope(cfg):
    """Short human phrase for what the host bind exposes — this is the
    HOST-side publish interface (`-p LISTEN_HOST:PORT:8765`), not the
    container's internal bind (always 0.0.0.0:8765)."""
    if cfg.listen_host == "0.0.0.0":
        return "all interfaces — reachable on your LAN"
    if cfg.listen_host in ("127.0.0.1", "::1", "localhost"):
        return "localhost only — this machine"
    return "this interface only"


# ──── Password (reads the server's config volume) ────────────────────────

def _scalar_from_yaml(text, key="password"):
    prefix = f"{key}:"
    for line in text.splitlines():
        if line.startswith(prefix):
            return line.split(":", 1)[1].strip()
    return ""


def _password_from_yaml(text):
    return _scalar_from_yaml(text, "password")


def _read_auth_config(cfg, rt):
    """Raw text of the container's auth config, or "" if unreachable."""
    if cfg.config_is_bind():
        f = Path(cfg.config_volume) / "config.yaml"
        try:
            return f.read_text(encoding="utf-8") if f.is_file() else ""
        except OSError:
            return ""
    if rt.container_running(cfg.container):
        out = rt.output("exec", cfg.container, "sh", "-c",
                        "cat /home/app/.config/painapple-code/config.yaml 2>/dev/null")
        if _password_from_yaml(out):
            return out
    if rt.volume_exists(cfg.config_volume):
        return rt.output("run", "--rm", "--entrypoint", "sh",
                         "-v", f"{cfg.config_volume}:/cfg:ro", cfg.image,
                         "-c", "cat /cfg/config.yaml 2>/dev/null")
    return ""


def get_password(cfg, rt):
    return _password_from_yaml(_read_auth_config(cfg, rt))


def get_credentials(cfg, rt):
    """(password, api_token) in one read of the container's auth config.

    api_token is "" on a config written by a pre-WP-02 build; callers fall
    back to a bare URL rather than putting the password in a link.
    """
    text = _read_auth_config(cfg, rt)
    return _scalar_from_yaml(text, "password"), _scalar_from_yaml(text, "api_token")


def print_bootstrap_url(cfg, pw, profile=None, raw_tty=False, token=None):
    """The clickable ?tkn= URL block shown after a start / password.

    raw_tty: when printing around an attached `docker run -it` the TTY
    is in raw mode, so plain \\n stair-steps — use \\r\\n (harmless in
    cooked mode).
    """
    scheme = "https" if cfg.effective_tls() == "on" else "http"
    nl = "\r\n" if raw_tty else "\n"
    out = [""]
    url_kind = "auto-login URL" if token else "URL"
    out.append(f"{GREEN}✓{RESET} Open this {url_kind} once (cookie keeps you logged in):")
    link = token or ""
    for host in bootstrap_hosts(cfg):
        base = f"{scheme}://{host}:{cfg.port}/"
        out.append(f"    {BOLD}{base}?tkn={link}{RESET}" if link else f"    {BOLD}{base}{RESET}")
    out.append(f"    {BOLD}Password (login form): {pw}{RESET}")
    out.append(f"{DIM}    Reveal again later with:  {hint('password', profile)}{RESET}")
    sys.stdout.write(nl.join(out) + nl)
    sys.stdout.flush()


# ──── pull ────────────────────────────────────────────────────────────────

def pull_image(cfg, rt, tag="latest", source=None):
    """Pull the upstream (or ``source``) image and retag it to
    ``cfg.image`` so the rest of the CLI finds it under its local name.
    Returns True on success, False on a failed pull."""
    if source:
        pull_ref = source if ":" in source else f"{source}:{tag}"
    else:
        pull_ref = f"{UPSTREAM_IMAGE}:{tag}"

    info(f"Pulling {pull_ref} via {rt.name}…")
    if rt.run("pull", pull_ref).returncode != 0:
        return False
    # Name the version, always. A moving tag that has silently stopped
    # moving is invisible otherwise — `painapple pull` reports success,
    # the digest never changes, and the user runs a months-old build
    # while every release note says otherwise. (It happened: :latest sat
    # on v1.0.0-rc1 from July.) '' when the label is missing.
    version = rt.label(pull_ref, "org.opencontainers.image.version")
    ok(f"Pulled {pull_ref}" + (f"  {DIM}(version {version}){RESET}" if version else ""))

    if pull_ref != cfg.image:
        rt.run("tag", pull_ref, cfg.image)
        ok(f"Tagged {pull_ref} → {cfg.image}")
    return True


def cmd_pull(cfg, args):
    rt = Runtime(cfg)

    tag, explicit_source = "latest", None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--source", "--image"):
            if i + 1 >= len(args):
                die(f"{arg} needs an image reference (e.g. ghcr.io/foo/bar:edge)")
            explicit_source = args[i + 1]
            i += 2
        elif arg.startswith("-"):
            die(f"Unknown flag: {arg}")
        else:
            tag = arg
            i += 1

    if not pull_image(cfg, rt, tag=tag, source=explicit_source):
        die("Pull failed. Check the tag exists and you have network access.",
            f"  Available tags: https://hub.docker.com/r/{UPSTREAM_IMAGE}/tags")

    # The published image bakes UID 1000. Newer tags re-stamp their user
    # to the host's on start (or get remapped by podman), so the mismatch
    # only bites on an older image under docker.
    # Ordered cheapest-first: the uid probe may cost a throwaway container
    # on an unlabeled image, and none of it matters off Linux/docker.
    if (sys.platform.startswith("linux") and rt.name == "docker"
            and not rt.image_adapts_uid(cfg.image)
            and rt.image_user_ids(cfg.image)[0] not in (None, os.getuid())):
        app_uid = rt.image_user_ids(cfg.image)[0]
        say()
        warn(f"This tag bakes UID {app_uid}; your host UID is {os.getuid()}.")
        warn("The container won't be able to write your workspace or its own /data.")
        warn("Pull a newer tag, or build locally so the UIDs match:  "
             "./painapple-docker.sh build  (repo checkout)")

    say()
    say(f"{DIM}Next:{RESET}  painapple --in-docker   {DIM}(or: painapple start NAME "
        f"for a docker-mode profile){RESET}")
    return 0


# ──── run ─────────────────────────────────────────────────────────────────

def _host_uid():
    """The uid that owns bind mounts, or None where that isn't a
    meaningful question — off Linux the mounts come through a VM and the
    login uid isn't what the container sees."""
    if sys.platform.startswith("linux") and hasattr(os, "getuid"):
        return os.getuid()
    return None


class Identity:
    """How this launch lines the container's user up with the host user.

    ``userns``   extra flag for podman's user-namespace mapping
    ``run_user`` value for ``--user`` (None = the image's own default)
    ``env``      PAINAPPLE_UID/GID for an adapting entrypoint
    ``app_ids``  (uid, gid) the server ends up running as, in-container
    ``repair``   True when named volumes must be chowned from outside —
                 the mapping moved under them, or the image is too old
                 to put its own house in order
    """

    def __init__(self, userns=None, run_user=None, env=None,
                 app_ids=(None, None), repair=False):
        self.userns = userns
        self.run_user = run_user
        self.env = env or {}
        self.app_ids = app_ids
        self.repair = repair


def plan_identity(cfg, rt, profile=None):
    """Decide the uid story for this launch — see :class:`Identity`.

    ``profile`` only shapes the remediation hint on the give-up path.

    Everything the server is mounted FOR is owned by the host user: the
    workspace it edits, ~/.claude, the server config dir, and /data
    itself when a host profile rides along as a bind. The image bakes
    its `app` user at a fixed uid (1000 unless you built with
    ``--build-arg USER_UID``), so on any host whose uid isn't that, the
    container can't write a single one of them — it dies on boot with
    `PermissionError: /data/logs/server.log` and, if /data happens to be
    a named volume instead, silently can't edit your project.

    Two mechanisms, one per runtime:

    * **podman** (rootless) — remap the user namespace so the running
      user lands ON the app uid (``keep-id:uid=…,gid=…``). Works with any
      image, including already-pulled ones, and on every platform: even
      podman machine on a Mac presents real uids from inside the VM.
    * **docker** — hand the ids to the entrypoint, which re-stamps `app`
      and drops privileges. Needs an image that advertises it can
      (``io.painapple.uid-adapt``); older ones get a real error instead
      of a crash loop. Linux only — Docker Desktop fakes bind ownership.

    A NAMED VOLUME is a separate story from a bind and applies on every
    platform: it keeps the uid of whichever container populated it, so a
    data home outlives the image that made it and stops being writable.
    That repair is driven by ``repair``.
    """
    adapts = rt.image_adapts_uid(cfg.image)
    app_uid, app_gid = rt.image_user_ids(cfg.image)
    # Volumes need fixing from outside whenever the image can't do it
    # itself — a current entrypoint chowns /data on boot, as root.
    repair = not adapts and app_uid is not None

    if rt.name == "podman":
        # No os.getuid() here on purpose, and no platform check: keep-id
        # means "map the user I'm running as", which on a Mac is the
        # podman-machine VM's user rather than your login uid. Plain
        # keep-id maps that user to its OWN id — exactly the mismatch
        # when the image's `app` is some other uid — while the uid=/gid=
        # form lands it ON `app`. When they already agree the two are
        # identical, so this is safe to apply unconditionally.
        can_map = app_uid is not None and rt.supports_userns_map()
        userns = (f"--userns=keep-id:uid={app_uid},gid={app_gid}" if can_map
                  else "--userns=keep-id")
        # An adapting image doesn't need the mapping — its entrypoint
        # re-stamps `app` on its own — so only an old podman paired with
        # an old image is genuinely stuck. (host_uid is None off Linux,
        # where we can't know it and therefore can't rule the clash out.)
        if not can_map and not adapts and app_uid not in (None, _host_uid()):
            warn(f"podman is too old for `keep-id:uid=…` — the container runs as "
                 f"uid {app_uid} but the mounts are owned by someone else; "
                 f"writes will fail. Upgrade podman (≥4.3), pull a newer image, "
                 f"or rebuild with --build-arg USER_UID.")
        # An adapting image can also repair a named volume from the
        # inside, but only from root — and dropping back to `app` is that
        # entrypoint's whole job, so this stays unprivileged.
        return Identity(userns=userns, run_user="0" if adapts else None,
                        app_ids=(app_uid, app_gid), repair=repair)

    # docker. Off Linux there's no host uid to line anything up WITH:
    # Docker Desktop presents bind mounts through a VM that fakes
    # ownership to match whoever asks, so only the volumes matter.
    if not sys.platform.startswith("linux") or not hasattr(os, "getuid"):
        return Identity(app_ids=(app_uid, app_gid), repair=repair)

    host_uid, host_gid = os.getuid(), os.getgid()

    # On Linux bind mounts carry real host ownership, and there's no
    # namespace to bend — the entrypoint has to do the re-stamping.
    if app_uid in (None, host_uid) or adapts:
        env = {"PAINAPPLE_UID": str(host_uid), "PAINAPPLE_GID": str(host_gid)} if adapts else {}
        return Identity(env=env, app_ids=(app_uid, app_gid), repair=repair)

    # The runtime is a config key, not an env var — `RUNTIME=podman` only
    # means anything to the build wrapper, so spell out the real command.
    switch = (f"painapple profile set {profile} RUNTIME=podman" if profile
              else "painapple setup")
    die(f"This image runs as uid {app_uid}, but your files are owned by uid "
        f"{host_uid} — the container could not write your workspace, ~/.claude, "
        f"or its own /data.",
        f"  Fix it with any of:\n"
        f"    painapple pull                {DIM}(newer images align on start){RESET}\n"
        f"    ./painapple-docker.sh build   {DIM}(repo checkout — bakes "
        f"USER_UID={host_uid}){RESET}\n"
        f"    {DIM}…or switch to podman, which remaps uids for you:{RESET}\n"
        f"    {switch}")


def prepare_volumes(cfg, rt, ident):
    """Hand named volumes to the uid the container will run as.

    A volume keeps the ownership of whatever populated it, so it outlives
    the image that made it: remap the namespace under it, rebuild with a
    different USER_UID, or pull over a locally built tag, and the server
    can no longer write its own data home. Idempotent — the runtime-side
    check is a no-op when the ownership is already right.

    Only for images that can't do it themselves; a current entrypoint
    chowns /data from the inside, as root, before it drops privileges.
    """
    if not ident.repair:
        return
    uid, gid = ident.app_ids
    extra = [ident.userns] if ident.userns else []
    for volume, is_bind in ((cfg.data_volume, cfg.data_is_bind()),
                            (cfg.config_volume, cfg.config_is_bind())):
        # Binds keep host ownership on purpose — they're the user's own
        # directories, and the remap is what makes them line up already.
        if is_bind or not rt.volume_exists(volume):
            continue
        if not rt.chown_volume(cfg.image, volume, uid, gid, extra):
            warn(f"Could not adjust ownership of volume '{volume}' — the server "
                 f"may fail to write /data.")


def build_run_argv(cfg, rt, detach, profile=None, ident=None):
    """The full `docker run …` argv. Pure assembly — no side effects —
    so tests can pin it. ``ident`` comes from plan_identity(); omitted,
    the uid handling stays at the plain `--userns=keep-id` default."""
    selinux = rt.selinux_enforcing()
    ident = ident or Identity()

    def mount(spec, bind=True):
        return f"{spec}:Z" if selinux and bind else spec

    argv = ["run"]
    # Foreground runs are ephemeral (--rm, you're watching); detached runs
    # are durable (--restart unless-stopped, survive crash/reboot).
    argv += ["-d", "--restart", "unless-stopped"] if detach else ["--rm", "-it"]
    argv += ["--name", cfg.container,
             "-e", f"PAINAPPLE_REVEAL_CMD={hint('password', profile)}",
             "-p", f"{cfg.listen_host}:{cfg.port}:8765"]
    for key, value in ident.env.items():
        argv += ["-e", f"{key}={value}"]
    if ident.run_user:
        argv += ["--user", ident.run_user]
    argv += ["-v", mount(f"{cfg.data_volume}:/data", bind=cfg.data_is_bind()),
             "-v", mount(f"{cfg.config_volume}:/home/app/.config/painapple-code",
                         bind=cfg.config_is_bind()),
             "-v", mount(f"{cfg.claude_home}:/home/app/.claude"),
             "-v", mount(f"{cfg.effective_claude_json()}:/home/app/.claude.json")]

    if cfg.workspace_mode == "multi":
        for ws in cfg.workspaces:
            argv += ["-v", mount(f"{ws}:/workspace/{Path(ws).name}")]
    else:
        argv += ["-v", mount(f"{cfg.workspace}:{cfg.container_mount()}")]

    if rt.name == "podman":
        argv += [ident.userns or "--userns=keep-id"]

    # The served workspace is ALWAYS /workspace — the dir holding projects.
    # In project mode the repo is mounted one level down (container_mount),
    # so it shows up as the single pickable project on the welcome screen
    # rather than the server treating the repo's own subdirs as projects.
    argv += [cfg.image, "python", "-m", "painapple_code",
             "--host", "0.0.0.0", "--port", "8765",
             "--workspace", "/workspace"]
    if cfg.instance_name:
        argv += ["--instance-name", cfg.instance_name]
    if cfg.accent:
        argv += ["--accent", cfg.accent]
    # Can't pass `auto` through: the server would resolve it against its
    # own in-container bind (always 0.0.0.0) and force TLS on. We know the
    # real reachability via listen_host, so resolve here.
    argv += ["--tls", cfg.effective_tls()]
    return argv


def _container_trouble(cfg, rt):
    """Why the container isn't coming up — '' when it looks healthy.

    A container that dies on boot is restarted by ``--restart
    unless-stopped`` forever, so "no auth config yet" and "crash-looping"
    look identical from the outside unless we ask."""
    if not rt.container_running(cfg.container):
        return "it exited"
    status = rt.container_status(cfg.container) or ""
    if "restarting" in status.lower():
        return "it keeps restarting"
    count = rt.output("inspect", cfg.container,
                      "--format", "{{.RestartCount}}").strip()
    if count.isdigit() and int(count) > 0:
        return f"it has already restarted {count}×"
    return ""


def _tail_container_logs(cfg, rt, n=20):
    proc = rt.run("logs", "--tail", str(n), cfg.container,
                  capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (proc.stdout + proc.stderr).splitlines()[-n:]:
        say(f"  {DIM}{line}{RESET}")


def _wait_for_password(cfg, rt, timeout=10.0, watch=False):
    """Poll for the auth config the server writes on boot.

    Returns (password, trouble). With ``watch`` (a detached start we just
    launched), the container's own health is checked each round so a
    crash-loop fails fast instead of masquerading as a slow boot."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pw = get_password(cfg, rt)
        if pw:
            return pw, ""
        if watch:
            trouble = _container_trouble(cfg, rt)
            if trouble:
                return "", trouble
        time.sleep(0.5)
    return "", (_container_trouble(cfg, rt) if watch else "")


def run_container(cfg, detach, profile=None):
    """Validate + start the container. Returns an exit code (foreground
    runs raise SystemExit with the container's own code)."""
    rt = Runtime(cfg)

    if cfg.workspace_mode == "multi":
        if not cfg.workspaces:
            die(f"No workspaces configured for multi mode. Run:  "
                f"{hint('setup', profile)}")
        for ws in cfg.workspaces:
            if not Path(ws).is_dir():
                die(f"Workspace doesn't exist: {ws}")
    else:
        if not cfg.workspace:
            die(f"No workspace configured. Run:  {hint('setup', profile)}")
        if not Path(cfg.workspace).is_dir():
            die(f"Workspace doesn't exist: {cfg.workspace}")

    # An explicitly configured runtime skips auto_detect's reachability
    # check, so ask here — every query below fails soft ('' / False) and
    # would otherwise misreport a dead daemon as a missing image.
    if not rt.responds():
        die(f"`{rt.binary} info` failed — the {rt.name} runtime isn't reachable.",
            "Start the service (`systemctl --user start docker` / "
            "`podman.socket`), check you're in the `docker` group, or point "
            f"at another runtime:  {hint('setup', profile)}")

    # Missing image: the default local tag is what `painapple pull`
    # produces, so fetch it automatically on first run. A custom image
    # name keeps the fail-early error — we can't guess its registry, and
    # letting the runtime auto-pull a local-only tag from Docker Hub
    # dies confusingly.
    if not rt.image_exists(cfg.image):
        if cfg.image == DEFAULT_IMAGE:
            info(f"Image '{cfg.image}' not found locally — fetching the "
                 f"prebuilt image (one time).")
            if not pull_image(cfg, rt):
                err("Pull failed. Check your network access, or pull by hand:")
                say()
                say(f"  painapple pull           {DIM}({UPSTREAM_IMAGE}:latest){RESET}")
                say(f"  painapple pull v0.3.0    {DIM}(pin a release){RESET}")
                say(f"  {DIM}(building from source needs a repo checkout: ./painapple-docker.sh build){RESET}")
                raise SystemExit(1)
        else:
            err(f"Image '{cfg.image}' not found locally.")
            say()
            say(f"  Pull the prebuilt image:  painapple pull          {DIM}({UPSTREAM_IMAGE}:latest){RESET}")
            say(f"                            painapple pull v0.3.0    {DIM}(pin a release){RESET}")
            say(f"  {DIM}(building from source needs a repo checkout: ./painapple-docker.sh build){RESET}")
            raise SystemExit(1)

    Path(cfg.claude_home).mkdir(parents=True, exist_ok=True)
    # The paired .claude.json must exist as a FILE before docker run —
    # otherwise the engine creates a directory at the bind-mount target.
    claude_json = Path(cfg.effective_claude_json())
    if not claude_json.exists():
        from painapple_code.paths import lock_mode

        claude_json.touch()
        lock_mode(claude_json, 0o600)

    if rt.container_running(cfg.container):
        # "Ensure running" semantics (and desktop-launcher parity): an
        # already-serving container is success, not an error.
        warn(f"Container '{cfg.container}' is already running.")
        say(f"View logs: {hint('logs', profile)}")
        say(f"Stop it:   {hint('stop', profile)}")
        return 0
    if rt.container_exists(cfg.container):
        rt.run("rm", cfg.container, capture_output=True)

    # The container publishes on the HOST, so a taken port fails deep
    # inside the runtime with a message that never mentions painapple
    # ("pasta failed with exit code 1…") — and, being on stderr, it lands
    # out of order among our own lines. Check it ourselves, first.
    from painapple_code.cli.netinfo import port_holder, port_taken
    reason = port_taken(cfg.listen_host, cfg.port)
    if reason:
        if getattr(reason, "bad_host", False):
            err(f"Cannot bind {cfg.listen_host}:{cfg.port} — {reason}")
            say(f"  {DIM}Fix the bind host:  {hint('setup', profile)}{RESET}")
            return 1
        holder = port_holder(cfg.port)
        err(f"Port {cfg.port} on {cfg.listen_host} is already in use — {reason}"
            + (f" (held by {holder})" if holder else ""))
        say(f"  {DIM}Pick another port:  {hint('setup', profile)}{RESET}")
        return 1

    # Bind-mount dirs must exist so docker doesn't create them as root.
    if cfg.data_is_bind():
        Path(cfg.data_volume).mkdir(parents=True, exist_ok=True)
    if cfg.config_is_bind():
        Path(cfg.config_volume).mkdir(parents=True, exist_ok=True)

    # Everything mounted in is owned by the host user — line the
    # container's user up with it, or none of it is writable.
    ident = plan_identity(cfg, rt, profile)
    prepare_volumes(cfg, rt, ident)

    info("Starting Painapple Code…")
    if cfg.workspace_mode == "multi":
        say(f"  Workspaces: {DIM}(multi → /workspace){RESET}")
        for ws in cfg.workspaces:
            say(f"    {DIM}↳ /workspace/{Path(ws).name}  ← {ws}{RESET}")
    else:
        say(f"  Workspace : {DIM}{cfg.workspace}{RESET} → {cfg.container_mount()} {DIM}({cfg.workspace_mode}){RESET}")
    say(f"  .claude   : {DIM}{cfg.claude_home}{RESET} → /home/app/.claude")
    say(f"  .claude.json: {DIM}{cfg.effective_claude_json()}{RESET} → /home/app/.claude.json")
    say(f"  Data      : {DIM}{cfg.data_volume}{RESET} ({'bind' if cfg.data_is_bind() else 'volume'}) → /data")
    say(f"  Config    : {DIM}{cfg.config_volume}{RESET} ({'bind' if cfg.config_is_bind() else 'volume'}) → /home/app/.config/painapple-code")
    say(f"  Listen on : {DIM}{cfg.listen_host}:{cfg.port}{RESET} → container :8765 "
        f"{DIM}(host bind — {listen_scope(cfg)}){RESET}")
    if cfg.instance_name:
        say(f"  Instance  : {DIM}{cfg.instance_name}{RESET}")
    if cfg.accent:
        say(f"  Accent    : {DIM}{cfg.accent}{RESET}")
    # Show the password up-front on a re-up of an existing deployment
    # (cheap bind-file read only; fresh deploys print it post-start).
    if cfg.config_is_bind():
        existing_pw = get_password(cfg, rt)
        if existing_pw:
            say(f"  Password  : {BOLD}{existing_pw}{RESET}")
    say()

    argv = build_run_argv(cfg, rt, detach, profile=profile, ident=ident)

    if detach:
        sys.stdout.flush()  # keep the runtime's own stderr in order
        result = rt.run(*argv)
        if result.returncode != 0:
            err(f"{rt.name} could not start {cfg.container} "
                f"(exit {result.returncode}) — see its message above.")
            return result.returncode
        say()
        info("Waiting for the server to write its auth config…")
        pw, trouble = _wait_for_password(cfg, rt, watch=True)
        if pw:
            print_bootstrap_url(cfg, pw, profile=profile,
                               token=get_credentials(cfg, rt)[1])
        elif trouble:
            err(f"{cfg.container} didn't come up — {trouble}. Last output:")
            _tail_container_logs(cfg, rt)
            say(f"  {DIM}Full log: {hint('logs', profile)}{RESET}")
            return 1
        else:
            warn(f"Timed out waiting for auth config. Try: "
                 f"{hint('logs', profile)}  or  {hint('password', profile)}")
        return 0

    # Foreground: the server's own banner shows the in-container bind
    # (0.0.0.0:8765) which isn't reachable from the host, so a background
    # poller prints the real clickable URL once config.yaml appears.
    def _poll_and_print():
        pw, _trouble = _wait_for_password(cfg, rt)
        if pw:
            time.sleep(0.5)  # let the server banner finish printing
            print_bootstrap_url(cfg, pw, profile=profile, raw_tty=True,
                               token=get_credentials(cfg, rt)[1])

    threading.Thread(target=_poll_and_print, daemon=True).start()
    result = rt.run(*argv)
    raise SystemExit(result.returncode)


# ──── Lifecycle ───────────────────────────────────────────────────────────

def stop_container(cfg, profile=None):
    rt = Runtime(cfg)
    if rt.container_running(cfg.container):
        info(f"Stopping {cfg.container}…")
        rt.run("stop", cfg.container)
        ok("Stopped")
        return 0
    warn(f"Container '{cfg.container}' is not running")
    return 0


def remove_container(cfg):
    """Stop + rm — used by restart so the name is free again."""
    rt = Runtime(cfg)
    if rt.container_exists(cfg.container):
        rt.run("stop", cfg.container, capture_output=True)
        rt.run("rm", cfg.container, capture_output=True)


def cmd_logs(cfg):
    Runtime(cfg).exec_interactive("logs", "-f", cfg.container)


def cmd_shell(cfg, profile=None):
    rt = Runtime(cfg)
    if not rt.container_running(cfg.container):
        die(f"Container '{cfg.container}' is not running. Start it with:  "
            f"{hint('start', profile)}")
    info(f"Opening shell in {cfg.container}…")
    # -u app: the image's last USER is root (the entrypoint needs it to
    # align uids), so an exec would otherwise land you as root and let
    # you scatter root-owned files through the bind-mounted workspace.
    # The name resolves against the container's own /etc/passwd, so it
    # follows whatever uid the entrypoint settled on.
    # The image's default user shell is zsh; `docker exec` doesn't read
    # /etc/passwd for the default, so name it explicitly.
    rt.exec_interactive("exec", "-it", "-u", "app", cfg.container, "zsh")


def cmd_claude_login(cfg, profile=None):
    rt = Runtime(cfg)
    if not rt.container_running(cfg.container):
        die(f"Container '{cfg.container}' is not running. Start it with:  "
            f"{hint('start', profile)}")
    info(f"Running 'claude login' inside {cfg.container}…")
    say(f"{DIM}(this writes credentials to {cfg.claude_home}, not your host's ~/.claude){RESET}")
    # -u app so the credentials land owned by you, not root — see cmd_shell.
    rt.exec_interactive("exec", "-it", "-u", "app", cfg.container, "claude", "login")


def cmd_password(cfg, profile=None):
    rt = Runtime(cfg)
    pw = get_password(cfg, rt)
    if not pw:
        die(f"No password found. Has the server ever started?  "
            f"({hint('start', profile)})")
    scheme = "https" if cfg.effective_tls() == "on" else "http"
    _, token = get_credentials(cfg, rt)
    urls = [f"{scheme}://{host}:{cfg.port}/" + (f"?tkn={token}" if token else "")
            for host in bootstrap_hosts(cfg)]
    print_credentials(urls, pw, token)
    return 0


def cmd_extract(cfg, args, profile=None):
    rt = Runtime(cfg)
    dest = Path(args[0] if args else "./painapple-data-export").expanduser()

    if cfg.data_is_bind():
        info(f"Data is already a bind mount: {cfg.data_volume}")
        say("  Nothing to extract — copy directly with:")
        say(f'    cp -a "{cfg.data_volume}/." "{dest}/"')
        return 0

    if not rt.volume_exists(cfg.data_volume):
        die(f"Volume '{cfg.data_volume}' not found. Has the container ever run?")

    dest.mkdir(parents=True, exist_ok=True)
    dest = dest.resolve()
    info(f"Extracting volume '{cfg.data_volume}' → {dest}")

    # Stream tar OUT of the container instead of bind-mounting dest —
    # avoids UID-mapping headaches. The container only READS the volume;
    # untar runs on the host and creates files owned by you.
    reader = subprocess.Popen(
        rt.argv("run", "--rm", "--entrypoint", "sh",
                "-v", f"{cfg.data_volume}:/src:ro", cfg.image,
                "-c", "tar -cf - -C /src ."),
        stdout=subprocess.PIPE)
    untar = subprocess.run(["tar", "-xf", "-", "-C", str(dest)], stdin=reader.stdout)
    reader.stdout.close()
    if reader.wait() != 0 or untar.returncode != 0:
        die("Extract failed — see errors above.")
    ok(f"Extracted to: {dest}")
    say(f'{DIM}  Tip: tar it up with:  tar czf painapple-data.tgz -C "{dest}" .{RESET}')
    return 0
