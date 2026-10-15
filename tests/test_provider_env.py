"""Provider environment overrides (Settings → Providers → Environment).

Covers the provider-side resolution (stored rows + disabled suggestions,
reserved names, layering onto a spawn env) and the GET/PUT endpoint.
"""

import os

import pytest

from tests.test_providers import _patch_config_store

RM_PROMPT = "CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT"


@pytest.fixture
def locked(monkeypatch):
    """Records lock_mode calls instead of chmod-ing a real config file."""
    from painapple_code import paths
    calls = []
    monkeypatch.setattr(paths, "lock_mode", lambda path, mode: calls.append(mode))
    return calls


@pytest.fixture
def store(monkeypatch, locked):
    data = {}
    _patch_config_store(monkeypatch, data)
    return data


def _claude():
    from painapple_code.providers import get_provider
    return get_provider("claude-sdk")


def test_suggestion_listed_disabled_and_not_applied(store):
    p = _claude()
    rows = {r["name"]: r for r in p.env_entries()}
    assert rows[RM_PROMPT]["enabled"] is False
    assert rows[RM_PROMPT]["suggested"] is True
    assert rows[RM_PROMPT]["value"] == "1"
    assert rows[RM_PROMPT]["desc"]
    assert p.env_overrides() == {}
    # No overrides → spawn env untouched (None stays "inherit")
    assert p.apply_env(None) is None
    base = {"A": "1"}
    assert p.apply_env(base) is base


def test_enabled_rows_layer_onto_spawn_env(store):
    p = _claude()
    store["provider_env"] = {"claude": [
        {"name": RM_PROMPT, "value": "1", "enabled": True},
        {"name": "FOO", "value": "bar", "enabled": False},
        # Reserved names are never applied even if they got stored
        {"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": "x", "enabled": True},
        {"name": "PAINAPPLE_URL", "value": "x", "enabled": True},
    ]}
    assert p.env_overrides() == {RM_PROMPT: "1"}
    env = p.apply_env({"CLAUDE_CODE_OAUTH_TOKEN": "tok"})
    assert env[RM_PROMPT] == "1"
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "tok"
    # None base → inherits the server env plus the override
    inherited = p.apply_env(None)
    assert inherited[RM_PROMPT] == "1"
    assert inherited.get("PATH") == os.environ.get("PATH")
    # A stored suggestion keeps its description and isn't listed twice
    rows = [r for r in p.env_entries() if r["name"] == RM_PROMPT]
    assert len(rows) == 1 and rows[0]["desc"]


def test_driver_pairs_share_namespace(store):
    from painapple_code.providers import get_provider
    assert _claude().env_key == "claude"
    codex = get_provider("codex-app-server")
    assert codex.env_key == "codex"
    store["provider_env"] = {"claude": [{"name": "FOO", "value": "1", "enabled": True}]}
    assert codex.env_overrides() == {}


def test_put_get_roundtrip(client, store, locked):
    r = client.put("/api/app/provider-env/claude-sdk", json={"entries": [
        {"name": RM_PROMPT, "value": "1", "enabled": True},
        {"name": "MY_VAR", "value": "a b=c", "enabled": False},
        {"name": "", "value": "ignored blank row", "enabled": True},
    ]})
    assert r.status_code == 200, r.text
    assert store["provider_env"]["claude"] == [
        {"name": RM_PROMPT, "value": "1", "enabled": True},
        {"name": "MY_VAR", "value": "a b=c", "enabled": False},
    ]
    assert locked == [0o600]
    data = client.get("/api/app/provider-env/claude-sdk").json()
    names = [e["name"] for e in data["entries"]]
    assert names == [RM_PROMPT, "MY_VAR"]
    assert "CLAUDE_CODE_OAUTH_TOKEN" in data["reserved"]

    # Clearing drops the key entirely; the suggestion reappears disabled
    r = client.put("/api/app/provider-env/claude-sdk", json={"entries": []})
    assert r.status_code == 200
    assert "provider_env" not in store
    rows = r.json()["entries"]
    assert [(e["name"], e["enabled"]) for e in rows] == [(RM_PROMPT, False)]


@pytest.mark.parametrize("entries", [
    "nope",
    [{"name": "1BAD", "value": "x"}],
    [{"name": "HAS SPACE", "value": "x"}],
    [{"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": "x"}],
    [{"name": "painapple_url", "value": "x"}],
    [{"name": "DUP", "value": "1"}, {"name": "DUP", "value": "2"}],
    [{"name": "NUL", "value": "a\x00b"}],
])
def test_put_rejects_bad_entries(client, store, entries):
    store["provider_env"] = {"claude": [{"name": "KEEP", "value": "1", "enabled": True}]}
    r = client.put("/api/app/provider-env/claude-sdk", json={"entries": entries})
    assert r.status_code == 400
    assert store["provider_env"] == {"claude": [{"name": "KEEP", "value": "1", "enabled": True}]}


def test_unknown_provider_404(client, store):
    assert client.get("/api/app/provider-env/nope").status_code == 404
