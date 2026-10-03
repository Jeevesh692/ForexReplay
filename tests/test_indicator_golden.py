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
