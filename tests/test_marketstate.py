"""Market state labels (order flow, Phase 4): examples worked out by hand, no look-ahead, and the golden file kept current."""

import json

import pytest

from forex_replay import state_golden
from forex_replay.marketstate import market_state

DAY = 1762207200  # Mon 3 Nov 2025 22:00 UTC = 17:00 New York (winter): a trading day starts. 30-minute closes at DAY + 1800, + 3600 ...
VAL, VAH = 100, 200


def make(rows):
    """rows: (minute of the day, high, low, close). One-minute bars."""
    return {"seconds": 60, "time": [DAY + 60 * m for m, *_ in rows], "high": [r[1] for r in rows],
            "low": [r[2] for r in rows], "close": [r[3] for r in rows]}


def flat(first, last, price):
    """Quiet minutes from `first` to `last` at one price."""
    return [(m, price, price, price) for m in range(first, last + 1)]


def test_two_closes_above_value_are_acceptance_and_not_before_the_second_has_closed():
    b = make(flat(0, 59, 250))
    assert market_state(b, DAY + 3600, VAL, VAH) == {
        "events": [{"time": DAY + 3600, "kind": "accepted", "side": "above", "price": 250}], "state": "accepted_above", "price": 250}
    early = market_state(b, DAY + 3599, VAL, VAH)  # the second candle has not closed: one close above so far
    assert early["events"] == [] and early["state"] == "above"
    assert market_state(make(flat(0, 59, 50)), DAY + 3600, VAL, VAH)["state"] == "accepted_below"


def test_a_wick_above_value_and_a_close_back_inside_is_a_rejection():
    rows = flat(0, 9, 150) + [(10, 210, 150, 160)] + flat(11, 29, 160)
    out = market_state(make(rows), DAY + 1800, VAL, VAH)
    assert out["events"] == [{"time": DAY + 1800, "kind": "rejected", "side": "above", "price": 160}]
    assert out["state"] == "rejected_above"


def test_a_rejection_may_follow_one_close_outside_but_not_two():
    one = make([(5, 210, 190, 205)] + flat(6, 29, 205) + flat(30, 59, 150))  # outside at 00:05, one close above, back in by 01:00
    assert [(e["time"], e["kind"]) for e in market_state(one, DAY + 3600, VAL, VAH)["events"]] == [(DAY + 3600, "rejected")]
    two = make(flat(0, 59, 250) + flat(60, 89, 150))  # two closes above (accepted), then inside: no rejection
    out = market_state(two, DAY + 5400, VAL, VAH)
    assert [e["kind"] for e in out["events"]] == ["accepted"] and out["state"] == "inside"


def test_the_close_back_inside_must_come_within_the_window_of_the_first_trade_outside():
    rows = [(0, 210, 190, 205)] + flat(1, 29, 205) + flat(30, 59, 150)  # outside at 00:00, back inside at the 01:00 close
    assert market_state(make(rows), DAY + 3600, VAL, VAH)["state"] == "rejected_above"  # 60 minutes: just in
    late = market_state(make(rows), DAY + 3600, VAL, VAH, window=3540)  # 59 minutes allowed: too late
    assert late["events"] == [] and late["state"] == "inside"


def test_the_state_follows_the_last_close():
    rows = [(10, 210, 150, 160)] + flat(11, 29, 160) + flat(30, 59, 250) + flat(60, 89, 150)
    states = [market_state(make(rows), DAY + k * 1800, VAL, VAH)["state"] for k in (1, 2, 3)]
    assert states == ["rejected_above", "above", "rejected_above"]  # out at 00:30, one close above, back in by 01:30: again
    later = rows + flat(90, 179, 150)
    assert market_state(make(later), DAY + 6 * 1800, VAL, VAH)["state"] == "rejected_above"  # it lasts while closes stay inside
    slow = make(rows)
    out = market_state(slow, DAY + 3 * 1800, VAL, VAH, window=1800)  # with 30 minutes allowed, the second is too late
    assert [e["time"] for e in out["events"]] == [DAY + 1800] and out["state"] == "inside"


def test_before_the_first_close_without_a_value_area_and_before_any_bar():
    b = make(flat(0, 10, 250))
    assert market_state(b, DAY + 600, VAL, VAH)["state"] == "above"  # from the last one-minute close
    assert market_state(b, DAY + 600, None, None) == {"events": [], "state": "no_value", "price": None}
    assert market_state(make([]), DAY + 600, VAL, VAH)["state"] == "no_bars"
    with pytest.raises(ValueError):
        market_state(b, DAY + 600, VAL, VAH, timeframe=1200)


def test_only_the_cursors_trading_day_counts():
    yesterday = [(m - 1440, 250, 250, 250) for m in range(0, 120)]  # the day before: far above value
    b = make(yesterday + flat(0, 29, 150))
    assert market_state(b, DAY + 1800, VAL, VAH) == {"events": [], "state": "inside", "price": 150}


def test_bars_after_the_cursor_make_no_difference():
    data = state_golden.bars(__import__("random").Random(7))
    for cursor in range(DAY + 86400 + 300, DAY + 2 * 86400, 2333):
        cut = sum(1 for t in data["time"] if t + 60 <= cursor)
        only = {k: (v[:cut] if isinstance(v, list) else v) for k, v in data.items()}
        assert market_state(only, cursor, 219_900, 220_100) == market_state(data, cursor, 219_900, 220_100)


def test_the_golden_file_is_what_python_computes_today():
    assert json.loads(state_golden.FIXTURE.read_text(encoding="utf-8")) == state_golden.build(), \
        "out of date: run python -m forex_replay.state_golden"
