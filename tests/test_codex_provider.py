"""
CodexProvider tests.

Covers argv construction (fresh + resume, effort/permission/model mapping) and
the native-event → canonical-(Claude-shape) translation against the documented
`codex exec --json` event samples. No live `codex` binary is required.
"""
import json

import pytest

from painapple_code.providers import get_provider, CodexProvider, LaunchOptions
from painapple_code.providers.base import StderrClass, SummaryForkPlan


def _fresh_state():
    return {"model": "gpt-5.4"}


# --- registry ---------------------------------------------------------------

def test_codex_is_registered_and_ephemeral():
    c = get_provider("codex")
    assert isinstance(c, CodexProvider)
    assert c.name == "codex"
    caps = c.capabilities
    assert caps.persistent_process is False
    assert caps.cumulative_cost is False
    assert caps.forward_plain_stderr is False
    # Codex forks itself (copy rollout + exec resume) to summarize a turn, so
    # rich-commit sections are on.
    assert caps.rich_commit_summaries is True


def test_codex_app_server_is_registered_and_jsonrpc():
    from painapple_code.providers import CodexAppServerProvider
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


# --- build_command ----------------------------------------------------------

def test_build_command_fresh(tmp_path, monkeypatch):
    # Deterministic catalog: -m passes only for ids codex's own cache lists
    # (a Claude id — the app's global default — is dropped, so codex falls
    # back to its configured default). See launch.py.
    import json as _json
    from painapple_code import paths
    monkeypatch.setattr(paths, "load_global_config", lambda: {})
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "models_cache.json").write_text(_json.dumps({"models": [
        {"slug": "gpt-5.4", "display_name": "GPT-5.4", "visibility": "list", "priority": 1},
    ]}))
    cmd = CodexProvider().build_command(LaunchOptions(
        model="gpt-5.4", effort="high", permission_mode="acceptEdits", prompt="hi",
    ))
    assert cmd[:4] == ["codex", "exec", "--json", "--skip-git-repo-check"]
    assert cmd[cmd.index("-m") + 1] == "gpt-5.4"
    cmd_claude_model = CodexProvider().build_command(LaunchOptions(
        model="claude-opus-4-8", prompt="hi",
    ))
    assert "-m" not in cmd_claude_model
    # The config key is `model_reasoning_effort`; a bare `reasoning_effort`
    # override is silently ignored by Codex (regression: f57cb8ac).
    assert "model_reasoning_effort=high" in cmd
    # acceptEdits → workspace-write; codex exec has no approval flag
    assert cmd[cmd.index("-s") + 1] == "workspace-write"
    assert "-a" not in cmd
    assert cmd[-1] == "hi"            # prompt is the final positional arg
    assert "resume" not in cmd


def test_build_command_resume(monkeypatch):
    # Isolate from the box's real config (a saved codex_path would replace
    # the bare "codex" argv[0] the assertion expects).
    from painapple_code import paths
    monkeypatch.setattr(paths, "load_global_config", lambda: {})
    cmd = CodexProvider().build_command(LaunchOptions(
        session_id="019abc", permission_mode="plan", prompt="next",
    ))
    assert cmd[:4] == ["codex", "exec", "resume", "019abc"]
    # `resume` has no -s flag; sandbox is a config override instead.
    assert "-s" not in cmd
    assert 'sandbox_mode="read-only"' in cmd   # plan → read-only
    assert cmd[-1] == "next"


def test_effort_and_permission_maps(tmp_path, monkeypatch):
    # Pin to the no-cache vocabulary: with no models cache the conservative
    # triad governs and xhigh/max collapse to 'high'. (Cache-driven per-model
    # clamping is covered in test_providers.py.)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = CodexProvider()
    # xhigh/max collapse to codex 'high'
    assert "model_reasoning_effort=high" in p.build_command(LaunchOptions(effort="max", prompt="x"))
    # bypassPermissions → danger-full-access
    cmd = p.build_command(LaunchOptions(permission_mode="bypassPermissions", prompt="x"))
    assert cmd[cmd.index("-s") + 1] == "danger-full-access"
    # unknown/unset mode → sandboxed default (workspace-write)
    cmd = p.build_command(LaunchOptions(prompt="x"))
    assert cmd[cmd.index("-s") + 1] == "workspace-write"


# --- session id -------------------------------------------------------------

def test_claude_model_id_is_dropped_not_passed_to_codex():
    # A codex session inherits the box default model (a Claude id) — it must
    # not reach `codex -m`; codex falls back to its own configured default.
    cmd = CodexProvider().build_command(LaunchOptions(model="claude-opus-4-8", prompt="x"))
    assert "-m" not in cmd
    # `-m` is gated on the provider's own catalog: only a model this engine
    # actually offers is forwarded. models() is empty today, so nothing is —
    # when a real Codex catalog is registered, -m starts working unchanged.
    class _Cataloged(CodexProvider):
        def models(self):
            return [{"id": "gpt-5.4", "label": "GPT-5.4"}]
    cmd = _Cataloged().build_command(LaunchOptions(model="gpt-5.4", prompt="x"))
    assert cmd[cmd.index("-m") + 1] == "gpt-5.4"
    # A model NOT in the catalog is still dropped.
    cmd = _Cataloged().build_command(LaunchOptions(model="o3", prompt="x"))
    assert "-m" not in cmd


def test_modelusage_omitted_for_claude_default():
    out = CodexProvider().translate_events(
        {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},
        {"model": "claude-opus-4-8"})
    assert "modelUsage" not in out[0]   # Claude id not recorded as the codex model


def test_session_id_from_thread_started():
    p = CodexProvider()
    assert p.session_id_from_event({"type": "thread.started", "thread_id": "T9"}) == "T9"
    assert p.session_id_from_event({"type": "turn.started"}) is None


# --- event translation ------------------------------------------------------

def test_thread_started_becomes_system_init():
    out = CodexProvider().translate_events(
        {"type": "thread.started", "thread_id": "T1"}, _fresh_state())
    assert out == [{"type": "system", "subtype": "init", "session_id": "T1", "model": "gpt-5.4"}]


def test_turn_started_is_dropped():
    assert CodexProvider().translate_events({"type": "turn.started"}, _fresh_state()) == []


def test_reasoning_and_agent_message():
    p = CodexProvider()
    th = p.translate_events(
        {"type": "item.completed", "item": {"id": "i0", "type": "reasoning", "text": "hmm"}}, _fresh_state())
    assert th[0]["message"]["content"][0] == {"type": "thinking", "thinking": "hmm"}
    st = _fresh_state()
    msg = p.translate_events(
        {"type": "item.completed", "item": {"id": "i3", "type": "agent_message", "text": "Done."}}, st)
    assert msg[0]["message"]["content"][0] == {"type": "text", "text": "Done."}
    assert st["last_text"] == "Done."   # surfaced as result.result later


def test_command_execution_pairs_tool_use_and_result():
    p = CodexProvider()
    st = _fresh_state()
    started = p.translate_events(
        {"type": "item.started", "item": {"id": "i1", "type": "command_execution", "command": "ls"}}, st)
    block = started[0]["message"]["content"][0]
    assert block == {"type": "tool_use", "id": "i1", "name": "Bash", "input": {"command": "ls"}}
    done = p.translate_events(
        {"type": "item.completed", "item": {
            "id": "i1", "type": "command_execution", "command": "ls",
            "aggregated_output": "docs\nsrc", "exit_code": 0}}, st)
    res = done[0]["message"]["content"][0]
    assert res == {"type": "tool_result", "tool_use_id": "i1", "content": "docs\nsrc"}


def test_command_execution_nonzero_exit_annotated():
    done = CodexProvider().translate_events(
        {"type": "item.completed", "item": {
            "id": "i1", "type": "command_execution", "command": "false",
            "aggregated_output": "boom", "exit_code": 2}}, _fresh_state())
    assert "exit code: 2" in done[0]["message"]["content"][0]["content"]


def test_file_change_emits_tool_use_and_result_per_change():
    out = CodexProvider().translate_events(
        {"type": "item.completed", "item": {"id": "i4", "type": "file_change", "changes": [
            {"path": "a.py", "kind": "add"},
            {"path": "b.py", "kind": "update"}]}}, _fresh_state())
    # add → Write, update → Edit; each followed by a closing tool_result
    names = [m["message"]["content"][0].get("name") for m in out if m["type"] == "assistant"]
    assert names == ["Write", "Edit"]
    files = [m["message"]["content"][0]["input"]["file_path"]
             for m in out if m["type"] == "assistant"]
    assert files == ["a.py", "b.py"]
    assert sum(1 for m in out if m["type"] == "user") == 2


def test_todo_list_only_on_completed():
    p = CodexProvider()
    started = {"type": "item.started", "item": {"id": "i8", "type": "todo_list",
              "items": [{"text": "scan", "completed": False}]}}
    assert p.translate_events(started, _fresh_state()) == []
    completed = {"type": "item.completed", "item": {"id": "i8", "type": "todo_list",
                "items": [{"text": "scan", "completed": True}]}}
    out = p.translate_events(completed, _fresh_state())
    tw = out[0]["message"]["content"][0]
    assert tw["name"] == "TodoWrite"
    assert tw["input"]["todos"][0]["status"] == "completed"


def test_turn_completed_maps_usage_no_cost():
    out = CodexProvider().translate_events(
        {"type": "turn.completed", "usage": {
            "input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 20}},
        _fresh_state())
    r = out[0]
    assert r["type"] == "result" and r["is_error"] is False
    assert r["total_cost_usd"] == 0          # tokens only, no USD
    assert r["usage"]["input_tokens"] == 100
    assert r["usage"]["cache_read_input_tokens"] == 80
    assert r["modelUsage"]["gpt-5.4"]["inputTokens"] == 100


def test_turn_failed_is_error_result():
    out = CodexProvider().translate_events(
        {"type": "turn.failed", "error": {"message": "stream ended"}}, _fresh_state())
    assert out[0]["type"] == "result" and out[0]["is_error"] is True
    assert "stream ended" in out[0]["result"]


# --- app-server retry/error notifications -----------------------------------

def _app_server():
    from painapple_code.providers import CodexAppServerProvider
    return CodexAppServerProvider()


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


# --- stderr classification --------------------------------------------------

def test_classify_stderr():
    p = CodexProvider()
    assert p.classify_stderr("hit a rate limit, retrying") == StderrClass.RETRYABLE
    assert p.classify_stderr("error: no rollout found for id") == StderrClass.STALE_SESSION
    assert p.classify_stderr("Reading repository…") == StderrClass.NONE


def test_is_usage_limit_short_text_only():
    p = CodexProvider()
    assert p.is_usage_limit("You've hit your usage limit. Try again at 5pm.")
    assert p.is_usage_limit("Rate limit reached for gpt-5.4")
    # Long prose that merely quotes a limit phrase never matches.
    assert not p.is_usage_limit("Discussing what a usage limit is… " + "x" * 300)
    assert not p.is_usage_limit("")


def test_is_auth_error():
    p = CodexProvider()
    assert p.is_auth_error("", api_error_status=401)
    assert p.is_auth_error("token expired — run codex login")
    assert p.is_auth_error("401 Unauthorized")
    assert not p.is_auth_error("everything is fine")
    assert not p.is_auth_error("authentication " + "x" * 300)   # length-gated


# --- rich-commit summary fork -----------------------------------------------

def test_strictify_schema_widens_required_to_all_props():
    # Codex --output-schema runs OpenAI strict mode: `required` must list every
    # property. The shared builder only marks a couple required.
    src = json.dumps({
        "type": "object",
        "properties": {"summary": {"type": "string"}, "tags": {"type": "array"}},
        "required": ["summary"],
        "additionalProperties": False,
    })
    out = json.loads(CodexProvider._strictify_schema(src))
    assert set(out["required"]) == {"summary", "tags"}
    assert out["additionalProperties"] is False


def test_build_summary_fork_none_when_rollout_missing(tmp_path, monkeypatch):
    # No sessions dir under CODEX_HOME → can't fork → None (the turn still gets a
    # basic shadow commit upstream, just no AI sections).
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    plan = CodexProvider().build_summary_fork(
        session_id="missing", fork_prompt="p", schema_json="{}", cwd=str(tmp_path))
    assert plan is None


def test_parse_summary_fork_reads_output_file_and_usage(tmp_path):
    out = tmp_path / "summary.json"
    out.write_text('{"summary": "did things", "tags": ["x"]}')
    plan = SummaryForkPlan(argv=[], output_file=str(out))
    stdout = (b'{"type":"turn.started"}\n'
              b'{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30}}\n')
    structured, cost = CodexProvider().parse_summary_fork(
        plan=plan, returncode=0, stdout=stdout, stderr=b"")
    assert structured == {"summary": "did things", "tags": ["x"]}
    # tokens only, no USD
    assert cost == {"cost": 0.0, "input_tokens": 120, "output_tokens": 30}


def test_parse_summary_fork_stream_fallback_when_output_empty(tmp_path):
    # -o file empty → fall back to the last agent_message in the JSONL stream.
    out = tmp_path / "summary.json"
    out.write_text("")
    plan = SummaryForkPlan(argv=[], output_file=str(out))
    stdout = (b'{"type":"item.completed","item":{"type":"agent_message",'
              b'"text":"{\\"summary\\":\\"from stream\\"}"}}\n'
              b'{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}\n')
    structured, cost = CodexProvider().parse_summary_fork(
        plan=plan, returncode=0, stdout=stdout, stderr=b"")
    assert structured == {"summary": "from stream"}
    assert cost["input_tokens"] == 5


def test_parse_summary_fork_none_on_nonzero_rc(tmp_path):
    out = tmp_path / "summary.json"
    out.write_text('{"summary": "x"}')
    plan = SummaryForkPlan(argv=[], output_file=str(out))
    structured, cost = CodexProvider().parse_summary_fork(
        plan=plan, returncode=1, stdout=b"", stderr=b"boom")
    assert structured is None and cost is None
