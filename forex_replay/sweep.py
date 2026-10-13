"""Sweep logger: every liquidity-sweep rule measurement for each closed trade, for Sweep_Backtest_Log.xlsx.

    strategies/<strategy>/sweep_log.csv    one row per closed trade
    strategies/<strategy>/sweep_days.csv   one row per New York weekday whose 08:00 the replay passed

The contract (column names and exact rules) is docs/plan-sweep-logger.md. Decisions where the spec
left room are in docs/decisions/0019-sweep-logger.md.

- PRE fields: the map at 08:00 New York, from candles before 08:00.
- SETUP fields: candles up to the entry candle.
- POST fields: candles after the confirmation, only once the replay has passed 16:00 New York
  (PENDING until then); never past the session's furthest candle.

Like the NBB logger, a buy is measured on mirrored candles (loglib.view): sells fade levels above
price, so on the mirror a buy's levels below price are "above".

    python -m forex_replay sweep <strategy>     rebuild both files from every saved session
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from .loglib import (WEEKDAYS, Candles, back, fmt_bool, fmt_num, fmt_price, is_swing_high, is_swing_low, minutes_bars,
                     ny_date, ny_minutes, ny_text, ny_time, previous_rows, server_bars, spread_at, trade_fields, view,
                     weekdays_between, wilder_atr, write_keyed_csv)

LOG_FILE, DAYS_FILE = "sweep_log.csv", "sweep_days.csv"
OPPOSITES = 6
COLUMNS = [
    "run_id", "trade_id", "date_ny", "weekday", "side", "order_type", "placed_time_ny", "entry_time_ny", "entry_min_ny",
    "exit_time_ny", "entry_price", "stop_loss", "take_profit", "exit_price", "exit_reason", "lots", "actual_r", "pnl_usd",
    "commission_usd", "risk_pips", "spread_pips", "trade_of_day", "level_attempt", "tags", "note", "atr30_pips", "pdh",
    "pdl", "on_high", "on_low", "map_levels_above", "map_levels_below", "level_found", "level_type", "level_price",
    "level_respect_atr", "level_age_days", "eq_spread_atr", "levels_swept_count", "break_time_ny", "sweep_extreme",
    "sweep_depth_pips", "sweep_depth_atr", "max_closes_beyond", "conf_time_ny", "conf_min_ny", "candles_to_close_back",
    "entry_delay_candles", "rule_entry", "rule_stop", "rule_risk_pips", "stop_diff_pips", "opp_taken_in_window",
] + [f"opp{k}_{f}" for k in range(1, OPPOSITES + 1) for f in ("type", "pips", "respect_atr", "age_days")] + [
    "post_status", "stop_hit", "stop_time_ny", "mfe_pips_before_stop", "pnl_pips_at_1600", "phase2_r_gross",
]
DAY_COLUMNS = ["run_id", "date_ny", "weekday", "atr30_pips", "map_levels_above", "map_levels_below", "eq_levels",
               "sweeps_in_window", "trades_taken", "auto_setup"]

MAP_HOUR, WINDOW_END_HOUR, CLOSE_HOUR = 8, 11, 16
LOOSE_RESPECT, LOOSE_AGE = 0.5, 5.0      # the app's map: logs more than the rulebook so thresholds can be tuned both ways
RULE_RESPECT, RULE_AGE = 1.0, 2.0        # the rulebook's map
EQ_TOLERANCE = 0.1                       # x ATR: two swings this close are one equal level; a swing this close to PD/ON is dropped
STOP_BUFFER_POINTS = 10                  # 1 pip beyond the sweep (plus the spread)
TARGET_BUFFER_POINTS = 10                # target 1 pip before the opposite level
MIN_TARGET_R, PARTIAL_R = 2.0, 1.0
CLOSE_BACK_CANDLES = 3                   # for sweeps_in_window
KIND_RANK = {"EQ": 0, "ON": 1, "PD": 2, "S": 3}


@dataclass
class Level:
    """A level of the 08:00 map, on one side's view (above = the side the trade fades)."""
    kind: str               # EQ, ON, PD or S (swing)
    price: float
    respect: float | None = None   # move-away in x ATR (swings and EQ only)
    age: float | None = None       # weekday days from the swing to 08:00 (swings and EQ only)
    eq_spread: float | None = None
    formed: int = 0                # open time of the (most recent) swing candle

    def code(self, upper: bool) -> str:
        """EQH/ONH/PDH/SH for the side above price in real prices; EQL/ONL/PDL/SL below."""
        return self.kind + ("H" if upper else "L")

    def rulebook(self) -> bool:
        return self.kind in ("ON", "PD") or (self.respect >= RULE_RESPECT and self.age <= RULE_AGE)


@dataclass
class Map:
    price08: float | None
    atr: float | None
    above: list = field(default_factory=list)   # levels the side fades (sells: buy-side liquidity above)
    below: list = field(default_factory=list)   # the opposite side
    pdh: float | None = None
    pdl: float | None = None
    on_high: float | None = None
    on_low: float | None = None


def weekday_days(t0: int, t1: int) -> float:
    """Days of 24 h between two times, counting only Monday to Friday (New York dates)."""
    total = 0
    day = ny_date(t0)
    while True:
        start, end = ny_time(day, 0), ny_time(day + timedelta(days=1), 0)
        if start >= t1:
            break
        if day.weekday() < 5:
            total += max(0, min(end, t1) - max(start, t0))
        day += timedelta(days=1)
    return total / 86400


def build_map(m5_view: Candles, day: date) -> Map:
    """The 08:00 map on a side's view, from candles that opened before 08:00 New York."""
    map_t = ny_time(day, MAP_HOUR)
    known = m5_view.until(map_t - 300)
    if not len(known):
        return Map(None, None)
    m30 = minutes_bars(known, 30)
    n30 = m30.closed_by(map_t)
    atr_all = wilder_atr(m30.high[:n30], m30.low[:n30], m30.close[:n30], 14) if n30 else np.array([])
    atr = float(atr_all[-1]) if n30 and np.isfinite(atr_all[-1]) else None
    m = Map(float(known.close[-1]), atr)
    d1 = server_bars(known, 24)
    nd = d1.closed_by(map_t)
    if nd:
        after = slice(int(d1.last[nd - 1]) + 1, len(known))
        m.pdh, m.pdl = float(d1.high[nd - 1]), float(d1.low[nd - 1])
        if not (after.stop > after.start and known.high[after].max() > m.pdh):
            m.above.append(Level("PD", m.pdh))
        if not (after.stop > after.start and known.low[after].min() < m.pdl):
            m.below.append(Level("PD", m.pdl))
    night = known.between(ny_time(day - timedelta(days=1), 17), map_t)
    if night.stop > night.start:
        m.on_high, m.on_low = float(known.high[night].max()), float(known.low[night].min())
        m.above.append(Level("ON", m.on_high))
        m.below.append(Level("ON", m.on_low))
    if atr is None or atr <= 0:
        return m
    first = int(np.searchsorted(m30.start, map_t - 8 * 86400))  # 5 weekdays fit in 8 calendar days
    highs, lows = [], []
    for k in range(max(2, first), n30 - 2):
        later = slice(int(m30.last[k]) + 1, len(known))
        age = weekday_days(int(m30.start[k]), map_t)
        if age > LOOSE_AGE:
            continue
        if is_swing_high(m30.high[:n30], k):
            p = float(m30.high[k])
            if not (known.high[later].max() > p):  # untaken since it formed
                respect = (p - float(known.low[later].min())) / atr
                if respect >= LOOSE_RESPECT:
                    highs.append(Level("S", p, respect, age, formed=int(m30.start[k])))
        if is_swing_low(m30.low[:n30], k):
            p = float(m30.low[k])
            if not (known.low[later].min() < p):
                respect = (float(known.high[later].max()) - p) / atr
                if respect >= LOOSE_RESPECT:
                    lows.append(Level("S", p, respect, age, formed=int(m30.start[k])))
    tol = EQ_TOLERANCE * atr
    for side, swings, extreme in ((m.above, highs, max), (m.below, lows, min)):
        swings = [s for s in swings if not any(abs(s.price - lv.price) <= tol for lv in side)]  # PD/ON stands for it
        swings.sort(key=lambda s: s.price)
        clusters, current = [], []
        for s in swings:
            if current and s.price - current[-1].price > tol:
                clusters.append(current)
                current = []
            current.append(s)
        if current:
            clusters.append(current)
        for c in clusters:
            if len(c) == 1:
                side.append(c[0])
            else:
                recent = max(c, key=lambda s: s.formed)
                prices = [s.price for s in c]
                side.append(Level("EQ", extreme(prices), recent.respect, recent.age, (max(prices) - min(prices)) / atr, recent.formed))
    m.above = [lv for lv in m.above if lv.price >= m.price08]
    m.below = [lv for lv in m.below if lv.price <= m.price08]
    return m


def _rank(level: Level, extreme: float):
    return (KIND_RANK[level.kind], abs(extreme - level.price))


@dataclass
class Sweep:
    found: bool = False
    level: Level | None = None
    swept: int = 0
    brk: int | None = None        # index of the break candle
    conf: int | None = None       # index of the confirmation candle
    extreme: float | None = None
    closes_beyond: int = 0
    rule_entry: float | None = None
    rule_stop: float | None = None
    opposites: list = field(default_factory=list)
    opp_taken: bool = False


def find_sweep(m5_view: Candles, m: Map, day: date, entry_t: int, data: dict) -> Sweep:
    """The level swept before the entry (sells: above), from candles that closed by the entry."""
    s = Sweep()
    m5 = m5_view.until(entry_t - 300)
    map_t = ny_time(day, MAP_HOUR)
    start = int(np.searchsorted(m5.time, map_t))
    kept = []
    for lv in m.above:
        brk = next((i for i in range(start, len(m5)) if m5.high[i] > lv.price), None)
        if brk is None:
            continue
        conf = next((j for j in range(brk, len(m5)) if m5.close[j] < lv.price), None)
        if conf is None:
            continue
        extreme = float(m5.high[brk:conf + 1].max())
        kept.append((lv, brk, conf, extreme))
    s.swept = len(kept)
    if not kept:
        return s
    lv, brk, conf, extreme = min(kept, key=lambda k: _rank(k[0], k[3]))
    run = best = 0
    for j in range(brk, conf + 1):
        run = run + 1 if m5.close[j] > lv.price else 0
        best = max(best, run)
    s.found, s.level, s.brk, s.conf, s.extreme, s.closes_beyond = True, lv, brk, conf, extreme, best
    s.rule_entry = float(m5.close[conf])
    s.rule_stop = extreme + spread_at(data, m5, conf, int(m5.time[conf])) + STOP_BUFFER_POINTS
    window = slice(start, conf + 1)
    low_in_window = float(m5.low[window].min())
    s.opposites = sorted((o for o in m.below if o.price < s.rule_entry and not low_in_window < o.price),
                         key=lambda o: s.rule_entry - o.price)
    s.opp_taken = any(low_in_window < o.price for o in m.below if o.rulebook())
    return s


def post_fields(m5_view: Candles, s: Sweep, day: date, data: dict) -> dict:
    """After the confirmation candle, up to the last candle before 16:00 New York (on the side's view)."""
    t1600 = ny_time(day, CLOSE_HOUR)
    m5 = m5_view.until(t1600 - 300)
    after = range(s.conf + 1, len(m5))
    out = {"stop_hit": False, "stop_time": None, "mfe": None, "pnl_1600": None, "phase2": None}
    hit = next((i for i in after if m5.high[i] >= s.rule_stop), None)
    if hit is not None:
        out["stop_hit"], out["stop_time"] = True, int(m5.time[hit])
    before = slice(s.conf + 1, hit if hit is not None else len(m5))
    if before.stop > before.start:
        out["mfe"] = s.rule_entry - float(m5.low[before].min())
    if hit is None and len(after):
        out["pnl_1600"] = s.rule_entry - float(m5.close[len(m5) - 1])
    out["phase2"] = phase2(m5, s, data)
    return out


def phase2(m5: Candles, s: Sweep, data: dict) -> float | None:
    """The rulebook's Phase 2 on the rule trade, gross R (sells' view). None when no target qualifies."""
    entry, stop = s.rule_entry, s.rule_stop
    risk = stop - entry
    if risk <= 0:
        return None
    qualifying = [o for o in s.opposites if o.rulebook() and entry - (o.price + TARGET_BUFFER_POINTS) >= MIN_TARGET_R * risk]
    if not qualifying:
        return None
    target = qualifying[0].price + TARGET_BUFFER_POINTS  # the nearest qualifying level, 1 pip before it
    internal = sorted((o.price for o in s.opposites if target < o.price < entry and entry - o.price >= PARTIAL_R * risk), reverse=True)
    r = lambda price: (entry - price) / risk
    open_part, total, half = 1.0, 0.0, False
    last_swing_high = None
    for i in range(s.conf + 1, len(m5)):
        if m5.high[i] >= stop:  # a candle touching the stop and a target counts as the stop
            return total + open_part * r(stop)
        if m5.low[i] <= target:
            return total + open_part * r(target)
        if not half and internal and m5.low[i] <= internal[0]:
            total, open_part, half, stop = total + 0.5 * r(internal[0]), 0.5, True, entry
        k = i - 2  # a 5m swing at k is confirmed when candle i closes
        if k > s.conf:
            if is_swing_low(m5.low[:i + 1], k) and not half and entry - m5.low[k] >= PARTIAL_R * risk:
                total, open_part, half, stop = total + 0.5 * r(float(m5.close[i])), 0.5, True, entry
            if is_swing_high(m5.high[:i + 1], k):
                swing = float(m5.high[k])
                if half and (last_swing_high is None or swing < last_swing_high):
                    stop = min(stop, swing + spread_at(data, m5, i, int(m5.time[i])) + STOP_BUFFER_POINTS)
                last_swing_high = swing
    return total + open_part * r(float(m5.close[len(m5) - 1]))


def sweeps_in_window(m5: Candles, m: Map, day: date) -> int:
    """Rulebook-map levels (both sides) traded beyond and closed back inside within 3 M5 candles, closing 08:00-11:00."""
    map_t, end = ny_time(day, MAP_HOUR), ny_time(day, WINDOW_END_HOUR)
    start = int(np.searchsorted(m5.time, map_t))
    count = 0
    for levels, beyond, back_inside in ((m.above, lambda i, p: m5.high[i] > p, lambda i, p: m5.close[i] < p),
                                        (m.below, lambda i, p: m5.low[i] < p, lambda i, p: m5.close[i] > p)):
        for lv in levels:
            if not lv.rulebook():
                continue
            brk = next((i for i in range(start, len(m5)) if m5.time[i] < end and beyond(i, lv.price)), None)
            if brk is None:
                continue
            conf = next((j for j in range(brk, min(brk + CLOSE_BACK_CANDLES, len(m5))) if back_inside(j, lv.price)), None)
            if conf is not None and map_t <= m5.time[conf] + 300 <= end:
                count += 1
    return count


# ----------------------------------------------------------------- rows
def _level_text(lv: Level | None, upper: bool, digits: int, side: str) -> tuple[str, str]:
    if lv is None:
        return "NONE", ""
    return lv.code(upper), fmt_price(int(round(back(lv.price, side))), digits)


def trade_row(trade: dict, data: dict, m5: Candles) -> dict:
    digits, pip = data["digits"], data["pipPoints"]
    furthest, entry_t, side = data["furthestTime"], trade["entryTime"], trade["side"]
    day = ny_date(entry_t)
    price = lambda p: "" if p is None else fmt_price(int(round(back(p, side))), digits)
    row = dict.fromkeys(COLUMNS, "")
    row.update(trade_fields(trade, data, m5))
    row["entry_min_ny"] = ny_minutes(entry_t)
    seen = m5.until(furthest)
    real = build_map(seen, day)  # in real prices, for the PRE columns
    row.update({
        "atr30_pips": fmt_num(None if real.atr is None else real.atr / pip, 1),
        "pdh": fmt_price(None if real.pdh is None else int(real.pdh), digits),
        "pdl": fmt_price(None if real.pdl is None else int(real.pdl), digits),
        "on_high": fmt_price(None if real.on_high is None else int(real.on_high), digits),
        "on_low": fmt_price(None if real.on_low is None else int(real.on_low), digits),
        "map_levels_above": sum(lv.rulebook() for lv in real.above),
        "map_levels_below": sum(lv.rulebook() for lv in real.below),
    })
    sv = view(seen, side)
    m = real if side == "SELL" else _flip_map(real)  # the same map, seen from the buy's mirrored candles
    s = find_sweep(sv, m, day, entry_t, data)
    upper = side == "SELL"  # the swept side is above in real prices for a sell
    row["level_found"] = fmt_bool(s.found)
    row["levels_swept_count"] = s.swept
    row["level_type"], row["level_price"] = _level_text(s.level, upper, digits, side)
    if not s.found:
        row["post_status"] = "NO_SETUP"
        return row
    atr = m.atr
    depth = s.extreme - s.level.price
    conf_t = int(sv.time[s.conf])
    row.update({
        "level_respect_atr": fmt_num(s.level.respect, 2), "level_age_days": fmt_num(s.level.age, 2),
        "eq_spread_atr": fmt_num(s.level.eq_spread, 2),
        "break_time_ny": ny_text(int(sv.time[s.brk])), "sweep_extreme": price(s.extreme),
        "sweep_depth_pips": fmt_num(depth / pip, 1), "sweep_depth_atr": fmt_num(depth / atr if atr else None, 2),
        "max_closes_beyond": s.closes_beyond, "conf_time_ny": ny_text(conf_t), "conf_min_ny": ny_minutes(conf_t + 300),
        "candles_to_close_back": s.conf - s.brk + 1, "entry_delay_candles": (entry_t - (conf_t + 300)) // 300,
        "rule_entry": price(s.rule_entry), "rule_stop": price(s.rule_stop),
        "rule_risk_pips": fmt_num(abs(s.rule_stop - s.rule_entry) / pip, 1),
        "opp_taken_in_window": fmt_bool(s.opp_taken),
    })
    initial = trade.get("initialStop", trade.get("stopLoss"))
    if initial is not None:
        row["stop_diff_pips"] = fmt_num(abs(initial - back(s.rule_stop, side)) / pip, 1)
    for k, o in enumerate(s.opposites[:OPPOSITES], start=1):
        row[f"opp{k}_type"] = o.code(not upper)
        row[f"opp{k}_pips"] = fmt_num((s.rule_entry - o.price) / pip, 1)
        row[f"opp{k}_respect_atr"] = fmt_num(o.respect, 2)
        row[f"opp{k}_age_days"] = fmt_num(o.age, 2)
    if furthest + 300 < ny_time(day, CLOSE_HOUR):
        row["post_status"] = "PENDING"
        return row
    row["post_status"] = "COMPLETE"
    post = post_fields(sv, s, day, data)
    row.update({
        "stop_hit": fmt_bool(post["stop_hit"]), "stop_time_ny": ny_text(post["stop_time"]),
        "mfe_pips_before_stop": fmt_num(None if post["mfe"] is None else post["mfe"] / pip, 1),
        "pnl_pips_at_1600": fmt_num(None if post["pnl_1600"] is None else post["pnl_1600"] / pip, 1),
        "phase2_r_gross": fmt_num(post["phase2"], 2),
    })
    return row


def _flip_map(m: Map) -> Map:
    """A map in real prices seen from a buy's mirrored view: below becomes above, prices negated."""
    flip = lambda lv: Level(lv.kind, -lv.price, lv.respect, lv.age, lv.eq_spread, lv.formed)
    return Map(None if m.price08 is None else -m.price08, m.atr, [flip(lv) for lv in m.below], [flip(lv) for lv in m.above])


def day_rows(data: dict, m5: Candles, reuse: dict | None = None) -> list[dict]:
    """One row per weekday whose 08:00 New York the replay passed. A day before the furthest candle's date can
    no longer change, so an earlier row of it is reused; the furthest day is always worked out again."""
    pip, run = data["pipPoints"], data["id"]
    start, furthest = data["startTime"], data["furthestTime"]
    seen = m5.until(furthest)
    entries = [ny_date(t["entryTime"]) for t in data.get("trades") or [] if t.get("entryTime") is not None]
    last_day = ny_date(furthest)
    rows = []
    for day in weekdays_between(ny_date(start), last_day):
        if not (start <= ny_time(day, MAP_HOUR) <= furthest):
            continue
        taken = sum(1 for d in entries if d == day)
        if reuse and day.isoformat() in reuse and day < last_day:
            rows.append(dict(reuse[day.isoformat()], trades_taken=taken))
            continue
        m = build_map(seen, day)
        rule = [lv for lv in m.above + m.below if lv.rulebook()]
        rows.append({
            "run_id": run, "date_ny": day.isoformat(), "weekday": WEEKDAYS[day.weekday()],
            "atr30_pips": fmt_num(None if m.atr is None else m.atr / pip, 1),
            "map_levels_above": sum(lv.rulebook() for lv in m.above), "map_levels_below": sum(lv.rulebook() for lv in m.below),
            "eq_levels": sum(lv.kind == "EQ" for lv in rule), "sweeps_in_window": sweeps_in_window(seen, m, day),
            "trades_taken": taken, "auto_setup": "",
        })
    return rows


def _trade_order(r: dict):
    return (r["date_ny"], r["run_id"], int(r["trade_id"]) if str(r.get("trade_id", "")).isdigit() else 0)


FINAL = ("COMPLETE", "NO_SETUP")


def write_logs(data: dict, folder: Path, m5: Candles) -> dict:
    """Recompute this session's rows in sweep_log.csv and sweep_days.csv; other sessions' rows are kept.
    Finished rows are reused, as in the NBB logger (see nbb.write_logs)."""
    folder = Path(folder)
    trades = data.get("trades") or []
    closed = [t for t in trades if t.get("status") == "CLOSED" and t.get("entryTime") is not None]
    before = previous_rows(folder / LOG_FILE, data["id"], "trade_id")
    rows = []
    for t in closed:
        old = before.get(str(t["id"]))
        if old and old.get("post_status") in FINAL and old.get("entry_time_ny") == ny_text(t["entryTime"]) \
                and old.get("exit_time_ny") == ny_text(t.get("exitTime")):
            rows.append(dict(old, tags="; ".join(t.get("tags") or []), note=t.get("note") or ""))
        else:
            rows.append(trade_row(t, data, m5))
    _count_attempts(rows, data, m5)
    days = day_rows(data, m5, reuse=previous_rows(folder / DAYS_FILE, data["id"], "date_ny"))
    write_keyed_csv(folder / LOG_FILE, COLUMNS, data["id"], rows, _trade_order)
    write_keyed_csv(folder / DAYS_FILE, DAY_COLUMNS, data["id"], days, lambda r: (r["date_ny"], r["run_id"]))
    return {"trades": len(rows), "days": len(days)}


def _count_attempts(rows: list[dict], data: dict, m5: Candles) -> None:
    """trade_of_day and level_attempt, counted over every trade of the session that was filled (open ones too)."""
    seen = m5.until(data["furthestTime"])
    logged = {r["trade_id"]: r for r in rows}
    entered = sorted((t for t in data.get("trades") or [] if t.get("entryTime") is not None),
                     key=lambda t: (t["entryTime"], t["id"]))
    per_day: dict = {}
    for t in entered:
        row = logged.get(t["id"]) or logged.get(str(t["id"]))
        if row is not None:
            key = (row["level_type"], row["level_price"])
        else:  # an open trade: only its swept level is needed
            day = ny_date(t["entryTime"])
            sv = view(seen, t["side"])
            real = build_map(seen, day)
            s = find_sweep(sv, real if t["side"] == "SELL" else _flip_map(real), day, t["entryTime"], data)
            key = _level_text(s.level, t["side"] == "SELL", data["digits"], t["side"])
        day_list = per_day.setdefault(ny_date(t["entryTime"]), [])
        attempt = 1 + sum(1 for k in day_list if k == key and key[0] != "NONE")
        day_list.append(key)
        if row is not None:
            row["trade_of_day"], row["level_attempt"] = len(day_list), attempt


def rebuild(folder: Path, m5: Candles) -> dict:
    """Both files from scratch, from every saved session of the strategy."""
    folder = Path(folder)
    for name in (LOG_FILE, DAYS_FILE):
        (folder / name).unlink(missing_ok=True)
    totals = {"sessions": 0, "trades": 0, "days": 0}
    for path in sorted((folder / "backtests").glob("*.json")):
        result = write_logs(json.loads(path.read_text(encoding="utf-8")), folder, m5)
        totals["sessions"] += 1
        totals["trades"] += result["trades"]
        totals["days"] += result["days"]
    return totals
