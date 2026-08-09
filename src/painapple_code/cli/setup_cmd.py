"""Interactive ``painapple setup`` — global defaults and profiles.

Two wizards behind one verb:

* ``painapple setup`` — GLOBAL defaults for the bare serve: network
  (bind/port/TLS) and the container runtime used by ``--in-docker``
  (docker/podman/custom binary, image). Written to the root
  ``serve.yaml``. No workspace, no cosmetics — a bare ``painapple``
  always serves the cwd, and labels/accents belong to named
  deployments.

* ``painapple setup NAME`` — a PROFILE: a named deployment with a run
  mode (host or docker). Creating = configuring: a new NAME runs the
  wizard with fresh defaults; an existing one opens pre-filled.
  Written to ``profiles/NAME/profile.yaml`` (cli/profiles.py).

Both use the same step machine + widgets (cli/ui.py): steps only
mutate an in-memory dict; nothing is written until the review screen's
"Save & finish" — backing out or Ctrl-C never leaves state.
"""

import sys
from pathlib import Path

from painapple_code.cli import profiles, serve_config, ui
from painapple_code.cli.netinfo import detect_local_ips
from painapple_code.cli.ui import BACK, BOLD, DIM, RESET, Choice, info, ok, say, warn
from painapple_code.cli.serve_config import (
    ACCENT_PRESETS, INSTANCE_NAME_MAX, _HEX_RE,
)


def _section(n, title, blurb=None):
    say()
    say(f"{BOLD}{n}. {title}{RESET}")
    if blurb:
        say(f"{DIM}   {blurb}{RESET}")


# ──── Shared steps ────────────────────────────────────────────────────────
# Each step takes (cfg: dict, back: bool) and returns None (advance) or
# ui.BACK. Steps only mutate the in-memory dict.

def step_network(cfg, back, n=1):
    _section(n, "Network", "Which interface and port the bridge binds to")
    choices = [Choice("127.0.0.1", "Localhost only", "127.0.0.1 (recommended)")]
    for ip, iface in detect_local_ips():
        choices.append(Choice(ip, ip, f"bind to {iface} only — reachable on your LAN"))
    choices.append(Choice("custom", "Custom address…", "type an IP or hostname"))
    # 0.0.0.0 last and clearly labelled, so a hurried Enter can't pick it.
    choices.append(Choice("0.0.0.0", "All interfaces", "0.0.0.0 — exposes every interface"))

    known = {c.value for c in choices}
    current = cfg.get("host") or "127.0.0.1"
    picked = ui.select("Bind address", choices,
                       default=current if current in known else "custom",
                       back=back)
    if picked is BACK:
        return BACK
    if picked == "custom":
        host = ui.text("Address to bind (IP or hostname)",
                       default=current if current not in
                       ("127.0.0.1", "0.0.0.0") else "",
                       validate=lambda v: "Can't be empty." if not v else None)
        if host is BACK:
            return step_network(cfg, back, n)
        cfg["host"] = host
    else:
        cfg["host"] = picked
    if cfg["host"] == "0.0.0.0":
        warn("Bridge will accept connections on every interface — anyone "
             "with the password can connect.")
    elif cfg["host"] not in ("127.0.0.1", "::1", "localhost"):
        warn(f"Bridge will be reachable on {cfg['host']} — anyone with the "
             "password can connect.")

    port = ui.int_input("Port to bind", default=cfg.get("port") or 8765,
                        lo=1, hi=65535)
    if port is BACK:
        return step_network(cfg, back, n)
    cfg["port"] = port

    tls = ui.select(
        "TLS (self-signed cert, accepted without verification)",
        [Choice("auto", "Auto", "on for non-loopback, off for 127.0.0.1 (recommended)"),
         Choice("on", "On", "always force TLS"),
         Choice("off", "Off", "plain HTTP")],
        default=cfg.get("tls") or "auto", back=True)
    if tls is BACK:
        return step_network(cfg, back, n)
    cfg["tls"] = tls
    if tls == "off" and cfg["host"] not in ("127.0.0.1", "::1", "localhost"):
        warn("Plain HTTP on a non-loopback bind sends the password and "
             "traffic in cleartext.")
    return None


def step_cosmetics(cfg, back, n=3, default_label=""):
    _section(n, f"Cosmetics {DIM}(optional){RESET}")
    label = ui.text(
        f"Instance label — shown in the PWA icon and UI, max "
        f"{INSTANCE_NAME_MAX} chars (e.g. HOME / DEV"
        + (f", empty = '{default_label}'" if default_label else ", empty = none")
        + ")",
        default=cfg.get("instance_name") or "",
        validate=lambda v: (f"Too long ({len(v)} chars, max {INSTANCE_NAME_MAX})."
                            if len(v) > INSTANCE_NAME_MAX else None),
        back=back)
    if label is BACK:
        return BACK
    cfg["instance_name"] = label

    presets = [nm for nm in ACCENT_PRESETS if nm != "grey"]  # alias, not a choice
    current = cfg.get("accent") or ""
    accent = ui.select(
        "Accent color",
        [Choice("", "(none — default)"),
         *[Choice(name, name) for name in presets],
         Choice("custom", "Custom hex…")],
        default=current if current in presets or not current else "custom",
        back=True)
    if accent is BACK:
        return step_cosmetics(cfg, back, n, default_label)
    if accent == "custom":
        hex_val = ui.text("Hex color (#RGB or #RRGGBB)",
                          default=current if current.startswith("#") else "#c084fc",
                          validate=lambda v: None if _HEX_RE.match(v)
                          else "Not a valid hex color (need #RRGGBB or #RGB).")
        if hex_val is BACK:
            return step_cosmetics(cfg, back, n, default_label)
        cfg["accent"] = hex_val
    else:
        cfg["accent"] = accent
    return None


# ──── Global wizard: runtime step ────────────────────────────────────────

def step_runtime(cfg, back, n=2):
    from painapple_code.cli.deploy.runtime import detect_runtimes
    _section(n, "Container runtime",
             "Used by `painapple --in-docker` and docker-mode profiles")
    detected = detect_runtimes()
    choices = [Choice("", "Auto", "prefer docker, fall back to podman")]
    for name, path, version in detected:
        choices.append(Choice(name, f"{name} {version}".strip(), path))
    choices.append(Choice("custom", "Custom binary path…",
                          "a docker/podman-compatible CLI"))
    if not detected:
        warn("Neither docker nor podman found on PATH — --in-docker needs "
             "one installed (or a custom binary path).")

    current = cfg.get("runtime") or ""
    known = {c.value for c in choices}
    picked = ui.select("Runtime", choices,
                       default=current if current in known else "custom",
                       back=back)
    if picked is BACK:
        return BACK
    if picked == "custom":
        path = ui.text(
            "Runtime binary path (docker/podman-compatible)",
            default=current if Path(current).is_absolute() else "",
            validate=lambda v: None if Path(v).expanduser().is_absolute()
            and Path(v).expanduser().is_file()
            else "Need an absolute path to an existing binary.")
        if path is BACK:
            return step_runtime(cfg, back, n)
        cfg["runtime"] = path
    else:
        cfg["runtime"] = picked

    image = ui.text(
        "Container image tag (empty = painapple-code:latest, the tag "
        "`painapple pull` writes)",
        default=cfg.get("image") or "",
        validate=None, back=True)
    if image is BACK:
        return step_runtime(cfg, back, n)
    cfg["image"] = image
    return None


# ──── Profile steps ───────────────────────────────────────────────────────

def step_mode(cfg, back):
    _section(1, "Run mode", "How this deployment runs")
    mode = ui.select(
        "Mode",
        [Choice("host", "Host", "a local server process — this machine's "
                "tools, own isolated data home"),
         Choice("docker", "Docker", "a container sandbox (Docker/Podman) — "
                "prebuilt image, isolated filesystem")],
        default=cfg.get("mode") or "host", back=back)
    if mode is BACK:
        return BACK
    cfg["mode"] = mode
    return None


def step_workspace_host(cfg, back):
    _section(2, "Workspace",
             "The root directory holding your projects — its subfolders "
             "appear as projects on the welcome screen")
    path = ui.browse_dir("Workspace root",
                         start=cfg.get("workspace") or str(Path.cwd()),
                         allow_create=True)
    if path is BACK:
        return BACK
    cfg["workspace"] = path
    ok(f"Workspace: {path}")
    return None


def step_workspace_docker(cfg, back):
    _section(2, "Workspace", "How will you use this sandbox?")
    mode = ui.select(
        "Workspace layout",
        [Choice("project", "Single project", "mount one repo at /workspace/<name>"),
         Choice("parent", "Many projects", "mount a parent dir — pick projects in the UI"),
         Choice("multi", "Multiple projects", "mount several specific repos side by side")],
        default=cfg.get("workspace_mode") or "project", back=back)
    if mode is BACK:
        return BACK
    cfg["workspace_mode"] = mode

    if mode == "multi":
        return _edit_multi_workspaces(cfg)

    hint = ("pick the project dir" if mode == "project"
            else "pick the parent dir (its subdirs become projects)")
    path = ui.browse_dir(f"Workspace — {hint}",
                         start=cfg.get("workspace") or str(Path.cwd()),
                         allow_create=True)
    if path is BACK:
        return step_workspace_docker(cfg, back)  # re-pick the mode
    cfg["workspace"] = path
    cfg["workspaces"] = []  # clear a stale multi list on mode swap

    # Echo the host → container mapping so the pick is verifiable.
    if mode == "parent":
        ok(f"Parent dir: {path}")
        say(f"    {DIM}↳ container workspace root /workspace  ← this host dir{RESET}")
        say(f"    {DIM}↳ each subdir under it becomes a project{RESET}")
    else:
        ok(f"Project: {path}")
        say(f"    {DIM}↳ mounted at /workspace/{Path(path).name}  ← this host dir{RESET}")
    return None


def _edit_multi_workspaces(cfg):
    """List editor: add via path prompt, remove by picking an entry."""
    workspaces = list(cfg.get("workspaces") or [])
    while True:
        choices = [Choice("add", "＋ Add a project path…")]
        for ws in workspaces:
            choices.append(Choice(("rm", ws), f"– {ws}",
                                  f"→ /workspace/{Path(ws).name}  (pick to remove)"))
        if workspaces:
            choices.append(Choice("done", f"✓ Done — {len(workspaces)} project(s)"))
        picked = ui.select("Projects to mount under /workspace",
                           choices, default="add" if not workspaces else "done",
                           back=True)
        if picked is BACK:
            return BACK
        if picked == "done":
            cfg["workspaces"] = workspaces
            cfg["workspace"] = ""  # unused in multi mode; cleared so it can't mislead
            return None
        if picked == "add":
            # Sibling repos are the common case — start one level above
            # the last-added project so they're a single pick away.
            start = str(Path(workspaces[-1]).parent) if workspaces else str(Path.cwd())
            path = ui.browse_dir("Project to mount", start=start,
                                 allow_create=True)
            if path is BACK or not path:
                continue
            if path in workspaces:
                warn(f"Already in list: {path}")
                continue
            basename = Path(path).name
            clash = next((w for w in workspaces if Path(w).name == basename), None)
            if clash:
                warn(f"Basename '{basename}' already used by: {clash}")
                warn("Two paths can't share /workspace/<name>. Rename one host dir or skip.")
                continue
            workspaces.append(path)
            ok(f"Added: {path} → /workspace/{basename}")
        else:
            workspaces.remove(picked[1])
            info(f"Removed: {picked[1]}")


def step_claude(cfg, back, pending):
    _section(5, "Claude state",
             "Where the container reads/writes Claude CLI state "
             "(credentials, history, sessions, settings)")
    isolated_default = str(serve_config.root_home() / "shared" / ".claude")
    host_claude = str(Path("~/.claude").expanduser())
    current_home = cfg.get("claude_home") or isolated_default
    current = ("isolated" if current_home == isolated_default
               else "host" if current_home == host_claude else "custom")
    choice = ui.select(
        "Claude state location",
        [Choice("isolated", "Isolated", f"{isolated_default}  (recommended)"),
         Choice("host", "Host's", f"{host_claude}  — shares state with your host CLI"),
         Choice("custom", "Custom", "pick your own path")],
        default=current, back=back)
    if choice is BACK:
        return BACK
    old_home = cfg.get("claude_home")
    if choice == "isolated":
        cfg["claude_home"] = isolated_default
    elif choice == "host":
        cfg["claude_home"] = host_claude
        warn("Container will read/write your host's ~/.claude directly.")
    else:
        path = ui.browse_dir("Custom .claude location",
                             start=current_home,
                             suggest=current_home,
                             allow_create=True)
        if path is BACK:
            return step_claude(cfg, back, pending)
        cfg["claude_home"] = path
    # If CLAUDE_JSON was implicitly tracking the previous home, re-derive.
    if old_home and cfg.get("claude_json") == f"{old_home}.json":
        cfg["claude_json"] = ""
    effective_json = cfg.get("claude_json") or f"{cfg['claude_home']}.json"
    ok(f".claude home: {cfg['claude_home']}")
    ok(f".claude.json: {effective_json}")

    # Credential/onboarding seeding — decisions recorded here, executed
    # after the review screen (no side effects while backing around).
    pending["seed_creds"] = pending["seed_json"] = False
    if choice == "host":
        return None  # self-copy would be a no-op
    host_creds = Path("~/.claude/.credentials.json").expanduser()
    dst_creds = Path(cfg["claude_home"]) / ".credentials.json"
    if dst_creds.is_file():
        ok(f"Existing credentials at {dst_creds}")
    elif host_creds.is_file():
        pending["seed_creds"] = ui.confirm(
            f"Seed credentials from {host_creds}?", default=True)
    host_json = Path("~/.claude.json").expanduser()
    dst_json = Path(effective_json)
    if dst_json.is_file():
        ok(f"Existing state at {dst_json}")
    elif host_json.is_file():
        pending["seed_json"] = ui.confirm(
            f"Seed onboarding flags from {host_json}?", default=True)
    return None


def step_storage(cfg, back):
    _section(6, "Data storage",
             "Where the container stores sessions, logs, and DuckDB")
    current = cfg.get("data_volume") or ""
    is_bind = Path(current).is_absolute()
    if current:
        default = "bind" if is_bind else "named"
    else:
        default = "bind" if sys.platform.startswith("linux") else "named"
    kind = ui.select(
        "Storage type",
        [Choice("named", "Named Docker volume", "better for Windows and macOS"),
         Choice("bind", "Host directory", "direct mount, native for Linux")],
        default=default, back=back)
    if kind is BACK:
        return BACK
    if kind == "named":
        name = ui.text("Volume name",
                       default=current if current and not is_bind else "painapple-data",
                       validate=lambda v: "Volume name can't be empty." if not v else None)
        if name is BACK:
            return step_storage(cfg, back)
        cfg["data_volume"] = name
    else:
        default_path = current if is_bind else \
            str(serve_config.root_home() / "shared" / "data")
        path = ui.browse_dir("Data directory", start=default_path,
                             suggest=default_path, allow_create=True)
        if path is BACK:
            return step_storage(cfg, back)
        cfg["data_volume"] = path
    ok(f"Data: {cfg['data_volume']}")
    return None


# ──── Global wizard ──────────────────────────────────────────────────────

def _global_summary(cfg):
    say()
    say(f"{BOLD}Review{RESET}")
    say(f"  Network : {cfg.get('host') or '127.0.0.1'}:{cfg.get('port') or 8765}, "
        f"TLS {cfg.get('tls') or 'auto'}")
    say(f"  Runtime : {cfg.get('runtime') or DIM + 'auto' + RESET}"
        f"{RESET}, image {cfg.get('image') or DIM + 'painapple-code:latest' + RESET}")


def _global_setup():
    ui.require_tty(
        "The setup wizard",
        alternative=f"{DIM}Non-interactive alternative: edit "
                    f"{serve_config.serve_yaml_path()} directly "
                    f"(keys: {', '.join(serve_config.ROOT_KEYS)}){RESET}")

    cfg, problems = serve_config.load(
        recognized=serve_config.HOST_KEYS + serve_config.DEPLOY_KEYS)
    for key in serve_config.PROFILE_ONLY_KEYS:
        if cfg.pop(key, None) is not None:
            problems.append(f"key {key!r} is profile-only now — dropped "
                            "(painapple setup NAME)")
    for problem in problems:
        warn(f"serve.yaml: {problem}")

    say(f"{BOLD}Painapple Code — global defaults{RESET}")
    say(f"{DIM}What a bare `painapple` starts with — flags always override. "
        f"A bare `painapple` always serves the directory you launch it from; "
        f"named deployments: painapple setup NAME. "
        f"↑↓ + Enter, Esc/← Back to go back{RESET}")

    steps = [lambda back: step_network(cfg, back, 1),
             lambda back: step_runtime(cfg, back, 2)]
    try:
        i = 0
        while i < len(steps):
            result = steps[i](back=i > 0)
            i += -1 if result is BACK else 1

        section_names = ["Network", "Container runtime"]
        while True:
            _global_summary(cfg)
            action = ui.select(
                "All good?",
                [Choice("save", "✓ Save & finish"),
                 *[Choice(idx, f"Edit: {name}")
                   for idx, name in enumerate(section_names)],
                 Choice("cancel", "✗ Cancel — discard everything")])
            if action == "save":
                break
            if action == "cancel":
                say("Setup cancelled — nothing saved.")
                return 0
            steps[action](back=False)
    except KeyboardInterrupt:
        say()
        say("Setup cancelled — nothing saved.")
        return 130

    say()
    path = serve_config.save(cfg)
    if path.is_file():
        ok(f"Defaults saved to {path}")
    else:
        ok(f"All defaults cleared — {path} removed")

    say()
    say(f"{BOLD}Next:{RESET}")
    say(f"  painapple                {DIM}# serve the current dir with these defaults{RESET}")
    say(f"  painapple --in-docker    {DIM}# …or sandboxed (painapple pull fetches the image){RESET}")
    say(f"  painapple setup NAME     {DIM}# a named deployment (host or docker mode){RESET}")
    return 0


# ──── Profile wizard ─────────────────────────────────────────────────────

def _profile_summary(name, cfg):
    say()
    say(f"{BOLD}Review — profile '{name}'{RESET}")
    say(f"  Mode      : {cfg.get('mode', 'host')}")
    if cfg.get("mode") == "docker" and cfg.get("workspace_mode") == "multi":
        say(f"  Workspaces: {', '.join(cfg.get('workspaces') or [])} {DIM}(multi){RESET}")
    else:
        say(f"  Workspace : {cfg.get('workspace') or DIM + '(current dir at start)' + RESET}"
            + (f" {DIM}({cfg.get('workspace_mode')}){RESET}"
               if cfg.get("mode") == "docker" else ""))
    say(f"  Network   : {cfg.get('host') or '127.0.0.1'}:{cfg.get('port') or 8765}, "
        f"TLS {cfg.get('tls') or 'auto'}")
    say(f"  Cosmetics : label {cfg.get('instance_name') or DIM + f'({name})' + RESET}"
        f"{RESET}, accent {cfg.get('accent') or DIM + '(default)' + RESET}")
    if cfg.get("mode") == "docker":
        say(f"  Claude    : {cfg.get('claude_home')}")
        dv = cfg.get("data_volume") or ""
        say(f"  Data      : {dv} "
            f"{DIM}({'bind' if Path(dv).is_absolute() else 'named volume'}){RESET}")


def _apply_docker_side_effects(cfg, pending, name):
    import shutil as _shutil
    from painapple_code.cli.deploy.claude_seed import seed_claude_json
    claude_home = Path(cfg["claude_home"])
    claude_home.mkdir(parents=True, exist_ok=True)
    effective_json = cfg.get("claude_json") or f"{cfg['claude_home']}.json"

    dst_creds = claude_home / ".credentials.json"
    if pending.get("seed_creds"):
        src = Path("~/.claude/.credentials.json").expanduser()
        _shutil.copy(src, dst_creds)
        dst_creds.chmod(0o600)
        ok(f"Credentials copied to {dst_creds}")
    if pending.get("seed_json"):
        if seed_claude_json(Path("~/.claude.json").expanduser(), effective_json):
            ok(f"Onboarding state seeded to {effective_json}")
        else:
            warn(f"Could not seed {effective_json} — first interactive claude "
                 "in the container may show onboarding")
    if cfg["claude_home"] != str(Path("~/.claude").expanduser()) \
            and not dst_creds.is_file():
        warn(f"No credentials at {dst_creds}")
        warn(f"After starting, run:  painapple claude-login {name}")


def _profile_setup(name):
    if not profiles.valid_name(name):
        warn(f"Bad profile name: {name!r} (letters/digits/._- only, max 32 chars)")
        return 2

    ui.require_tty(
        "The setup wizard",
        alternative=f"{DIM}Non-interactive alternative: edit "
                    f"{profiles.profile_path(name)} directly{RESET}")

    existing = profiles.load(name)
    fresh = existing is None
    if fresh:
        from painapple_code.cli.deploy.config import DockerSettings, settings_to_data
        cfg = {k: v for k, v in
               settings_to_data(DockerSettings(profile=name)).items()}
        cfg["mode"] = "host"
        # Docker collision-free defaults pre-seeded; runtime/image stay
        # global unless overridden per-profile later.
        cfg.pop("runtime", None)
        cfg.pop("runtime_flags", None)
    else:
        cfg = {"mode": existing.mode, **existing.data}
        for problem in existing.problems:
            warn(f"profile.yaml: {problem}")

    pending = {}
    say(f"{BOLD}Painapple Code — profile '{name}'{RESET}"
        f"  {DIM}· {'new' if fresh else 'editing'}{RESET}")
    say(f"{DIM}A named deployment: run it with `painapple start {name}` "
        f"(background) or `painapple --profile {name}` (foreground). "
        f"↑↓ + Enter, Esc/← Back to go back{RESET}")

    def ws_step(back):
        return (step_workspace_docker(cfg, back) if cfg.get("mode") == "docker"
                else step_workspace_host(cfg, back))

    def docker_only(step):
        def run(back):
            if cfg.get("mode") != "docker":
                return None
            return step(back)
        return run

    steps = [
        lambda back: step_mode(cfg, back),
        ws_step,
        lambda back: step_network(cfg, back, 3),
        lambda back: step_cosmetics(cfg, back, 4, default_label=name),
        docker_only(lambda back: step_claude(cfg, back, pending)),
        docker_only(lambda back: step_storage(cfg, back)),
    ]

    # Warn about port collisions with other profiles (advisory only).
    def _port_clash():
        for other in profiles.list_profiles():
            if other == name:
                continue
            loaded = profiles.load(other)
            if loaded and loaded.data.get("port") == cfg.get("port"):
                warn(f"Port {cfg.get('port')} is also configured on profile "
                     f"'{other}' — they can't run at the same time.")
                return

    try:
        i = 0
        while i < len(steps):
            result = steps[i](back=i > 0)
            i += -1 if result is BACK else 1

        section_names = ["Run mode", "Workspace", "Network", "Cosmetics"]
        docker_sections = ["Claude state", "Data storage"]
        while True:
            _port_clash()
            _profile_summary(name, cfg)
            names = section_names + (docker_sections
                                     if cfg.get("mode") == "docker" else [])
            action = ui.select(
                "All good?",
                [Choice("save", "✓ Save & finish"),
                 *[Choice(idx, f"Edit: {sname}")
                   for idx, sname in enumerate(names)],
                 Choice("cancel", "✗ Cancel — discard everything")])
            if action == "save":
                break
            if action == "cancel":
                say("Setup cancelled — nothing saved.")
                return 0
            steps[action](back=False)
    except KeyboardInterrupt:
        say()
        say("Setup cancelled — nothing saved.")
        return 130

    say()
    mode = cfg.pop("mode", "host")
    if mode == "docker":
        from painapple_code.cli.deploy.config import (
            settings_from_data, settings_to_data)
        data = settings_to_data(settings_from_data(cfg, profile=name))
        _apply_docker_side_effects(cfg, pending, name)
    else:
        data = {k: cfg[k] for k in serve_config.HOST_KEYS
                if cfg.get(k) not in (None, "")}
    path = profiles.save(name, mode, data)
    ok(f"Profile saved to {path}")

    say()
    say(f"{BOLD}Next:{RESET}")
    if mode == "docker":
        from painapple_code.cli.deploy.config import settings_from_data
        from painapple_code.cli.deploy.runtime import Runtime
        try:
            settings = settings_from_data(data, profile=name)
            rt = Runtime(settings)
            if not rt.image_exists(settings.image):
                say(f"  painapple pull           {DIM}# fetch the prebuilt image (one time){RESET}")
        except SystemExit:
            say(f"  painapple pull           {DIM}# fetch the prebuilt image (one time){RESET}")
    say(f"  painapple start {name}      {DIM}# run it in the background{RESET}")
    say(f"  painapple --profile {name}  {DIM}# …or in the foreground{RESET}")
    say(f"  painapple status {name}     {DIM}# config + running state{RESET}")
    return 0


# ──── Entry ───────────────────────────────────────────────────────────────

def main(argv):
    """``painapple setup`` (global) / ``painapple setup NAME`` (profile —
    created on first save if it doesn't exist)."""
    try:
        prof, rest = serve_config.extract_profile(list(argv or []))
        if rest and not rest[0].startswith("-"):
            if prof and prof != rest[0]:
                warn(f"Profile given twice: {rest[0]!r} and --profile {prof!r}")
                return 2
            prof = rest[0]
        if prof in ("", "default"):
            prof = None
    except ValueError as e:
        warn(str(e))
        return 2

    profiles.ensure_migrated()
    if prof:
        return _profile_setup(prof)
    return _global_setup()
