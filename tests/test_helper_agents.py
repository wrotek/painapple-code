"""Auto-journal helpers: per-provider agent install, agent env export, and the
helper scripts' server/home discovery.

Regression context (2026-10-10): on a box running a host profile (`vm`), the
helpers silently read the ROOT deployment — `shadow-git` showed a frozen
history whose newest commits were weeks-old Claude turns ("Codex isn't
committing"), and `shadow-query` hit http://localhost:8765, which the profile
didn't even listen on. And only ~/.claude/agents was ever written, so Codex
users had no helper agents at all.
"""

import os
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

from painapple_code import helpers
from painapple_code.server import agent_env

TOOLS = Path(helpers.PACKAGE_DIR) / "tools"


# ── agent_env ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("host,tls,url,cacert", [
    ("127.0.0.1", False, "http://127.0.0.1:9000", False),
    ("localhost", False, "http://127.0.0.1:9000", False),
    ("::1", False, "http://[::1]:9000", False),
    ("0.0.0.0", False, "http://127.0.0.1:9000", False),
    ("::", False, "http://[::1]:9000", False),
    # TLS on a specific LAN address → main() runs a plain-http loopback
    # companion; agents use that, no cert needed.
    ("192.168.1.225", True, "http://127.0.0.1:9000", False),
    # TLS covering loopback itself → https + the self-signed cert.
    ("0.0.0.0", True, "https://127.0.0.1:9000", True),
    ("127.0.0.1", True, "https://127.0.0.1:9000", True),
    ("192.168.1.225", False, "http://192.168.1.225:9000", False),
    ("fd00::5", False, "http://[fd00::5]:9000", False),
])
def test_agent_env_url(tmp_path, host, tls, url, cacert):
    cert = tmp_path / "cert.pem"
    env = agent_env(host, 9000, tls, cert if tls else None,
                    str(tmp_path / "config.yaml"), tmp_path / "home")
    assert env["PAINAPPLE_URL"] == url
    assert env["PAINAPPLE_CODE_HOME"] == str(tmp_path / "home")
    assert env["PAINAPPLE_AUTH_CONFIG"] == str(tmp_path / "config.yaml")
    assert ("PAINAPPLE_CACERT" in env) is cacert
    # Never a credential in the environment.
    assert not any("TOKEN" in k or "PASSWORD" in k for k in env)


# ── agent rendering ──────────────────────────────────────────────────────

@pytest.mark.parametrize("src", helpers.AGENT_SOURCES)
def test_toml_render_is_valid_codex_role(src):
    data = tomllib.loads(helpers.render_agent(src, "toml"))
    # Codex rejects unknown fields and requires these three, non-blank.
    assert set(data) == {"name", "description", "developer_instructions"}
    assert data["name"] == Path(src).stem
    assert data["description"].strip()
    body = data["developer_instructions"]
    assert body.strip() and not body.startswith("---")
    assert "~/.local/bin/" in body


@pytest.mark.parametrize("src", helpers.AGENT_SOURCES)
def test_markdown_render_is_the_source(src):
    assert helpers.render_agent(src, "markdown") == \
        (helpers.PACKAGE_DIR / src).read_text(encoding="utf-8")


def test_toml_str_falls_back_when_delimiter_present():
    tricky = "a ''' b\n"
    assert tomllib.loads("x = " + helpers._toml_str(tricky))["x"] == tricky


# ── registry-driven targets ──────────────────────────────────────────────

class _FakeProvider:
    def __init__(self, name, root, fmt, *, available=True, default_enabled=True):
        self.name = name
        self.display_name = name.title()
        self.default_enabled = default_enabled
        self._root, self._fmt, self._available = root, fmt, available

    def is_available(self):
        return (self._available, None if self._available else "missing")

    def agent_roots(self, cwd):
        return [
            {"scope": "project", "dir": Path(cwd) / ".x", "fmt": self._fmt},
            {"scope": "personal", "dir": self._root, "fmt": self._fmt},
        ]


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    bin_dir = home / ".local" / "bin"
    monkeypatch.setattr(helpers, "SCRIPT_FILES", [
        ("tools/shadow-git", bin_dir / "shadow-git"),
        ("tools/shadow-query", bin_dir / "shadow-query"),
    ])
    monkeypatch.setattr(helpers, "LEGACY_TARGETS", [])
    return home


def _use_providers(monkeypatch, provs):
    import painapple_code.providers as reg
    monkeypatch.setattr(reg, "all_providers", lambda: provs)


def test_targets_follow_enabled_and_available_providers(fake_home, monkeypatch):
    claude_a = _FakeProvider("claude-a", fake_home / ".claude" / "agents", "markdown")
    claude_b = _FakeProvider("claude-b", fake_home / ".claude" / "agents", "markdown")
    codex = _FakeProvider("codex", fake_home / ".codex" / "agents", "toml")
    absent = _FakeProvider("absent", fake_home / ".absent" / "agents", "toml",
                           available=False)
    _use_providers(monkeypatch, [claude_a, claude_b, codex, absent])

    targets = helpers.helper_targets()
    agents = [t for t in targets if t.kind == "agent"]
    # Shared root claimed once; unavailable provider skipped.
    assert {t.provider for t in agents} == {"claude-a", "codex"}
    assert {t.target.name for t in agents if t.fmt == "toml"} == \
        {"shadow-git-helper.toml", "shadow-db-helper.toml"}
    assert {t.target.name for t in agents if t.fmt == "markdown"} == \
        {"shadow-git-helper.md", "shadow-db-helper.md"}

    # Disabled in Settings → no agents for it.
    only_claude = helpers.helper_targets({"claude-a": True, "codex": False})
    assert {t.provider for t in only_claude if t.kind == "agent"} == {"claude-a"}

    # Uninstall reach covers every registered provider, enabled or not.
    every = helpers.helper_targets(include_all=True)
    assert "absent" in {t.provider for t in every}


def test_install_status_model_uninstall_roundtrip(fake_home, monkeypatch):
    claude = _FakeProvider("claude", fake_home / ".claude" / "agents", "markdown")
    codex = _FakeProvider("codex", fake_home / ".codex" / "agents", "toml")
    _use_providers(monkeypatch, [claude, codex])

    st = helpers.helpers_status()
    assert not st["all_installed"]
    assert [h["provider"] for h in st["agent_hosts"]] == ["claude", "codex"]

    res = helpers.install_helpers(True)
    assert res["ok"], res
    st = helpers.helpers_status()
    assert st["all_installed"] and st["all_current"] and not st["any_outdated"]

    # The model pick touches Claude-format agents only, and doesn't read as stale.
    assert helpers.apply_agent_model("claude-test-model")
    for name in ("shadow-git-helper.md", "shadow-db-helper.md"):
        assert "model: claude-test-model" in \
            (fake_home / ".claude" / "agents" / name).read_text()
    assert "claude-test-model" not in \
        (fake_home / ".codex" / "agents" / "shadow-db-helper.toml").read_text()
    assert helpers.read_installed_agent_model() == "claude-test-model"
    assert helpers.helpers_status()["all_current"]

    # A hand-edited TOML is outdated.
    (fake_home / ".codex" / "agents" / "shadow-git-helper.toml").write_text("x = 1\n")
    assert helpers.helpers_status()["any_outdated"]

    # Codex later disabled → uninstall still cleans its agents.
    _use_providers(monkeypatch, [claude, _FakeProvider(
        "codex", fake_home / ".codex" / "agents", "toml", default_enabled=False)])
    out = helpers.uninstall_helpers()
    assert out["ok"]
    assert not list((fake_home / ".codex" / "agents").glob("*"))
    assert not list((fake_home / ".claude" / "agents").glob("*"))


# ── shadow-git home resolution ───────────────────────────────────────────

def _project_hash(path: str) -> str:
    import hashlib
    return hashlib.sha256(path.encode()).hexdigest()[:12]


def _make_repo(home: Path, project: Path, msg: str, when: int):
    d = home / "projects" / _project_hash(str(project)) / "shadow-git"
    d.parent.mkdir(parents=True, exist_ok=True)
    (d.parent / "path").write_text(str(project))
    subprocess.run(["git", "init", "-q", "--bare", str(d)], check=True)
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    tree = subprocess.run(["git", f"--git-dir={d}", "mktree"], input="",
                          capture_output=True, text=True, check=True, env=env).stdout.strip()
    c = subprocess.run(["git", f"--git-dir={d}", "commit-tree", tree, "-m", msg],
                       capture_output=True, text=True, check=True, env=env).stdout.strip()
    subprocess.run(["git", f"--git-dir={d}", "update-ref", "refs/heads/shadow/main", c],
                   check=True)
    subprocess.run(["git", f"--git-dir={d}", "symbolic-ref", "HEAD",
                    "refs/heads/shadow/main"], check=True)
    ref = d / "refs" / "heads" / "shadow" / "main"
    os.utime(ref, (when, when))


@pytest.mark.skipif(not shutil.which("git") or not shutil.which("bash"),
                    reason="needs git + bash")
def test_shadow_git_prefers_live_profile_over_stale_root(tmp_path):
    home = tmp_path / "u"
    root = home / ".painapple-code"
    project = tmp_path / "proj"
    project.mkdir()
    _make_repo(root, project, "stale root commit", 1_700_000_000)
    _make_repo(root / "profiles" / "vm", project, "live profile commit", 1_800_000_000)

    env = {k: v for k, v in os.environ.items() if k != "PAINAPPLE_CODE_HOME"}
    env.update(HOME=str(home), SHADOW_PROJECT=str(project))

    def run(**extra):
        return subprocess.run(["bash", str(TOOLS / "shadow-git"), "log", "--format=%s", "-1"],
                              capture_output=True, text=True, env={**env, **extra}, cwd=project)

    r = run()
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "live profile commit"
    assert "profiles/vm" in r.stderr  # says which one it chose

    # An explicit home (what the server exports into sessions) is authoritative.
    r = run(PAINAPPLE_CODE_HOME=str(root))
    assert r.stdout.strip() == "stale root commit"
    assert r.stderr == ""


@pytest.mark.skipif(not shutil.which("git") or not shutil.which("bash"),
                    reason="needs git + bash")
def test_shadow_git_projects_without_profiles(tmp_path):
    # The common fresh-install layout: a root home, no profiles/ at all.
    # candidate_homes() used to return the last failed `[[ -d ]]` status,
    # and under `set -e` the `homes="$(…)"` assignment killed the script —
    # `shadow-git projects` printed nothing and exited 1.
    home = tmp_path / "u"
    project = tmp_path / "proj"
    project.mkdir()
    _make_repo(home / ".painapple-code", project, "c", 1_700_000_000)
    env = {k: v for k, v in os.environ.items() if k != "PAINAPPLE_CODE_HOME"}
    env.update(HOME=str(home))
    r = subprocess.run(["bash", str(TOOLS / "shadow-git"), "projects"],
                       capture_output=True, text=True, env=env, cwd=project)
    assert r.returncode == 0, r.stderr
    assert _project_hash(str(project)) in r.stdout


@pytest.mark.skipif(not shutil.which("bash"), reason="needs bash")
def test_shadow_query_reads_exported_auth_config(tmp_path):
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text("api_token: tok-from-exported-config\n")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    # Stand-in curl: echo the URL it was given and the config read on stdin.
    (fake_bin / "curl").write_text(
        '#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in http*) echo "URL $a";; esac; done\n'
        'echo "CACERT $(printf "%s " "$@" | grep -o -- "--cacert [^ ]*")"\ncat\n')
    (fake_bin / "curl").chmod(0o755)
    env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}",
           "PAINAPPLE_URL": "https://127.0.0.1:9", "PAINAPPLE_AUTH_CONFIG": str(cfg),
           "PAINAPPLE_CACERT": str(cfg)}
    env.pop("PAINAPPLE_TOKEN", None)
    r = subprocess.run(["bash", str(TOOLS / "shadow-query"), "SELECT 1"],
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    assert "URL https://127.0.0.1:9/api/shadow-db/sql?format=tsv" in r.stdout
    assert "tok-from-exported-config" in r.stdout
    assert f"--cacert {cfg}" in r.stdout
