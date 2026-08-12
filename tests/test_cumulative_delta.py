"""
Tests for `ClaudeProvider.normalize_result` (the cumulative→delta conversion).

The Claude CLI emits `result.total_cost_usd` and `result.modelUsage` as
running totals across the lifetime of one Claude subprocess. The provider
rewrites a result message in-place so downstream stores receive per-turn
deltas. Process restart is signaled by a fresh `CostState` (the session layer
calls `provider.new_cost_state()` in `start_claude`).
"""
from painapple_code.providers import ClaudeProvider, CostState

_p = ClaudeProvider()


def _convert(state, msg):
    """Adapter mirroring the old `_convert_cumulative_to_delta(session, msg)`."""
    _p.normalize_result(msg, state)


def _result(cum_cost, opus_cum, haiku_cum=None):
    mu = {"opus": dict(opus_cum)}
    if haiku_cum is not None:
        mu["haiku"] = dict(haiku_cum)
    return {"total_cost_usd": cum_cost, "modelUsage": mu}


def test_single_result_in_process_passes_through():
    s = CostState()
    msg = _result(0.50, {"costUSD": 0.50, "inputTokens": 10, "outputTokens": 100,
                          "cacheReadInputTokens": 1000, "cacheCreationInputTokens": 50})
    _convert(s, msg)
    assert msg["total_cost_usd"] == 0.50
    assert msg["modelUsage"]["opus"]["costUSD"] == 0.50
    assert msg["modelUsage"]["opus"]["outputTokens"] == 100


def test_multi_results_in_same_process_subtract_previous():
    s = CostState()

    r1 = _result(0.50, {"costUSD": 0.50, "inputTokens": 10, "outputTokens": 100,
                         "cacheReadInputTokens": 1000, "cacheCreationInputTokens": 50})
    _convert(s, r1)
    assert r1["total_cost_usd"] == 0.50

    r2 = _result(1.20, {"costUSD": 1.20, "inputTokens": 25, "outputTokens": 400,
                         "cacheReadInputTokens": 5000, "cacheCreationInputTokens": 70})
    _convert(s, r2)
    assert abs(r2["total_cost_usd"] - 0.70) < 1e-9
    assert abs(r2["modelUsage"]["opus"]["costUSD"] - 0.70) < 1e-9
    assert r2["modelUsage"]["opus"]["inputTokens"] == 15
    assert r2["modelUsage"]["opus"]["outputTokens"] == 300
    assert r2["modelUsage"]["opus"]["cacheReadInputTokens"] == 4000
    assert r2["modelUsage"]["opus"]["cacheCreationInputTokens"] == 20


def test_model_unchanged_yields_zero_delta():
    """Haiku used only in turn 1; turn 2 reports same haiku cumulative."""
    s = CostState()

    r1 = _result(
        0.6303,
        {"costUSD": 0.6298, "inputTokens": 17, "outputTokens": 3638,
         "cacheReadInputTokens": 199901, "cacheCreationInputTokens": 70211},
        {"costUSD": 0.00046, "inputTokens": 360, "outputTokens": 20,
         "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0},
    )
    _convert(s, r1)
    assert r1["modelUsage"]["haiku"]["costUSD"] == 0.00046

    r2 = _result(
        3.1236,
        {"costUSD": 3.1232, "inputTokens": 60, "outputTokens": 30356,
         "cacheReadInputTokens": 3092637, "cacheCreationInputTokens": 130822},
        {"costUSD": 0.00046, "inputTokens": 360, "outputTokens": 20,
         "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0},
    )
    _convert(s, r2)
    assert r2["modelUsage"]["haiku"]["costUSD"] == 0
    assert r2["modelUsage"]["haiku"]["inputTokens"] == 0
    assert abs(r2["modelUsage"]["opus"]["costUSD"] - (3.1232 - 0.6298)) < 1e-6


def test_process_restart_via_reset_clears_tracker():
    """Simulates start_claude resetting tracker — next result is full delta."""
    s = CostState()

    r1 = _result(0.50, {"costUSD": 0.50, "inputTokens": 10, "outputTokens": 100,
                         "cacheReadInputTokens": 1000, "cacheCreationInputTokens": 50})
    _convert(s, r1)

    # Simulate start_claude — a fresh CostState replaces the old one.
    s = CostState()

    r2 = _result(0.30, {"costUSD": 0.30, "inputTokens": 5, "outputTokens": 50,
                         "cacheReadInputTokens": 500, "cacheCreationInputTokens": 25})
    _convert(s, r2)
    assert r2["total_cost_usd"] == 0.30
    assert r2["modelUsage"]["opus"]["costUSD"] == 0.30


def test_negative_delta_falls_back_to_current():
    """If cumulative somehow drops (defensive), treat as fresh count."""
    s = CostState()

    r1 = _result(1.00, {"costUSD": 1.00, "inputTokens": 10, "outputTokens": 100,
                         "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0})
    _convert(s, r1)

    r2 = _result(0.20, {"costUSD": 0.20, "inputTokens": 5, "outputTokens": 50,
                         "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0})
    _convert(s, r2)
    assert r2["total_cost_usd"] == 0.20
    assert r2["modelUsage"]["opus"]["costUSD"] == 0.20


def test_missing_modelUsage_handled():
    s = CostState()
    msg = {"total_cost_usd": 0.10}
    _convert(s, msg)
    assert msg["total_cost_usd"] == 0.10


def test_real_session_trace_matches_known_total():
    """Reproduces iVhbsbgN4XM session trace — total should equal $4.45."""
    s = CostState()
    raws = [
        # Process A: R1, R2, R3
        (0.6303, {"costUSD": 0.629804, "inputTokens": 17, "outputTokens": 3638,
                  "cacheReadInputTokens": 199901, "cacheCreationInputTokens": 70211}),
        (3.1236, {"costUSD": 3.123156, "inputTokens": 60, "outputTokens": 30356,
                  "cacheReadInputTokens": 3092637, "cacheCreationInputTokens": 130822}),
        (3.2182, {"costUSD": 3.217698, "inputTokens": 66, "outputTokens": 31995,
                  "cacheReadInputTokens": 3189648, "cacheCreationInputTokens": 131627}),
    ]
    total = 0.0
    for cum, opus in raws:
        msg = _result(cum, opus)
        _convert(s, msg)
        total += msg["total_cost_usd"]

    # Process restart
    s = CostState()
    for cum, opus in [
        (0.9191, {"costUSD": 0.919100, "inputTokens": 11, "outputTokens": 4274,
                  "cacheReadInputTokens": 527390, "cacheCreationInputTokens": 87760}),
        (1.2274, {"costUSD": 1.227351, "inputTokens": 20, "outputTokens": 7013,
                  "cacheReadInputTokens": 949877, "cacheCreationInputTokens": 92318}),
    ]:
        msg = _result(cum, opus)
        _convert(s, msg)
        total += msg["total_cost_usd"]

    # Real total in this session was ~$4.4456; naive sum would be ~$9.12.
    assert abs(total - 4.4456) < 0.001
