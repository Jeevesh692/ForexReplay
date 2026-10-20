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


def test_profit_by_day_and_month_and_the_dollar_drawdown():
    import pandas as pd
    from forex_replay.stats import max_drawdown_usd, period_table
    journal = pd.DataFrame({
        "result_r": [2.0, -1.0, -1.0, 0.0, 1.5],
        "pnl_usd": [196.0, -104.0, -104.0, None, 146.0],  # the fourth row is an old one without dollars
        "exit_time": pd.to_datetime(["2026-03-02 10:00", "2026-03-02 15:00", "2026-03-03 09:00", "2026-03-03 11:00", "2026-04-01 12:00"]),
    })
    days = period_table(journal, "day")
    assert list(days.index) == ["2026-04-01", "2026-03-03", "2026-03-02"]  # newest first
    assert days.loc["2026-03-02"].tolist() == [2, 0.5, 1.0, 92.0]
    assert days.loc["2026-03-03", "net_usd"] == -104.0 and days.loc["2026-03-03", "trades"] == 2
    months = period_table(journal, "month")
    assert months.loc["2026-03"].tolist() == [4, 0.25, 0.0, -12.0] and months.loc["2026-04", "net_usd"] == 146.0
    # dollars 0 -> 196 -> 92 -> -12 -> 134: the largest fall from a peak is 196 - (-12) = 208
    assert max_drawdown_usd(journal) == 208.0
    assert pd.isna(max_drawdown_usd(journal.assign(pnl_usd=None)))
