"""NBB logger: every NBB rule measurement for each closed trade, written for NBB_Backtest_Log.xlsx.

    strategies/<strategy>/nbb_log.csv    one row per closed trade
    strategies/<strategy>/nbb_days.csv   one row per New York weekday the replay passed

The contract (column names and exact rules) is docs/plan-nbb-logger.md. Decisions where the
spec left room are in docs/decisions/0018-nbb-logger.md.

How it stays honest:
- PRE fields see only candles before 00:00 New York of the trade's date; SETUP fields only
  candles up to the moment the order was placed; nothing ever reads past the session's furthest
  candle. Each part cuts the candles first (Candles.until) and builds 15m, H4 and D1 from the cut.
- POST fields wait until the replay has passed 16:00 New York of that date (PENDING until then).

Buys mirror sells. Rather than write every rule twice, a buy is measured on mirrored candles
(every price negated, so highs become lows): a sell rule on the mirror is the buy rule.
Prices are negated back for output. Fib levels and ratios are the same either way.

    python -m forex_replay nbb <strategy>     rebuild both files from every saved session
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from .loglib import (WEEKDAYS, Bars, Candles, fmt_bool, fmt_num, fmt_price, is_swing_high, minutes_bars, ny, ny_date, ny_text,
                     ny_time, server_bars, server_day, week_bars, week_of_server_day, weekdays_between, wilder_atr,
                     write_keyed_csv)

LOG_FILE, DAYS_FILE = "nbb_log.csv", "nbb_days.csv"
COLUMNS = [
    "run_id", "trade_id", "date_ny", "weekday", "killzone", "side", "order_type", "placed_time_ny", "entry_time_ny",
    "exit_time_ny", "entry_price", "stop_loss", "take_profit", "exit_price", "exit_reason", "lots", "actual_r", "pnl_usd",
    "commission_usd", "risk_pips", "spread_pips", "tags", "note", "adr5_pips", "daily_structure", "weekly_structure",
    "bias", "asian_high", "asian_low", "asian_range_pips", "open_0000", "pdh", "pdl", "pwh", "pwl", "nearest_pd_type",
    "open_dist_pips", "setup_found", "h2_price", "h2_time_ny", "h2_beyond_asian_pips", "pd_hit_type",
    "pd_hit_beyond_pips", "h1_price", "h1_time_ny", "h1_candles_before_h2", "l1_price", "disp_time_ny",
    "disp_range_atr", "disp_body_pct", "disp_candles_after_h2", "fib_1", "fib_0", "fib_0_time_ny", "leg_pips",
    "opp_pd_between", "opp_pd_type", "entry_fib_level", "stop_fib_level", "user_fib_found", "user_fib_1", "user_fib_0",
    "post_status", "time_062_ny", "deepest_level_kz", "deepest_level_total", "resolution", "resolution_time_ny",
    "level_at_1600", "be_triggered", "target_momentum", "phase2_r_gross",
]
DAY_COLUMNS = ["run_id", "date_ny", "weekday", "adr5_pips", "daily_structure", "weekly_structure", "bias",
               "asian_range_pips", "nearest_pd_type", "open_dist_pips", "trades_taken", "auto_setup_ny", "auto_setup_london"]

KILLZONES = {"LONDON": (2, 5), "NY": (7, 10)}  # New York hours, end exclusive
ENTRY_LEVEL, BE_LEVEL = 0.62, 0.20
D1_LOOKBACK, H4_LOOKBACK = 20, 60
DAILY_STRUCTURE_DAYS, WEEKLY_STRUCTURE_WEEKS = 120, 30
H1_SEARCH = 64
TYPE_RANK = {"PW": 0, "PD": 1, "BRK": 2, "OB": 3, "FVG": 4}


# ----------------------------------------------------------------- mirroring
def mirror(m5: Candles) -> Candles:
    """Every price negated, highs and lows swapped: a sell rule measured on this is the buy rule."""
    return Candles(m5.time, -m5.open, -m5.low, -m5.high, -m5.close, m5.spread)


def view(m5: Candles, side: str) -> Candles:
    return m5 if side == "SELL" else mirror(m5)


def back(value, side: str):
    """A price on the side's view -> the real price."""
    if value is None:
        return None
    return value if side == "SELL" else -value


def killzone_of(utc: int) -> str:
    hour = ny(utc).hour
    return next((name for name, (a, b) in KILLZONES.items() if a <= hour < b), "NONE")


def in_any_killzone(utc: int) -> bool:
    return killzone_of(utc) != "NONE"


def killzone_window(day: date, zone: str) -> tuple[int, int]:
    a, b = KILLZONES[zone if zone in KILLZONES else "NY"]
    return ny_time(day, a), ny_time(day, b)


# ----------------------------------------------------------------- PRE: before 00:00 New York
def structure(high, low, close) -> str:
    """Walk the candles: a close above the latest confirmed, unbroken swing high sets BULL; below the swing low, BEAR."""
    state, sh, sl = "NONE", None, None
    for j in range(len(close)):
        k = j - 2  # the 2nd candle after k has just closed: a swing at k is confirmed now
        if k >= 2:
            if high[k] > max(high[k - 2], high[k - 1], high[k + 1], high[k + 2]):
                sh = [high[k], False]
            if low[k] < min(low[k - 2], low[k - 1], low[k + 1], low[k + 2]):
                sl = [low[k], False]
        if sh and not sh[1] and close[j] > sh[0]:
            state, sh[1] = "BULL", True
        if sl and not sl[1] and close[j] < sl[0]:
            state, sl[1] = "BEAR", True
    return state


@dataclass
class Zone:
    """A PD array on one side's view (sells: bearish, above price). lo <= hi in that view's prices."""
    code: str
    lo: float
    hi: float
    rank: tuple

    def flipped(self) -> "Zone":
        return Zone(self.code, -self.hi, -self.lo, self.rank)


def _completed(bars: Bars, cutoff: int) -> int:
    return bars.closed_by(cutoff)


def _latest_swing(values, k: int, high: bool, limit: int):
    """Latest swing (high or low) confirmed before candle k opened: its 2nd candle after closed by k-1."""
    for s in range(k - 3, 1, -1):
        if s + 2 >= limit:
            continue
        neighbours = (values[s - 2], values[s - 1], values[s + 1], values[s + 2])
        if (high and all(values[s] > v for v in neighbours)) or (not high and all(values[s] < v for v in neighbours)):
            return values[s]
    return None


def _zone_arrays(m5: Candles, bars: Bars, n: int, lookback: int, tf: str, tf_rank: int) -> list[Zone]:
    """Bearish FVG, OB and breaker zones (on this view) among the last `lookback` completed bars, still valid."""
    out = []
    o, h, l, c = bars.open, bars.high, bars.low, bars.close
    for k in range(max(0, n - lookback), n):
        after_m5 = slice(int(bars.last[k]) + 1, len(m5))  # every later price, up to the cut
        # FVG: low[k-2] above high[k]; gone once a later high reaches low[k-2]
        if k >= 2 and l[k - 2] > h[k]:
            later = m5.high[after_m5]
            if not (len(later) and later.max() >= l[k - 2]):
                out.append(Zone(f"FVG_{tf}", float(h[k]), float(l[k - 2]), (TYPE_RANK["FVG"], tf_rank)))
        # OB: an up candle, then within 3 candles a close below the latest swing low; gone on a later close above high[k]
        if c[k] > o[k]:
            sl = _latest_swing(l, k, high=False, limit=n)
            nxt = range(k + 1, min(k + 4, n))
            if sl is not None and any(c[j] < sl for j in nxt):
                if not any(c[j] > h[k] for j in range(k + 1, n)):
                    out.append(Zone(f"OB_{tf}", float(l[k]), float(h[k]), (TYPE_RANK["OB"], tf_rank)))
        # Breaker: a down candle that became a bullish order block, later broken by a close below low[k]
        if c[k] < o[k]:
            sh = _latest_swing(h, k, high=True, limit=n)
            nxt = range(k + 1, min(k + 4, n))
            if sh is not None and any(c[j] > sh for j in nxt):
                brk = next((j for j in range(k + 1, n) if c[j] < l[k]), None)
                if brk is not None and not any(c[j] > h[k] for j in range(brk + 1, n)):
                    out.append(Zone(f"BRK_{tf}", float(l[k]), float(h[k]), (TYPE_RANK["BRK"], tf_rank)))
    return out


def pd_arrays(m5_known: Candles, day_start: int, side: str) -> list[Zone]:
    """The side's PD arrays at day start, on the side's view (sells: bearish arrays above)."""
    m5 = view(m5_known, side)
    d1, h4 = server_bars(m5, 24), server_bars(m5, 4)
    nd, nh = _completed(d1, day_start), _completed(h4, day_start)
    zones = []
    level = "PDH" if side == "SELL" else "PDL"
    if nd:
        since = m5.high[int(d1.last[nd - 1]) + 1:]
        if not (len(since) and since.max() > d1.high[nd - 1]):
            zones.append(Zone(level, float(d1.high[nd - 1]), float(d1.high[nd - 1]), (TYPE_RANK["PD"], 0)))
    wk = week_bars(Bars(*(getattr(d1, f)[:nd] for f in Bars.__dataclass_fields__)))
    current_week = week_of_server_day(server_day(day_start))
    done = [i for i in range(len(wk["key"])) if wk["key"][i] < current_week]
    if done:
        i = done[-1]
        last_day = int(wk["last"][i])
        since = m5.high[int(d1.last[last_day]) + 1:]
        if not (len(since) and since.max() > wk["high"][i]):
            zones.append(Zone("PWH" if side == "SELL" else "PWL", float(wk["high"][i]), float(wk["high"][i]), (TYPE_RANK["PW"], 0)))
    zones += _zone_arrays(m5, d1, nd, D1_LOOKBACK, "D1", 0)
    zones += _zone_arrays(m5, h4, nh, H4_LOOKBACK, "H4", 1)
    return zones


def nearest(zones: list[Zone], price: float):
    """The zone at or above `price` (on the view) nearest to it; ties by priority. Returns (zone, distance) or (None, None)."""
    best = None
    for z in zones:
        if z.hi < price:
            continue
        dist = max(0.0, z.lo - price)
        if best is None or (dist, z.rank) < (best[1], best[0].rank):
            best = (z, dist)
    return best if best else (None, None)


def pre_fields(m5: Candles, day: date, trade_side: str | None, pip: int) -> dict:
    """Everything known before 00:00 New York of `day`. `m5` must reach at least 00:00 (for the 00:00 open)."""
    day_start = ny_time(day, 0)
    known = m5.until(day_start - 1)
    d1 = server_bars(known, 24)
    nd = _completed(d1, day_start)
    out = {"adr5": None, "daily": "NONE", "weekly": "NONE", "bias": "NONE", "asian_high": None, "asian_low": None,
           "open": None, "pdh": None, "pdl": None, "pwh": None, "pwl": None, "nearest": None, "open_dist": None,
           "zones": {}, "day_start": day_start}
    if nd >= 5:
        out["adr5"] = float(np.mean(d1.high[nd - 5:nd] - d1.low[nd - 5:nd]))
    a = max(0, nd - DAILY_STRUCTURE_DAYS)
    out["daily"] = structure(d1.high[a:nd], d1.low[a:nd], d1.close[a:nd])
    wk = week_bars(Bars(*(getattr(d1, f)[:nd] for f in Bars.__dataclass_fields__)))
    current_week = week_of_server_day(server_day(day_start))
    done = np.flatnonzero(wk["key"] < current_week)
    if len(done):
        w0 = max(0, len(done) - WEEKLY_STRUCTURE_WEEKS)
        idx = done[w0:]
        out["weekly"] = structure(wk["high"][idx], wk["low"][idx], wk["close"][idx])
        out["pwh"], out["pwl"] = int(wk["high"][done[-1]]), int(wk["low"][done[-1]])
    if out["daily"] == out["weekly"] == "BEAR":
        out["bias"] = "SELL"
    elif out["daily"] == out["weekly"] == "BULL":
        out["bias"] = "BUY"
    if nd:
        out["pdh"], out["pdl"] = int(d1.high[nd - 1]), int(d1.low[nd - 1])
    asia = known.between(ny_time(day - timedelta(days=1), 20), day_start)
    if asia.stop > asia.start:
        out["asian_high"], out["asian_low"] = int(known.high[asia].max()), int(known.low[asia].min())
    i = m5.index_at(day_start)
    if i >= 0:
        out["open"] = int(m5.open[i])
    for side in ("SELL", "BUY"):
        out["zones"][side] = pd_arrays(known, day_start, side)
    side = out["bias"] if out["bias"] != "NONE" else trade_side
    if side and out["open"] is not None:
        zone, dist = nearest(out["zones"][side], out["open"] if side == "SELL" else -out["open"])
        if zone:
            out["nearest"], out["open_dist"] = zone.code, dist / pip
        else:
            out["nearest"] = "NONE"
    return out


# ----------------------------------------------------------------- SETUP: up to the order
@dataclass
class Setup:
    found: bool = False
    h2: float | None = None
    h2_time: int | None = None
    h1: float | None = None
    h1_time: int | None = None
    h1_before: int | None = None
    l1: float | None = None
    disp_time: int | None = None
    disp_index: int | None = None
    disp_atr: float | None = None
    disp_body: float | None = None
    disp_after: int | None = None


def find_setup(m5_view: Candles, day_start: int, placed: int) -> Setup:
    """H2, H1, L1 and the displacement candle, on the side's view, from candles up to `placed` only."""
    s = Setup()
    m5 = m5_view.until(placed)
    seg = m5.between(day_start, placed + 1)
    if seg.stop <= seg.start:
        return s
    i2 = seg.start + int(np.argmax(m5.high[seg]))  # the first candle making the day's high so far
    s.h2, s.h2_time = float(m5.high[i2]), int(m5.time[i2])
    m15 = minutes_bars(m5, 15)
    kh = m15.index_of_time(s.h2_time)
    for k in range(kh - 3, max(1, kh - H1_SEARCH) - 1, -1):  # its 2nd candle after closed before the H2 candle
        if is_swing_high(m15.high, k) and m15.high[k] < s.h2:
            s.h1, s.h1_time, s.h1_before = float(m15.high[k]), int(m15.start[k]), kh - k
            s.l1 = float(m15.low[k + 1:kh].min())
            break
    if s.h1 is None:
        return s
    atr = wilder_atr(m15.high, m15.low, m15.close, 14)
    for j in range(kh + 1, len(m15)):
        if m15.end[j] > placed + 300:  # had not closed when the order was placed
            break
        if m5.high[int(m15.first[j]):int(m15.last[j]) + 1].max() > s.h2:
            break  # price went beyond H2 first
        if m15.close[j] < s.l1:
            rng = float(m15.high[j] - m15.low[j])
            s.disp_time, s.disp_index, s.disp_after = int(m15.start[j]), j, j - kh
            s.disp_atr = rng / atr[j - 1] if j >= 1 and np.isfinite(atr[j - 1]) and atr[j - 1] > 0 else None
            s.disp_body = abs(float(m15.close[j] - m15.open[j])) / rng if rng > 0 else 0.0
            s.found = True
            break
    return s


@dataclass
class Fib:
    one: float
    zero: float
    zero_time: int
    final: bool       # 0.62 touched inside a killzone with the leg fixed
    complete: bool    # the walk reached its end (not cut short by the replay's furthest point)


def walk_fib(m5_view: Candles, setup: Setup, walk_end: int, furthest: int) -> Fib:
    """The rule Fibonacci: 1.0 = H2; 0.0 = the leg low, moved and fixed candle by candle (see the spec, step 4)."""
    m5 = m5_view.until(furthest)
    m15 = minutes_bars(m5, 15)
    j = m15.index_of_time(setup.disp_time)
    one = setup.h2
    a, b = int(m15.first[j]), int(m15.last[j]) + 1
    k = a + int(np.argmin(m5.low[a:b]))
    zero, zero_time = float(m5.low[k]), int(m5.time[k])
    fixed = False
    for c in range(j + 1, len(m15)):
        if m15.start[c] >= walk_end:
            break
        for i in range(int(m15.first[c]), int(m15.last[c]) + 1):
            if m5.time[i] >= walk_end:
                break
            if fixed:
                level = zero + ENTRY_LEVEL * (one - zero)
                if m5.high[i] >= level and in_any_killzone(int(m5.time[i])):
                    return Fib(one, zero, zero_time, True, True)
                if m5.low[i] < zero:
                    zero, zero_time, fixed = float(m5.low[i]), int(m5.time[i]), False
            elif m5.low[i] < zero:
                zero, zero_time = float(m5.low[i]), int(m5.time[i])
        closed = m15.end[c] <= min(walk_end, furthest + 300)
        if closed and not fixed and m15.close[c] > m15.high[c - 1]:
            fixed = True
    return Fib(one, zero, zero_time, False, furthest + 300 >= walk_end)


def user_fib(drawings: list, placed: int, side: str):
    """The latest Fibonacci drawn in the trade's direction whose 0.0 (second click) is at or before the order."""
    best = None
    for n, d in enumerate(drawings or []):
        if not isinstance(d, dict) or d.get("type") != "fib" or len(d.get("points") or []) != 2:
            continue
        p1, p0 = d["points"]
        if p0["time"] > placed:
            continue
        if (side == "SELL" and p1["price"] > p0["price"]) or (side == "BUY" and p1["price"] < p0["price"]):
            if best is None or (p0["time"], n) >= best[0]:
                best = ((p0["time"], n), p1["price"], p0["price"])
    return best


# ----------------------------------------------------------------- POST: after the setup, once 16:00 has been replayed
def post_fields(m5_view: Candles, fib: Fib, day: date, zone: str, adr5: float | None) -> dict:
    """What price did after the rule Fibonacci was set, up to 16:00 New York (all on the side's view)."""
    t1600 = ny_time(day, 16)
    m5 = m5_view.until(t1600 - 300)
    one, zero = fib.one, fib.zero
    span = one - zero
    lvl = lambda p: (p - zero) / span
    kz_start, kz_end = killzone_window(day, zone)
    start = int(np.searchsorted(m5.time, fib.zero_time, side="right"))
    out = {"time_062": None, "deepest_kz": None, "deepest_total": None, "resolution": "TIME", "resolution_time": None,
           "level_at_1600": None, "be": False, "momentum": False, "phase2": None}
    res_i = None
    for i in range(start, len(m5)):
        if m5.high[i] >= one:
            out["resolution"], res_i = "STOP", i
            break
        if m5.low[i] <= zero:
            out["resolution"], res_i = "TARGET", i
            break
    end = res_i if res_i is not None else len(m5)
    out["resolution_time"] = int(m5.time[res_i]) if res_i is not None else t1600
    # Deepest levels: candles before the resolution, plus the stop candle itself (every entry filled on it).
    counted = list(range(start, end)) + ([res_i] if out["resolution"] == "STOP" else [])
    if counted:
        out["deepest_total"] = max(lvl(float(m5.high[i])) for i in counted)
        in_kz = [i for i in counted if kz_start <= m5.time[i] < kz_end]
        if in_kz and out["resolution_time"] >= kz_start:
            out["deepest_kz"] = max(lvl(float(m5.high[i])) for i in in_kz)
    if out["resolution"] == "TIME" and len(m5):
        out["level_at_1600"] = lvl(float(m5.close[-1]))
    entry = zero + ENTRY_LEVEL * span
    last = res_i if res_i is not None else len(m5) - 1
    fill = next((i for i in range(start, last + 1) if kz_start <= m5.time[i] < kz_end and m5.high[i] >= entry), None)
    m15 = minutes_bars(m5, 15)
    if fill is not None:
        out["time_062"] = int(m5.time[fill])
        stop_end = int(m5.time[res_i]) + 300 if res_i is not None else t1600
        out["be"] = any(m15.end[c] > m5.time[fill] and m15.end[c] <= stop_end and lvl(float(m15.close[c])) <= BE_LEVEL
                        for c in range(len(m15)))
        out["phase2"] = phase2(m5, m15, fill, entry, one, zero, None if adr5 is None else one - adr5)
    if out["resolution"] == "TARGET":
        c = m15.index_of_time(int(m5.time[res_i]))
        rng = float(m15.high[c] - m15.low[c])
        out["momentum"] = bool(m15.close[c] < zero and rng > 0 and abs(float(m15.close[c] - m15.open[c])) >= 0.5 * rng)
    return out


def phase2(m5: Candles, m15: Bars, fill: int, entry: float, one: float, zero: float, runner_target: float | None) -> float:
    """The rulebook's Phase 2 on a 0.62 limit filled at `fill`, stop at 1.0, gross R (sells' view)."""
    risk = one - entry
    r = lambda price: (entry - price) / risk
    stop, open_part, total = one, 1.0, 0.0
    half_done, runner, decide_at = False, False, None
    for i in range(fill, len(m5)):
        if m5.high[i] >= stop:  # a candle touching the stop and a target counts as the stop
            return total + open_part * r(stop)
        if i > fill:  # on the fill candle the order of the touches is unknown: only the stop is checked
            if not half_done and m5.low[i] <= zero:
                total += 0.5 * r(zero)
                open_part, half_done = 0.5, True
                decide_at = m15.index_of_time(int(m5.time[i]))
            if runner and runner_target is not None and m5.low[i] <= runner_target:
                return total + open_part * r(runner_target)
        c = m15.index_of_time(int(m5.time[i]))
        if i != int(m15.last[c]):
            continue
        close = float(m15.close[c])  # a 15m candle has closed
        if not half_done and stop > entry and (close - zero) / (one - zero) <= BE_LEVEL:
            stop = entry
        if decide_at == c:
            decide_at = None
            rng = float(m15.high[c] - m15.low[c])
            if close < zero and rng > 0 and abs(close - float(m15.open[c])) >= 0.5 * rng:
                runner, stop = True, min(stop, zero)
            else:
                return total + open_part * r(close)
        elif runner and c >= 2 and is_swing_high(m15.high[:c + 1], c - 2):
            stop = min(stop, float(m15.high[c - 2]))
    return total + open_part * r(float(m5.close[len(m5) - 1]))


# ----------------------------------------------------------------- rows
def _settings_at(data: dict, t: int) -> dict:
    settings = dict(data.get("settings") or {})
    for a in data.get("actions") or []:
        if a.get("kind") == "settings" and a.get("at", 0) <= t and isinstance(a.get("settings"), dict):
            settings.update(a["settings"])
    return settings


def trade_row(trade: dict, data: dict, m5: Candles) -> dict:
    run, digits, pip = data["id"], data["digits"], data["pipPoints"]
    furthest = data["furthestTime"]
    entry_t = trade["entryTime"]
    side = trade["side"]
    day = ny_date(entry_t)
    zone = killzone_of(entry_t)
    price = lambda p: fmt_price(None if p is None else int(round(p)), digits)
    row = dict.fromkeys(COLUMNS, "")  # every column present; blank until measured
    row.update({
        "run_id": run, "trade_id": trade["id"], "date_ny": day.isoformat(), "weekday": WEEKDAYS[day.weekday()],
        "killzone": zone, "side": side, "order_type": trade.get("orderType", ""),
        "placed_time_ny": ny_text(trade.get("placedTime")), "entry_time_ny": ny_text(entry_t),
        "exit_time_ny": ny_text(trade.get("exitTime")), "entry_price": price(trade.get("entryPrice")),
        "stop_loss": price(trade.get("initialStop", trade.get("stopLoss"))), "take_profit": price(trade.get("takeProfit")),
        "exit_price": price(trade.get("exitPrice")), "exit_reason": trade.get("exitReason") or "",
        "lots": fmt_num(trade.get("lots"), 2), "actual_r": fmt_num(trade.get("resultR"), 2),
        "pnl_usd": fmt_num(trade.get("money"), 2), "commission_usd": fmt_num(trade.get("commission"), 2),
        "tags": "; ".join(trade.get("tags") or []), "note": trade.get("note") or "",
    })
    initial = trade.get("initialStop", trade.get("stopLoss"))
    if trade.get("entryPrice") is not None and initial is not None:
        row["risk_pips"] = fmt_num(abs(trade["entryPrice"] - initial) / pip, 1)
    i = m5.index_at(entry_t)
    if i >= 0:
        min_spread = round(float(_settings_at(data, entry_t).get("minSpreadPips", 0) or 0) * pip)
        row["spread_pips"] = fmt_num(max(min_spread, int(m5.spread[i])) / pip, 1)

    seen = m5.until(furthest)
    pre = pre_fields(seen, day, side, pip)
    row.update({
        "adr5_pips": fmt_num(None if pre["adr5"] is None else pre["adr5"] / pip, 1),
        "daily_structure": pre["daily"], "weekly_structure": pre["weekly"], "bias": pre["bias"],
        "asian_high": fmt_price(pre["asian_high"], digits), "asian_low": fmt_price(pre["asian_low"], digits),
        "asian_range_pips": fmt_num(None if pre["asian_high"] is None else (pre["asian_high"] - pre["asian_low"]) / pip, 1),
        "open_0000": fmt_price(pre["open"], digits), "pdh": fmt_price(pre["pdh"], digits), "pdl": fmt_price(pre["pdl"], digits),
        "pwh": fmt_price(pre["pwh"], digits), "pwl": fmt_price(pre["pwl"], digits),
        "nearest_pd_type": pre["nearest"] or "", "open_dist_pips": fmt_num(pre["open_dist"], 1),
    })

    placed = trade.get("placedTime") or entry_t
    sv = view(seen, side)
    setup = find_setup(sv, pre["day_start"], placed)
    row["setup_found"] = fmt_bool(setup.found)
    if setup.h2 is not None:
        row["h2_price"], row["h2_time_ny"] = price(back(setup.h2, side)), ny_text(setup.h2_time)
        asian = pre["asian_high"] if side == "SELL" else pre["asian_low"]
        if asian is not None:
            row["h2_beyond_asian_pips"] = fmt_num((setup.h2 - (asian if side == "SELL" else -asian)) / pip, 1)
        hit = None
        for z in pre["zones"][side]:  # on the trade's side: the array H2 traded into
            inside = setup.h2 > z.hi if z.code[:2] in ("PD", "PW") else setup.h2 >= z.lo
            if inside and (hit is None or (z.rank, abs(setup.h2 - z.lo)) < (hit.rank, abs(setup.h2 - hit.lo))):
                hit = z
        row["pd_hit_type"] = hit.code if hit else "NONE"
        if hit and hit.code[:2] in ("PD", "PW"):
            row["pd_hit_beyond_pips"] = fmt_num((setup.h2 - hit.lo) / pip, 1)
    if setup.h1 is not None:
        row.update({"h1_price": price(back(setup.h1, side)), "h1_time_ny": ny_text(setup.h1_time),
                    "h1_candles_before_h2": setup.h1_before, "l1_price": price(back(setup.l1, side))})
    if setup.found:
        row.update({"disp_time_ny": ny_text(setup.disp_time), "disp_range_atr": fmt_num(setup.disp_atr, 2),
                    "disp_body_pct": fmt_num(setup.disp_body, 2), "disp_candles_after_h2": setup.disp_after})
    drawn = user_fib(data.get("drawings"), placed, side)
    row["user_fib_found"] = fmt_bool(drawn is not None)
    if drawn:
        row["user_fib_1"], row["user_fib_0"] = fmt_price(drawn[1], digits), fmt_price(drawn[2], digits)

    t1600 = ny_time(day, 16)
    if not setup.found:
        row["post_status"] = "NO_SETUP"
        return row
    walk_end = killzone_window(day, zone)[1]
    fib = walk_fib(sv, setup, walk_end, furthest)
    span = fib.one - fib.zero
    row.update({"fib_1": price(back(fib.one, side)), "fib_0": price(back(fib.zero, side)),
                "fib_0_time_ny": ny_text(fib.zero_time), "leg_pips": fmt_num(abs(span) / pip, 1)})
    level062 = fib.zero + ENTRY_LEVEL * span
    opposite = [z.flipped() for z in pre["zones"]["BUY" if side == "SELL" else "SELL"]]  # onto this side's view
    blocking = sorted((z for z in opposite if z.hi >= fib.zero and z.lo <= level062), key=lambda z: z.rank)
    row["opp_pd_between"] = fmt_bool(bool(blocking))
    row["opp_pd_type"] = blocking[0].code if blocking else ""
    if span > 0:
        to_view = (lambda p: p) if side == "SELL" else (lambda p: -p)
        if trade.get("entryPrice") is not None:
            row["entry_fib_level"] = fmt_num((to_view(trade["entryPrice"]) - fib.zero) / span, 3)
        if initial is not None:
            row["stop_fib_level"] = fmt_num((to_view(initial) - fib.zero) / span, 3)
    if furthest + 300 < t1600 or not fib.complete:
        row["post_status"] = "PENDING"
        return row
    row["post_status"] = "COMPLETE"
    post = post_fields(sv, fib, day, zone, pre["adr5"])
    row.update({
        "time_062_ny": ny_text(post["time_062"]), "deepest_level_kz": fmt_num(post["deepest_kz"], 3),
        "deepest_level_total": fmt_num(post["deepest_total"], 3), "resolution": post["resolution"],
        "resolution_time_ny": ny_text(post["resolution_time"]), "level_at_1600": fmt_num(post["level_at_1600"], 3),
        "be_triggered": fmt_bool(post["be"]), "target_momentum": fmt_bool(post["momentum"]),
        "phase2_r_gross": fmt_num(post["phase2"], 2),
    })
    return row


def day_rows(data: dict, m5: Candles, reuse: dict | None = None) -> list[dict]:
    """One row per New York weekday whose 00:00 the replay passed, from its start to its furthest candle.
    `reuse` maps date -> an earlier row of this session; only its trade count is worked out again."""
    pip, run = data["pipPoints"], data["id"]
    start, furthest = data["startTime"], data["furthestTime"]
    seen = m5.until(furthest)
    entries = [ny_date(t["entryTime"]) for t in data.get("trades") or [] if t.get("entryTime") is not None]
    rows = []
    for day in weekdays_between(ny_date(start), ny_date(furthest)):
        if not (start <= ny_time(day, 0) <= furthest):
            continue
        if reuse and day.isoformat() in reuse:
            rows.append(dict(reuse[day.isoformat()], trades_taken=sum(1 for d in entries if d == day)))
            continue
        pre = pre_fields(seen, day, None, pip)
        rows.append({
            "run_id": run, "date_ny": day.isoformat(), "weekday": WEEKDAYS[day.weekday()],
            "adr5_pips": fmt_num(None if pre["adr5"] is None else pre["adr5"] / pip, 1),
            "daily_structure": pre["daily"], "weekly_structure": pre["weekly"], "bias": pre["bias"],
            "asian_range_pips": fmt_num(None if pre["asian_high"] is None else (pre["asian_high"] - pre["asian_low"]) / pip, 1),
            "nearest_pd_type": (pre["nearest"] or "") if pre["bias"] != "NONE" else "",
            "open_dist_pips": fmt_num(pre["open_dist"], 1) if pre["bias"] != "NONE" else "",
            "trades_taken": sum(1 for d in entries if d == day), "auto_setup_ny": "", "auto_setup_london": "",
        })
    return rows


def _trade_order(r: dict):
    return (r["date_ny"], r["run_id"], int(r["trade_id"]) if str(r.get("trade_id", "")).isdigit() else 0)


FINAL = ("COMPLETE", "NO_SETUP")  # rows that later candles can no longer change


def _previous(path: Path, run: str, key: str) -> dict:
    if not path.exists():
        return {}
    import csv
    with path.open(newline="", encoding="utf-8") as f:
        return {r[key]: r for r in csv.DictReader(f) if r.get("run_id") == run}


def write_logs(data: dict, folder: Path, m5: Candles) -> dict:
    """Recompute this session's rows in nbb_log.csv and nbb_days.csv; other sessions' rows are kept.

    The app saves every couple of seconds while a replay plays, so finished work is not repeated:
    a trade row that is COMPLETE or NO_SETUP, and a day already logged, depend only on candles
    that can no longer change. They are reused, with what can still change refreshed (the trade's
    note and tags, your Fibonacci drawing, the day's trade count). `rebuild` recomputes everything.
    """
    folder = Path(folder)
    closed = [t for t in data.get("trades") or [] if t.get("status") == "CLOSED" and t.get("entryTime") is not None]
    before = _previous(folder / LOG_FILE, data["id"], "trade_id")
    rows = []
    for t in closed:
        old = before.get(str(t["id"]))
        if old and old.get("post_status") in FINAL and old.get("entry_time_ny") == ny_text(t["entryTime"]) \
                and old.get("exit_time_ny") == ny_text(t.get("exitTime")):
            row = dict(old)
            row["tags"], row["note"] = "; ".join(t.get("tags") or []), t.get("note") or ""
            drawn = user_fib(data.get("drawings"), t.get("placedTime") or t["entryTime"], t["side"])
            row["user_fib_found"] = fmt_bool(drawn is not None)
            row["user_fib_1"], row["user_fib_0"] = (fmt_price(drawn[1], data["digits"]), fmt_price(drawn[2], data["digits"])) if drawn else ("", "")
            rows.append(row)
        else:
            rows.append(trade_row(t, data, m5))
    old_days = _previous(folder / DAYS_FILE, data["id"], "date_ny")
    days = day_rows(data, m5, reuse=old_days)
    write_keyed_csv(Path(folder) / LOG_FILE, COLUMNS, data["id"], rows, _trade_order)
    write_keyed_csv(Path(folder) / DAYS_FILE, DAY_COLUMNS, data["id"], days, lambda r: (r["date_ny"], r["run_id"]))
    return {"trades": len(rows), "days": len(days)}


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
