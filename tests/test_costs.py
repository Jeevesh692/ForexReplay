"""The position tool's sums (order flow, Phase 7): examples by hand and the golden file kept current."""

import json

import pytest

from forex_replay import costs_golden
from forex_replay.costs import position_plan, units_for_risk

EUR = {"balance": 10000, "risk_percent": 0.5, "point_value": 1.0, "pip_points": 10, "spread_points": 10}


def test_size_cost_and_r_after_costs_by_hand():
    p = position_plan("long", 110000, 109900, 110250, **EUR)
    assert p["units"] == 50  # $50 at risk / $100 a lot at a 10-pip stop
    assert (p["stop_pips"], p["rr"]) == (10.0, 2.5)
    assert p["cost_r"] == pytest.approx(0.16)  # ((10 + 2) points x $1 + $4) / $100
    assert p["target_r"] == pytest.approx(2.34) and p["stop_r"] == pytest.approx(-1.16)
    assert p["cost_money"] == pytest.approx(8.0)
    assert position_plan("long", 110000, 109900, 110250, **EUR, per_side=True)["cost_r"] == pytest.approx(0.20)


def test_a_short_mirrors_and_wrong_sides_are_refused():
    p = position_plan("short", 110000, 110100, 109750, **EUR)
    assert p["units"] == 50 and p["rr"] == 2.5
    assert "error" in position_plan("short", 110000, 109900, 110250, **EUR)
    assert "error" in position_plan("long", 110000, 110000, 110250, **EUR)


def test_warnings():
    p = position_plan("long", 110000, 109950, 110105, **EUR, min_stop_pips=6, max_stop_pips=20, min_target_r=2.0)
    assert p["warnings"] == ["stop_below_min", "target_below_min"]  # 5 pips; 2.1R before costs, under 2R after
    wide = position_plan("long", 110000, 109750, 110600, **EUR, min_stop_pips=6, max_stop_pips=20, min_target_r=2.0)
    assert wide["warnings"] == ["stop_above_max"]
    tiny = position_plan("long", 110000, 109000, 112000, **{**EUR, "balance": 100})
    assert tiny["units"] == 0 and tiny["warnings"] == ["too_small"]
    assert tiny["cost_r"] > 0  # cost in R is still known: it does not depend on the size


def test_units_match_the_accounts_rule():
    assert units_for_risk(10000, 1, 100, 1.0) == 100
    assert units_for_risk(10000, 1, 0, 1.0) == 0
    assert units_for_risk(10000, 0.5, 150, 100000 / 150000) == 50  # USDJPY at 150.000: the point is worth less


def test_the_golden_file_is_what_python_computes_today():
    assert json.loads(costs_golden.FIXTURE.read_text(encoding="utf-8")) == costs_golden.build(), \
        "out of date: run python -m forex_replay.costs_golden"
