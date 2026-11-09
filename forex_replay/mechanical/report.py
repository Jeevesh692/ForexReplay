"""A backtest run: each pair through the engine, the trades in the Phase 8 log format, and the summary.

    <output>/<name>/trades.csv       one row per trade, the order-flow log's columns (oflog.COLUMNS)
    <output>/<name>/trades.xlsx      the same on a "Log" sheet, and the summary on a "Summary" sheet
    <output>/<name>/summary.md       the summary in words and tables
    <output>/<name>/skipped.csv      every setup or trigger the rules turned down, and why
    <output>/<name>/equity.csv       the balance after each trade
    <output>/<name>/config.yaml      the settings used, so a run can be repeated exactly
"""

from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .. import flow, oflog, stats
from ..loglib import load_base
from ..marketstate import market_state
from ..profile import server_day
from .engine import PairRun, cut, load_news


def manifest(symbol: str) -> dict:
    from ..config import PROJECT_ROOT

    path = PROJECT_ROOT / "web" / "data" / symbol / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def period(m1: dict, base, config: dict) -> tuple[int, int]:
    """From the first minute with a 20-day baseline (or the configured day) to the last minute of both data sets."""
    have = np.flatnonzero(m1["baseline_x2"] >= 0)
    start = int(m1["time"][have[0]]) if len(have) else int(m1["time"][0])
    end = int(min(m1["time"][-1], base.time[-1])) + 60
    day = lambda text: int(datetime.fromisoformat(str(text)).replace(tzinfo=timezone.utc).timestamp())
    if config.get("from"):
        start = max(start, day(config["from"]))
    if config.get("to"):
        end = min(end, day(config["to"]) + 86400)
    return start, end


def session_data(run: PairRun, config: dict, end: int) -> dict:
    """The run's trades as a saved session, so oflog.trade_row fills the log exactly as for your own trades."""
    a = config["account"]
    return {
        "id": f"mbt-{config['name']}-{run.symbol}", "symbol": run.symbol, "digits": run.digits, "pipPoints": run.pip,
        "barSeconds": 60, "timeframe": "M1", "furthestTime": end - 60, "actions": [],
        "settings": {"commissionPerLot": a["commission_per_lot"], "commissionPerSide": a["commission_per_side"],
                     "minSpreadPips": a["min_spread_pips"]},
        "drawings": run.drawings, "trades": run.closed,
        "orderflow": {
            "profile": {"valueArea": config["profile"]["value_area"], "smoothing": config["profile"]["smoothing"], "lvn": config["profile"]["lvn"]},
            "bin": config["bins"][run.symbol],
            "state": {"timeframe": run.tf, "accept": run.accept, "window": run.window},
            "layer": {"minRvol": config["bubbles"]["min_rvol"], "medium": config["bubbles"]["medium"], "large": config["bubbles"]["large"],
                      "bubbleMove": dict(config["bubbles"]["bubble_move"]), "absorptionMove": dict(config["bubbles"]["absorption_move"])},
            "trigger": {"atrPeriod": config["trigger"]["atr_period"], "bubbleRvol": config["trigger"]["bubble_rvol"],
                        "on": {"bubble": config["trigger"]["use_bubble_rule"]}},
            "costs": {"slippagePips": a["slippage_pips"]},
        },
    }


def rejection_poc(run: PairRun, start: int, end: int) -> tuple[int, int]:
    """Every rejection of the prior day's value (both sides), and how many reached the prior POC by the day's end."""
    total = reached = 0
    t = int(start - start % 3600)
    seen = set()
    while t < end:
        d = server_day(t)
        if d in seen:
            t += 3600
            continue
        seen.add(d)
        day_end = t
        while server_day(day_end) == d:
            day_end += 3600
        info = run.day(min(day_end, end))
        if info["prior"]:
            last = min(day_end, end)
            st = run.state(last, info["prior"])
            for e in st["events"]:
                if e["kind"] != "rejected":
                    continue
                total += 1
                after = cut(run.m1, e["time"], last - 59)
                poc = info["prior"]["poc"]
                reached += any(lo <= poc <= hi for lo, hi in zip(after["low"], after["high"]))
        t = day_end
    return total, reached


def summarize(rows: list[dict], runs: list[PairRun], config: dict, rejections: tuple[int, int]) -> dict:
    """The brief's summary, with stats.py (the app's one set of statistics) on the R after costs."""
    df = pd.DataFrame(rows)
    out = {"name": config["name"], "trades": len(df)}
    if df.empty:
        return {**out, "note": "no trades"}
    df["result_r"] = pd.to_numeric(df["result_r_after_costs"], errors="coerce")
    df["mfe_r"] = pd.to_numeric(df["mfe_r"], errors="coerce")
    df["exit_time"] = pd.to_datetime(df["exit_time_ny"], errors="coerce")
    df = df.sort_values("exit_time")
    s = stats.compute_stats(df)
    balance0 = config["account"]["balance"]
    worst_pct = 0.0
    for run in runs:
        curve = np.array([balance0] + [b for _, b in run.equity])
        peak = np.maximum.accumulate(curve)
        worst_pct = max(worst_pct, float(((peak - curve) / peak * 100).max()))
    out.update({
        "win_rate": s.win_rate, "expectancy_r": s.expectancy_r, "total_r": s.total_r, "profit_factor": s.profit_factor,
        "max_drawdown_r": s.max_drawdown_r, "max_drawdown_percent": worst_pct, "longest_losing_streak": s.longest_loss_streak,
        "end_balance": {r.symbol: round(r.balance, 2) for r in runs},
        "rejections": rejections[0], "rejections_reached_poc": rejections[1],
        "rejection_poc_rate": rejections[1] / rejections[0] if rejections[0] else None,
    })
    tags = df.assign(tag=df["tags"].fillna("").str.split("; ")).explode("tag")
    tags = tags[tags["tag"] != ""]
    out["by"] = {by: stats.breakdown(df, by).reset_index().to_dict("records") for by in ("pair", "session", "model")}
    out["by"]["tag"] = stats.breakdown(tags, "tag").reset_index().to_dict("records") if len(tags) else []
    return out


def summary_markdown(summary: dict, config: dict) -> str:
    if summary["trades"] == 0:
        return f"# Mechanical backtest: {summary['name']}\n\nNo trades.\n"
    pct = lambda v: "" if v is None else f"{v:.1%}"
    lines = [
        f"# Mechanical backtest: {summary['name']}", "",
        f"Pairs {', '.join(config['pairs'])}; risk {config['account']['risk_percent']}% "
        f"({config['account']['reduced_risk_percent']}% after {config['account']['losses_before_reduced']} losses in a row). "
        "Every result in R is after costs (commission and slippage; the spread is in the fills).", "",
        "| | |", "|---|---|",
        f"| Trades | {summary['trades']} |", f"| Win rate | {pct(summary['win_rate'])} |",
        f"| Expectancy after costs | {summary['expectancy_r']:+.3f}R |", f"| Total | {summary['total_r']:+.2f}R |",
        f"| Profit factor | {summary['profit_factor']:.2f} |",
        f"| Max drawdown | {summary['max_drawdown_r']:.2f}R; {summary['max_drawdown_percent']:.2f}% of the account |",
        f"| Longest losing streak | {summary['longest_losing_streak']} |",
        f"| Rejection → reached prior POC | {summary['rejections_reached_poc']} of {summary['rejections']} ({pct(summary['rejection_poc_rate'])}) |",
        f"| End balance | {', '.join(f'{k} ${v:,.2f}' for k, v in summary['end_balance'].items())} |", "",
    ]
    for by, rows in summary["by"].items():
        lines += [f"## By {by}", "", f"| {by} | trades | win rate | total R | expectancy R |", "|---|---|---|---|---|"]
        lines += [f"| {r[by]} | {r['trades']} | {pct(r['win_rate'])} | {r['total_r']:+.2f} | {r['expectancy_r']:+.3f} |" for r in rows]
        lines.append("")
    return "\n".join(lines)


def write_xlsx(path: Path, rows: list[dict], summary: dict) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "Log"
    ws.append(oflog.COLUMNS)
    for r in rows:
        ws.append([oflog._cell(str(r.get(c, ""))) for c in oflog.COLUMNS])
    for cell in ws[1]:
        cell.font, cell.fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="2962FF")
    ws.freeze_panes, ws.auto_filter.ref = "C2", ws.dimensions
    sm = wb.create_sheet("Summary")
    for key in ("name", "trades", "win_rate", "expectancy_r", "total_r", "profit_factor", "max_drawdown_r", "max_drawdown_percent",
                "longest_losing_streak", "rejections", "rejections_reached_poc", "rejection_poc_rate"):
        if key in summary:
            sm.append([key, summary[key]])
    for by, table in (summary.get("by") or {}).items():
        sm.append([])
        sm.append([f"by {by}", "trades", "win_rate", "total_r", "expectancy_r"])
        for r in table:
            sm.append([r[by], r["trades"], r["win_rate"], r["total_r"], r["expectancy_r"]])
    wb.save(path)


def run(config: dict, pairs: list[str] | None = None, progress=print) -> dict:
    """The whole backtest; returns the summary and writes the files."""
    import yaml

    out_dir = Path(config["output"]) / config["name"]
    out_dir.mkdir(parents=True, exist_ok=True)
    news = load_news(config["limits"]["news_file"])
    rows, runs, skipped, rej = [], [], [], [0, 0]
    for symbol in pairs or config["pairs"]:
        m1 = flow.read_flow(symbol, "M1")
        if m1 is None:
            progress(f"{symbol}: no order-flow data (python -m forex_replay flow build {symbol}); skipped")
            continue
        base = load_base(symbol)
        man = manifest(symbol)
        r = PairRun(symbol, config, base, m1, news, contract=man.get("contract_size"), digits=man.get("digits"),
                    pip_points=man.get("pip_points", 10))
        start, end = period(m1, base, config)
        progress(f"{symbol}: {datetime.fromtimestamp(start, timezone.utc):%Y-%m-%d} to {datetime.fromtimestamp(end - 60, timezone.utc):%Y-%m-%d}")
        r.run(start, end)
        data = session_data(r, config, end)
        ctx = oflog.Context(data, base, m1)
        for t in r.closed:
            row = oflog.trade_row(t, data, ctx)
            rows.append(row)
        total, reached = rejection_poc(r, start, end)
        rej[0] += total
        rej[1] += reached
        skipped += r.skipped
        runs.append(r)
        progress(f"{symbol}: {len(r.closed)} trades, {len(r.skipped)} setups or triggers turned down, end balance ${r.balance:,.2f}")
    rows.sort(key=lambda x: (x["entry_time_ny"], x["pair"]))
    with (out_dir / "trades.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=oflog.COLUMNS, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    with (out_dir / "skipped.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["time_ist", "pair", "model", "side", "reason"], lineterminator="\n")
        w.writeheader()
        for s in skipped:
            w.writerow({"time_ist": oflog.ist_text(s["time"]), **{k: s[k] for k in ("pair", "model", "side", "reason")}})
    with (out_dir / "equity.csv").open("w", newline="", encoding="utf-8") as f:
        f.write("pair,time_ist,balance\n")
        for r in runs:
            for t, b in r.equity:
                f.write(f"{r.symbol},{oflog.ist_text(t)},{b:.2f}\n")
    summary = summarize(rows, runs, config, tuple(rej))
    (out_dir / "summary.md").write_text(summary_markdown(summary, config), encoding="utf-8")
    (out_dir / "config.yaml").write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    write_xlsx(out_dir / "trades.xlsx", rows, summary)
    summary["folder"] = str(out_dir)
    summary["runs"] = runs
    summary["rows"] = rows
    return summary
