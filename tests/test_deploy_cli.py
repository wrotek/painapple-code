"""Unit tests for the unified CLI: docker-mode settings, the profile
store, legacy migration, run-argv assembly, and dispatch. Pure logic
only — no container runtime, no server.

Isolation: every test points PAINAPPLE_CODE_HOME at tmp_path so nothing
reads/writes the real ~/.painapple-code.
"""

import pytest
import yaml

from painapple_code.cli import profiles, serve_config
from painapple_code.cli.deploy.config import (
    ConfigError, DEFAULT_IMAGE, DockerSettings, UPSTREAM_IMAGE, flag_to_key,
    settings_from_data, settings_to_data,
)


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "painapple-home"
    home.mkdir()
    monkeypatch.setenv("PAINAPPLE_CODE_HOME", str(home))
    # setenv-then-delenv (not bare delenv): guarantees a registered
    # restore even when the var was absent, since profiles.activate()
    # writes PAINAPPLE_PROFILE into the live environment.
    monkeypatch.setenv("PAINAPPLE_PROFILE", "")
    monkeypatch.delenv("PAINAPPLE_PROFILE")
    monkeypatch.setattr(profiles, "_migrated_this_process", False)
    return home


# ──── assign() validation ────────────────────────────────────────────────

def test_assign_port_bounds():
    cfg = DockerSettings()
    cfg.assign("PORT", "9001")
    assert cfg.port == 9001
    for bad in ("0", "65536", "abc", ""):
        with pytest.raises(ConfigError):
            cfg.assign("PORT", bad)


def test_assign_listen_host_localhost_normalizes():
    cfg = DockerSettings()
    cfg.assign("LISTEN_HOST", "localhost")
    assert cfg.listen_host == "127.0.0.1"
    with pytest.raises(ConfigError):
        cfg.assign("LISTEN_HOST", "not-an-ip")


def test_assign_workspace_must_exist(tmp_path):
    cfg = DockerSettings()
    with pytest.raises(ConfigError):
        cfg.assign("WORKSPACE", str(tmp_path / "nope"))
    ws = tmp_path / "proj"
    ws.mkdir()
    cfg.assign("WORKSPACE", str(ws))
    assert cfg.workspace == str(ws)


def test_assign_accent():
    cfg = DockerSettings()
    for good in ("", "blue", "#abc", "#c084fc"):
        cfg.assign("ACCENT", good)
    for bad in ("magenta", "#12", "c084fc"):
        with pytest.raises(ConfigError):
            cfg.assign("ACCENT", bad)


def test_assign_instance_name_length():
    cfg = DockerSettings()
    cfg.assign("INSTANCE_NAME", "A" * 12)
    with pytest.raises(ConfigError):
        cfg.assign("INSTANCE_NAME", "A" * 13)


def test_assign_runtime_accepts_custom_binary(tmp_path):
    cfg = DockerSettings()
    for good in ("", "docker", "podman"):
        cfg.assign("RUNTIME", good)
    with pytest.raises(ConfigError):
        cfg.assign("RUNTIME", "nerdctl")          # bare name, not allowed
    with pytest.raises(ConfigError):
        cfg.assign("RUNTIME", str(tmp_path / "missing"))
    binary = tmp_path / "nerdctl"
    binary.write_text("#!/bin/sh\n")
    cfg.assign("RUNTIME", str(binary))
    assert cfg.runtime == str(binary)


def test_claude_json_rederives_when_claude_home_moves(tmp_path):
    """An implicit CLAUDE_JSON tracks CLAUDE_HOME; an explicit one doesn't."""
    cfg = DockerSettings()
    assert cfg.effective_claude_json() == f"{cfg.claude_home}.json"
    cfg.assign("CLAUDE_HOME", str(tmp_path / "a"))
    assert cfg.effective_claude_json() == str(tmp_path / "a") + ".json"
    cfg.assign("CLAUDE_JSON", str(tmp_path / "explicit.json"))
    cfg.assign("CLAUDE_HOME", str(tmp_path / "b"))
    assert cfg.effective_claude_json() == str(tmp_path / "explicit.json")


def test_flag_to_key():
    assert flag_to_key("--listen-host") == "LISTEN_HOST"
    assert flag_to_key("--claude-home") == "CLAUDE_HOME"
    assert flag_to_key("--bogus") is None
    assert flag_to_key("port") is None


# ──── effective TLS ──────────────────────────────────────────────────────

def test_effective_tls_auto_pivots_on_listen_host():
    cfg = DockerSettings()
    cfg.tls_mode = "auto"
    cfg.listen_host = "127.0.0.1"
    assert cfg.effective_tls() == "off"
    cfg.listen_host = "192.168.1.50"
    assert cfg.effective_tls() == "on"
    cfg.tls_mode = "off"
    assert cfg.effective_tls() == "off"


# ──── profile store round-trip ───────────────────────────────────────────

def _sample_settings(tmp_path, profile=None):
    ws = tmp_path / "proj"
    ws.mkdir(exist_ok=True)
    cfg = DockerSettings(profile=profile)
    cfg.assign("WORKSPACE", str(ws))
    cfg.assign("PORT", "9100")
    cfg.assign("LISTEN_HOST", "0.0.0.0")
    cfg.assign("INSTANCE_NAME", "RT")
    cfg.assign("ACCENT", "#abc")
    cfg.assign("TLS_MODE", "on")
    return cfg


def test_docker_profile_round_trip(tmp_path):
    cfg = _sample_settings(tmp_path, profile="box")
    profiles.save("box", "docker", settings_to_data(cfg))
    prof = profiles.load("box")
    assert prof.mode == "docker" and prof.is_docker
    loaded = prof.docker_settings()
    from painapple_code.cli.deploy.config import CONFIG_KEYS
    for key in CONFIG_KEYS:
        assert loaded.get(key) == cfg.get(key), key


def test_docker_profile_collision_free_defaults():
    cfg = DockerSettings(profile="work")
    assert cfg.container == "painapple-code-work"
    assert cfg.data_volume == "painapple-data-work"
    assert cfg.config_volume.endswith("painapple-code/docker-work")
    # CLAUDE_HOME stays shared: one login serves every sandbox.
    assert cfg.claude_home == DockerSettings(profile="other").claude_home


def test_host_profile_round_trip():
    profiles.save("work", "host", {"port": 9001, "accent": "red",
                                   "workspace": "/tmp"})
    prof = profiles.load("work")
    assert prof.mode == "host" and not prof.is_docker
    vals = prof.host_values()
    assert vals["port"] == 9001
    assert vals["accent"] == "red"
    assert vals["workspace"] == "/tmp"


def test_host_values_skips_invalid():
    profiles.save("work", "host", {"port": 9001})
    # Hand-edit garbage in:
    path = profiles.profile_path("work")
    data = yaml.safe_load(path.read_text())
    data["accent"] = "not-a-color"
    path.write_text(yaml.safe_dump(data))
    vals = profiles.load("work").host_values()
    assert vals["port"] == 9001
    assert "accent" not in vals


def test_unknown_mode_defaults_to_host():
    path = profiles.profile_path("odd")
    path.parent.mkdir(parents=True)
    path.write_text("mode: warp\nport: 9009\n")
    prof = profiles.load("odd")
    assert prof.mode == "host"
    assert prof.problems


def test_bad_profile_names_rejected():
    for bad in ("", "-lead", "a" * 33, "sp ace", "../up"):
        with pytest.raises(ValueError):
            profiles.save(bad, "host", {})
        assert not profiles.valid_name(bad)


def test_stale_workspace_survives_load(tmp_path):
    """A profile whose WORKSPACE dir vanished must still load (status
    and list must work; only an actual start should fail on it)."""
    cfg = settings_from_data({"workspace": "/gone/away", "port": 9400})
    assert cfg.workspace == "/gone/away"
    assert cfg.port == 9400


def test_settings_from_data_accepts_legacy_names():
    cfg = settings_from_data({"listen_host": "0.0.0.0", "tls_mode": "on"})
    assert cfg.listen_host == "0.0.0.0"
    assert cfg.tls_mode == "on"
    cfg = settings_from_data({"host": "0.0.0.0", "tls": "on"})
    assert cfg.listen_host == "0.0.0.0"
    assert cfg.tls_mode == "on"


# ──── activation ─────────────────────────────────────────────────────────

def test_activate_repoints_home(isolated_home, monkeypatch):
    home = profiles.activate("work")
    assert home == isolated_home / "profiles" / "work"
    assert home.is_dir()
    import os
    assert os.environ["PAINAPPLE_CODE_HOME"] == str(home)
    assert os.environ["PAINAPPLE_PROFILE"] == "work"


def test_activate_no_nesting(isolated_home, monkeypatch):
    """A spawner that already exported the profile home must not get a
    second profiles/NAME nested inside it."""
    prof_home = isolated_home / "profiles" / "work"
    prof_home.mkdir(parents=True)
    monkeypatch.setenv("PAINAPPLE_CODE_HOME", str(prof_home))
    assert profiles.activate("work") == prof_home
    assert not (prof_home / "profiles").exists()


def test_root_home_climbs_out_of_profile(isolated_home, monkeypatch):
    prof_home = isolated_home / "profiles" / "work"
    prof_home.mkdir(parents=True)
    monkeypatch.setenv("PAINAPPLE_CODE_HOME", str(prof_home))
    assert serve_config.root_home() == isolated_home
    legacy = isolated_home / "serve-profiles" / "old"
    legacy.mkdir(parents=True)
    monkeypatch.setenv("PAINAPPLE_CODE_HOME", str(legacy))
    assert serve_config.root_home() == isolated_home


# ──── migration ──────────────────────────────────────────────────────────

def _legacy_serve_profile(home, name, port=9001):
    d = home / "serve-profiles" / name
    d.mkdir(parents=True)
    (d / "serve.yaml").write_text(f"port: {port}\nworkspace: /tmp\n")
    (d / "data.marker").write_text("x")
    return d


def _legacy_docker_profile(home, name, port=9200):
    d = home / "docker-profiles" / name
    d.mkdir(parents=True)
    (d / "docker.yaml").write_text(
        f"workspace: /tmp\nport: {port}\nlisten_host: 0.0.0.0\n"
        f"container: painapple-code-{name}\ninstance_name: UP\n")
    return d


def test_migrate_serve_profile_moves_data(isolated_home):
    _legacy_serve_profile(isolated_home, "work")
    notes = profiles.ensure_migrated(announce=lambda *_: None)
    assert any("adopted serve profile 'work'" in n for n in notes)
    prof = profiles.load("work")
    assert prof.mode == "host"
    assert prof.host_values()["port"] == 9001
    # Data rode along; a compat symlink replaces the old dir.
    assert (isolated_home / "profiles" / "work" / "data.marker").is_file()
    assert (isolated_home / "serve-profiles" / "work").is_symlink()
    assert not (isolated_home / "profiles" / "work" / "serve.yaml").exists()


def test_migrate_docker_profile(isolated_home):
    _legacy_docker_profile(isolated_home, "sandbox")
    profiles.ensure_migrated(announce=lambda *_: None)
    prof = profiles.load("sandbox")
    assert prof.is_docker
    cfg = prof.docker_settings()
    assert cfg.listen_host == "0.0.0.0"
    assert cfg.container == "painapple-code-sandbox"
    assert not (isolated_home / "docker-profiles" / "sandbox").exists()


def test_migrate_name_collision_renames_docker(isolated_home):
    _legacy_serve_profile(isolated_home, "work")
    _legacy_docker_profile(isolated_home, "work")
    profiles.ensure_migrated(announce=lambda *_: None)
    assert profiles.load("work").mode == "host"
    assert profiles.load("work-docker").mode == "docker"


def test_migrate_root_docker_yaml_merges_defaults(isolated_home):
    (isolated_home / "docker.yaml").write_text(
        "runtime: podman\nimage: painapple-code:custom\nworkspace: /tmp\n")
    profiles.ensure_migrated(announce=lambda *_: None)
    values, _ = serve_config.load()
    assert values["runtime"] == "podman"
    assert values["image"] == "painapple-code:custom"
    assert not (isolated_home / "docker.yaml").exists()
    assert (isolated_home / "docker.yaml.migrated").exists()


def test_migrate_idempotent(isolated_home, monkeypatch):
    _legacy_serve_profile(isolated_home, "work")
    profiles.ensure_migrated(announce=lambda *_: None)
    monkeypatch.setattr(profiles, "_migrated_this_process", False)
    notes = profiles.ensure_migrated(announce=lambda *_: None)
    assert notes == []  # symlinked legacy dir is not re-adopted


def test_migrate_noop_on_fresh_home(isolated_home):
    assert profiles.ensure_migrated(announce=lambda *_: None) == []


# ──── root serve.yaml: profile-only keys dropped ─────────────────────────

def test_root_serve_yaml_drops_profile_only_keys(isolated_home):
    (isolated_home / "serve.yaml").write_text(
        "port: 9800\nworkspace: /tmp\ninstance_name: OLD\naccent: red\n")
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--instance-name", default=None)
    values, problems = serve_config.apply_to_parser(parser)
    assert values == {"port": 9800}
    assert any("profile-only" in p for p in problems)
    assert parser.get_default("port") == 9800
    assert parser.get_default("workspace") == "."      # cwd stays cwd


def test_profile_config_layers_full_vocabulary(isolated_home, monkeypatch):
    profiles.save("work", "host", {"port": 9001, "workspace": "/tmp",
                                   "accent": "red"})
    monkeypatch.setenv("PAINAPPLE_CODE_HOME",
                       str(isolated_home / "profiles" / "work"))
    monkeypatch.setenv("PAINAPPLE_PROFILE", "work")
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--instance-name", default=None)
    parser.add_argument("--accent", default=None)
    values, _ = serve_config.apply_to_parser(parser)
    assert parser.get_default("port") == 9001
    assert parser.get_default("workspace") == "/tmp"
    assert parser.get_default("accent") == "red"
    # No explicit label → the profile name becomes the instance label.
    assert parser.get_default("instance_name") == "work"


def test_save_root_keeps_only_root_keys(isolated_home):
    serve_config.save({"port": 9000, "runtime": "docker",
                       "image": "painapple-code:edge",
                       "workspace": "/tmp", "accent": "red"})
    data = yaml.safe_load(serve_config.serve_yaml_path().read_text())
    assert data == {"port": 9000, "runtime": "docker",
                    "image": "painapple-code:edge"}


# ──── docker run argv assembly ───────────────────────────────────────────

class _FakeRuntime:
    def __init__(self, name="docker", selinux=False, app_ids=(1000, 1000),
                 adapts=False, userns_map=True):
        self.name = name
        self._selinux = selinux
        self._app_ids = app_ids
        self._adapts = adapts
        self._userns_map = userns_map
        self.chowned = []

    def selinux_enforcing(self):
        return self._selinux

    def image_user_ids(self, image):
        return self._app_ids

    def image_adapts_uid(self, image):
        return self._adapts

    def supports_userns_map(self):
        return self.name == "podman" and self._userns_map

    def volume_exists(self, volume):
        return True

    def chown_volume(self, image, volume, uid, gid, extra=()):
        self.chowned.append((volume, uid, gid))
        return True


def test_build_run_argv_project_mode(tmp_path):
    from painapple_code.cli.deploy.container import build_run_argv
    cfg = _sample_settings(tmp_path)
    argv = build_run_argv(cfg, _FakeRuntime(), detach=False)
    ws = cfg.workspace
    name = ws.rsplit("/", 1)[1]
    assert argv[:3] == ["run", "--rm", "-it"]
    assert f"{ws}:/workspace/{name}" in argv
    assert f"{cfg.listen_host}:9100:8765" in argv
    assert argv[-2:] == ["--tls", "on"]
    assert "--userns=keep-id" not in argv


def test_build_run_argv_detached_and_podman_selinux(tmp_path):
    from painapple_code.cli.deploy.container import build_run_argv
    cfg = _sample_settings(tmp_path)
    cfg.data_volume = str(tmp_path / "data")  # bind → gets :Z
    argv = build_run_argv(cfg, _FakeRuntime("podman", selinux=True), detach=True)
    assert argv[:4] == ["run", "-d", "--restart", "unless-stopped"]
    assert "--userns=keep-id" in argv
    assert f"{cfg.data_volume}:/data:Z" in argv
    # Named volumes never get :Z — only bind mounts do.
    cfg.data_volume = "painapple-data"
    argv = build_run_argv(cfg, _FakeRuntime("podman", selinux=True), detach=True)
    assert "painapple-data:/data" in argv


def test_build_run_argv_multi_mode(tmp_path):
    from painapple_code.cli.deploy.container import build_run_argv
    ws1, ws2 = tmp_path / "one", tmp_path / "two"
    ws1.mkdir(); ws2.mkdir()
    cfg = DockerSettings()
    cfg.workspace_mode = "multi"
    cfg.workspaces = [str(ws1), str(ws2)]
    argv = build_run_argv(cfg, _FakeRuntime(), detach=False)
    assert f"{ws1}:/workspace/one" in argv
    assert f"{ws2}:/workspace/two" in argv
    assert argv[argv.index("--workspace") + 1] == "/workspace"


def test_build_run_argv_reveal_hint_carries_profile(tmp_path):
    from painapple_code.cli.deploy.container import build_run_argv
    cfg = _sample_settings(tmp_path)
    argv = build_run_argv(cfg, _FakeRuntime(), detach=True, profile="work")
    assert "PAINAPPLE_REVEAL_CMD=painapple password work" in argv


def test_build_run_argv_reveal_hint_selects_the_adhoc_sandbox(tmp_path):
    """The ad-hoc container has no profile name, so its login page must
    say `--in-docker` — bare `painapple password` reads the HOST config
    and would hand the user a different deployment's password."""
    from painapple_code.cli.deploy.container import build_run_argv
    cfg = _sample_settings(tmp_path)
    argv = build_run_argv(cfg, _FakeRuntime(), detach=False)
    assert "PAINAPPLE_REVEAL_CMD=painapple password --in-docker" in argv


def test_adhoc_hints_point_at_commands_that_exist():
    from painapple_code.cli.deploy.container import hint
    assert hint("start") == "painapple --in-docker"      # not `start --in-docker`
    assert hint("logs") == "painapple logs --in-docker"
    assert hint("password", "work") == "painapple password work"
    assert hint("setup") == "painapple setup"            # no ad-hoc form


# ──── uid alignment (the container has to write the host's files) ────────

@pytest.fixture
def host_ids(monkeypatch):
    """Pin the host identity + platform so the uid story is testable off
    a Linux box with any uid."""
    from painapple_code.cli.deploy import container
    monkeypatch.setattr(container.sys, "platform", "linux")

    def _set(uid=1001, gid=1001):
        monkeypatch.setattr(container.os, "getuid", lambda: uid)
        monkeypatch.setattr(container.os, "getgid", lambda: gid)
    _set()
    return _set


def test_identity_maps_onto_app_uid_even_when_ids_already_match(tmp_path, host_ids):
    """A locally built image bakes USER_UID=$(id -u), so the mapping is
    an identity one — emitted anyway, because `keep-id:uid=N` and plain
    `keep-id` are the same thing when N is already the running uid, and
    not comparing means this needs no host uid at all (there isn't a
    meaningful one under podman machine)."""
    from painapple_code.cli.deploy.container import build_run_argv, plan_identity
    cfg = _sample_settings(tmp_path)
    rt = _FakeRuntime("podman", app_ids=(1001, 1001))
    ident = plan_identity(cfg, rt)
    assert ident.userns == "--userns=keep-id:uid=1001,gid=1001"
    assert ident.run_user is None and ident.env == {}
    assert ident.userns in build_run_argv(cfg, rt, detach=True, ident=ident)


def test_identity_podman_maps_uids_off_linux_too(tmp_path, monkeypatch):
    """podman machine presents real uids from inside the VM — unlike
    Docker Desktop, it does NOT fake bind-mount ownership, so the mapping
    is just as necessary on a Mac."""
    from painapple_code.cli.deploy import container
    monkeypatch.setattr(container.sys, "platform", "darwin")
    ident = container.plan_identity(_sample_settings(tmp_path),
                                    _FakeRuntime("podman", app_ids=(1000, 1000)))
    assert ident.userns == "--userns=keep-id:uid=1000,gid=1000"


def test_identity_podman_remaps_host_user_onto_app_uid(tmp_path, host_ids):
    """The bug: uid 1001 owns the mounts, the image runs as 1000."""
    from painapple_code.cli.deploy.container import build_run_argv, plan_identity
    cfg = _sample_settings(tmp_path)
    rt = _FakeRuntime("podman", app_ids=(1000, 1000))
    ident = plan_identity(cfg, rt)
    assert ident.userns == "--userns=keep-id:uid=1000,gid=1000"
    assert ident.repair is True
    assert "--userns=keep-id:uid=1000,gid=1000" in build_run_argv(
        cfg, rt, detach=True, ident=ident)


def test_identity_podman_adapting_image_runs_entrypoint_as_root(tmp_path, host_ids):
    """An image that re-stamps itself gets to fix its own volumes — but
    only from root, and it drops privileges before the server starts."""
    from painapple_code.cli.deploy.container import build_run_argv, plan_identity
    cfg = _sample_settings(tmp_path)
    rt = _FakeRuntime("podman", app_ids=(1000, 1000), adapts=True)
    ident = plan_identity(cfg, rt)
    assert ident.run_user == "0"
    assert ident.repair is False          # the entrypoint chowns instead
    argv = build_run_argv(cfg, rt, detach=True, ident=ident)
    assert argv[argv.index("--user") + 1] == "0"
    # No PAINAPPLE_UID under a remap: inside that namespace the host user
    # already IS the app uid, so telling the entrypoint otherwise would
    # make it align to a uid that doesn't exist there.
    assert not any(a.startswith("PAINAPPLE_UID") for a in argv)


def test_identity_docker_hands_ids_to_adapting_entrypoint(tmp_path, host_ids):
    from painapple_code.cli.deploy.container import build_run_argv, plan_identity
    cfg = _sample_settings(tmp_path)
    rt = _FakeRuntime("docker", app_ids=(1000, 1000), adapts=True)
    ident = plan_identity(cfg, rt)
    assert ident.env == {"PAINAPPLE_UID": "1001", "PAINAPPLE_GID": "1001"}
    argv = build_run_argv(cfg, rt, detach=True, ident=ident)
    assert "PAINAPPLE_UID=1001" in argv and "PAINAPPLE_GID=1001" in argv
    assert "--userns=keep-id" not in argv


def test_identity_docker_refuses_unfixable_mismatch(tmp_path, host_ids):
    """docker has no namespace to bend and an old image can't align
    itself — say so instead of crash-looping on PermissionError."""
    from painapple_code.cli.deploy.container import plan_identity
    cfg = _sample_settings(tmp_path)
    with pytest.raises(SystemExit):
        plan_identity(cfg, _FakeRuntime("docker", app_ids=(1000, 1000)))


def test_identity_off_linux_bends_nothing_but_still_repairs_volumes(tmp_path, monkeypatch):
    """Docker Desktop / podman machine fake bind-mount ownership, so
    there's no uid to line up — but a named volume is real storage in the
    VM that keeps whatever populated it, and outlives the image."""
    from painapple_code.cli.deploy import container
    monkeypatch.setattr(container.sys, "platform", "darwin")
    ident = container.plan_identity(_sample_settings(tmp_path),
                                    _FakeRuntime("docker", app_ids=(1000, 1000)))
    assert ident.userns is None and ident.env == {} and ident.run_user is None
    assert ident.repair is True


def test_identity_off_linux_leaves_adapting_image_to_itself(tmp_path, monkeypatch):
    """A current entrypoint chowns /data from the inside, as root, before
    dropping privileges — no need to pay for a throwaway container."""
    from painapple_code.cli.deploy import container
    monkeypatch.setattr(container.sys, "platform", "darwin")
    ident = container.plan_identity(
        _sample_settings(tmp_path),
        _FakeRuntime("docker", app_ids=(1000, 1000), adapts=True))
    assert ident.repair is False


def test_remap_repairs_named_volume_but_never_a_bind(tmp_path, host_ids):
    """A volume written under the old mapping belongs to nobody now. The
    user's own directories keep their ownership — the remap is what makes
    those line up in the first place."""
    from painapple_code.cli.deploy.container import plan_identity, prepare_volumes
    cfg = _sample_settings(tmp_path)
    cfg.data_volume = "painapple-data"
    cfg.config_volume = str(tmp_path / "cfg")      # bind
    rt = _FakeRuntime("podman", app_ids=(1000, 1000))
    prepare_volumes(cfg, rt, plan_identity(cfg, rt))
    assert rt.chowned == [("painapple-data", 1000, 1000)]


# ──── scripted profile channel (desktop launcher) ────────────────────────

def test_profile_set_creates_docker_profile(tmp_path, capsys):
    from painapple_code.cli.manage_cmd import main as manage_main
    ws = tmp_path / "proj"
    ws.mkdir()
    rc = manage_main("profile", ["set", "box", f"WORKSPACE={ws}",
                                 "PORT=9550", "--listen-host", "0.0.0.0"])
    assert rc == 0
    prof = profiles.load("box")
    assert prof.is_docker
    cfg = prof.docker_settings()
    assert cfg.port == 9550
    assert cfg.listen_host == "0.0.0.0"
    assert cfg.workspace == str(ws)


def test_profile_set_rejects_bad_value():
    from painapple_code.cli.manage_cmd import main as manage_main
    assert manage_main("profile", ["set", "box", "PORT=99999"]) == 1
    assert profiles.load("box") is None


def test_profile_get_and_list(capsys):
    from painapple_code.cli.manage_cmd import main as manage_main
    profiles.save("h1", "host", {"port": 9001})
    assert manage_main("profile", ["get", "h1", "port"]) == 0
    assert capsys.readouterr().out.strip() == "9001"
    assert manage_main("profile", ["list"]) == 0
    assert "h1\thost" in capsys.readouterr().out


# ──── root deployment: host or the ad-hoc sandbox? ───────────────────────

@pytest.fixture
def host_config(tmp_path, monkeypatch):
    """Point the host auth-config lookup somewhere writable. Returns the
    config.yaml path — absent until a test writes it.

    Patches paths.CONFIG_HOME, which is what both the server and
    `painapple password` resolve against. Setting XDG_CONFIG_HOME (what this
    fixture used to do) no longer redirects the lookup — and since
    CONFIG_HOME is bound at import time, an env var alone would leave the
    test reading the developer's REAL ~/.config/painapple-code/config.yaml
    and asserting against their live password.
    """
    from painapple_code import paths
    cfg_home = tmp_path / "config-home"
    cfg_home.mkdir(parents=True)
    monkeypatch.setattr(paths, "CONFIG_HOME", cfg_home)
    return cfg_home / "config.yaml"


@pytest.fixture
def captured_container_password(monkeypatch):
    """Record calls to the containerized password body instead of
    shelling out to a runtime."""
    from painapple_code.cli.deploy import container
    seen = []
    monkeypatch.setattr(container, "cmd_password",
                        lambda cfg, profile=None: seen.append((cfg, profile)) or 0)
    return seen


def test_password_in_docker_targets_the_adhoc_container(
        host_config, captured_container_password):
    """`--in-docker` selects the nameless root sandbox — the flag is the
    only handle it has, since profiles are selected by name."""
    from painapple_code.cli.manage_cmd import main as manage_main
    assert manage_main("password", ["--in-docker"]) == 0
    assert len(captured_container_password) == 1
    cfg, profile = captured_container_password[0]
    assert profile is None
    assert cfg.container == "painapple-code"


def test_password_in_docker_rejected_for_a_named_profile(capsys):
    """A profile carries mode: — asking for --in-docker on top of it is
    ambiguous, so say so rather than silently picking one."""
    from painapple_code.cli.manage_cmd import main as manage_main
    profiles.save("h1", "host", {"port": 9001})
    assert manage_main("password", ["h1", "--in-docker"]) == 1
    assert "carries its own mode" in capsys.readouterr().err


def test_password_falls_back_to_a_running_sandbox(
        host_config, captured_container_password, monkeypatch):
    """No host server has ever run, but the container is up and its login
    page sent the user here — answer for the container instead of
    claiming nothing has started."""
    from painapple_code.cli import manage_cmd
    monkeypatch.setattr(manage_cmd, "_adhoc_container_running", lambda: True)
    assert not host_config.exists()
    assert manage_cmd.main("password", []) == 0
    assert len(captured_container_password) == 1


def test_password_prefers_the_host_and_skips_the_runtime_probe(
        host_config, captured_container_password, monkeypatch, capsys):
    """A real host deployment wins, and the probe never runs — the happy
    path must not pay for a `docker info` round-trip."""
    from painapple_code.cli import manage_cmd
    host_config.write_text("password: hunter2\n")

    def _boom():
        raise AssertionError("probed the container runtime on the host path")

    monkeypatch.setattr(manage_cmd, "_adhoc_container_running", _boom)
    assert manage_cmd.main("password", []) == 0
    assert not captured_container_password
    assert "hunter2" in capsys.readouterr().out


def test_adhoc_probe_is_soft_when_no_runtime_exists(monkeypatch):
    """auto_detect() die()s (SystemExit, not Exception) when neither
    docker nor podman is installed — that must read as 'no container'."""
    from painapple_code.cli import manage_cmd
    from painapple_code.cli.deploy import runtime
    monkeypatch.setattr(runtime, "auto_detect",
                        lambda: (_ for _ in ()).throw(SystemExit(1)))
    assert manage_cmd._adhoc_container_running() is False


# ──── the fleet view (painapple list == bare painapple status) ───────────

def _proc(pid, port, home, name="", workspace="/w"):
    return {"pid": pid, "host": "127.0.0.1", "port": str(port), "name": name,
            "workspace": workspace, "home": str(home) if home else "",
            "command": f"python -m painapple_code --port {port}"}


_MAC_PYTHON = ("/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/"
               "Python.framework/Versions/3.14/Resources/Python.app/"
               "Contents/MacOS/Python")


def test_serve_args_accepts_a_capital_p_framework_interpreter():
    """pipx on macOS bakes the Homebrew/python.org FRAMEWORK build into
    the console script's shebang, and that binary is named `Python`. The
    interpreter guard used a case-SENSITIVE startswith("python"), so
    every pipx-installed painapple on macOS was skipped by the scan and
    `painapple list` reported the running deployment as stopped."""
    from painapple_code.cli.list_cmd import _serve_args
    # argv LIST, not a joined string: re-splitting a command line on spaces
    # is what broke paths containing one (C:\Program Files\…\painapple.exe),
    # so the scan hands the real token list straight through.
    bare = [_MAC_PYTHON, "-E", "/Users/w/.local/bin/painapple"]
    assert _serve_args(bare) == []
    assert _serve_args(bare + ["--port", "8890"]) == ["--port", "8890"]
    assert _serve_args([_MAC_PYTHON, "-m", "painapple_code",
                        "--port", "8890"]) == ["--port", "8890"]
    # The guard must still reject subcommands and non-interpreter argv[0].
    assert _serve_args(bare + ["list"]) is None
    assert _serve_args(["/usr/bin/vim", "/Users/w/.local/bin/painapple"]) is None
    # A path with a space survives intact — the regression the list-based
    # signature exists to prevent.
    assert _serve_args([_MAC_PYTHON, "-E",
                        r"C:\Program Files\painapple\painapple.exe",
                        "--port", "8890"]) == ["--port", "8890"]


def test_scan_resolves_a_foreground_profile_launch(isolated_home, monkeypatch):
    """`painapple --profile test` must read back as the `test`
    deployment, not as the root one.

    `profiles.activate()` sets PAINAPPLE_CODE_HOME/PAINAPPLE_PROFILE
    IN-PROCESS, and psutil (like /proc/<pid>/environ) reports the
    environment a process was EXEC'd with — so a foreground profile run
    exposes neither, and the scan fell back to the default home + root
    serve.yaml. Symptoms, all in one `painapple list`: the profile row
    said `stopped` while its port was demonstrably in use, the process
    was listed as unmanaged on port 8765, and — worst — it sat on the
    root home + root port, which is a tier-1 `match_process()` hit, so
    `painapple stop` could kill it as if it were `default`. Only argv
    survives the exec, so that's what the scan reads."""
    from painapple_code.cli import list_cmd
    profiles.save("test", "host", {"port": 8890, "workspace": "/home/w/dev"})
    argv = ["/home/w/.local/share/pipx/venvs/painapple-code/bin/python", "-E",
            "/home/w/.local/bin/painapple", "--profile", "test"]
    monkeypatch.setattr(list_cmd, "_iter_processes", lambda: [(7377, argv)])
    # The ROOT home, exported or defaulted — either way it names the root
    # deployment, and only argv says which profile was activated on top.
    monkeypatch.setattr(list_cmd, "_proc_environ",
                        lambda pid: {"PAINAPPLE_CODE_HOME": str(isolated_home)})
    monkeypatch.setattr(list_cmd, "_in_container", lambda pid: False)
    monkeypatch.setattr(list_cmd, "_collapse_chains", lambda rows: rows)

    row, = list_cmd.local_servers()
    assert row["port"] == "8890"                       # was "8765"
    assert row["home"] == str(profiles.profile_home("test").resolve())
    assert row["workspace"] == "/home/w/dev"
    assert row["name"] == "test"                       # profile-name label

    # …and the deployment row now claims it, instead of `default` doing so.
    rows = {r["name"]: r for r in list_cmd.deployment_rows([row])}
    assert rows["test"]["pid"] == 7377
    assert rows["default"]["pid"] is None


def test_scan_reads_profile_home_from_an_exported_env(isolated_home, monkeypatch):
    """`painapple start NAME` exports both vars, and the exported home
    ALREADY is the profile home — re-appending profiles/NAME would nest a
    second home inside the first (the anti-nesting rule activate() uses).
    """
    from pathlib import Path

    from painapple_code.cli import list_cmd
    home = profiles.profile_home("work")
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(list_cmd, "_proc_environ",
                        lambda pid: {"PAINAPPLE_CODE_HOME": str(home),
                                     "PAINAPPLE_PROFILE": "work"})
    assert list_cmd._home_of(123) == str(home.resolve())
    assert list_cmd._home_of(123, ["--profile=work"]) == str(home.resolve())

    # And with NOTHING exported (the foreground case): the built-in
    # default root, with the argv profile appended under it.
    monkeypatch.setattr(list_cmd, "_proc_environ", lambda pid: {})
    assert (list_cmd._home_of(123, ["--profile", "work"])
            == str(Path("~/.painapple-code/profiles/work").expanduser().resolve()))
    # An unreadable environment (another user) still yields '' — that's
    # what keeps port-only matching from claiming a foreign deployment.
    monkeypatch.setattr(list_cmd, "_proc_environ", lambda pid: None)
    assert list_cmd._home_of(123, ["--profile", "work"]) == ""


def test_match_process_prefers_the_deployments_own_port(isolated_home):
    """A data home can hold two servers (one started with --port). The
    row that owns the deployment is the one on its configured port."""
    from painapple_code.cli.list_cmd import match_process
    running = [_proc(11, 8880, isolated_home), _proc(22, 8765, isolated_home)]
    assert match_process(running, isolated_home, 8765) == 22


def test_match_process_never_claims_a_known_foreign_home(isolated_home, tmp_path):
    """Port-only matching is restricted to rows whose home is UNKNOWN —
    otherwise `stop` would kill someone else's deployment."""
    from painapple_code.cli.list_cmd import match_process
    other = tmp_path / "someone-else"
    assert match_process([_proc(11, 8765, other)], isolated_home, 8765) is None
    assert match_process([_proc(11, 8765, None)], isolated_home, 8765) == 11


def test_deployment_rows_lead_with_default_and_claim_their_processes(
        isolated_home, monkeypatch):
    """The root deployment is a first-class row: the process running out
    of the root home is 'default', not an unmanaged stray (it used to be
    listed as ad-hoc while `status` simultaneously claimed it)."""
    from painapple_code.cli import list_cmd
    profiles.save("work", "host", {"port": 8899})
    running = [_proc(2658, 8765, isolated_home, name="STABLE"),
               _proc(3000, 8899, profiles.profile_home("work")),
               _proc(4000, 8880, isolated_home, name="DEV")]
    rows = list_cmd.deployment_rows(running)
    assert [r["name"] for r in rows] == ["default", "work"]
    assert rows[0]["pid"] == 2658 and rows[1]["pid"] == 3000
    # …and the label of the process behind `default` isn't lost.
    assert "STABLE" in rows[0]["detail"]
    claimed = {r["pid"] for r in rows if r["pid"]}
    assert [r["pid"] for r in running if r["pid"] not in claimed] == [4000]


def test_bare_status_is_the_fleet_view(monkeypatch, capsys):
    from painapple_code.cli import list_cmd
    from painapple_code.cli.manage_cmd import main as manage_main
    seen = []
    monkeypatch.setattr(list_cmd, "main", lambda argv=None: seen.append(argv) or 0)
    assert manage_main("status", []) == 0
    assert seen == [[]]
    # An explicit `default` still means the root's own detail block.
    assert manage_main("status", ["default"]) == 0
    assert len(seen) == 1
    assert "Data home" in capsys.readouterr().out


def test_status_targets_an_unmanaged_process(monkeypatch, capsys, isolated_home):
    """`painapple list` shows them and start/stop already take them, so
    status must too — not 'No profile named …'."""
    from painapple_code.cli import list_cmd
    from painapple_code.cli.manage_cmd import main as manage_main
    monkeypatch.setattr(list_cmd, "local_servers",
                        lambda: [_proc(19225, 8880, isolated_home, name="DEV")])
    assert manage_main("status", ["DEV"]) == 0
    out = capsys.readouterr().out
    assert "[process]" in out and "8880" in out
    assert manage_main("status", ["nope"]) == 1


def test_profile_set_host_accepts_the_uppercase_vocabulary(capsys):
    """One key vocabulary for scripted callers, both modes."""
    from painapple_code.cli.manage_cmd import main as manage_main
    assert manage_main("profile", ["set", "h2", "--mode", "host",
                                   "PORT=9002", "LISTEN_HOST=0.0.0.0"]) == 0
    assert profiles.load("h2").host_values() == {"port": 9002,
                                                 "host": "0.0.0.0"}


# ──── top-level dispatch ─────────────────────────────────────────────────

def test_serve_stays_default(monkeypatch):
    """Bare argv must fall through to server.main unchanged."""
    from painapple_code import cli
    seen = {}
    monkeypatch.setattr("painapple_code.server.main",
                        lambda argv=None: seen.setdefault("argv", argv))
    cli.main(["--port", "9999"])
    assert seen["argv"] == ["--port", "9999"]
    seen.clear()
    cli.main(["serve", "--port", "8888"])
    assert seen["argv"] == ["--port", "8888"]


def test_docker_group_moved():
    from painapple_code import cli
    assert cli.main(["docker", "up", "-d"]) == 2


def test_profile_docker_mode_routes_to_container(monkeypatch, tmp_path):
    """`painapple --profile box` on a docker-mode profile must launch the
    container path, not the host server."""
    ws = tmp_path / "proj"
    ws.mkdir()
    profiles.save("box", "docker", {"workspace": str(ws), "port": 9660})
    seen = {}
    from painapple_code.cli.deploy import launch
    monkeypatch.setattr(launch, "run_container",
                        lambda cfg, detach, profile=None:
                        seen.update(port=cfg.port, detach=detach,
                                    profile=profile) or 0)
    from painapple_code import cli
    assert cli.main(["--profile", "box"]) == 0
    assert seen == {"port": 9660, "detach": False, "profile": "box"}


# ──── image auto-pull ─────────────────────────────────────────────────────

class _PullRuntime:
    """Fake runtime for the pull path: records run() argv tuples."""

    def __init__(self, name="docker", pull_rc=0, version="1.0.0rc9"):
        self.name = name
        self.pull_rc = pull_rc
        self.version = version
        self.calls = []

    def run(self, *argv, **kw):
        self.calls.append(argv)
        rc = self.pull_rc if argv[0] == "pull" else 0

        class _Res:
            returncode = rc
        return _Res()

    def label(self, image, name):
        return self.version


def test_pull_image_pulls_upstream_and_retags(tmp_path):
    from painapple_code.cli.deploy.container import pull_image
    cfg = _sample_settings(tmp_path)
    rt = _PullRuntime()
    assert pull_image(cfg, rt) is True
    assert rt.calls == [("pull", f"{UPSTREAM_IMAGE}:latest"),
                        ("tag", f"{UPSTREAM_IMAGE}:latest", cfg.image)]


def test_pull_names_the_version_it_landed_on(tmp_path, capsys):
    """A moving tag that quietly stops moving is invisible otherwise —
    :latest sat on v1.0.0-rc1 for a month while pull reported success."""
    from painapple_code.cli.deploy.container import pull_image
    cfg = _sample_settings(tmp_path)
    assert pull_image(cfg, _PullRuntime(version="1.0.0rc9")) is True
    assert "1.0.0rc9" in capsys.readouterr().out


def test_pull_survives_an_image_with_no_version_label(tmp_path, capsys):
    from painapple_code.cli.deploy.container import pull_image
    cfg = _sample_settings(tmp_path)
    assert pull_image(cfg, _PullRuntime(version="")) is True
    assert "version" not in capsys.readouterr().out


def test_pull_image_failure_returns_false_without_retag(tmp_path):
    from painapple_code.cli.deploy.container import pull_image
    cfg = _sample_settings(tmp_path)
    rt = _PullRuntime(pull_rc=1)
    assert pull_image(cfg, rt) is False
    assert rt.calls == [("pull", f"{UPSTREAM_IMAGE}:latest")]


def test_pull_image_explicit_source_used_verbatim(tmp_path):
    from painapple_code.cli.deploy.container import pull_image
    cfg = _sample_settings(tmp_path)
    rt = _PullRuntime()
    assert pull_image(cfg, rt, tag="edge", source="ghcr.io/foo/bar") is True
    assert rt.calls[0] == ("pull", "ghcr.io/foo/bar:edge")


class _MissingImageRuntime:
    name = "docker"

    def responds(self):
        return True

    def image_exists(self, image):
        return False


def test_run_container_autopulls_missing_default_image(monkeypatch, tmp_path):
    """Default local tag missing → run_container fetches it by itself
    (the pull failing afterwards is what stops the run here)."""
    from painapple_code.cli.deploy import container
    cfg = _sample_settings(tmp_path)
    assert cfg.image == DEFAULT_IMAGE
    seen = {}
    monkeypatch.setattr(container, "Runtime",
                        lambda cfg: _MissingImageRuntime())
    monkeypatch.setattr(container, "pull_image",
                        lambda c, r, **kw: seen.setdefault("pulled", True)
                        and False)
    with pytest.raises(SystemExit):
        container.run_container(cfg, detach=True)
    assert seen == {"pulled": True}


def test_run_container_custom_image_does_not_autopull(monkeypatch, tmp_path):
    """A custom image name keeps the fail-early error — no guessing
    which registry it comes from."""
    from painapple_code.cli.deploy import container
    cfg = _sample_settings(tmp_path)
    cfg.assign("IMAGE", "myregistry.local/painapple:v9")
    seen = {}
    monkeypatch.setattr(container, "Runtime",
                        lambda cfg: _MissingImageRuntime())
    monkeypatch.setattr(container, "pull_image",
                        lambda c, r, **kw: seen.setdefault("pulled", True))
    with pytest.raises(SystemExit):
        container.run_container(cfg, detach=True)
    assert seen == {}
