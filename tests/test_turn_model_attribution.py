"""
Tests for per-turn model attribution — "which model actually answered?"

A turn's `modelUsage` aggregates the WHOLE turn: the main chat thread AND any
Task-tool subagents. Picking the highest spender out of that map is a guess,
and it guesses wrong whenever a subagent outspends the main thread — which is
routine, since a subagent can run for minutes while the main thread only
dispatches it. Observed in the wild: a Sonnet subagent at $1.72 outspending an
Opus main thread at $0.36, so an Opus answer was labeled "sonnet-5".

The fix records the model live from assistant frames, where
`parent_tool_use_id is None` identifies the main thread exactly. Cost survives
only as a fallback for turns that produced no main-thread frame.

This has regressed once before (the cost heuristic itself replaced an even
earlier "first key in modelUsage" bug), so these tests pin the behavior.
"""
import uuid

import pytest

from painapple_code.services.agent_session import AgentBridge
from painapple_code.shadow_db import ShadowDB
from painapple_code.turn_tracker import TurnTracker


# ═══════════════════════════════════════════════════════════════════
# Live capture: TurnTracker.main_thread_model via _handle_assistant_msg
# ═══════════════════════════════════════════════════════════════════

class _FakeSession:
    """Minimal stand-in. With no content blocks, _handle_assistant_msg touches
    nothing but the tracker, so `self` is never dereferenced either."""
    def __init__(self):
        self.turn_tracker = TurnTracker()
        self.store_id = "s1"
        self.cwd = None


def _assistant(model, parent_tool_use_id=None, content=None):
    return {
        "type": "assistant",
        "parent_tool_use_id": parent_tool_use_id,
        "message": {"model": model, "content": content or []},
    }


def _feed(session, msg):
    # `self` is unused on this path (no content blocks -> no tool/text handling).
    AgentBridge._handle_assistant_msg(None, session, msg, "2026-08-07T00:00:00Z")


def test_main_thread_frame_is_recorded():
    s = _FakeSession()
    _feed(s, _assistant("claude-fable-5"))
    assert s.turn_tracker.main_thread_model == "claude-fable-5"


def test_subagent_frame_does_not_steal_the_label():
    """The core regression: a subagent frame must never set the turn's model."""
    s = _FakeSession()
    _feed(s, _assistant("claude-opus-4-8"))
    _feed(s, _assistant("claude-sonnet-5", parent_tool_use_id="toolu_017g24Mv"))
    assert s.turn_tracker.main_thread_model == "claude-opus-4-8"


def test_subagent_frame_alone_records_nothing():
    s = _FakeSession()
    _feed(s, _assistant("claude-haiku-4-5", parent_tool_use_id="toolu_abc"))
    assert s.turn_tracker.main_thread_model is None


def test_last_main_thread_frame_wins_for_refusal_fallback():
    """A mid-turn refusal fallback (fable-5 -> opus-4-8) must show the model
    that actually produced the answer, not the one that declined."""
    s = _FakeSession()
    _feed(s, _assistant("claude-fable-5"))
    _feed(s, _assistant("claude-opus-4-8"))
    assert s.turn_tracker.main_thread_model == "claude-opus-4-8"


def test_synthetic_error_bubble_is_ignored():
    """The CLI's synthetic auth/limit bubbles carry model "<synthetic>" — never
    a real model, so they must not be recorded as the turn's model."""
    s = _FakeSession()
    _feed(s, _assistant("<synthetic>"))
    assert s.turn_tracker.main_thread_model is None

    _feed(s, _assistant("claude-opus-5"))
    _feed(s, _assistant("<synthetic>"))
    assert s.turn_tracker.main_thread_model == "claude-opus-5"


def test_tracker_reset_clears_model():
    """Each turn must start clean, or a turn with no frames inherits the
    previous turn's model."""
    s = _FakeSession()
    _feed(s, _assistant("claude-opus-5"))
    s.turn_tracker.reset()
    assert s.turn_tracker.main_thread_model is None


# ═══════════════════════════════════════════════════════════════════
# Persistence: ShadowDB.complete_turn precedence
# ═══════════════════════════════════════════════════════════════════

@pytest.fixture
def db(tmp_path):
    return ShadowDB(db_path=tmp_path / "shadow-test.duckdb")


def _new_turn(db):
    return db.start_turn(session_id=str(uuid.uuid4()), project_hash="deadbeef",
                         user_prompt="hi", turn_number=1)


def _model_of(db, turn_id):
    return db._fetch_one("SELECT model FROM turns WHERE id = ?", [turn_id])[0]


# The shape that broke: subagent outspends the main thread ~5:1.
_SUBAGENT_HEAVY = {
    "total_cost_usd": 2.08,
    "modelUsage": {
        "claude-sonnet-5": {"costUSD": 1.7183},   # subagent — the top spender
        "claude-opus-4-8": {"costUSD": 0.3572},   # main thread — the real answer
        "claude-haiku-4-5": {"costUSD": 0.0006},
    },
}


def test_main_thread_model_wins_over_top_spender(db):
    turn_id = _new_turn(db)
    db.complete_turn(turn_id, result_msg=dict(_SUBAGENT_HEAVY),
                     main_thread_model="claude-opus-4-8")
    assert _model_of(db, turn_id) == "claude-opus-4-8"


def test_falls_back_to_cost_when_no_main_thread_model(db):
    """Turns with no main-thread frame (errors, interrupts) keep the old
    heuristic rather than recording nothing."""
    turn_id = _new_turn(db)
    db.complete_turn(turn_id, result_msg=dict(_SUBAGENT_HEAVY))
    assert _model_of(db, turn_id) == "claude-sonnet-5"


def test_main_thread_model_survives_empty_model_usage(db):
    """No modelUsage at all must not wipe the captured model."""
    turn_id = _new_turn(db)
    db.complete_turn(turn_id, result_msg={"total_cost_usd": 0.0, "modelUsage": {}},
                     main_thread_model="claude-opus-5")
    assert _model_of(db, turn_id) == "claude-opus-5"


def test_web_search_still_aggregates_across_all_models(db):
    """The main-thread short-circuit must not skip the sibling aggregation that
    shares the same `if model_usage_data:` block."""
    turn_id = _new_turn(db)
    db.complete_turn(turn_id, main_thread_model="claude-opus-5", result_msg={
        "total_cost_usd": 1.0,
        "modelUsage": {
            "claude-opus-5": {"costUSD": 0.9, "webSearchRequests": 2, "webFetchRequests": 1},
            "claude-haiku-4-5": {"costUSD": 0.1, "webSearchRequests": 3, "webFetchRequests": 4},
        },
    })
    row = db._fetch_one(
        "SELECT model, web_search_count, web_fetch_count FROM turns WHERE id = ?",
        [turn_id])
    assert row[0] == "claude-opus-5"
    assert row[1] == 5   # 2 + 3
    assert row[2] == 5   # 1 + 4
