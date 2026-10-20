"""Performance statistics on a trade journal, measured in R multiples.

Trades are analysed in the order they were logged (the order you took them),
not by timestamp: replaying the same weeks twice is common and sorting by date
would interleave two separate runs.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

BREAKEVEN_TOLERANCE_R = 0.05  # |result| below this counts as breakeven


def classify(r: float, tol: float = BREAKEVEN_TOLERANCE_R) -> str:
    if r > tol:
        return "win"
    if r < -tol:
        return "loss"
    return "breakeven"


def equity_curve(results_r: pd.Series) -> pd.Series:
    """Cumulative R after each trade, starting from 0."""
    return results_r.reset_index(drop=True).cumsum()


def max_drawdown_r(results_r: pd.Series) -> float:
    """Largest peak-to-trough fall of the equity curve, in R (positive number)."""
    equity = np.concatenate([[0.0], equity_curve(results_r).to_numpy()])
    peaks = np.maximum.accumulate(equity)
    return float((peaks - equity).max())


def longest_streak(outcomes: pd.Series, kind: str) -> int:
    best = current = 0
    for outcome in outcomes:
        if outcome == kind:
            current += 1
            best = max(best, current)
        elif outcome != "breakeven":  # breakevens don't break a streak
            current = 0
    return best


@dataclass
class Stats:
    trades: int
    wins: int
    losses: int
    breakevens: int
    win_rate: float
    avg_win_r: float
    avg_loss_r: float
    payoff_ratio: float
    expectancy_r: float
    total_r: float
    profit_factor: float
    max_drawdown_r: float
    longest_win_streak: int
    longest_loss_streak: int
    avg_mfe_r: float
    worst_day_r: float
    avg_duration_min: float


def compute_stats(journal: pd.DataFrame) -> Stats | None:
    df = journal.dropna(subset=["result_r"])
    if df.empty:
        return None
    r = df["result_r"].astype(float)
    outcomes = r.map(classify)
    wins, losses = r[outcomes == "win"], r[outcomes == "loss"]

    gross_profit, gross_loss = wins.sum(), -losses.sum()
    avg_win = wins.mean() if len(wins) else 0.0
    avg_loss = losses.mean() if len(losses) else 0.0

    if "exit_time" in df and df["exit_time"].notna().any():
        run = (df["run_id"].fillna("").astype(str) if "run_id" in df
               else pd.Series("", index=df.index))
        worst_day = float(r.groupby([run, df["exit_time"].dt.date]).sum().min())
    else:
        worst_day = float("nan")

    return Stats(
        trades=len(r),
        wins=len(wins),
        losses=len(losses),
        breakevens=int((outcomes == "breakeven").sum()),
        win_rate=len(wins) / len(r),
        avg_win_r=float(avg_win),
        avg_loss_r=float(avg_loss),
        payoff_ratio=float(avg_win / -avg_loss) if avg_loss else float("inf"),
        expectancy_r=float(r.mean()),
        total_r=float(r.sum()),
        profit_factor=float(gross_profit / gross_loss) if gross_loss else float("inf"),
        max_drawdown_r=max_drawdown_r(r),
        longest_win_streak=longest_streak(outcomes, "win"),
        longest_loss_streak=longest_streak(outcomes, "loss"),
        avg_mfe_r=float(df["mfe_r"].mean()) if "mfe_r" in df and df["mfe_r"].notna().any() else float("nan"),
        worst_day_r=worst_day,
        avg_duration_min=float(df["duration_min"].mean()) if "duration_min" in df else float("nan"),
    )


def breakdown(journal: pd.DataFrame, by: str) -> pd.DataFrame:
    """Trades, win rate, total R and expectancy per group (session, weekday, side...)."""
    df = journal.dropna(subset=["result_r"])
    grouped = df.groupby(by, sort=False)["result_r"]
    usd = pd.to_numeric(df["pnl_usd"], errors="coerce") if "pnl_usd" in df else pd.Series(np.nan, index=df.index)
    table = pd.DataFrame({
        "trades": grouped.size(),
        "win_rate": grouped.apply(lambda s: (s > BREAKEVEN_TOLERANCE_R).mean()),
        "total_r": grouped.sum(),
        "expectancy_r": grouped.mean(),
        "net_usd": usd.groupby(df[by], sort=False).sum(min_count=1),  # NaN when no row of the group has dollars
    })
    return table.sort_values("trades", ascending=False)


def period_table(journal: pd.DataFrame, period: str) -> pd.DataFrame:
    """Trades, win rate, total R and net dollars per day or month, newest first.

    A trade counts on the day (or month) it closed, when its result was banked. Days are the
    broker server's dates (a day ends 17:00 New York), as the journal's times are. A row with no
    dollar amount (older journals) adds to the trades and R but not to the dollars. Trades of every
    run on that date are added together: filter one run to see one session.
    """
    if period not in ("day", "month"):
        raise ValueError(f"period must be 'day' or 'month', not {period!r}")
    df = journal.dropna(subset=["result_r"])
    df = df[df["exit_time"].notna()] if "exit_time" in df else df.iloc[0:0]
    columns = ["trades", "win_rate", "total_r", "net_usd"]
    if df.empty:
        return pd.DataFrame(columns=columns)
    key = df["exit_time"].dt.strftime("%Y-%m-%d" if period == "day" else "%Y-%m")
    r = df["result_r"].astype(float)
    usd = pd.to_numeric(df["pnl_usd"], errors="coerce") if "pnl_usd" in df else pd.Series(np.nan, index=df.index)
    table = pd.DataFrame({
        "trades": r.groupby(key).size(),
        "win_rate": (r > BREAKEVEN_TOLERANCE_R).groupby(key).mean(),
        "total_r": r.groupby(key).sum(),
        "net_usd": usd.groupby(key).sum(min_count=1),  # NaN when no row of the period has dollars
    })
    return table.sort_index(ascending=False)


def max_drawdown_usd(journal: pd.DataFrame) -> float:
    """Largest fall from a peak of the dollar equity curve (from 0, in logged order), as a positive number.
    Only rows with a dollar amount count; NaN when none has one."""
    df = journal.dropna(subset=["result_r"])
    usd = pd.to_numeric(df["pnl_usd"], errors="coerce").dropna() if "pnl_usd" in df else pd.Series(dtype=float)
    if usd.empty:
        return float("nan")
    equity = np.concatenate([[0.0], usd.to_numpy().cumsum()])
    return float((np.maximum.accumulate(equity) - equity).max())


def money_stats(journal: pd.DataFrame, start_balance: float | None = None) -> dict:
    """The dollar side of a journal, as replay tools usually show it.

    Wins and losses in dollars go by the sign of the dollar result (after commission), so a trade at
    breakeven in R that paid commission is a small dollar loss. Rows without dollars (older journals)
    are left out of the dollar figures. Days, as for the worst day in R, are per run and closing date.
    With the session's starting balance: the ending balance, the return and the largest fall from a
    peak of the balance, in % of that peak.
    """
    df = journal.dropna(subset=["result_r"])
    r = df["result_r"].astype(float)
    usd_all = pd.to_numeric(df["pnl_usd"], errors="coerce") if "pnl_usd" in df else pd.Series(np.nan, index=df.index)
    usd = usd_all.dropna()
    won, lost = usd[usd > 0], usd[usd < 0]
    nan = float("nan")
    gross_profit = float(won.sum()) if len(usd) else nan
    gross_loss = float(-lost.sum()) if len(usd) else nan
    out = {
        "trades_with_usd": int(len(usd)),
        "net_usd": float(usd.sum()) if len(usd) else nan,
        "gross_profit_usd": gross_profit,
        "gross_loss_usd": gross_loss,
        "profit_factor_usd": (gross_profit / gross_loss if gross_loss else float("inf")) if len(usd) else nan,
        "avg_win_usd": float(won.mean()) if len(won) else nan,
        "avg_loss_usd": float(lost.mean()) if len(lost) else nan,
        "largest_win_usd": float(won.max()) if len(won) else nan,
        "largest_loss_usd": float(lost.min()) if len(lost) else nan,
        "largest_win_r": float(r.max()) if (r > BREAKEVEN_TOLERANCE_R).any() else nan,
        "largest_loss_r": float(r.min()) if (r < -BREAKEVEN_TOLERANCE_R).any() else nan,
        "best_day_r": nan, "best_day_usd": nan, "worst_day_usd": nan,
        "avg_planned_rr": float(pd.to_numeric(df["planned_rr"], errors="coerce").mean())
        if "planned_rr" in df and pd.to_numeric(df["planned_rr"], errors="coerce").notna().any() else nan,
        "max_drawdown_usd": max_drawdown_usd(journal),
        "start_balance": nan, "end_balance": nan, "return_pct": nan, "max_drawdown_pct": nan,
    }
    if "exit_time" in df and df["exit_time"].notna().any():
        run = df["run_id"].fillna("").astype(str) if "run_id" in df else pd.Series("", index=df.index)
        day = df["exit_time"].dt.date
        out["best_day_r"] = float(r.groupby([run, day]).sum().max())
        if len(usd):
            per_day = usd_all.groupby([run, day]).sum(min_count=1).dropna()
            out["best_day_usd"], out["worst_day_usd"] = float(per_day.max()), float(per_day.min())
    if start_balance is not None and start_balance > 0:
        out["start_balance"] = float(start_balance)
        net = out["net_usd"] if len(usd) else 0.0
        out["end_balance"] = float(start_balance + net)
        out["return_pct"] = float(net / start_balance * 100)
        balance = np.concatenate([[start_balance], start_balance + usd.to_numpy().cumsum()])
        peaks = np.maximum.accumulate(balance)
        out["max_drawdown_pct"] = float(((peaks - balance) / peaks).max() * 100)
    return out


@dataclass
class PropFirmCheck:
    risk_per_trade_pct: float
    return_pct: float
    max_drawdown_pct: float
    worst_day_pct: float
    daily_limit_pct: float
    max_limit_pct: float
    target_pct: float

    @property
    def breaches_daily(self) -> bool:
        return self.worst_day_pct <= -self.daily_limit_pct

    @property
    def breaches_max(self) -> bool:
        return self.max_drawdown_pct >= self.max_limit_pct

    @property
    def hits_target(self) -> bool:
        return self.return_pct >= self.target_pct


def prop_firm_check(stats: Stats, risk_per_trade_pct: float = 1.0, daily_limit_pct: float = 5.0,
                    max_limit_pct: float = 10.0, target_pct: float = 8.0) -> PropFirmCheck:
    """Translate R results into account % for a typical funded-challenge rule set
    (fixed % risk per trade, no compounding)."""
    return PropFirmCheck(
        risk_per_trade_pct=risk_per_trade_pct,
        return_pct=stats.total_r * risk_per_trade_pct,
        max_drawdown_pct=stats.max_drawdown_r * risk_per_trade_pct,
        worst_day_pct=stats.worst_day_r * risk_per_trade_pct,
        daily_limit_pct=daily_limit_pct,
        max_limit_pct=max_limit_pct,
        target_pct=target_pct,
    )


def format_report(journal: pd.DataFrame, risk_per_trade_pct: float = 1.0) -> str:
    stats = compute_stats(journal)
    if stats is None:
        return "No closed trades yet."

    pf = "inf" if stats.profit_factor == float("inf") else f"{stats.profit_factor:.2f}"
    lines = [
        "=============== STATISTICS ===============",
        f"Trades            : {stats.trades}  (W {stats.wins} / L {stats.losses} / BE {stats.breakevens})",
        f"Win rate          : {stats.win_rate:.1%}",
        f"Average win       : {stats.avg_win_r:+.2f} R",
        f"Average loss      : {stats.avg_loss_r:+.2f} R",
        f"Payoff ratio      : {stats.payoff_ratio:.2f}",
        f"Expectancy        : {stats.expectancy_r:+.2f} R per trade",
        f"Total             : {stats.total_r:+.2f} R",
        f"Profit factor     : {pf}",
        f"Max drawdown      : {stats.max_drawdown_r:.2f} R",
        f"Longest win/loss  : {stats.longest_win_streak} / {stats.longest_loss_streak} trades",
    ]
    if not np.isnan(stats.avg_mfe_r):
        with_mfe = int(journal["mfe_r"].notna().sum())
        note = "" if with_mfe == stats.trades else f"  (only {with_mfe} trade(s) have MFE recorded)"
        lines.append(f"Average MFE       : {stats.avg_mfe_r:.2f} R{note}")
    if not np.isnan(stats.avg_duration_min):
        lines.append(f"Average duration  : {stats.avg_duration_min:.0f} min")

    check = prop_firm_check(stats, risk_per_trade_pct)
    lines += [
        "",
        f"At {risk_per_trade_pct:g}% risk per trade (typical challenge: "
        f"{check.target_pct:g}% target, {check.daily_limit_pct:g}% daily, {check.max_limit_pct:g}% max loss):",
        f"  Return {check.return_pct:+.1f}% | max drawdown {check.max_drawdown_pct:.1f}% | "
        f"worst day {check.worst_day_pct:+.1f}%",
        "  " + ", ".join([
            "target reached" if check.hits_target else "target not reached",
            "DAILY LIMIT BREACHED" if check.breaches_daily else "daily limit ok",
            "MAX LOSS BREACHED" if check.breaches_max else "max loss ok",
        ]),
    ]

    if "session" in journal and journal["session"].notna().any():
        lines += ["", "By session:", breakdown(journal, "session").to_string(
            formatters={"win_rate": "{:.0%}".format, "total_r": "{:+.2f}".format,
                        "expectancy_r": "{:+.2f}".format})]
    lines.append("==========================================")
    return "\n".join(lines)
