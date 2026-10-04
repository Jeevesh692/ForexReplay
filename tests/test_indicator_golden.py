"""The chart indicators are tested against web/tests/fixtures/indicators_golden.json.
These tests make sure that file is what the Python reference calculations produce."""

import json

from forex_replay.indicator_golden import FIXTURE, build, ema, rsi, sma


def test_fixture_is_up_to_date():
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == json.loads(json.dumps(build()))


def test_reference_calculations_on_numbers_you_can_check_by_hand():
    assert sma([1, 2, 3, 4, 5], 3) == [None, None, 2, 3, 4]
    assert ema([2, 4, 6, 8], 3) == [None, None, 4, 6]  # starts from the 3-value average 4; weight 0.5
    assert rsi([1, 2, 3, 4], 3)[3] == 100.0           # only gains
    assert rsi([4, 3, 2, 1], 3)[3] == 0.0             # only losses
    assert rsi([1, 2, 1, 2], 3)[3] == 100 - 100 / (1 + (2 / 3) / (1 / 3))


def test_atr_and_adr_on_numbers_you_can_check_by_hand():
    from forex_replay.indicator_golden import adr, atr
    # true ranges: 2 (first: high - low), then max(3-1, |3-2|, |1-2|) = 2, then max(5-4, |5-2|, |4-2|) = 3
    assert atr([2, 3, 5], [0, 1, 4], [2, 2, 4], 2) == [None, 2.0, 2.5]
    # Three server days (server midnight = 21:00 UTC in summer, 22:00 in winter); ADR(2) needs two completed days.
    day = 86400
    t0 = 1786665600 - 3 * 3600  # 21:00 UTC on 13 Aug 2026 = 00:00 server, a day boundary
    times = [t0 + 3600, t0 + day + 3600, t0 + 2 * day + 3600, t0 + 2 * day + 7200]
    highs, lows = [110, 120, 105, 112], [100, 100, 101, 101]
    a, hi, lo = adr(times, highs, lows, 2)
    assert a == [None, None, 15.0, 15.0]              # (10 + 20) / 2 from the two completed days, never today
    assert hi == [None, None, 101 + 15.0, 101 + 15.0]  # today's low so far + ADR
    assert lo == [None, None, 105 - 15.0, 112 - 15.0]  # today's high so far - ADR: moves as the day goes on
