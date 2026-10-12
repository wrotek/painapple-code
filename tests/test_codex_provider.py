"""
Codex provider tests (`codex-app-server`).

The exec driver (`codex exec --json`, prompt in argv — the `ps`-leak provider)
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


def test_no_registered_provider_puts_prompts_in_argv():
    # The reason the exec driver was removed. The `prompt_in_argv` seam stays
    # (a drop-in provider may declare it and get the Settings warning), but no
    # shipped provider may carry it.
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


def test_drive_summary_fork_sends_exclude_turns_with_experimental_opt_in(monkeypatch):
    # codex-cli 0.159 rejects an ephemeral fork of a paginated thread without
    # `excludeTurns: true` (-32600); 0.144 rejects `excludeTurns` unless the
    # client opted into `experimentalApi` at initialize. Without both, every
    # codex rich commit failed silently (raw journal, no session titles).
    import asyncio
    from painapple_code.providers.codex_app_server import summary as S

    sent = {}

    class FakeClient:
        def __init__(self, proc, deny_map=None):
            pass

        async def start(self):
            pass

        async def request(self, method, params, timeout=None):
            sent[method] = params
            return {"thread": {"id": "F1"}} if method == "thread/fork" else {}

        async def notify(self, method, params=None):
            pass

        async def await_turn(self, timeout=None):
            return {"summary": "s"}, {"inputTokens": 3, "outputTokens": 1}

        async def close(self):
            pass

    monkeypatch.setattr(S, "_SummaryRpcClient", FakeClient)
    provider = _app_server()
    plan = provider.build_summary_fork(
        session_id="T1", fork_prompt="p", schema_json="{}", cwd="/w")
    structured, cost = asyncio.run(provider.drive_summary_fork(None, plan))

    assert structured == {"summary": "s"}
    assert sent["initialize"]["capabilities"] == {"experimentalApi": True}
    fork = sent["thread/fork"]
    assert fork["excludeTurns"] is True and fork["ephemeral"] is True
    assert fork["threadId"] == "T1"
    assert sent["turn/start"]["threadId"] == "F1"


# --- /compact → thread/compact/start ------------------------------------------

def _user(content):
    return {"type": "user", "message": {"role": "user", "content": content}}


def test_is_compact_command():
    p = _app_server()
    assert p.is_compact_command(_user("/compact"))
    assert p.is_compact_command(_user("  /compact keep the API notes "))
    assert p.is_compact_command(_user([{"type": "text", "text": "/compact"}]))
    assert not p.is_compact_command(_user("/compactor"))
    assert not p.is_compact_command(_user("please /compact"))
    assert not p.is_compact_command(_user([
        {"type": "text", "text": "/compact"},
        {"type": "image", "source": {"type": "base64", "data": ""}}]))


def test_compact_routes_to_thread_compact_start_not_turn_start():
    # The app-server has no slash commands: `/compact` sent as turn/start
    # input just reaches the model as text (it replied instead of compacting).
    import asyncio
    from types import SimpleNamespace

    session = SimpleNamespace(cwd="/w", session_id="T1", store_id=None,
                              _xlate_state={})
    t = _app_server().make_transport(process=None, opts=LaunchOptions(), session=session)
    t._initialized = True
    t._thread_id = "T1"
    calls = []

    async def fake_request(method, params, timeout=None):
        calls.append((method, params))
        return {}
    t._request = fake_request

    asyncio.run(t.send_turn(_user("/compact")))
    assert calls == [("thread/compact/start", {"threadId": "T1"})]
    assert session._xlate_state["compact_trigger"] == "manual"

    calls.clear()
    t.intake({"method": "turn/completed", "params": {"turn": {"id": "c1"}}})
    asyncio.run(t.send_turn(_user("hello")))
    assert [m for m, _ in calls] == ["turn/start"]


def _queue_transport():
    from types import SimpleNamespace
    sent = []

    async def safe_send(frame):
        sent.append(frame)
    session = SimpleNamespace(cwd="/w", session_id="T1", store_id=None,
                              _xlate_state={}, is_idle=True, safe_send=safe_send)
    t = _app_server().make_transport(process=None, opts=LaunchOptions(), session=session)
    t._initialized = True
    t._thread_id = "T1"
    calls = []

    async def fake_request(method, params, timeout=None):
        calls.append((method, params))
        return {"turn": {"id": f"turn-{len(calls)}"}}
    t._request = fake_request
    return t, session, calls, sent


def test_follow_up_during_compact_queues_then_runs_after_completion():
    # Codex refuses to steer input into a manual-compact turn
    # (ActiveTurnNotSteerable); the Claude CLI buffers such a follow-up and
    # runs it after compaction — the transport must do the same.
    import asyncio
    t, session, calls, _ = _queue_transport()

    async def scenario():
        await t.send_turn(_user("/compact"))
        assert await t.send_turn(_user("first")) is True
        assert await t.send_turn(_user("second")) is True
        assert [m for m, _ in calls] == ["thread/compact/start"]   # parked
        session.is_idle = True               # compact's result finalized
        t.intake({"method": "turn/completed", "params": {"turn": {"id": "c1"}}})
        for _ in range(5):
            await asyncio.sleep(0)
        assert [m for m, _ in calls] == ["thread/compact/start", "turn/start", "turn/start"]
        texts = [p["input"][0]["text"] for m, p in calls if m == "turn/start"]
        assert texts == ["first", "second"]
        assert session.is_idle is False      # queued turn is running
        assert t._queued == [] and t._unsteerable is False
    asyncio.run(scenario())


def test_not_steerable_error_from_unknown_turn_kind_queues():
    # e.g. a /review turn we didn't start: codex rejects the steer — park the
    # message instead of surfacing "Failed to send message".
    import asyncio
    t, session, calls, _ = _queue_transport()

    async def reject_once(method, params, timeout=None):
        calls.append((method, params))
        if len(calls) == 1:
            raise RuntimeError("{'code': -32603, 'message': 'failed to submit turn input: "
                               "ActiveTurnNotSteerable { turn_kind: Review }'}")
        return {"turn": {"id": "t2"}}
    t._request = reject_once

    async def scenario():
        assert await t.send_turn(_user("hi")) is True
        assert t._queued and t._unsteerable
        t.intake({"method": "turn/completed", "params": {"turn": {"id": "r1"}}})
        for _ in range(5):
            await asyncio.sleep(0)
        assert [m for m, _ in calls] == ["turn/start", "turn/start"]
        assert t._queued == []
    asyncio.run(scenario())


def test_other_turn_start_errors_still_raise():
    import asyncio
    t, _, _, _ = _queue_transport()

    async def boom(method, params, timeout=None):
        raise RuntimeError("{'code': -32603, 'message': 'thread not found'}")
    t._request = boom
    with pytest.raises(RuntimeError):
        asyncio.run(t.send_turn(_user("hi")))
    assert t._queued == []


def test_interrupt_drops_queued_follow_ups():
    import asyncio
    t, _, calls, _ = _queue_transport()

    async def scenario():
        await t.send_turn(_user("/compact"))
        await t.send_turn(_user("later"))
        await t.interrupt()
        t.intake({"method": "turn/completed", "params": {"turn": {"id": "c1"}}})
        for _ in range(5):
            await asyncio.sleep(0)
        assert [m for m, _ in calls] == ["thread/compact/start", "turn/interrupt"]
    asyncio.run(scenario())


def test_context_compaction_item_maps_to_claude_compaction_frames():
    # Live sequence (codex 0.144 + 0.159): turn/started → item/started
    # contextCompaction → tokenUsage → item/completed contextCompaction →
    # turn/completed. Map onto the frames the bridge already handles for
    # Claude: status=compacting (heartbeat), compact_boundary (info row).
    p = _app_server()
    state = _fresh_state()
    state["token_usage"] = {"inputTokens": 180000, "outputTokens": 2000}
    state["compact_trigger"] = "manual"
    item = {"type": "contextCompaction", "id": "C1"}

    out = p.translate_events({"method": "item/started", "params": {"item": item}}, state)
    assert out == [{"type": "system", "subtype": "status", "status": "compacting"}]

    out = p.translate_events({"method": "item/completed", "params": {"item": item}}, state)
    assert out == [{"type": "system", "subtype": "compact_boundary", "uuid": "C1",
                    "compact_metadata": {"trigger": "manual", "pre_tokens": 182000}}]
    assert "compact_trigger" not in state

    # Codex's own mid-turn auto-compaction emits the same item → trigger auto.
    p.translate_events({"method": "item/started", "params": {"item": item}}, state)
    out = p.translate_events({"method": "item/completed", "params": {"item": item}}, state)
    assert out[0]["compact_metadata"]["trigger"] == "auto"


# --- image attachments ------------------------------------------------------

def test_materialize_images_writes_files(monkeypatch, tmp_path):
    """Regression: a local list named `paths` shadowed the `paths` module, so
    `paths.DATA_HOME` raised UnboundLocalError on every image send."""
    import base64
    from painapple_code import paths as paths_mod
    monkeypatch.setattr(paths_mod, "DATA_HOME", tmp_path)
    data = base64.b64encode(b"\x89PNG fake").decode()
    out = _app_server()._materialize_images([
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
        {"type": "image", "source": {"type": "url", "url": "http://x"}},  # skipped
    ])
    assert len(out) == 1 and out[0].endswith(".jpg")
    from pathlib import Path
    assert Path(out[0]).read_bytes() == b"\x89PNG fake"
    assert Path(out[0]).parent == tmp_path / "tmp" / "codex-images"


# --- fileChange → Write/Edit (payload captured live from codex 0.159.3) ------

_FILE_CHANGE = {"method": "item/completed", "params": {"item": {
    "type": "fileChange", "id": "exec-1", "status": "completed",
    "changes": [
        {"path": "/w/existing.txt", "kind": {"type": "update", "move_path": None},
         "diff": "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,3 @@\n j\n-k\n+K\n l\n"},
        {"path": "/w/hello.py", "kind": {"type": "add"},
         "diff": "print('hi')\nprint('bye')\n"},
        {"path": "/w/gone.txt", "kind": {"type": "delete"}, "diff": "old\n"},
    ]}}}


def _tool_uses(out):
    return [(m["message"]["content"][0]["id"], m["message"]["content"][0]["name"],
             m["message"]["content"][0]["input"])
            for m in out if m["type"] == "assistant"]


def test_file_change_add_carries_content_for_write_block():
    # Regression: Write used to carry only file_path, so codex-created files
    # rendered as an empty one-line block.
    uses = _tool_uses(_app_server().translate_events(_FILE_CHANGE, _fresh_state()))
    write = [u for u in uses if u[1] == "Write"]
    assert write == [("exec-1_1", "Write",
                      {"file_path": "/w/hello.py", "content": "print('hi')\nprint('bye')\n"})]


def test_file_change_update_splits_hunks_into_edits_with_start_lines():
    out = _app_server().translate_events(_FILE_CHANGE, _fresh_state())
    edits = [u for u in _tool_uses(out) if u[0].startswith("exec-1_0")]
    assert edits == [
        ("exec-1_0_0", "Edit", {"file_path": "/w/existing.txt",
                                "old_string": "a\nb\nc", "new_string": "a\nB\nc"}),
        ("exec-1_0_1", "Edit", {"file_path": "/w/existing.txt",
                                "old_string": "j\nk\nl", "new_string": "j\nK\nl"}),
    ]
    starts = {m["message"]["content"][0]["tool_use_id"]: m["tool_use_result"]["structuredPatch"][0]["newStart"]
              for m in out if m["type"] == "user" and "tool_use_result" in m}
    assert starts["exec-1_0_0"] == 1 and starts["exec-1_0_1"] == 10


def test_file_change_delete_renders_as_removal_and_rename_keeps_path():
    uses = _tool_uses(_app_server().translate_events(_FILE_CHANGE, _fresh_state()))
    assert ("exec-1_2", "Edit", {"file_path": "/w/gone.txt",
                                 "old_string": "old\n", "new_string": ""}) in uses
    rename = {"method": "item/completed", "params": {"item": {
        "type": "fileChange", "id": "x", "status": "completed",
        "changes": [{"path": "/w/a", "kind": {"type": "update", "move_path": "/w/b"},
                     "diff": ""}]}}}
    assert _tool_uses(_app_server().translate_events(rename, _fresh_state())) == [
        ("x_0", "Edit", {"file_path": "/w/b"})]


# --- /goal: provider control command ------------------------------------------
#
# Codex's TUI parses /goal itself; the app-server we drive does not, so the
# command used to reach the model as prompt text. Now: parse → thread/goal/*
# RPC, goal notifications → goal_update frames, and turns Codex starts on its
# own to pursue the goal → opened by the session layer as provider turns.

def test_parse_goal_control_command_forms():
    p = _app_server()
    assert p.parse_control_command(_user("/goal")) == {"command": "goal", "action": "show"}
    assert p.parse_control_command(_user("/goal  Pause ")) == {"command": "goal", "action": "pause"}
    assert p.parse_control_command(_user("/goal resume"))["action"] == "resume"
    assert p.parse_control_command(_user("/goal clear"))["action"] == "clear"
    assert p.parse_control_command(_user("/goal ship it\nwith tests")) == {
        "command": "goal", "action": "set", "objective": "ship it\nwith tests"}
    assert p.parse_control_command(_user("/goals x")) is None
    assert p.parse_control_command(_user("please /goal x")) is None
    assert p.parse_control_command(_user("hello")) is None
    with_image = p.parse_control_command(_user([
        {"type": "text", "text": "/goal x"},
        {"type": "image", "source": {"type": "base64", "data": ""}}]))
    assert with_image["action"] == "invalid" and with_image["error"]


def test_goal_is_declared_for_the_slash_popup_and_claude_stays_clean():
    names = [c["cmd"] for c in _app_server().describe()["slash_commands"]]
    assert "/goal" in names
    claude = get_provider("claude-sdk")
    assert claude.slash_commands() == []
    assert claude.parse_control_command(_user("/goal x")) is None


def test_goal_and_turn_lifecycle_notifications_translate():
    p = _app_server()
    st = _fresh_state()
    assert p.translate_events({"method": "turn/started",
                               "params": {"turn": {"id": "U1"}}}, st) == [
        {"type": "system", "subtype": "turn_started", "turn_id": "U1"}]
    goal = {"objective": "o", "status": "active", "tokensUsed": 5}
    assert p.translate_events({"method": "thread/goal/updated",
                               "params": {"goal": goal}}, st) == [
        {"type": "system", "subtype": "goal_update", "goal": goal}]
    assert p.translate_events({"method": "thread/goal/cleared",
                               "params": {"threadId": "T1"}}, st) == [
        {"type": "system", "subtype": "goal_update", "goal": None}]


def _goal_transport(responses, goal=None):
    """A transport with a scripted `_request` (method → result | Exception)."""
    from types import SimpleNamespace
    session = SimpleNamespace(cwd="/w", session_id="T1", store_id=None,
                              _xlate_state={}, goal=goal)
    t = _app_server().make_transport(process=None, opts=LaunchOptions(), session=session)
    t._initialized = True
    t._thread_id = "T1"
    calls = []

    async def fake_request(method, params, timeout=None):
        calls.append((method, params))
        r = responses.get(method)
        if isinstance(r, Exception):
            raise r
        return r
    t._request = fake_request
    return t, calls


def test_run_control_goal_actions():
    import asyncio
    g_active = {"objective": "o", "status": "active"}
    g_paused = {"objective": "o", "status": "paused"}

    t, calls = _goal_transport({"thread/goal/set": {"goal": g_active}})
    assert asyncio.run(t.run_control({"command": "goal", "action": "set",
                                      "objective": "o"})) == {"goal": g_active}
    assert calls == [("thread/goal/set", {"threadId": "T1", "objective": "o",
                                          "status": "active"})]

    t, calls = _goal_transport({"thread/goal/get": {"goal": g_active},
                                "thread/goal/set": {"goal": g_paused}})
    assert asyncio.run(t.run_control({"command": "goal", "action": "pause"})) == {"goal": g_paused}
    assert calls[-1] == ("thread/goal/set", {"threadId": "T1", "status": "paused"})

    # Already in the asked-for state → no write.
    t, calls = _goal_transport({"thread/goal/get": {"goal": g_paused}})
    assert asyncio.run(t.run_control({"command": "goal", "action": "pause"})) == {"goal": g_paused}
    assert [m for m, _ in calls] == ["thread/goal/get"]

    t, _ = _goal_transport({"thread/goal/get": {"goal": None}})
    assert "No goal" in asyncio.run(t.run_control({"command": "goal", "action": "resume"}))["error"]

    t, _ = _goal_transport({"thread/goal/get": {"goal": {"objective": "o", "status": "complete"}}})
    assert "complete" in asyncio.run(t.run_control({"command": "goal", "action": "resume"}))["error"]

    t, calls = _goal_transport({"thread/goal/clear": {}})
    assert asyncio.run(t.run_control({"command": "goal", "action": "clear"})) == {"goal": None}

    t, _ = _goal_transport({"thread/goal/get": {"goal": g_active}})
    assert asyncio.run(t.run_control({"command": "goal", "action": "show"})) == {"goal": g_active}


def test_run_control_reports_rpc_errors_readably():
    import asyncio
    t, _ = _goal_transport({"thread/goal/set": RuntimeError(
        str({"code": -32601, "message": "Method not found"}))})
    err = asyncio.run(t.run_control({"command": "goal", "action": "set", "objective": "o"}))["error"]
    assert "update codex" in err
    t, _ = _goal_transport({"thread/goal/set": RuntimeError(
        str({"code": -32600, "message": "ephemeral thread does not support goals"}))})
    assert asyncio.run(t.run_control({"command": "goal", "action": "set", "objective": "o"})) == {
        "error": "ephemeral thread does not support goals"}


def test_stop_pauses_an_active_goal():
    # turn/interrupt halts the goal's continuation but leaves it reporting
    # `active` (verified live on 0.159.3) — pause it so the bar tells the truth.
    import asyncio
    t, calls = _goal_transport({}, goal={"objective": "o", "status": "active"})
    t._active_turn_id = "U1"
    asyncio.run(t.interrupt())
    assert [m for m, _ in calls] == ["turn/interrupt", "thread/goal/set"]
    assert calls[1][1] == {"threadId": "T1", "status": "paused"}

    t, calls = _goal_transport({}, goal={"objective": "o", "status": "paused"})
    asyncio.run(t.interrupt())
    assert [m for m, _ in calls] == ["turn/interrupt"]


@pytest.fixture
def goal_session():
    from unittest.mock import patch
    from painapple_code.services.agent_session import AgentManager, AgentSession
    with patch("painapple_code.services.agent_session.SessionStore") as store:
        store.load_meta.return_value = {}
        store.add_message.return_value = 7
        sess = AgentSession(store_id="store_goal", cwd="/tmp")
        sent = []

        async def safe_send(msg):
            sent.append(msg)
        sess.safe_send = safe_send
        yield AgentManager(), sess, store, sent


def _rows(store):
    return [c.args[1]["content"] for c in store.add_message.call_args_list]


def test_goal_updates_store_rows_only_on_transitions(goal_session):
    import asyncio
    agents, sess, store, _ = goal_session
    g = {"objective": "ship", "status": "active", "createdAt": 1, "updatedAt": 1,
         "tokensUsed": 0, "timeUsedSeconds": 0}
    run = lambda goal: asyncio.run(agents._handle_system_msg(
        sess, {"type": "system", "subtype": "goal_update", "goal": goal}))
    run(g)
    run({**g, "updatedAt": 2, "tokensUsed": 900})          # per-turn counters
    run({**g, "updatedAt": 3, "tokensUsed": 2400})
    run({**g, "updatedAt": 4, "status": "paused"})
    run({**g, "updatedAt": 5, "status": "active"})
    run({**g, "updatedAt": 6, "status": "complete", "tokensUsed": 12300,
         "timeUsedSeconds": 252})
    run(None)
    assert _rows(store) == [
        "Goal set: ship", "Goal paused", "Goal resumed",
        "Goal complete — 12.3k tokens · 4m 12s", "Goal cleared"]
    assert sess.goal is None
    store.update_metadata.assert_called_with("store_goal", goal=None)


def test_goal_snapshot_after_restart_does_not_duplicate_goal_set(goal_session):
    # A resumed thread re-announces its goal; meta already has it → no new row.
    import asyncio
    agents, sess, store, _ = goal_session
    g = {"objective": "ship", "status": "active", "createdAt": 1, "updatedAt": 9}
    store.load_meta.return_value = {"goal": g}
    asyncio.run(agents._handle_system_msg(
        sess, {"type": "system", "subtype": "goal_update", "goal": g}))
    assert _rows(store) == []


def test_turn_started_while_idle_opens_a_provider_turn(goal_session):
    import asyncio
    from unittest.mock import patch
    agents, sess, store, sent = goal_session
    sess.goal = {"objective": "ship", "status": "active"}
    sess._goal_loaded = True
    sess.is_idle = True
    with patch("painapple_code.services.agent_session.record_turn_start") as rec:
        asyncio.run(agents._handle_system_msg(sess, {"type": "system", "subtype": "turn_started"}))
    assert sess.is_idle is False
    rec.assert_called_once_with(sess, "")
    assert "Goal: ship" in sess.turn_tracker.user_prompt
    assert sent[-1]["type"] == "turn_started" and sent[-1]["source"] == "goal"

    # A turn we started ourselves is already busy → left alone.
    sent.clear()
    with patch("painapple_code.services.agent_session.record_turn_start") as rec:
        asyncio.run(agents._handle_system_msg(sess, {"type": "system", "subtype": "turn_started"}))
    rec.assert_not_called()
    assert sent == []


def test_bare_goal_reports_current_goal_and_errors_become_rows(goal_session):
    import asyncio
    agents, sess, store, _ = goal_session

    class T:
        def __init__(self, result):
            self.result = result

        async def run_control(self, cmd):
            return self.result
    sess._transport = T({"goal": None})
    asyncio.run(agents.run_control_command(sess, {"command": "goal", "action": "show"}))
    sess._transport = T({"error": "boom"})
    asyncio.run(agents.run_control_command(sess, {"command": "goal", "action": "pause"}))
    assert _rows(store) == ["No goal set — /goal <objective> starts one.", "boom"]
    assert store.add_message.call_args_list[-1].args[1]["role"] == "error"


def test_empty_agent_message_renders_no_bubble():
    p = _app_server()
    st = _fresh_state()
    assert p.translate_events({"method": "item/completed", "params": {
        "item": {"type": "agentMessage", "id": "m", "text": "  "}}}, st) == []
    assert "last_text" not in st
