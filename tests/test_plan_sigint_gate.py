"""Tests for the plan-approval SIGINT gate in _handle_tool_use.

Bug: pre-fix, every ExitPlanMode tool_use marked `_pending_input_tool`,
which triggered SIGINT in _read_claude_output. That includes the
acknowledgment-ExitPlanMode Claude emits in the resumed turn after the
user approves the plan — killing Claude mid-implementation.

Fix: gate ExitPlanMode SIGINT behind `_plan_sigint_armed`. Armed by
/plan, by Claude's EnterPlanMode tool call, or by session-start with
permission_mode=="plan". Disarmed one-shot after firing.
"""
from unittest.mock import patch

import pytest

from painapple_code.services.agent_session import AgentBridge, AgentSession


def _session():
    return AgentSession(store_id="store_test", cwd="/tmp")


def _enter(tool_id="ep1"):
    return {"id": tool_id, "name": "EnterPlanMode", "input": {}}


def _exit_(tool_id="xp1"):
    return {"id": tool_id, "name": "ExitPlanMode", "input": {}}


@pytest.fixture
def bridge():
    return AgentBridge()


@pytest.fixture
def sess():
    return _session()


@patch("painapple_code.services.agent_session.SessionStore")
@patch("painapple_code.services.agent_session._track_tool_usage")
def test_default_state_is_disarmed(_track, _store, sess):
    assert sess._plan_sigint_armed is False


@patch("painapple_code.services.agent_session.SessionStore")
@patch("painapple_code.services.agent_session._track_tool_usage")
def test_exit_plan_without_arming_does_not_set_pending(_track, _store, bridge, sess):
    """Post-approval acknowledgment case: ExitPlanMode arrives with no prior
    arming → no SIGINT scheduled."""
    bridge._handle_tool_use(sess, _exit_(), "ts")
    assert sess._pending_input_tool is None
    assert sess._plan_sigint_armed is False


@patch("painapple_code.services.agent_session.SessionStore")
@patch("painapple_code.services.agent_session._track_tool_usage")
def test_enter_plan_arms_the_gate(_track, _store, bridge, sess):
    bridge._handle_tool_use(sess, _enter(), "ts")
    assert sess._plan_sigint_armed is True
    assert sess._pending_input_tool is None


@patch("painapple_code.services.agent_session.SessionStore")
@patch("painapple_code.services.agent_session._track_tool_usage")
def test_enter_then_exit_fires_and_disarms(_track, _store, bridge, sess):
    bridge._handle_tool_use(sess, _enter("ep1"), "ts")
    assert sess._plan_sigint_armed is True

    bridge._handle_tool_use(sess, _exit_("xp1"), "ts")
    assert sess._pending_input_tool == "ExitPlanMode"
    assert sess._plan_sigint_armed is False


@patch("painapple_code.services.agent_session.SessionStore")
@patch("painapple_code.services.agent_session._track_tool_usage")
def test_post_approval_second_exit_does_not_re_sigint(_track, _store, bridge, sess):
    """The bug scenario end to end.

    Pre-fix: the second ExitPlanMode (Claude's acknowledgment of approval)
    set _pending_input_tool again → second SIGINT → process killed.
    """
    bridge._handle_tool_use(sess, _enter("ep1"), "ts")
    bridge._handle_tool_use(sess, _exit_("xp1"), "ts")
    assert sess._pending_input_tool == "ExitPlanMode"

    sess._pending_input_tool = None

    bridge._handle_tool_use(sess, _exit_("xp2"), "ts")
    assert sess._pending_input_tool is None
    assert sess._plan_sigint_armed is False


@patch("painapple_code.services.agent_session.SessionStore")
@patch("painapple_code.services.agent_session._track_tool_usage")
def test_externally_armed_state_fires_once(_track, _store, bridge, sess):
    """Simulates /plan command or start-in-plan-mode: the gate is armed by
    external code (ws_chat handler / start_claude), not by EnterPlanMode."""
    sess._plan_sigint_armed = True

    bridge._handle_tool_use(sess, _exit_("xp1"), "ts")
    assert sess._pending_input_tool == "ExitPlanMode"
    assert sess._plan_sigint_armed is False

    sess._pending_input_tool = None
    bridge._handle_tool_use(sess, _exit_("xp2"), "ts")
    assert sess._pending_input_tool is None


@patch("painapple_code.services.agent_session.SessionStore")
@patch("painapple_code.services.agent_session._track_tool_usage")
def test_re_arming_after_disarm_works(_track, _store, bridge, sess):
    """Second plan cycle later in the conversation: new EnterPlanMode
    re-arms the gate so the next ExitPlanMode triggers approval again."""
    bridge._handle_tool_use(sess, _enter("ep1"), "ts")
    bridge._handle_tool_use(sess, _exit_("xp1"), "ts")
    assert sess._plan_sigint_armed is False

    sess._pending_input_tool = None

    bridge._handle_tool_use(sess, _enter("ep2"), "ts")
    assert sess._plan_sigint_armed is True
    bridge._handle_tool_use(sess, _exit_("xp2"), "ts")
    assert sess._pending_input_tool == "ExitPlanMode"
