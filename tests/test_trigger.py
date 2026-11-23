"""The trigger panel's rules (order flow, Phase 6): examples by hand, no look-ahead, and the golden file kept current."""

import json

from forex_replay import trigger_golden
from forex_replay.trigger import atr_before, bubble_rule, candle_rules, current_m5, m5_candles, trigger

T = 1762207200


def minutes(rows):
    """rows: (minute, open, high, low, close)."""
    return {"time": [T + 60 * r[0] for r in rows], "open": [r[1] for r in rows], "high": [r[2] for r in rows],
            "low": [r[3] for r in rows], "close": [r[4] for r in rows]}


def test_the_current_candle_forms_from_the_minutes_and_closes_at_its_close():
    m = minutes([(0, 100, 110, 95, 105), (1, 105, 120, 104, 118), (2, 118, 119, 100, 101), (5, 101, 102, 99, 100)])
    assert current_m5(m, T + 59) is None
    assert current_m5(m, T + 120) == {"start": T, "open": 100, "high": 120, "low": 95, "close": 118, "minutes": 2, "closed": False}
    assert current_m5(m, T + 300)["closed"] is True  # minutes 3 and 4 are missing: the candle still closes at T + 300
    assert current_m5(m, T + 360)["start"] == T + 300


def test_atr_is_taken_at_the_candle_before():
    m = minutes([(5 * k, 100, 100 + k, 100, 100) for k in range(20)])  # one minute per 5-minute candle, ranges 0..19
    m5 = m5_candles(m)
    assert atr_before(m5, T + 5 * 60 * 13, 14) is None  # 13 candles before it: not yet 14
    assert atr_before(m5, T + 5 * 60 * 14, 14) == sum(range(14)) / 14  # the first ATR: the average of 14 ranges
    assert atr_before(m5, T + 5 * 60 * 15, 14) == (sum(range(14)) / 14 * 13 + 14) / 14  # Wilder's next step: (previous x 13 + range) / 14


def test_the_four_candle_rules_by_hand():
    r = candle_rules(100, 200, 95, 195, 80, 2.0, "long")
    assert all(r[k]["pass"] for k in ("body", "range", "close", "rvol"))
    assert candle_rules(100, 200, 95, 195, 80, 2.0, "short")["close"]["pass"] is False
    flat = candle_rules(100, 100, 100, 100, 80, None, "long")
    assert not any(flat[k]["pass"] for k in flat) and flat["body"]["value"] is None
    assert candle_rules(100, 200, 95, 195, None, 2.0, "long")["range"]["pass"] is False  # no ATR yet: cannot pass
    edge = candle_rules(100, 196, 100, 172, 80, 1.5, "long")  # exactly on every line: range 96 = 1.2 x 80, body 72 of 96,
    assert all(edge[k]["pass"] for k in edge)                 # close at 172 = 196 - 25% of 96, RVOL 1.5: "at least" passes


def test_the_bubble_rule_by_hand():
    z = [{"low": 100, "high": 120}]
    up = {"kind": "bubble", "side": "up", "rvol": 3.5, "price": 110, "delta": 9}
    assert bubble_rule([up], z, 105, 140, "long")["pass"] is True
    assert bubble_rule([up], z, 105, 140, "short")["pass"] is False
    buyers_absorbed = {"kind": "absorption", "side": None, "rvol": 4, "price": 115, "delta": 6}
    assert bubble_rule([up, buyers_absorbed], z, 105, 140, "long") == {"pass": False, "zone": z[0], "same": 1, "opposite": 1}
    assert bubble_rule([up], z, 121, 140, "long")["zone"] is None  # the candle never traded into the zone
    assert bubble_rule([dict(up, rvol=2.9)], z, 105, 140, "long")["pass"] is False


def test_the_overall_light_needs_every_rule_switched_on():
    rules = {k: {"pass": True} for k in ("body", "range", "close", "rvol")} | {"bubble": {"pass": False}}
    on = {"body": True, "range": True, "close": True, "rvol": True, "bubble": False}
    assert trigger(rules, on) is True
    assert trigger(rules, on | {"bubble": True}) is False
    assert trigger(rules, {k: False for k in on}) is False


def test_minutes_after_the_cursor_make_no_difference():
    m = trigger_golden.minutes(__import__("random").Random(3))
    for cursor in range(T + 500, T + 30000, 977):
        keep = sum(1 for t in m["time"] if t + 60 <= cursor)
        cut = {k: v[:keep] for k, v in m.items()}
        assert current_m5(cut, cursor) == current_m5(m, cursor)


def test_the_golden_file_is_what_python_computes_today():
    assert json.loads(trigger_golden.FIXTURE.read_text(encoding="utf-8")) == trigger_golden.build(), \
        "out of date: run python -m forex_replay.trigger_golden"
