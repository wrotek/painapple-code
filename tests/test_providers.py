"""
Provider seam tests.

Locks the Claude provider's launch argv to exactly what the old inline builder
in `start_claude` produced (a behavioral guardrail for the multi-provider
refactor), and checks the registry + stub contract.
"""
import json

from painapple_code.providers import (
    ClaudeProvider,
    LaunchOptions,
    StderrClass,
    get_provider,
    provider_names,
)

# Static head every Claude launch starts with (binary resolves to 'claude' by
# default when no claude_path is configured).
_HEAD = [
    "claude", "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--thinking-display", "summarized",
]


def test_build_command_minimal():
    cmd = ClaudeProvider().build_command(LaunchOptions())
    # No model/effort/resume; permission falls back to dontAsk.
    assert cmd == _HEAD + ["--permission-mode", "dontAsk"]


def test_build_command_full_resume():
    cmd = ClaudeProvider().build_command(LaunchOptions(
        model="claude-opus-4-8",
        effort="max",
        permission_mode="plan",
        session_id="sess-123",
    ))
    assert cmd == _HEAD + [
        "--model", "claude-opus-4-8",
        "--effort", "max",
        "--permission-mode", "plan",
        "--resume", "sess-123",
    ]


def test_effort_high_is_skipped():
    """'high' is the CLI default — must not be emitted (avoids noise)."""
    cmd = ClaudeProvider().build_command(LaunchOptions(effort="high"))
    assert "--effort" not in cmd


def test_fork_takes_precedence_over_resume():
    cmd = ClaudeProvider().build_command(LaunchOptions(
        session_id="sess-123",
        fork_from_session_id="parent-456",
    ))
    # Fork wins; plain --resume of session_id is not added.
    assert cmd[-3:] == ["--resume", "parent-456", "--fork-session"]
    assert "sess-123" not in cmd


def test_frame_input_is_identity_for_claude():
    msg = {"type": "user", "message": {"role": "user", "content": "hi"}}
    assert ClaudeProvider().frame_input(msg) == msg


def test_parse_line_is_json_loads():
    raw = json.dumps({"type": "result", "total_cost_usd": 0.1})
    assert ClaudeProvider().parse_line(raw) == {"type": "result", "total_cost_usd": 0.1}


def test_classify_stderr():
    p = ClaudeProvider()
    assert p.classify_stderr("No conversation found with session ID abc") == StderrClass.STALE_SESSION
    assert p.classify_stderr("Compacting conversation") == StderrClass.COMPACTING
    assert p.classify_stderr('API Error: 529') == StderrClass.RETRYABLE
    assert p.classify_stderr("ordinary diagnostic line") == StderrClass.NONE


def test_registry_defaults_and_fallback():
    from painapple_code.providers import DEFAULT_PROVIDER
    assert DEFAULT_PROVIDER == "claude-sdk"
    assert get_provider().name == DEFAULT_PROVIDER          # default
    assert get_provider(None).name == DEFAULT_PROVIDER
    assert get_provider("nonexistent").name == DEFAULT_PROVIDER  # unknown → fallback
    for name in ("claude", "claude-sdk", "codex", "codex-app-server"):
        assert name in provider_names()
    # Default sorts first in the registry ordering.
    assert provider_names()[0] == DEFAULT_PROVIDER


# ── Engine picker surface (describe metadata + lock predicate) ──────────


def test_describe_carries_picker_metadata():
    """Every registered provider self-describes for the picker UI: display
    name, one-line description, capabilities, availability. (Brand `color`
    was dropped in 4a262439 — pickers are dot-free.)"""
    from painapple_code.providers import all_providers
    for p in all_providers():
        d = p.describe()
        for key in ("name", "display_name", "description",
                    "capabilities", "available", "models", "permission_modes"):
            assert key in d, f"{p.name} describe() missing {key}"
        assert d["description"], f"{p.name} has no picker description"


def test_describe_capability_matrix_for_picker_gating():
    """The client gates fork/Discuss, model chip and USD cost off describe()."""
    from painapple_code.providers import get_provider
    codex = get_provider("codex").describe()
    app_server = get_provider("codex-app-server").describe()
    claude_sdk = get_provider("claude-sdk").describe()
    assert codex["capabilities"]["fork"] is False          # Discuss/fork hidden
    assert app_server["capabilities"]["fork"] is True
    # Codex models come from the CLI's own cache — present on a box where
    # codex has run, absent otherwise; either way the shape must hold.
    assert isinstance(codex["models"], list)
    assert all(m.get("id") and m.get("label") for m in codex["models"])
    assert claude_sdk["models"], "default engine should list models"
    assert codex["capabilities"]["cumulative_cost"] is False  # USD hidden


def test_provider_is_locked_predicate():
    """Engine switchable only while the session is empty."""
    from painapple_code.routes.dependencies import provider_is_locked
    assert provider_is_locked({}) is False
    assert provider_is_locked({"message_count": 0, "provider_session_id": None}) is False
    assert provider_is_locked({"message_count": 3}) is True
    assert provider_is_locked({"provider_session_id": "uuid-123"}) is True
    assert provider_is_locked({"message_count": 0, "provider_session_id": "u"}) is True


# ── Picker visibility defaults + bind-time permission anchoring ─────────


def test_default_enabled_split():
    """Out of the box the picker offers one entry per engine: the SDK-grade
    drivers ship enabled, the plainer CLI variants defined-but-disabled."""
    from painapple_code.providers import get_provider
    assert get_provider("claude-sdk").default_enabled is True
    assert get_provider("codex-app-server").default_enabled is True
    assert get_provider("claude").default_enabled is False
    assert get_provider("codex").default_enabled is False
    # describe() carries it so Settings can show "what Reset returns to"
    assert get_provider("claude").describe()["default_enabled"] is False


def test_bind_permission_level_anchoring():
    """A permission level the new engine doesn't speak is re-anchored to the
    engine's own default at bind time; a shared/valid level survives."""
    from painapple_code.routes.dependencies import bind_permission_level
    from painapple_code.providers import get_provider
    codex = get_provider("codex-app-server")
    claude_sdk = get_provider("claude-sdk")
    # Claude vocab landing on Codex → Codex's own default
    assert bind_permission_level("dontAsk", codex) == "workspace-write"
    # Sandbox tier landing back on Claude → claude-sdk's default (Ask)
    assert bind_permission_level("workspace-write", claude_sdk) == "default"
    # Identity: engine already speaks it → nothing to change
    assert bind_permission_level("read-only", codex) is None
    assert bind_permission_level("bypassPermissions", claude_sdk) is None
    # No provider → no opinion
    assert bind_permission_level("anything", None) is None


# ── Codex model catalog (CLI cache) + bind-time model anchoring ──────────


def _write_codex_cache(home, models):
    home.mkdir(parents=True, exist_ok=True)
    (home / "models_cache.json").write_text(json.dumps({"models": models}))


def test_codex_models_from_cli_cache(tmp_path, monkeypatch):
    """models() surfaces $CODEX_HOME/models_cache.json: only 'list'-visible
    entries, priority-sorted, mapped to the app's {id,label,desc} shape."""
    from painapple_code.providers import get_provider
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    _write_codex_cache(tmp_path, [
        {"slug": "gpt-b", "display_name": "GPT B", "description": "second",
         "visibility": "list", "priority": 2},
        {"slug": "gpt-hidden", "display_name": "Hidden",
         "visibility": "hide", "priority": 0},
        {"slug": "gpt-a", "display_name": "GPT A", "description": "first",
         "visibility": "list", "priority": 1},
        {"display_name": "no-slug", "visibility": "list", "priority": 3},
    ])
    for name in ("codex", "codex-app-server"):
        models = get_provider(name).models()
        assert [m["id"] for m in models] == ["gpt-a", "gpt-b"], name
        assert models[0] == {"id": "gpt-a", "label": "GPT A", "desc": "first",
                             "efforts": []}


def test_codex_models_empty_without_cache(tmp_path, monkeypatch):
    """codex installed but never run (no cache) → empty catalog, no crash;
    same for a malformed cache file."""
    from painapple_code.providers import get_provider
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "missing"))
    assert get_provider("codex").models() == []
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / "models_cache.json").write_text("{not json")
    assert get_provider("codex").models() == []


def _write_codex_efforts_cache(home):
    """Two listed models with different reasoning ranges + one hidden model
    whose exotic level must NOT leak into the engine vocabulary."""
    _write_codex_cache(home, [
        {"slug": "m-new", "display_name": "New", "visibility": "list",
         "priority": 1, "supported_reasoning_levels": [
             {"effort": e} for e in ["low", "medium", "high", "xhigh", "max"]]},
        {"slug": "m-old", "display_name": "Old", "visibility": "list",
         "priority": 2, "supported_reasoning_levels": [
             {"effort": e} for e in ["low", "medium", "high", "xhigh"]]},
        {"slug": "m-hidden", "visibility": "hide", "priority": 3,
         "supported_reasoning_levels": [{"effort": "ultra"}]},
    ])


def test_codex_effort_levels_from_models_cache(tmp_path, monkeypatch):
    """effort_levels() is the ordered union of the listed models' own
    supported_reasoning_levels; effort_for_model() clamps a requested level
    to the TARGET model's range (unknown/default model → the intersection
    every listed model speaks; no cache → the classic triad)."""
    from painapple_code.providers import get_provider
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = get_provider("codex")

    # No cache → classic triad + conservative clamp (legacy behavior).
    assert p.effort_levels() == ["low", "medium", "high"]
    assert p.effort_for_model("max", None) == "high"
    assert p.effort_for_model("high", "whatever") == "high"

    _write_codex_efforts_cache(tmp_path)
    for name in ("codex", "codex-app-server"):
        prov = get_provider(name)
        assert prov.effort_levels() == ["low", "medium", "high", "xhigh", "max"], name
        # models() carries each model's own range for per-model UI gating
        assert [m["efforts"] for m in prov.models()] == [
            ["low", "medium", "high", "xhigh", "max"],
            ["low", "medium", "high", "xhigh"],
        ], name

    # In-range passes through; above-range clamps down per model.
    assert p.effort_for_model("max", "m-new") == "max"
    assert p.effort_for_model("max", "m-old") == "xhigh"
    assert p.effort_for_model("ultra", "m-new") == "max"
    # Unknown/default model → intersection across the listed catalog.
    assert p.effort_for_model("max", None) == "xhigh"
    assert p.effort_for_model("max", "no-such-model") == "xhigh"
    assert p.effort_for_model("medium", None) == "medium"
    # Below-range clamps up; garbage/absent → None (codex default).
    assert p.effort_for_model("minimal", "m-new") == "low"
    assert p.effort_for_model("turbo", "m-new") is None
    assert p.effort_for_model(None, "m-new") is None


def test_codex_launch_effort_clamped_per_model(tmp_path, monkeypatch):
    """Both codex drivers wire effort through effort_for_model: the exec argv
    and the app-server turn params carry the clamped value for the model that
    will actually run (forwarded pick, else the conservative default range)."""
    from painapple_code.providers import get_provider
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    _write_codex_efforts_cache(tmp_path)

    exec_p = get_provider("codex")
    cmd = exec_p.build_command(LaunchOptions(model="m-old", effort="max", prompt="hi"))
    assert "-m" in cmd and "m-old" in cmd
    assert "model_reasoning_effort=xhigh" in " ".join(cmd)
    # No forwarded model → intersection range governs.
    cmd = exec_p.build_command(LaunchOptions(effort="max", prompt="hi"))
    assert "-m" not in cmd
    assert "model_reasoning_effort=xhigh" in " ".join(cmd)
    cmd = exec_p.build_command(LaunchOptions(model="m-new", effort="ultra", prompt="hi"))
    assert "model_reasoning_effort=max" in " ".join(cmd)

    app_p = get_provider("codex-app-server")
    params = app_p.turn_start_params(
        LaunchOptions(model="m-new", effort="ultra"), "t1", [])
    assert params["effort"] == "max" and params["model"] == "m-new"
    params = app_p.turn_start_params(LaunchOptions(effort="max"), "t1", [])
    assert params["effort"] == "xhigh" and "model" not in params


def test_describe_settings_surface():
    """The Settings engines tab renders per-engine cards off describe():
    which engines have an app-owned (editable) catalog, which have a
    configurable CLI path, and the bare command the path falls back to."""
    from painapple_code.providers import get_provider
    for name in ("claude", "claude-sdk"):
        d = get_provider(name).describe()
        assert d["models_editable"] is True, name       # models.yaml editor
        assert d["path_configurable"] is True, name
        assert d["default_binary"] == "claude", name
    for name in ("codex", "codex-app-server"):
        d = get_provider(name).describe()
        assert d["models_editable"] is False, name      # CLI-owned catalog
        assert d["path_configurable"] is True, name
        assert d["default_binary"] == "codex", name
    # Same-engine driver variants share one config key (edit the engine,
    # not the driver).
    assert get_provider("claude").path_config_key == get_provider("claude-sdk").path_config_key
    assert get_provider("codex").path_config_key == get_provider("codex-app-server").path_config_key


# ── Generic engine-path endpoint (provider self-describes the key) ──────


def _patch_config_store(monkeypatch, store):
    """Point bridge_paths' global-config load/save at an in-memory dict."""
    from painapple_code import bridge_paths
    monkeypatch.setattr(bridge_paths, "load_global_config", lambda: dict(store))
    def _save(cfg):
        store.clear()
        store.update(cfg)
    monkeypatch.setattr(bridge_paths, "save_global_config", _save)


def test_engine_path_get(client, monkeypatch):
    store = {"codex_path": "/opt/somewhere/codex"}
    _patch_config_store(monkeypatch, store)
    r = client.get("/api/app/engine-path/codex-app-server")
    assert r.status_code == 200
    data = r.json()
    assert data["configurable"] is True
    assert data["path"] == "/opt/somewhere/codex"       # raw config value
    assert data["default_binary"] == "codex"
    # Unset key → path None (UI shows the default_binary placeholder)
    store.clear()
    data = client.get("/api/app/engine-path/claude-sdk").json()
    assert data["path"] is None
    assert data["default_binary"] == "claude"


def test_engine_path_get_unknown_provider(client):
    assert client.get("/api/app/engine-path/nonexistent").status_code == 404


def test_engine_path_put_roundtrip(client, monkeypatch, tmp_path):
    store = {}
    _patch_config_store(monkeypatch, store)
    fake = tmp_path / "codex"
    fake.write_text("#!/bin/sh\n")

    # Explicit path → stored under the provider's own key
    r = client.put("/api/app/engine-path/codex", json={"path": str(fake)})
    assert r.status_code == 200
    assert store["codex_path"] == str(fake)
    assert r.json()["path"] == str(fake)

    # Nonexistent path → 400, config untouched
    r = client.put("/api/app/engine-path/codex", json={"path": str(tmp_path / "nope")})
    assert r.status_code == 400
    assert store["codex_path"] == str(fake)

    # null (and the bare default binary name) clear the override — always
    # allowed, even if the CLI isn't installed (stale overrides removable)
    r = client.put("/api/app/engine-path/codex", json={"path": None})
    assert r.status_code == 200
    assert "codex_path" not in store
    assert r.json()["path"] is None


def test_engine_path_not_configurable():
    """A provider without a path_config_key reports non-configurable."""
    import asyncio
    from painapple_code.routes.api_app_config import _engine_path_payload

    class _NoPath:
        name = "stub"
        display_name = "Stub"
        path_config_key = None

    payload = asyncio.run(_engine_path_payload(_NoPath()))
    assert payload == {"provider": "stub", "configurable": False}


def test_preferred_model_anchoring_on_engine_switch(tmp_path, monkeypatch):
    """A preferred_model from the old engine's catalog is cleared when the
    session binds to an engine whose catalog doesn't offer it; in-catalog
    picks (and dated variants of them) survive; an engine with no catalog
    keeps whatever is stored (its launch path decides what to forward)."""
    from painapple_code.providers import get_provider
    from painapple_code.routes.dependencies import preferred_model_survives
    _patch_config_store(monkeypatch, {})   # no models_disabled overlay
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    _write_codex_cache(tmp_path, [
        {"slug": "gpt-x", "display_name": "GPT X", "visibility": "list", "priority": 1},
    ])
    codex = get_provider("codex-app-server")
    claude_sdk = get_provider("claude-sdk")
    claude_id = claude_sdk.models()[0]["id"]

    assert preferred_model_survives(claude_id, codex) is False      # cleared
    assert preferred_model_survives("gpt-x", codex) is True
    assert preferred_model_survives("gpt-x", claude_sdk) is False   # cleared
    assert preferred_model_survives(claude_id, claude_sdk) is True
    assert preferred_model_survives(claude_id + "-20260101", claude_sdk) is True
    assert preferred_model_survives(None, codex) is True            # nothing stored
    assert preferred_model_survives("anything", None) is True       # no engine

    # Engine with an empty catalog → stored value kept
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "empty"))
    assert preferred_model_survives(claude_id, codex) is True


# ── Per-model visibility (models_disabled overlay, shared models_key) ───


def test_models_key_shared_across_driver_pairs():
    """Hiding a model must hide it on BOTH drivers of an engine — the
    visibility namespace follows the catalog, not the driver."""
    from painapple_code.providers import get_provider
    assert get_provider("claude").models_key == "claude"
    assert get_provider("claude-sdk").models_key == "claude"
    assert get_provider("codex").models_key == "codex"
    assert get_provider("codex-app-server").models_key == "codex"
    for p in (get_provider("claude"), get_provider("codex")):
        assert p.describe()["models_key"] == p.models_key


def test_enabled_models_filters_hidden_ids(tmp_path, monkeypatch):
    """enabled_models() = models() minus the models_disabled set for the
    provider's namespace. describe()'s `models` (what pickers see) serves
    the filtered list, while models() keeps the full definitions."""
    from painapple_code.providers import get_provider
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    _write_codex_cache(tmp_path, [
        {"slug": "gpt-a", "display_name": "A", "visibility": "list", "priority": 1},
        {"slug": "gpt-b", "display_name": "B", "visibility": "list", "priority": 2},
    ])
    store = {"models_disabled": {"codex": ["gpt-a"]}}
    _patch_config_store(monkeypatch, store)
    for name in ("codex", "codex-app-server"):
        p = get_provider(name)
        assert [m["id"] for m in p.models()] == ["gpt-a", "gpt-b"], name
        assert [m["id"] for m in p.enabled_models()] == ["gpt-b"], name
        assert [m["id"] for m in p.describe()["models"]] == ["gpt-b"], name
    # No overlay → offering == definitions
    store.clear()
    p = get_provider("codex")
    assert p.enabled_models() == p.models()


def test_engine_models_get(client, monkeypatch, tmp_path):
    """Settings GET returns the FULL catalog with per-model enabled flags
    (hidden models still render, toggle off) + the raw stored set — stale
    ids (catalog churned underneath) are preserved, not pruned."""
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    _write_codex_cache(tmp_path, [
        {"slug": "gpt-a", "display_name": "A", "visibility": "list", "priority": 1},
        {"slug": "gpt-b", "display_name": "B", "visibility": "list", "priority": 2},
    ])
    _patch_config_store(
        monkeypatch, {"models_disabled": {"codex": ["gpt-b", "gpt-stale"]}})
    r = client.get("/api/app/engine-models/codex-app-server")
    assert r.status_code == 200
    data = r.json()
    assert data["provider"] == "codex-app-server"
    assert data["models_key"] == "codex"
    assert data["editable"] is False
    assert [(m["id"], m["enabled"]) for m in data["models"]] == [
        ("gpt-a", True), ("gpt-b", False)]
    assert data["disabled"] == ["gpt-b", "gpt-stale"]
    assert client.get("/api/app/engine-models/nonexistent").status_code == 404


def test_engine_models_put_roundtrip(client, monkeypatch):
    """PUT replaces the hidden set under the shared models_key (the twin
    driver reads the same curation); empty list clears the key; malformed
    bodies → 400 with config untouched."""
    from painapple_code.providers import get_provider
    store = {}
    _patch_config_store(monkeypatch, store)
    hide = get_provider("claude-sdk").models()[0]["id"]

    r = client.put("/api/app/engine-models/claude-sdk", json={"disabled": [hide]})
    assert r.status_code == 200
    assert store["models_disabled"] == {"claude": [hide]}
    flags = {m["id"]: m["enabled"] for m in r.json()["models"]}
    assert flags[hide] is False
    twin = client.get("/api/app/engine-models/claude").json()
    assert twin["disabled"] == [hide]

    for bad in ("gpt", [1], None):
        r = client.put("/api/app/engine-models/claude-sdk", json={"disabled": bad})
        assert r.status_code == 400, bad
    assert store["models_disabled"] == {"claude": [hide]}

    r = client.put("/api/app/engine-models/claude-sdk", json={"disabled": []})
    assert r.status_code == 200
    assert "models_disabled" not in store


def test_hidden_model_does_not_survive_as_preferred(monkeypatch):
    """preferred_model_survives checks membership against the ENABLED
    catalog: a hidden model isn't offered, so it can't stay the default
    (chip would say "Default" while launch passed the hidden id). The
    all-hidden case clears too — raw catalog non-empty means the app DOES
    know this engine's vocabulary, unlike the empty-catalog escape."""
    from painapple_code.providers import get_provider
    from painapple_code.routes.dependencies import preferred_model_survives
    claude_sdk = get_provider("claude-sdk")
    ids = [m["id"] for m in claude_sdk.models()]
    store = {}
    _patch_config_store(monkeypatch, store)

    assert preferred_model_survives(ids[0], claude_sdk) is True
    store["models_disabled"] = {"claude": [ids[0]]}
    assert preferred_model_survives(ids[0], claude_sdk) is False   # hidden
    assert preferred_model_survives(ids[1], claude_sdk) is True    # still listed
    store["models_disabled"] = {"claude": list(ids)}
    assert preferred_model_survives(ids[1], claude_sdk) is False   # offer nothing


# ── Generic engine-auth endpoint (provider self-describes the probe) ─────


def test_parse_auth_status_providers():
    """Pure parse contracts: claude reads its --json status; codex relies on
    the exit code and blanks the redundant logged-out line; non-JSON output
    falls back to the base parser (exit code + first line, either stream)."""
    claude = get_provider("claude-sdk")
    ok = claude.parse_auth_status(
        0, '{"loggedIn": true, "email": "a@b.c", "subscriptionType": "max"}', "")
    assert ok == {"logged_in": True, "detail": "a@b.c · max"}
    assert claude.parse_auth_status(0, '{"loggedIn": false}', "") == {
        "logged_in": False, "detail": ""}
    assert claude.parse_auth_status(1, "boom", "") == {
        "logged_in": False, "detail": "boom"}
    # stderr-only status text still yields a detail line (base parser)
    assert claude.parse_auth_status(0, "not json", "")["logged_in"] is True

    codex = get_provider("codex-app-server")
    assert codex.parse_auth_status(0, "", "Logged in using ChatGPT") == {
        "logged_in": True, "detail": "Logged in using ChatGPT"}
    assert codex.parse_auth_status(1, "", "Not logged in") == {
        "logged_in": False, "detail": ""}


def test_engine_auth_endpoint(client, monkeypatch, tmp_path):
    """The endpoint runs the provider's own status probe against the
    CONFIGURED binary and returns the parsed verdict plus the terminal
    login command (also built from the configured binary)."""
    fake = tmp_path / "claude"
    fake.write_text(
        "#!/bin/sh\n"
        "echo '{\"loggedIn\": true, \"email\": \"x@y.z\", \"subscriptionType\": \"pro\"}'\n")
    fake.chmod(0o755)
    _patch_config_store(monkeypatch, {"claude_path": str(fake)})

    r = client.get("/api/app/engine-auth/claude-sdk")
    assert r.status_code == 200
    data = r.json()
    assert data["supported"] is True
    assert data["logged_in"] is True
    assert data["detail"] == "x@y.z · pro"
    assert data["login_command"] == f"{fake} auth login"

    # Logged-out probe: codex-style exit 1 with the line on stderr
    fake_codex = tmp_path / "codex"
    fake_codex.write_text("#!/bin/sh\necho 'Not logged in' >&2\nexit 1\n")
    fake_codex.chmod(0o755)
    _patch_config_store(monkeypatch, {"codex_path": str(fake_codex)})
    data = client.get("/api/app/engine-auth/codex-app-server").json()
    assert data["logged_in"] is False
    assert data["detail"] == ""
    assert data["login_command"] == f"{fake_codex} login --device-auth"

    # Broken binary → probe can't run → logged_in null, login still offered
    _patch_config_store(monkeypatch, {"claude_path": "/nope/claude"})
    data = client.get("/api/app/engine-auth/claude").json()
    assert data["supported"] is True
    assert data["logged_in"] is None
    assert data["login_command"] == "/nope/claude auth login"

    assert client.get("/api/app/engine-auth/nonexistent").status_code == 404


def test_engine_auth_unsupported(client, monkeypatch):
    """A provider describing no auth probe reports supported: false — the
    Settings panel removes the login row instead of guessing."""
    p = get_provider("claude-sdk")
    monkeypatch.setattr(p, "auth_status_args", None)
    data = client.get("/api/app/engine-auth/claude-sdk").json()
    assert data == {"provider": "claude-sdk", "supported": False}


# ── Per-engine session defaults + auto-journal model ─────────────────────


def test_engine_defaults_resolution(monkeypatch, tmp_path):
    """Scoped map beats legacy flat key; legacy is vocab/accounts-gated per
    engine; the provider-aware resolve_profile threads through."""
    from painapple_code import bridge_paths
    from painapple_code.utils.token_profiles import resolve_profile
    # Pin codex to its no-cache vocabulary (low/medium/high) so the legacy
    # 'max' gate below is hermetic — with a real models cache present, the
    # 5.6 family legitimately speaks max and the gate would (correctly) pass
    # the value through.
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    claude = get_provider("claude-sdk")
    codex = get_provider("codex-app-server")
    claude_models = [m["id"] for m in claude.enabled_models()]
    claude_top, claude_other = claude_models[0], claude_models[-1]
    store = {
        "default_model": claude_other,
        "default_effort": "max",
        "default_efforts": {"codex": "medium"},
    }
    _patch_config_store(monkeypatch, store)

    # Legacy flat default, in Claude's catalog → honored (not overridden).
    assert bridge_paths.engine_default_model(claude) == claude_other
    # Codex has NO catalog here (CODEX_HOME=tmp_path, no cache) → the value is
    # trusted raw; the launch path lets the CLI decide.
    assert bridge_paths.engine_default_model(codex) == claude_other
    # A configured default the engine can't serve → its top catalog model.
    store["default_model"] = "totally-unknown"
    assert bridge_paths.engine_default_model(claude) == claude_top
    assert bridge_paths.engine_default_effort(claude) == "max"         # in claude vocab
    assert bridge_paths.engine_default_effort(codex) == "medium"       # scoped beats legacy

    store["default_efforts"] = {}
    assert bridge_paths.engine_default_effort(codex) is None           # legacy max ∉ codex vocab

    assert bridge_paths.engine_default_token_profile(codex) is None    # no accounts
    store["default_token_profiles"] = {"claude": "prof1"}
    assert resolve_profile(None, claude) == "prof1"
    assert resolve_profile("explicit", claude) == "explicit"           # session wins
    assert resolve_profile(None, codex) is None


def test_engine_default_model_top_catalog_fallback(tmp_path, monkeypatch):
    """With nothing configured, engine_default_model falls back to the
    engine's top (priority-first) enabled model — so the app always presents
    a concrete default (never the ambiguous 'Default'). An engine with NO
    catalog (Codex, no models cache) resolves to None and the launch path lets
    the CLI use its own configured model."""
    from painapple_code import bridge_paths
    from painapple_code.providers import get_provider
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    _patch_config_store(monkeypatch, {})

    codex = get_provider("codex-app-server")
    assert bridge_paths.engine_default_model(codex) is None            # no cache → CLI decides
    _write_codex_cache(tmp_path, [
        {"slug": "gpt-top", "display_name": "Top", "visibility": "list", "priority": 1},
        {"slug": "gpt-2", "display_name": "Two", "visibility": "list", "priority": 2},
    ])
    assert bridge_paths.engine_default_model(codex) == "gpt-top"       # priority-first
    assert bridge_paths.engine_default_model(get_provider("codex")) == "gpt-top"  # twin

    # Claude always had an in-catalog default (models.yaml) — still concrete.
    claude = get_provider("claude-sdk")
    claude_ids = [m["id"] for m in claude.enabled_models()]
    assert bridge_paths.engine_default_model(claude) == claude_ids[0]

    # A hidden top model steps the fallback to the next visible one.
    _patch_config_store(monkeypatch, {"models_disabled": {"codex": ["gpt-top"]}})
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    assert bridge_paths.engine_default_model(codex) == "gpt-2"


def test_engine_defaults_get(client, monkeypatch):
    store = {
        "default_model": "claude-fable-5",
        "default_effort": "max",
        "default_efforts": {"codex": "medium"},
    }
    _patch_config_store(monkeypatch, store)

    data = client.get("/api/app/engine-defaults/claude-sdk").json()
    assert data["models_key"] == "claude"
    assert data["default_model"] == "claude-fable-5"
    assert data["default_effort"] == "max"
    assert data["efforts"] == ["low", "medium", "high", "xhigh", "max"]
    assert data["summary_supported"] is True
    assert data["summary_model"]                       # models.yaml value

    data = client.get("/api/app/engine-defaults/codex-app-server").json()
    assert data["default_effort"] == "medium"
    assert data["accounts"] == []
    assert data["token_profile"] is None
    assert data["summary_placeholder"] == "session model"

    assert client.get("/api/app/engine-defaults/nonexistent").status_code == 404


def test_engine_defaults_put_scoped_with_migration(client, monkeypatch, tmp_path):
    """First PUT folds legacy flat keys into per-engine map entries (only
    where the engine speaks the value) and drops them — so per-engine
    clears actually stick instead of resurrecting the flat key."""
    # Pin codex to the no-cache vocabulary (low/medium/high) so the
    # "max ∉ codex vocab" seeding gate and 400 below are hermetic — a real
    # models cache would legitimately let the 5.6 family speak max.
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    ids = [m["id"] for m in get_provider("claude-sdk").models()]
    store = {"default_model": ids[0], "default_effort": "max"}
    _patch_config_store(monkeypatch, store)

    r = client.put("/api/app/engine-defaults/codex-app-server",
                   json={"default_effort": "medium"})
    assert r.status_code == 200
    # Legacy max seeds claude (in vocab) but NOT codex (caps at high);
    # codex gets the explicit new value; the flat key is gone.
    assert store["default_efforts"] == {"claude": "max", "codex": "medium"}
    assert "default_effort" not in store
    assert store["default_model"] == ids[0]            # untouched — different field

    # Vocab validation: max is not a codex level
    r = client.put("/api/app/engine-defaults/codex-app-server",
                   json={"default_effort": "max"})
    assert r.status_code == 400

    # Model migration: claude id seeds only the claude namespace (codex
    # catalog is empty without a models cache → can't speak it)
    r = client.put("/api/app/engine-defaults/claude-sdk",
                   json={"default_model": ids[-1]})
    assert r.status_code == 200
    assert store["default_models"] == {"claude": ids[-1]}
    assert "default_model" not in store

    # Clearing sticks (no flat key left to resurrect the old value)
    r = client.put("/api/app/engine-defaults/claude-sdk",
                   json={"default_model": None})
    assert r.status_code == 200
    assert "default_models" not in store                 # entry cleared
    # Cleared, but an engine with a catalog never resolves to null — it falls
    # back to its top (priority-first) model, so the picker always has one.
    assert r.json()["default_model"] == ids[0]

    # Token profile guards: engine without accounts 400s; unknown profile 400s
    assert client.put("/api/app/engine-defaults/codex-app-server",
                      json={"token_profile": "x"}).status_code == 400
    assert client.put("/api/app/engine-defaults/claude-sdk",
                      json={"token_profile": "definitely-missing"}).status_code == 400


def test_engine_defaults_journal_model(client, monkeypatch):
    """The journal knob writes each engine's own store: codex → the shared
    `codex_summary_model` config key (clear = inherit the session model),
    claude → models.yaml summary_model (clear = reset to shipped default)."""
    from painapple_code import bridge_paths
    store = {}
    _patch_config_store(monkeypatch, store)

    r = client.put("/api/app/engine-defaults/codex-app-server",
                   json={"summary_model": "gpt-5.4-mini"})
    assert r.status_code == 200
    assert store["codex_summary_model"] == "gpt-5.4-mini"
    assert r.json()["summary_model"] == "gpt-5.4-mini"
    # Twin driver reads the same override
    assert get_provider("codex").get_summary_model_override() == "gpt-5.4-mini"

    r = client.put("/api/app/engine-defaults/codex-app-server",
                   json={"summary_model": ""})
    assert "codex_summary_model" not in store
    assert r.json()["summary_model"] is None

    # Claude writes models.yaml through the same seam — capture the save
    saved = {}
    monkeypatch.setattr(bridge_paths, "save_models_config",
                        lambda cfg: saved.update(cfg))
    monkeypatch.setattr(bridge_paths, "get_selectable_models",
                        lambda: [{"id": "m1", "label": "M1", "desc": ""}])
    r = client.put("/api/app/engine-defaults/claude-sdk",
                   json={"summary_model": "claude-haiku-9"})
    assert r.status_code == 200
    assert saved == {"selectable": [{"id": "m1", "label": "M1", "desc": ""}],
                     "summary_model": "claude-haiku-9"}


def test_legacy_default_endpoints_wrap_default_engine(client, monkeypatch):
    """The old flat endpoints keep working as views over the DEFAULT
    engine's per-engine entry (old scripts / popup fallbacks)."""
    ids = [m["id"] for m in get_provider("claude-sdk").models()]
    store = {}
    _patch_config_store(monkeypatch, store)

    r = client.put("/api/app/default-model", json={"default_model": ids[0]})
    assert r.status_code == 200
    assert store["default_models"] == {"claude": ids[0]}   # default engine = claude-sdk
    assert client.get("/api/app/default-model").json()["default_model"] == ids[0]

    r = client.put("/api/app/default-effort", json={"default_effort": "max"})
    assert r.status_code == 200
    assert store["default_efforts"] == {"claude": "max"}
    data = client.get("/api/app/default-effort").json()
    assert data["default_effort"] == "max"
    assert data["valid_levels"] == ["low", "medium", "high", "xhigh", "max"]


def test_cli_resume_template_per_engine():
    """The 'Continue in CLI' quick action is engine-driven: each provider
    self-describes its resume command template (no hardcoded verb client-side).
    Both Codex drivers share the codex template (app-server inherits the mixin)."""
    assert get_provider("claude-sdk").describe()["cli_resume_template"] == "claude -r {id}"
    assert get_provider("claude").describe()["cli_resume_template"] == "claude -r {id}"
    assert get_provider("codex").describe()["cli_resume_template"] == "codex exec resume {id}"
    assert get_provider("codex-app-server").describe()["cli_resume_template"] == "codex exec resume {id}"


def test_set_session_effort_validates_against_engine_vocab(tmp_path, monkeypatch):
    """PUT /api/session/{id}/effort validates against the SESSION ENGINE's own
    effort vocabulary, not a hardcoded Claude set: a Codex session accepts a
    level (ultra) outside the Claude 5-level fallback, a Claude session rejects
    that same level, and an unknown level is rejected everywhere."""
    import asyncio
    import pytest
    from fastapi import HTTPException
    from painapple_code.routes import api_sessions

    # Codex cache listing a model that speaks 'ultra' → engine vocab includes it.
    _write_codex_cache(tmp_path, [
        {"slug": "m-ultra", "display_name": "Ultra", "visibility": "list",
         "priority": 1, "supported_reasoning_levels": [
             {"effort": e} for e in ["low", "medium", "high", "xhigh", "max", "ultra"]]},
    ])
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setenv("PAINAPPLE_CODE_HOME", str(tmp_path / "data"))

    class _FakeStore:
        meta = {"provider": "codex-app-server"}

        @classmethod
        def load_meta(cls, sid):
            return dict(cls.meta)

        @classmethod
        def update_metadata(cls, sid, **kw):
            cls.meta.update(kw)

    monkeypatch.setattr(api_sessions, "SessionStore", _FakeStore)
    monkeypatch.setattr("painapple_code.server.bridge", None, raising=False)

    class _Req:
        def __init__(self, body):
            self._body = body

        async def json(self):
            return self._body

    # Codex session: 'ultra' is in its vocab now → accepted (old hardcoded
    # {low,medium,high,xhigh,max} set would have raised 400 here — the bug).
    res = asyncio.run(api_sessions.set_session_effort(
        "sid", _Req({"effort_level": "ultra"})))
    assert res["effort_level"] == "ultra"

    # A level no engine speaks → still rejected.
    with pytest.raises(HTTPException) as ei:
        asyncio.run(api_sessions.set_session_effort(
            "sid", _Req({"effort_level": "turbo"})))
    assert ei.value.status_code == 400 and "turbo" in ei.value.detail

    # Per-engine gating: a Claude session rejects 'ultra' (not in its 5-level
    # vocabulary) — the validator is scoped to the session's own engine.
    _FakeStore.meta = {"provider": "claude-sdk"}
    with pytest.raises(HTTPException) as ei2:
        asyncio.run(api_sessions.set_session_effort(
            "sid", _Req({"effort_level": "ultra"})))
    assert ei2.value.status_code == 400


def test_codex_app_server_interrupt_carries_turn_id(monkeypatch):
    """codex ≥0.144 requires `turnId` on turn/interrupt (-32600 "missing field
    `turnId`" without it — the stop button silently did nothing). The transport
    tracks the active turn from the turn/started notification and includes it;
    the id drops once the turn settles (failed turns also arrive as
    turn/completed with status="failed")."""
    import asyncio
    from painapple_code.providers.codex_app_server.transport import JsonRpcTransport

    tr = JsonRpcTransport(process=None, opts=None, session=None, provider=None)
    tr._thread_id = "thr-1"

    # turn/started → active turn tracked; intake still passes it to translate.
    assert tr.intake({"method": "turn/started",
                      "params": {"turn": {"id": "turn-9"}}}) is True
    assert tr._active_turn_id == "turn-9"

    sent = []

    async def fake_request(method, params, timeout=None):
        sent.append((method, params))

    monkeypatch.setattr(tr, "_request", fake_request)
    asyncio.run(tr.interrupt())
    assert sent == [("turn/interrupt", {"threadId": "thr-1", "turnId": "turn-9"})]

    # Turn settles → id dropped; a later interrupt degrades to threadId-only
    # (nothing in flight — the pre-0.144 shape, and the server just errors it).
    assert tr.intake({"method": "turn/completed",
                      "params": {"turn": {"id": "turn-9"}}}) is True
    assert tr._active_turn_id is None
    asyncio.run(tr.interrupt())
    assert sent[-1] == ("turn/interrupt", {"threadId": "thr-1"})


def test_codex_app_server_turn_opts_into_reasoning_summaries():
    """turn/start carries summary="auto" — WITHOUT it the app-server emits
    reasoning items with empty summary/content arrays (thinking blocks would
    render blank; observed on both 0.137 and 0.144)."""
    p = get_provider("codex-app-server")
    params = p.turn_start_params(
        LaunchOptions(), "thr-1", [{"type": "text", "text": "hi"}])
    assert params["summary"] == "auto"
    assert params["threadId"] == "thr-1"
    assert params["input"] == [{"type": "text", "text": "hi"}]


def test_codex_app_server_empty_reasoning_items_skipped():
    """A reasoning item with no summary/content text yields NO message — an
    empty collapsed Thinking bubble is pure noise. Populated summaries still
    translate to a canonical thinking block."""
    p = get_provider("codex-app-server")
    empty = {"method": "item/completed",
             "params": {"item": {"type": "reasoning", "id": "r1",
                                 "summary": [], "content": []}}}
    assert p.translate_events(empty, {}) == []

    full = {"method": "item/completed",
            "params": {"item": {"type": "reasoning", "id": "r2",
                                "summary": [{"text": "planning the fix"}]}}}
    msgs = p.translate_events(full, {})
    assert len(msgs) == 1
    blk = msgs[0]["message"]["content"][0]
    assert blk["type"] == "thinking"
    assert blk["thinking"] == "planning the fix"
