import pandas as pd
import pytest

from forex_replay.stats import (compute_stats, format_report, longest_streak, max_drawdown_r,
                                prop_firm_check)


def journal(results, days=None):
    days = days or ["2025-03-03"] * len(results)
    return pd.DataFrame({
        "run_id": "run",
        "result_r": results,
        "exit_time": pd.to_datetime(days),
        "session": "London",
        "mfe_r": [None] * len(results),
        "duration_min": 10,
    })


def test_core_metrics():
    s = compute_stats(journal([2.0, -1.0, 1.0, -1.0, 0.0]))
    assert (s.trades, s.wins, s.losses, s.breakevens) == (5, 2, 2, 1)
    assert s.win_rate == pytest.approx(0.4)
    assert s.total_r == pytest.approx(1.0)
    assert s.expectancy_r == pytest.approx(0.2)
    assert s.profit_factor == pytest.approx(1.5)
    assert s.payoff_ratio == pytest.approx(1.5)


def test_breakeven_is_not_counted_as_a_loss():
    s = compute_stats(journal([0.02, -0.01]))
    assert s.losses == 0 and s.breakevens == 2


def test_max_drawdown_is_peak_to_trough_including_from_zero():
    assert max_drawdown_r(pd.Series([1, 1, -1, -1, -1, 2])) == pytest.approx(3)
    assert max_drawdown_r(pd.Series([-1, -1, 3])) == pytest.approx(2)


def test_streaks_ignore_breakevens():
    outcomes = pd.Series(["loss", "breakeven", "loss", "win", "loss"])
    assert longest_streak(outcomes, "loss") == 2


def test_worst_day_groups_by_exit_date():
    s = compute_stats(journal([-1, -1, 2], days=["2025-03-03", "2025-03-03", "2025-03-04"]))
    assert s.worst_day_r == pytest.approx(-2)


def test_prop_firm_check_flags_breaches():
    s = compute_stats(journal([-1.0] * 11))
    check = prop_firm_check(s, risk_per_trade_pct=1.0)
    assert check.breaches_max
    assert check.breaches_daily  # all on one day: -11%


def test_report_handles_empty_journal():
    assert format_report(journal([])) == "No closed trades yet."
