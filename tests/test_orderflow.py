"""Synthetic order flow (order flow, Phase 5): examples by hand, no look-ahead, and the golden file kept current."""

import json

from forex_replay import orderflow_golden
from forex_replay.orderflow import bubbles, candle_flow, classify_bucket, day_resets, divergences, fallback_delta, rvol

T = 1762207200  # Mon 3 Nov 2025 22:00 UTC: a trading day starts (17:00 New York, winter)


def minutes(rows):
    """rows: (minute, ticks, up, down, baseline_x2) -> order-flow 1-minute bars."""
    return {"seconds": 60, "time": [T + 60 * m for m, *_ in rows], "tick_count": [r[1] for r in rows],
            "up_ticks": [r[2] for r in rows], "down_ticks": [r[3] for r in rows], "baseline_x2": [r[4] for r in rows]}


def test_rvol_is_ticks_over_the_same_slot_median():
    assert rvol(30, 20) == 3.0  # a median of 10 ticks, stored as 20
    assert rvol(30, -1) is None and rvol(30, 0) is None


def test_a_bubble_needs_rvol_and_a_move_and_absorption_is_activity_without_progress():
    assert classify_bucket(100, 130, 30, 20, 30, 6) == {"kind": "bubble", "side": "up", "size": 1, "rvol": 3.0}
    assert classify_bucket(100, 70, 50, 20, 30, 6)["size"] == 2  # 5x: medium
    assert classify_bucket(100, 94, 80, 20, 30, 6) == {"kind": "absorption", "side": None, "size": 3, "rvol": 8.0}
    assert classify_bucket(100, 129, 30, 20, 30, 6) is None  # moved more than absorption allows, less than a bubble
    assert classify_bucket(100, 200, 29, 20, 30, 6) is None  # 2.9x: too quiet


def test_bubbles_only_from_buckets_closed_at_the_cursor():
    b = {"seconds": 15, "time": [T, T + 15, T + 30], "open": [100, 100, 100], "close": [140, 100, 60],
         "tick_count": [40, 40, 40], "up_ticks": [30, 25, 5], "down_ticks": [10, 15, 35], "baseline_x2": [20, 20, 20]}
    assert [x["kind"] for x in bubbles(b, T, T + 60, T + 45, 30, 6)] == ["bubble", "absorption", "bubble"]
    assert len(bubbles(b, T, T + 60, T + 44, 30, 6)) == 2  # the third bucket closes at T + 45
    assert [x["delta"] for x in bubbles(b, T, T + 60, T + 45, 30, 6)] == [20, 10, -30]  # up - down ticks of each bucket


def test_candle_delta_cvd_and_rvol_by_hand():
    bars = minutes([(0, 10, 7, 3, 10), (1, 10, 2, 8, 10), (5, 20, 15, 5, 10)])
    out = candle_flow([T, T + 300], 300, T + 600, bars, resets=[])
    assert out["delta"] == [-2, 10]  # (7-3) + (2-8); then 15-5
    assert out["cvd"] == [-2, 8]  # the running sum, read at each candle's last minute
    assert out["rvol"] == [2 * 20 / 20, 2 * 20 / 10]  # 20 ticks over medians 5 + 5; 20 over 5


def test_cvd_resets_and_a_missing_baseline_leaves_rvol_empty():
    bars = minutes([(0, 10, 10, 0, 10), (1, 10, 10, 0, -1), (2, 10, 0, 10, 10)])
    out = candle_flow([T, T + 60, T + 120], 60, T + 180, bars, resets=[T + 120])
    assert out["cvd"] == [10, 20, -10]  # back to 0 at T + 120
    assert out["rvol"] == [2.0, None, 2.0]


def test_the_fallback_before_the_order_flow_begins():
    candles = {"time": [T, T + 60], "open": [10, 15], "high": [20, 15], "low": [0, 15], "close": [15, 15], "volume": [100, 50]}
    bars = minutes([(2, 10, 6, 4, 10)])
    out = candle_flow([T], 300, T + 300, bars, [], fallback=candles, flow_first=T + 120)
    assert out["delta"] == [25.0 + 0.0 + 2]  # 100 x 5 / 20, a flat candle, then the ticks' own delta
    assert out["rvol"] == [2.0]  # from the minutes with ticks only: 10 ticks against a median of 5
    assert fallback_delta(100, 10, 20, 0, 15) == 25.0


def test_no_minute_after_the_cursor_is_used():
    bars = minutes([(0, 10, 7, 3, 10), (1, 10, 9, 1, 10)])
    assert candle_flow([T], 300, T + 60, bars, [])["delta"] == [4]
    assert candle_flow([T], 300, T + 119, bars, [])["delta"] == [4]
    assert candle_flow([T], 300, T + 120, bars, [])["delta"] == [12]


def test_divergence_a_new_high_without_a_new_cvd_high():
    starts = [T, T + 60, T + 120, T + 180]
    out = divergences(starts, highs=[10, 12, 11, 15], lows=[5, 6, 6, 7], cvd=[5, 9, 8, 7], resets=[], lookback=20)
    assert out == [{"index": 3, "side": "bearish"}]
    assert divergences(starts, [10, 12, 11, 15], [5, 6, 6, 7], [5, 9, 8, 10], [], 20) == []  # CVD made its new high too
    assert divergences(starts, [10, 12, 11, 15], [5, 6, 6, 7], [5, 9, 8, 7], [T + 180], 20) == []  # a new period starts there
    assert divergences(starts, [10, 9, 9, 9], [5, 4, 4, 3], [5, 1, 2, 3], [], 2) == [{"index": 3, "side": "bullish"}]


def test_day_resets_follow_new_york_summer_and_winter():
    assert day_resets(T - 7200, T + 3600) == [T]  # 22:00 UTC in winter
    summer = 1760997600  # Mon 20 Oct 2025 22:00 UTC; the summer day starts an hour earlier, at 21:00 UTC
    assert day_resets(summer - 7200, summer) == [summer - 3600]


def test_the_golden_file_is_what_python_computes_today():
    assert json.loads(orderflow_golden.FIXTURE.read_text(encoding="utf-8")) == orderflow_golden.build(), \
        "out of date: run python -m forex_replay.orderflow_golden"
