"""
Codex provider tests (`codex-app-server`).

The exec driver (`codex exec --json`, prompt in argv — the `ps`-leak engine)
was removed; `codex-app-server` is the only registered Codex driver. Covers
registry/alias behavior, the JSON-RPC event translation, the shared error
classification inherited from `providers/codex/`, and the native summary-fork
schema handling. No live `codex` binary is required.
"""
import json

import pytest

from painapple_code.providers import get_provider, CodexAppServerProvider, LaunchOptions
from painapple_code.providers.base import StderrClass


def _fresh_state():
    return {"model": "gpt-5.4"}


def _app_server():
    return CodexAppServerProvider()


# --- registry ---------------------------------------------------------------

def test_codex_app_server_is_registered_and_jsonrpc():
    a = get_provider("codex-app-server")
    assert isinstance(a, CodexAppServerProvider)
    caps = a.capabilities
    assert caps.transport == "jsonrpc"
    assert caps.persistent_process is True      # one app-server, many turns
    assert caps.fork is True                    # native thread/fork
    assert caps.cumulative_cost is False
    assert caps.forward_plain_stderr is False
    assert caps.rich_commit_summaries is True
    # The transport factory returns a driver with the duck-typed contract.
    t = a.make_transport(process=None, opts=LaunchOptions(), session=None)
    for hook in ("initialize", "intake", "send_turn", "interrupt"):
        assert callable(getattr(t, hook))


def test_codex_exec_is_gone_and_aliases_to_app_server():
    # The exec driver was removed from the registry — sessions persisted with
    # provider="codex" must land on codex-app-server (same $CODEX_HOME rollout
    # store, same thread ids), NOT fall through to the Claude default.
    from painapple_code.providers import provider_names
    assert "codex" not in provider_names()
    assert get_provider("codex").name == "codex-app-server"


def test_plain_claude_is_gone_and_aliases_to_sdk():
    # Same removal for the line-protocol claude driver; claude-sdk is
    # wire-identical, so legacy sessions resume under it unchanged.
    from painapple_code.providers import provider_names
    assert "claude" not in provider_names()
    assert get_provider("claude").name == "claude-sdk"


def test_no_registered_engine_puts_prompts_in_argv():
    # The reason the exec driver was removed. The `prompt_in_argv` seam stays
    # (a drop-in engine may declare it and get the Settings warning), but no
    # shipped engine may carry it.
    from painapple_code.providers import all_providers
    leaky = [p.name for p in all_providers() if p.capabilities.prompt_in_argv]
    assert leaky == []


# --- JSON-RPC param shaping -------------------------------------------------

def test_claude_model_id_is_dropped_not_forwarded():
    # A codex session inherits the box default model (a Claude id) — it must
    # never reach the app-server, which would reject it; codex falls back to
    # its own configured default.
    p = _app_server()
    params = p.turn_start_params(LaunchOptions(model="claude-opus-4-8"), "T1", [])
    assert "model" not in params
    params = p.turn_start_params(LaunchOptions(model="gpt-5.4"), "T1", [])
    assert params["model"] == "gpt-5.4"


def test_thread_start_maps_permissions_to_sandbox():
    p = _app_server()
    start = p.thread_start_params(LaunchOptions(permission_mode="read-only"), "/w")
    assert start["sandbox"] == "read-only"
    assert start["approvalPolicy"] == "never"
    # Legacy Claude-vocabulary sessions (pre-native modes) still map.
    assert p.thread_start_params(
        LaunchOptions(permission_mode="bypassPermissions"), "/w")["sandbox"] == "danger-full-access"
    # Unknown/unset mode → sandboxed default.
    assert p.thread_start_params(LaunchOptions(), "/w")["sandbox"] == "workspace-write"


# --- event translation ------------------------------------------------------

def test_session_id_from_thread_started():
    p = _app_server()
    assert p.session_id_from_event(
        {"method": "thread/started", "params": {"thread": {"id": "T9"}}}) == "T9"
    assert p.session_id_from_event({"method": "turn/started"}) is None


def test_thread_started_becomes_system_init():
    out = _app_server().translate_events(
        {"method": "thread/started", "params": {"thread": {"id": "T1"}}}, _fresh_state())
    assert out[0]["type"] == "system" and out[0]["subtype"] == "init"
    assert out[0]["session_id"] == "T1"
    assert out[0]["model"] == "gpt-5.4"


def test_app_server_will_retry_error_is_nonterminal_api_retry():
    # "Reconnecting... N/5" notifications must NOT become turn-ending results
    # (each used to finalize its own phantom empty turn) — they map to the
    # CLI-retry system shape, carrying the HTTP status for the 401 fast-path.
    out = _app_server().translate_events(
        {"method": "error", "params": {
            "willRetry": True,
            "error": {"message": "Reconnecting... 2/5",
                      "codexErrorInfo": {"responseStreamDisconnected":
                                         {"httpStatusCode": 401}}}}},
        _fresh_state())
    assert out == [{"type": "system", "subtype": "api_retry",
                    "error_status": 401, "message": "Reconnecting... 2/5"}]


def test_app_server_terminal_error_then_turn_failed_yields_one_result():
    # The logged-out shape ends with an error(willRetry:false) AND a
    # turn/completed(failed) — the pair must produce exactly ONE result.
    p = _app_server()
    state = _fresh_state()
    out1 = p.translate_events(
        {"method": "error", "params": {
            "willRetry": False,
            "error": {"message": "unexpected status 401 Unauthorized",
                      "codexErrorInfo": "other"}}},
        state)
    assert len(out1) == 1
    assert out1[0]["type"] == "result" and out1[0]["is_error"] is True
    out2 = p.translate_events(
        {"method": "turn/completed", "params": {"turn": {
            "status": "failed",
            "error": {"message": "unexpected status 401 Unauthorized"}}}},
        state)
    assert out2 == []


def test_app_server_turn_failed_alone_still_errors():
    out = _app_server().translate_events(
        {"method": "turn/completed", "params": {"turn": {
            "status": "failed", "error": {"message": "boom"}}}},
        _fresh_state())
    assert out[0]["type"] == "result" and out[0]["is_error"] is True
    assert "boom" in out[0]["result"]


def test_app_server_retryable_excludes_auth():
    # Auth failures need a re-login, not a server-level resend — even when the
    # message also contains a retryable substring.
    p = _app_server()
    assert not p.is_retryable_api_error("401 unauthorized stream error")
    assert p.is_retryable_api_error("503 overloaded")


# --- stderr classification (shared codex-family errors mixin) ----------------

def test_classify_stderr():
    p = _app_server()
    assert p.classify_stderr("hit a rate limit, retrying") == StderrClass.RETRYABLE
    assert p.classify_stderr("error: no rollout found for id") == StderrClass.STALE_SESSION
    assert p.classify_stderr("Reading repository…") == StderrClass.NONE


def test_is_usage_limit_short_text_only():
    p = _app_server()
    assert p.is_usage_limit("You've hit your usage limit. Try again at 5pm.")
    assert p.is_usage_limit("Rate limit reached for gpt-5.4")
    # Long prose that merely quotes a limit phrase never matches.
    assert not p.is_usage_limit("Discussing what a usage limit is… " + "x" * 300)
    assert not p.is_usage_limit("")


def test_is_auth_error():
    p = _app_server()
    assert p.is_auth_error("", api_error_status=401)
    assert p.is_auth_error("token expired — run codex login")
    assert p.is_auth_error("401 Unauthorized")
    assert not p.is_auth_error("everything is fine")
    assert not p.is_auth_error("authentication " + "x" * 300)   # length-gated


# --- rich-commit summary fork -----------------------------------------------

def test_strictify_schema_widens_required_to_all_props():
    # The app-server's `outputSchema` runs OpenAI strict mode: `required` must
    # list every property. The shared builder only marks a couple required.
    src = json.dumps({
        "type": "object",
        "properties": {"summary": {"type": "string"}, "tags": {"type": "array"}},
        "required": ["summary"],
        "additionalProperties": False,
    })
    out = json.loads(CodexAppServerProvider._strictify_schema(src))
    assert set(out["required"]) == {"summary", "tags"}
    assert out["additionalProperties"] is False


def test_build_summary_fork_is_transport_driven_no_temp_files():
    # Native thread/fork + outputSchema: nothing is copied to disk, the plan
    # just launches a throwaway app-server and carries the payload.
    plan = _app_server().build_summary_fork(
        session_id="T1", fork_prompt="p", schema_json="{}", cwd="/w")
    assert plan.argv[1:] == ["app-server", "--stdio"]
    assert plan.cleanup_paths == []
    assert plan.payload["fork_from"] == "T1"
    assert plan.payload["prompt"] == "p"


def test_build_summary_fork_none_without_session():
    assert _app_server().build_summary_fork(
        session_id="", fork_prompt="p", schema_json="{}", cwd="/w") is None
