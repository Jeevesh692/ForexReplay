"""The order-flow trade log (order flow, Phase 8): one row per closed trade, worked out from the saved session.

    strategies/<strategy>/orderflow_log.csv          one row per closed trade (other sessions' rows are kept)
    strategies/<strategy>/OrderFlow_Backtest_Log.xlsx  the same rows on the "Log" sheet; other sheets are kept

Written on every save of a strategy whose logger is "orderflow" (strategy.json), and rebuilt from every saved
session with `python -m forex_replay orderflow <strategy>`. Decision 0040.

Everything the app knows is filled in, measured at the moment the order was placed (the close of the 1-minute
candle the clock was on), with the same definitions as the app (Phases 2-7): the market state and the 30-minute
close that decided it, the LVN zone of your profile drawings the trade was taken at and its retracement of the
profile's leg, whether it sat near a VAH or VAL of the last five days, the trigger candle's numbers, the costs,
and whether the prior day's POC was reached after entry. Two answers come from you, in the journal box (the
strategy's checklist): the model (A or B) and, when the app cannot tell, the exit reason. Tags are the trade's.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from . import flow
from .costs import point_value, position_plan
from .loglib import (Candles, fmt_num, fmt_price, logger_candles, previous_rows, replace_file, settings_at, spread_at,
                     trade_fields, wilder_atr, write_keyed_csv)
from .marketstate import market_state
from .orderflow import bubbles, candle_flow
from .sessions import session_label
from .profile import build_profile, day_levels, price_bin, profile_from_bars, server_day, server_days
from .trigger import candle_rules, current_m5

LOG_FILE, WORKBOOK, SHEET = "orderflow_log.csv", "OrderFlow_Backtest_Log.xlsx", "Log"
OF_COLUMNS = [
    "pair", "session", "model", "state", "state_close_ist", "lvn_low", "lvn_high", "lvn_retracement_pct", "near_old_va",
    "trigger_candle_ist", "body_pct", "range_atr", "close_location_pct", "rvol", "bubble_rvol", "stop_pips", "cost_r",
    "result_r_after_costs", "mfe_r", "mae_r", "prior_poc", "reached_poc", "of_exit_reason", "screenshots",
]
COLUMNS = ["run_id", "trade_id", "date_ny", "weekday", "side", "order_type", "placed_time_ny", "entry_time_ny", "exit_time_ny",
           "entry_price", "stop_loss", "take_profit", "exit_price", "exit_reason", "lots", "actual_r", "pnl_usd",
           "commission_usd", "risk_pips", "spread_pips", "tags", "note"] + OF_COLUMNS
CHECKLIST = [  # the strategy's questions when it is made with this logger (strategy_folders.save_strategy)
    {"id": "model", "text": "Model", "kind": "choice", "options": ["A", "B"]},
    {"id": "exit_reason", "text": "Exit reason (when the app cannot tell)", "kind": "choice",
     "options": ["time stop", "state invalidation", "trail", "breakeven", "target", "stop"]},
]
INSTRUMENT_MOVES = {"EURUSD": (0.00015, 0.00003), "XAUUSD": (0.50, 0.10)}  # bubble and absorption moves (flow.INSTRUMENTS)
NEAR_VA_PIPS = 3.0  # a zone (or the entry) this close to an older VAH or VAL counts as near it
OLD_VA_DAYS = 5
IST = ZoneInfo("Asia/Kolkata")


def ist_text(utc) -> str:
    return "" if utc is None else datetime.fromtimestamp(int(utc), IST).strftime("%Y-%m-%d %H:%M")


def cut(bars: dict, start: float, end: float) -> dict:
    """The bars with open time in [start, end), as plain lists (the shared definitions read lists)."""
    a, b = np.searchsorted(bars["time"], [start, end])
    return {k: (v[a:b].tolist() if isinstance(v, np.ndarray) else v) for k, v in bars.items()}


def settings(data: dict) -> dict:
    """The order-flow settings the session was saved with (main.js puts them in the save), with the app's defaults."""
    of = data.get("orderflow") or {}
    profile = {"valueArea": 0.70, "smoothing": 3, "lvn": 0.35, **(of.get("profile") or {})}
    state = {"timeframe": 1800, "accept": 2, "window": 3600, **(of.get("state") or {})}
    layer = {"minRvol": 3.0, "medium": 5.0, "large": 8.0, **(of.get("layer") or {})}
    trigger = {"atrPeriod": 14, "bubbleRvol": 3.0, "on": {}, **(of.get("trigger") or {})}
    costs = {"slippagePips": 0.2, **(of.get("costs") or {})}
    return {"profile": profile, "state": state, "layer": layer, "trigger": trigger, "costs": costs, "bin": of.get("bin")}


def months_between(start: int, end: int) -> list[str]:
    """Every "YYYY-MM" (UTC) from start to end."""
    month = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m")
    out, t = [], start
    while month(t) <= month(end):
        if month(t) not in out:
            out.append(month(t))
        t += 86400
    return out


def day_end(cursor: int) -> int:
    """The start of the next trading day (17:00 New York) after the cursor's own."""
    today = server_day(cursor - 1)
    h = cursor - cursor % 3600 + 3600
    while server_day(h) == today:
        h += 3600
    return h


def contract_size(symbol: str) -> int:
    """Units in one lot, from the pair's data manifest (100 ounces for gold), else 100,000."""
    from .config import PROJECT_ROOT

    path = PROJECT_ROOT / "web" / "data" / symbol / "manifest.json"
    try:
        return int(json.loads(path.read_text(encoding="utf-8")).get("contract_size") or 100000)
    except (OSError, ValueError):
        return 100000


class Context:
    """What every trade of a session shares: candles, order-flow bars, ATR on every 5-minute candle."""

    def __init__(self, data: dict, base: Candles, m1: dict | None = None, s15_reader=None):
        self.data, self.base = data, base
        self.symbol, self.digits, self.pip = data.get("symbol") or "EURUSD", data["digits"], data["pipPoints"]
        self.m1 = m1 if m1 is not None else flow.read_flow(self.symbol, "M1")
        self.s15_reader = s15_reader or (lambda months: flow.read_flow(self.symbol, "S15", months))
        self.s = settings(data)
        m5 = logger_candles(data, base)
        self.m5 = m5
        self.atr = wilder_atr(m5.high.astype(float), m5.low.astype(float), m5.close.astype(float), int(self.s["trigger"]["atrPeriod"]))
        self.contract = contract_size(self.symbol)
        default_bin = {"EURUSD": 0.0001, "XAUUSD": 0.5}.get(self.symbol, self.pip / 10 ** self.digits)
        self.bin = max(1, price_bin(self.s["bin"] or default_bin, self.digits))


def zones_at(ctx: Context, cursor: int) -> list[dict]:
    """LVN zones of the session's profile drawings at the cursor, each with its profile's leg (bottom, top)."""
    out = []
    tf = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}.get(ctx.data.get("timeframe"), 900)
    drawings = ctx.data.get("drawings") or []
    for d in drawings.get("items", []) if isinstance(drawings, dict) else drawings:
        if d.get("type") not in ("vprofile", "aprofile") or not d.get("profile"):
            continue
        p = d["profile"]
        times = [pt["time"] for pt in d["points"]]
        start, end = (min(times), max(times) + tf) if d["type"] == "vprofile" else (times[0], cursor)
        bars = ctx.m1
        if p.get("source") == "S15":
            bars = ctx.s15_reader(months_between(int(start), int(end)))
        if bars is None:
            continue
        b = max(1, price_bin(p.get("bin") or ctx.bin / 2 / 10 ** ctx.digits, ctx.digits))
        pr = profile_from_bars(cut(bars, start, end), start, end, b, cursor,
                               value_area=p.get("valueArea", 0.7), smoothing=p.get("smoothing", 3), lvn=p.get("lvn", 0.35))
        if not pr:
            continue
        bottom, top = pr["first_bin"] * pr["bin_size"], (pr["first_bin"] + len(pr["volumes"])) * pr["bin_size"]
        out += [{"low": z["low"], "high": z["high"], "bottom": bottom, "top": top} for z in pr["lvns"]]
    return out


def trade_row(trade: dict, data: dict, ctx: Context) -> dict:
    """One row: the trade as traded, then what the order flow said when it was placed."""
    row = trade_fields(trade, data, ctx.base)
    row.update({c: "" for c in OF_COLUMNS})
    s, digits, pip = ctx.s, ctx.digits, ctx.pip
    side = "long" if trade["side"] == "BUY" else "short"
    cursor = int(trade.get("placedTime") or trade["entryTime"]) + int(data.get("barSeconds") or 60)
    answers = trade.get("answers") or {}
    price = lambda units: fmt_price(units / 2, digits) if units is not None else ""  # flow units -> price text
    row.update(pair=ctx.symbol, session=session_label(int(trade["entryTime"])), model=answers.get("model", ""),
               screenshots="; ".join(f"screenshots/{n}" for n in trade.get("screenshots") or []),
               mfe_r=fmt_num(trade.get("mfeR"), 2), mae_r=fmt_num(trade.get("maeR"), 2))
    entry, stop = trade.get("entryPrice"), trade.get("initialStop", trade.get("stopLoss"))
    risk_points = trade.get("plannedRisk") or (abs(entry - stop) if entry is not None and stop is not None else None)
    if risk_points:
        row["stop_pips"] = fmt_num(risk_points / pip, 1)

    # Costs: the round trip's cost in R as the position tool works it out, and the result after commission and
    # slippage (the spread is already in the result: fills are at the bid and the ask).
    if entry is not None and stop is not None and risk_points:
        acct = settings_at(data, int(trade["entryTime"]))
        pv = point_value(ctx.symbol, digits, ctx.contract, int(entry))
        i = ctx.base.index_at(int(trade["entryTime"]))
        spread = spread_at(data, ctx.base, i, int(trade["entryTime"])) if i >= 0 else 0
        rt = float(acct.get("commissionPerLot", 4)) * (2 if acct.get("commissionPerSide") else 1)
        slip = float(s["costs"]["slippagePips"]) * pip
        target = trade.get("takeProfit")
        direction = 1 if side == "long" else -1
        far = target if target is not None and direction * (target - entry) > 0 else entry + direction * risk_points
        plan = position_plan(side, int(entry), int(entry) - direction * int(risk_points), int(far), balance=1, risk_percent=1,
                             point_value=pv, pip_points=pip, spread_points=spread, commission_per_lot=rt, per_side=False,
                             slippage_pips=float(s["costs"]["slippagePips"]))
        if "cost_r" in plan:
            row["cost_r"] = fmt_num(plan["cost_r"], 3)
        if trade.get("resultR") is not None:
            row["result_r_after_costs"] = fmt_num(trade["resultR"] - (rt + slip * pv) / (risk_points * pv), 2)

    # The exit, in the brief's words; your answer wins when you gave one.
    reason = trade.get("exitReason")
    final_stop = trade.get("stopLoss")
    if reason == "TAKE_PROFIT":
        auto = "target"
    elif reason == "STOP_LOSS" and entry is not None and final_stop is not None:
        moved = (final_stop - entry) * (1 if side == "long" else -1)
        auto = "breakeven" if abs(moved) <= pip else "trail" if moved > pip else "stop"
    else:
        auto = "manual"
    row["of_exit_reason"] = answers.get("exit_reason") or auto

    if ctx.m1 is None:
        return row  # no order-flow data for this pair: the trade's own columns only
    m1 = ctx.m1
    window = cut(m1, cursor - (OLD_VA_DAYS + 7) * 86400, cursor)
    p = s["profile"]
    pset = {"value_area": p["valueArea"], "smoothing": p["smoothing"], "lvn": p["lvn"]}
    levels = day_levels(window, cursor, ctx.bin, 1, **pset)
    prior = levels["prior"]

    # Market state at the decision, and the 30-minute close that decided it.
    if prior:
        st = s["state"]
        today = cut(m1, cursor - 86400 - 60, cursor)
        ms = market_state(today, cursor, prior["val"], prior["vah"], int(st["timeframe"]), int(st["accept"]), int(st["window"]))
        row["state"] = ms["state"]
        kind = ms["state"].split("_")[0]
        events = [e for e in ms["events"] if e["kind"] == kind]
        if events:
            row["state_close_ist"] = ist_text(events[-1]["time"])
        elif ms["state"] in ("inside", "above", "below") and levels["day_start"] is not None:
            last_close = cursor - cursor % int(st["timeframe"])
            if last_close > levels["day_start"]:
                row["state_close_ist"] = ist_text(last_close)
        row["prior_poc"] = price(prior["poc"])
    else:
        row["state"] = "no_value"

    # The trigger candle: the 5-minute candle of the minute the order was placed in (closed, at a 5-minute close).
    lo, hi = np.searchsorted(ctx.base.time, [cursor - 600, cursor])
    minutes = {k: getattr(ctx.base, k)[lo:hi].tolist() for k in ("time", "open", "high", "low", "close")}
    candle = current_m5(minutes, cursor)
    zone = None
    if candle:
        k = int(np.searchsorted(ctx.m5.time, candle["start"])) - 1
        atr = float(ctx.atr[k]) if k >= 0 and not np.isnan(ctx.atr[k]) else None
        part = cut(m1, candle["start"], candle["start"] + 300)
        rv = candle_flow([candle["start"]], 300, cursor, part, [])["rvol"][0]
        rules = candle_rules(candle["open"], candle["high"], candle["low"], candle["close"], atr, rv, side)
        row.update(trigger_candle_ist=ist_text(candle["start"]),
                   body_pct=fmt_num(None if rules["body"]["value"] is None else rules["body"]["value"] * 100, 0),
                   range_atr=fmt_num(rules["range"]["value"], 2),
                   close_location_pct=fmt_num(None if rules["close"]["value"] is None else rules["close"]["value"] * 100, 0),
                   rvol=fmt_num(rv, 2))
        # The LVN zone: one holding the entry, else the nearest one the trigger candle traded into.
        e2 = 2 * int(entry) if entry is not None else 2 * candle["close"]
        zones = zones_at(ctx, cursor)
        holding = [z for z in zones if z["low"] <= e2 <= z["high"]]
        reached = [z for z in zones if z["low"] <= 2 * candle["high"] and z["high"] >= 2 * candle["low"]]
        pick = holding or reached
        if pick:
            zone = min(pick, key=lambda z: abs((z["low"] + z["high"]) / 2 - e2))
            mid, leg = (zone["low"] + zone["high"]) / 2, zone["top"] - zone["bottom"]
            row.update(lvn_low=price(zone["low"]), lvn_high=price(zone["high"]))
            if leg > 0:
                row["lvn_retracement_pct"] = fmt_num(((zone["top"] - mid) if side == "long" else (mid - zone["bottom"])) / leg * 100, 0)
        # The bubble's size, when the trigger's bubble rule was in use: the largest same-direction bubble in the zone.
        if zone and s["trigger"].get("on", {}).get("bubble"):
            month = datetime.fromtimestamp(candle["start"], timezone.utc).strftime("%Y-%m")
            s15 = ctx.s15_reader([month])
            if s15 is not None:
                lay = s["layer"]
                bm, am = INSTRUMENT_MOVES.get(ctx.symbol, (1.5 * pip / 10 ** digits, 0.3 * pip / 10 ** digits))
                bm = (lay.get("bubbleMove") or {}).get(ctx.symbol, bm)
                am = (lay.get("absorptionMove") or {}).get(ctx.symbol, am)
                items = bubbles(cut(s15, candle["start"], candle["start"] + 300), candle["start"], candle["start"] + 300, cursor,
                                price_bin(bm, digits), price_bin(am, digits), float(lay["minRvol"]), float(lay["medium"]), float(lay["large"]))
                want = "up" if side == "long" else "down"
                same = [b["rvol"] for b in items if b["kind"] == "bubble" and b["side"] == want and zone["low"] <= b["price"] <= zone["high"]]
                row["bubble_rvol"] = fmt_num(max(same), 2) if same else "0"

    # Near an older VAH or VAL: any of the last five finished days', within 3 pips of the zone (or the entry).
    near = NEAR_VA_PIPS * pip * 2
    days = server_days(window["time"])
    today_n = server_day(cursor - 1)
    finished = sorted({d for d in days if d < today_n})[-OLD_VA_DAYS:]
    lo_z, hi_z = (zone["low"], zone["high"]) if zone else ((2 * int(entry),) * 2 if entry is not None else (None, None))
    if lo_z is not None and finished:
        hits = False
        for d in finished:
            rows_d = [i for i, dd in enumerate(days) if dd == d]
            pr = build_profile([window["low"][i] for i in rows_d], [window["high"][i] for i in rows_d],
                               [window["tick_count"][i] for i in rows_d], ctx.bin, **pset)
            if pr and any(lo_z - near <= v <= hi_z + near for v in (pr["val"], pr["vah"])):
                hits = True
        row["near_old_va"] = "y" if hits else "n"

    # Did price reach the prior day's POC after entry, by the end of that trading day (even if stopped first)?
    if prior and trade.get("entryTime") is not None:
        end = day_end(cursor)
        seen = min(end, int(data.get("furthestTime") or end) + int(data.get("barSeconds") or 60))
        after = cut(m1, int(trade["entryTime"]), seen - 59)
        touched = any(l <= prior["poc"] <= h for l, h in zip(after["low"], after["high"]))
        row["reached_poc"] = "y" if touched else ("n" if seen >= end else "pending")
    return row


def _order(r: dict):
    return (r["date_ny"], r["run_id"], int(r["trade_id"]) if str(r.get("trade_id", "")).isdigit() else 0)


def write_logs(data: dict, folder: Path, base: Candles, m1: dict | None = None, s15_reader=None) -> dict:
    """Recompute this session's rows in orderflow_log.csv and the workbook; other sessions' rows are kept."""
    folder = Path(folder)
    ctx = Context(data, base, m1, s15_reader)
    closed = [t for t in data.get("trades") or [] if t.get("status") == "CLOSED" and t.get("entryTime") is not None]
    rows = [trade_row(t, data, ctx) for t in closed]
    write_keyed_csv(folder / LOG_FILE, COLUMNS, data["id"], rows, _order)
    workbook = write_workbook(folder)
    return {"trades": len(rows), "days": 0, "workbook": workbook}


INTEGER, DECIMAL = re.compile(r"-?\d{1,14}"), re.compile(r"-?\d+\.\d+")


def _cell(text: str):
    """A number as a number, so Excel can sum and chart it; dates, times and words stay text."""
    if text in ("", None):
        return None
    if INTEGER.fullmatch(text):
        return int(text)
    if DECIMAL.fullmatch(text):
        return float(text)
    return text


def write_workbook(folder: Path) -> str:
    """The CSV's rows on the workbook's "Log" sheet. An existing workbook keeps its other sheets (your charts and
    summaries); only the Log sheet is written again. Returns the file name, or why it could not be written."""
    import csv

    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Font, PatternFill

    folder = Path(folder)
    with (folder / LOG_FILE).open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    path = folder / WORKBOOK
    try:
        wb = load_workbook(path) if path.exists() else Workbook()
    except Exception as err:  # noqa: BLE001 (a damaged workbook must not lose the save)
        return f"not written: {err}"
    if SHEET in wb.sheetnames:
        index = wb.sheetnames.index(SHEET)
        wb.remove(wb[SHEET])
        ws = wb.create_sheet(SHEET, index)
    elif len(wb.sheetnames) == 1 and wb.active.max_row == 1 and wb.active.max_column == 1 and wb.active["A1"].value is None:
        ws = wb.active
        ws.title = SHEET
    else:
        ws = wb.create_sheet(SHEET, 0)
    ws.append(COLUMNS)
    for r in rows:
        ws.append([_cell(r.get(c, "")) for c in COLUMNS])
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="2962FF")
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions
    for k, name in enumerate(COLUMNS, start=1):
        ws.column_dimensions[ws.cell(1, k).column_letter].width = max(9, min(24, len(name) + 2))
    tmp = path.with_suffix(".tmp.xlsx")
    try:
        wb.save(tmp)
        replace_file(tmp, path)
    except Exception as err:  # noqa: BLE001 (open in Excel: Windows locks it)
        tmp.unlink(missing_ok=True)
        return f"not written (is it open in Excel?): {err}"
    return WORKBOOK


def rebuild(folder: Path, base: Candles | None = None) -> dict:
    """The log from scratch, from every saved session of the strategy (each on its own pair's candles)."""
    from .loglib import load_base

    folder = Path(folder)
    (folder / LOG_FILE).unlink(missing_ok=True)
    totals = {"sessions": 0, "trades": 0, "days": 0}
    for path in sorted((folder / "backtests").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        result = write_logs(data, folder, base if base is not None else load_base(str(data.get("symbol") or "EURUSD")))
        totals["sessions"] += 1
        totals["trades"] += result["trades"]
    return totals
