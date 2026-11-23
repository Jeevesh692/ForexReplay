"""The mechanical backtester's engine: Models A and B, trade management and limits, one pair at a time.

It walks the 1-minute candles the app replays (bid prices, in points) and lets broker.py, the engine the replay
is held to, fill and close the trades. At each candle's close (the cursor) it manages open trades, and at each
5-minute close inside a model's window it looks for setups and triggers. Every rule reads only what had closed
by the cursor, with the shared definitions: the profile and day levels (profile.py), the market state
(marketstate.py), RVOL and bubbles (orderflow.py), the trigger rules (trigger.py) and the costs (costs.py).
Decision 0041 lists every choice made where the brief left room.
"""

from __future__ import annotations

import csv
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from .. import flow
from ..broker import Broker, ExitReason, InvalidOrder, Side, Status
from ..config import Instrument
from ..costs import point_value, position_plan, units_for_risk
from ..loglib import Candles, five_minute, wilder_atr
from ..marketstate import market_state
from ..orderflow import bubbles, candle_flow
from ..profile import day_levels, price_bin, profile_from_bars, server_day, server_days
from ..sessions import session_label
from ..trigger import bubble_rule, candle_rules, current_m5

IST = ZoneInfo("Asia/Kolkata")


def cut(bars: dict, start: float, end: float) -> dict:
    """Bars with open time in [start, end), as lists (the shared definitions read lists)."""
    a, b = np.searchsorted(bars["time"], [start, end])
    return {k: (v[a:b].tolist() if isinstance(v, np.ndarray) else v) for k, v in bars.items()}


def ist_minutes(utc: int) -> int:
    t = datetime.fromtimestamp(int(utc), IST)
    return t.hour * 60 + t.minute


def window_minutes(window) -> tuple[int, int]:
    (h1, m1), (h2, m2) = (map(int, str(w).split(":")) for w in window)
    return h1 * 60 + m1, h2 * 60 + m2


def in_window(utc: int, window) -> bool:
    start, end = window_minutes(window)
    m = ist_minutes(utc)
    return start <= m <= end if start <= end else (m >= start or m <= end)


@dataclass
class Bars15:
    """15-minute candles built from the 1-minute ones (UTC grid), with ATR."""
    start: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    atr: np.ndarray

    @classmethod
    def build(cls, base: Candles, atr_period: int) -> "Bars15":
        keys = base.time // 900
        starts = np.flatnonzero(np.r_[True, keys[1:] != keys[:-1]])
        lasts = np.r_[starts[1:] - 1, len(keys) - 1]
        high, low = np.maximum.reduceat(base.high, starts), np.minimum.reduceat(base.low, starts)
        close = base.close[lasts]
        return cls(keys[starts] * 900, high, low, close, wilder_atr(high.astype(float), low.astype(float), close.astype(float), atr_period))

    def closed(self, cursor: int) -> int:
        """How many 15m candles had closed by the cursor."""
        return int(np.searchsorted(self.start, cursor - 900, side="right"))


def swing(values: np.ndarray, k: int, n: int, low: bool) -> bool:
    """A swing low (high): lower (higher) than the n candles on each side."""
    if k < n or k + n >= len(values):
        return False
    others = np.r_[values[k - n:k], values[k + 1:k + n + 1]]
    return bool(np.all(values[k] < others) if low else np.all(values[k] > others))


@dataclass
class Setup:
    model: str          # "A" or "B"
    side: str           # "long" or "short"
    zone: tuple         # (low, high) in points
    leg: tuple          # (low, high) in points
    leg_start: int      # UTC: where the leg's profile starts
    made: int           # the cursor it was found at
    key: tuple          # what it came from, so it is not found twice
    note: str = ""
    tags: list = field(default_factory=list)
    profile_end: int = 0  # where the leg's profile ends: the zone was read from it (the log redraws it from here)


@dataclass
class Open:
    """What the engine knows about a trade beyond the broker's record."""
    trade: object
    setup: Setup
    units: int
    risk_money: float
    pv: float
    commission_rt: float
    slip_points: float
    session: str
    day: int
    trail: bool = False
    be_done: bool = False
    time_checked: bool = False
    exit_answer: str = ""
    displacements: int = 0
    quarter: str = ""   # "" | "taken" (75% closed at POC) | "held" (the 25% kept)
    poc: float | None = None
    edge: float | None = None


class PairRun:
    """One pair from start to end, under one configuration."""

    def __init__(self, symbol: str, config: dict, base: Candles, m1: dict, news: list[tuple[int, str]] | None = None,
                 s15_reader=None, contract: int | None = None, digits: int | None = None, pip_points: int = 10):
        self.symbol, self.c, self.base, self.m1 = symbol, config, base, m1
        self.digits = digits if digits is not None else (2 if symbol == "XAUUSD" else 3 if symbol.endswith("JPY") else 5)
        self.pip = pip_points
        self.unit = 10 ** self.digits
        self.contract = contract or (100 if symbol == "XAUUSD" else 100000)
        self.s15_reader = s15_reader or (lambda months: flow.read_flow(symbol, "S15", months))
        self.news = news or []
        t = config["trigger"]
        self.m5 = five_minute(base)
        self.atr5 = wilder_atr(self.m5.high.astype(float), self.m5.low.astype(float), self.m5.close.astype(float), int(t["atr_period"]))
        self.m15 = Bars15.build(base, int(t["atr_period"]))
        self.bin = max(1, price_bin(config["bins"][symbol], self.digits))
        p = config["profile"]
        self.pset = {"value_area": p["value_area"], "smoothing": p["smoothing"], "lvn": p["lvn"]}
        ms = config["market_state"]
        self.tf, self.accept, self.window = ms["timeframe_minutes"] * 60, ms["accept_closes"], ms["reject_window_minutes"] * 60
        ps = config["pair_settings"][symbol]
        self.buffer = round(ps["stop_buffer"] * self.unit)
        self.min_stop_pips, self.max_stop_pips = ps["min_stop"] * self.unit / self.pip, ps["max_stop"] * self.unit / self.pip
        a = config["account"]
        self.balance = float(a["balance"])
        self.min_spread = round(a["min_spread_pips"] * self.pip)
        self.broker = Broker(Instrument(symbol=symbol, pip_size=self.pip, digits=0))
        self.open: list[Open] = []
        self.closed: list[dict] = []
        self.skipped: list[dict] = []
        self.setups: dict = {}            # (model, side) -> Setup
        self.tried: set = set()
        self.day_cache: dict = {}
        self.losing_streak = 0
        self.day_stats: dict = {}         # server day -> {"trades", "losses", "r", "sessions": {label: n}}
        self.week_start: dict = {}        # week -> balance at its start
        self.drawings: list[dict] = []
        self.equity: list[tuple[int, float]] = []

    # ------------------------------------------------------------------ the day
    def day(self, cursor: int) -> dict:
        """The trading day's fixed facts: the prior day's levels, today's first open, whether the prior day was balanced."""
        d = server_day(cursor - 1)
        if d in self.day_cache:
            return self.day_cache[d]
        window = cut(self.m1, cursor - 12 * 86400, cursor)
        levels = day_levels(window, cursor, self.bin, 1, **self.pset)
        prior = levels["prior"]
        info = {"day": d, "prior": prior, "start": levels["day_start"], "open_inside": None, "balanced": None}
        if prior:
            days = server_days(window["time"])
            rows = [i for i, x in enumerate(days) if x == prior["day"]]
            today = [i for i, x in enumerate(days) if x == d]
            if rows:
                hi, lo = max(window["high"][i] for i in rows), min(window["low"][i] for i in rows)
                middle = self.c["model_b"]["balanced_poc_middle"]
                margin = (1 - middle) / 2 * (hi - lo)
                info["balanced"] = lo + margin <= prior["poc"] <= hi - margin
            if today:
                info["open_inside"] = prior["val"] <= window["open"][today[0]] <= prior["vah"]
        self.day_cache = {d: info}
        return info

    def state(self, cursor: int, prior: dict) -> dict:
        today = cut(self.m1, cursor - 86400 - 60, cursor)
        return market_state(today, cursor, prior["val"], prior["vah"], self.tf, self.accept, self.window)

    def skip(self, cursor: int, model: str, side: str, reason: str) -> None:
        self.skipped.append({"time": cursor, "pair": self.symbol, "model": model, "side": side, "reason": reason})

    # ------------------------------------------------------------------ setups
    def model_a(self, cursor: int, info: dict, st: dict) -> None:
        cfg = self.c["model_a"]
        if not st["state"].startswith("accepted_"):
            return
        side = "long" if st["state"] == "accepted_above" else "short"
        event = [e for e in st["events"] if e["kind"] == "accepted" and e["side"] == st["state"].split("_")[1]][-1]
        key = ("A", side, event["time"])
        if key in self.tried or ("A", side) in self.setups:
            return
        self.tried.add(key)
        breakout = event["time"] - self.accept * self.tf  # the first 30-minute candle of the accepting run
        n = self.m15.closed(cursor)
        bars = cfg["swing_bars"]
        k = None
        for j in range(min(n - 1 - bars, int(np.searchsorted(self.m15.start, breakout)) - 1), max(-1, n - cfg["swing_lookback_15m"]), -1):
            if self.m15.start[j] < breakout and swing(self.m15.low if side == "long" else self.m15.high, j, bars, side == "long"):
                k = j
                break
        if k is None:
            self.skip(cursor, "A", side, "no 15m swing before the break")
            return
        lo, hi = np.searchsorted(self.base.time, [self.m15.start[k], cursor - 59])
        if side == "long":
            leg = (int(self.m15.low[k]), int(self.base.high[lo:hi].max()))
        else:
            leg = (int(self.base.low[lo:hi].min()), int(self.m15.high[k]))
        atr = self.m15.atr[n - 1] if n else np.nan
        size = leg[1] - leg[0]
        if not np.isfinite(atr) or size < cfg["leg_atr"] * atr:
            self.skip(cursor, "A", side, f"leg {size / self.pip:.1f} pips < {cfg['leg_atr']} x ATR15 {atr / self.pip if np.isfinite(atr) else float('nan'):.1f}")
            return
        start = int(self.m15.start[k])
        pr = profile_from_bars(cut(self.m1, start, cursor), start, cursor, self.bin, cursor, **self.pset)
        best = None
        for z in pr["lvns"] if pr else []:
            mid = (z["low"] + z["high"]) / 4  # flow units -> points
            retrace = (leg[1] - mid) / size if side == "long" else (mid - leg[0]) / size
            if cfg["retrace_min"] <= retrace <= cfg["retrace_max"] and (best is None or abs(retrace - 0.5) < abs(best[1] - 0.5)):
                best = (z, retrace)
        if best is None:
            self.skip(cursor, "A", side, f"no LVN in {cfg['retrace_min']:.0%}-{cfg['retrace_max']:.0%} of the leg")
            return
        z, retrace = best
        self.setups[("A", side)] = Setup("A", side, (z["low"] / 2, z["high"] / 2), leg, start, cursor, key, profile_end=cursor,
                                         note=f"A: leg {size / self.pip:.1f} pips = {size / atr:.1f} ATR15, LVN at {retrace:.0%}")

    def model_b(self, cursor: int, info: dict, st: dict) -> None:
        cfg = self.c["model_b"]
        if not st["state"].startswith("rejected_"):
            return
        out = st["state"].split("_")[1]  # where price failed: above or below
        side = "short" if out == "above" else "long"
        event = [e for e in st["events"] if e["kind"] == "rejected" and e["side"] == out][-1]
        key = ("B", side, event["time"])
        if key in self.tried or ("B", side) in self.setups:
            return
        self.tried.add(key)
        if not info["open_inside"]:
            self.skip(cursor, "B", side, "the day did not open inside the prior value")
            return
        if not info["balanced"]:
            self.skip(cursor, "B", side, "the prior day's profile was not balanced")
            return
        prior = info["prior"]
        lo, hi = np.searchsorted(self.base.time, [event["time"] - self.window - self.tf, event["time"]])
        if hi <= lo:
            return
        if side == "short":
            j = lo + int(np.argmax(self.base.high[lo:hi]))
            extreme = int(self.base.high[j])
            back = int(self.base.low[j:hi].min())
            leg = (back, extreme)
        else:
            j = lo + int(np.argmin(self.base.low[lo:hi]))
            extreme = int(self.base.low[j])
            back = int(self.base.high[j:hi].max())
            leg = (extreme, back)
        start = int(self.base.time[j])
        if cfg["double_failure_only"]:
            n = self.m15.closed(event["time"])
            edge = prior["vah"] / 2 if side == "short" else prior["val"] / 2
            pushes = [k for k in range(max(0, n - 12), n) if self.m15.start[k] >= event["time"] - self.window - self.tf
                      and swing(self.m15.high if side == "short" else self.m15.low, k, 1, side == "long")
                      and ((self.m15.high[k] > edge) if side == "short" else (self.m15.low[k] < edge))]
            if len(pushes) < 2:
                self.skip(cursor, "B", side, f"A+ filter: {len(pushes)} failed push(es), 2 needed")
                return
        pr = profile_from_bars(cut(self.m1, start, event["time"]), start, event["time"], self.bin, cursor, **self.pset)
        inside = [z for z in (pr["lvns"] if pr else []) if leg[0] < z["low"] / 2 and z["high"] / 2 < leg[1]]
        if not inside:
            self.skip(cursor, "B", side, "no LVN inside the reclaim leg")
            return
        middle = (leg[0] + leg[1]) / 2
        z = min(inside, key=lambda z: abs((z["low"] + z["high"]) / 4 - middle))
        tags = ["A+ double failure"] if cfg["double_failure_only"] else []
        self.setups[("B", side)] = Setup("B", side, (z["low"] / 2, z["high"] / 2), leg, start, event["time"], key, tags=tags,
                                         profile_end=event["time"],
                                         note=f"B: failed {'high' if side == 'short' else 'low'} {extreme / self.unit:.{self.digits}f}, reclaim leg {(leg[1] - leg[0]) / self.pip:.1f} pips")

    # ------------------------------------------------------------------ triggers and entries
    def trigger(self, cursor: int, setup: Setup, i: int) -> dict | None:
        """The closed 5-minute candle, if it traded into the zone and passed the rules switched on."""
        t = self.c["trigger"]
        lo = int(np.searchsorted(self.base.time, cursor - 600))
        minutes = {k: getattr(self.base, k)[lo:i + 1].tolist() for k in ("time", "open", "high", "low", "close")}
        candle = current_m5(minutes, cursor)
        if not candle or not candle["closed"] or candle["start"] < setup.made:
            return None
        z = setup.zone
        if candle["low"] > z[1] or candle["high"] < z[0]:
            return None
        k = int(np.searchsorted(self.m5.time, candle["start"])) - 1
        atr = float(self.atr5[k]) if k >= 0 and np.isfinite(self.atr5[k]) else None
        rv = candle_flow([candle["start"]], 300, cursor, cut(self.m1, candle["start"], candle["start"] + 300), [])["rvol"][0]
        rules = candle_rules(candle["open"], candle["high"], candle["low"], candle["close"], atr, rv, setup.side,
                             t["body"], t["range_atr"], t["close_zone"], t["min_rvol"])
        failed = [name for name, r in rules.items() if not r["pass"]]
        if t["use_bubble_rule"]:
            b = self.c["bubbles"]
            month = datetime.fromtimestamp(candle["start"], timezone.utc).strftime("%Y-%m")
            s15 = self.s15_reader([month])
            items = [] if s15 is None else bubbles(cut(s15, candle["start"], candle["start"] + 300), candle["start"], candle["start"] + 300, cursor,
                                                   price_bin(b["bubble_move"][self.symbol], self.digits), price_bin(b["absorption_move"][self.symbol], self.digits),
                                                   b["min_rvol"], b["medium"], b["large"])
            rule = bubble_rule(items, [{"low": 2 * z[0], "high": 2 * z[1]}], 2 * candle["low"], 2 * candle["high"], setup.side, t["bubble_rvol"])
            if not rule["pass"]:
                failed.append("bubble")
        if failed:
            self.skip(cursor, setup.model, setup.side, "trigger failed: " + ", ".join(failed))
            return None
        return candle

    def limits_block(self, cursor: int, session: str) -> str:
        lim = self.c["limits"]
        d = server_day(cursor - 1)
        ds = self.day_stats.get(d, {"trades": 0, "losses": 0, "r": 0.0, "sessions": {}})
        if ds["trades"] >= lim["max_trades_per_day"]:
            return f"{lim['max_trades_per_day']} trades today"
        if ds["sessions"].get(session, 0) >= lim["max_trades_per_session"]:
            return f"{lim['max_trades_per_session']} trades this session"
        if ds["losses"] >= lim["stop_day_after_losses"]:
            return "day stopped after losses"
        if ds["r"] >= lim["stop_day_after_r"]:
            return f"day stopped at +{lim['stop_day_after_r']}R"
        week = (d + 3) // 7  # weeks of server days, Monday to Friday together
        start = self.week_start.setdefault(week, self.balance)
        if (self.balance - start) / start * 100 <= lim["stop_week_at_percent"]:
            return f"week stopped at {lim['stop_week_at_percent']}%"
        ccy = {self.symbol[:3], self.symbol[3:]} - {"XAU"} | ({"USD"} if self.symbol.startswith("XAU") else set())
        near = lim["news_minutes"] * 60
        k = bisect_right(self.news, (cursor - near, ""))
        while k < len(self.news) and self.news[k][0] <= cursor + near:
            if self.news[k][1] in ccy:
                return f"news within {lim['news_minutes']} min"
            k += 1
        return ""

    def enter(self, cursor: int, setup: Setup, candle: dict, i: int, info: dict) -> None:
        a, ps = self.c["account"], self.c["pair_settings"][self.symbol]
        direction = 1 if setup.side == "long" else -1
        spread = max(self.min_spread, int(self.base.spread[i]))
        self.broker.spread = spread
        bid = int(self.base.close[i])
        entry = bid + spread if setup.side == "long" else bid
        if setup.side == "long":
            stop = min(candle["low"], setup.zone[0]) - self.buffer
        else:
            stop = max(candle["high"], setup.zone[1]) + self.buffer
        stop = int(np.floor(stop) if setup.side == "long" else np.ceil(stop))
        risk = abs(entry - stop)
        pips = risk / self.pip
        if pips < self.min_stop_pips or pips > self.max_stop_pips:
            self.skip(cursor, setup.model, setup.side, f"stop {pips:.1f} pips outside {self.min_stop_pips:.0f}-{self.max_stop_pips:.0f}")
            return
        pv = point_value(self.symbol, self.digits, self.contract, entry)
        trail, target = False, None
        if setup.model == "A":
            cfg = self.c["model_a"]
            levels = day_levels(cut(self.m1, cursor - (cfg["naked_poc_days"] + 8) * 86400, cursor), cursor, self.bin,
                                cfg["naked_poc_days"], **self.pset)
            pocs = sorted(n["poc"] / 2 for n in levels["naked"] if n["to"] is None and direction * (n["poc"] / 2 - entry) >= 2 * risk)
            pocs = pocs if setup.side == "long" else pocs[::-1]
            if pocs and direction * (pocs[0] - entry) <= cfg["naked_poc_max_r"] * risk:
                target = int(round(pocs[0]))
                plan_target = target
            else:
                trail = True
                target = entry + direction * 100 * risk  # no fixed target: trail from +3R (never reached)
                plan_target = entry + direction * round(cfg["fallback_target_r"] * risk)
            min_r = cfg["min_target_r"]
        else:
            cfg = self.c["model_b"]
            poc = info["prior"]["poc"] / 2
            plan_target = target = int(round(poc))
            if cfg["hold_quarter"]:
                edge = (info["prior"]["val"] if setup.side == "short" else info["prior"]["vah"]) / 2
                target = int(round(edge))
            min_r = cfg["min_target_r"]
        if direction * (plan_target - entry) <= 0:
            self.skip(cursor, setup.model, setup.side, "target on the wrong side of the entry")
            return
        risk_pct = a["reduced_risk_percent"] if self.losing_streak >= a["losses_before_reduced"] else a["risk_percent"]
        plan = position_plan(setup.side, entry, stop, plan_target, balance=self.balance, risk_percent=risk_pct, point_value=pv,
                             pip_points=self.pip, spread_points=spread, commission_per_lot=a["commission_per_lot"],
                             per_side=a["commission_per_side"], slippage_pips=a["slippage_pips"], min_target_r=min_r)
        if "error" in plan:
            self.skip(cursor, setup.model, setup.side, plan["error"])
            return
        if "target_below_min" in plan["warnings"]:
            self.skip(cursor, setup.model, setup.side, f"target {plan['target_r']:.2f}R after costs < {min_r}R")
            return
        if plan["units"] < 1:
            self.skip(cursor, setup.model, setup.side, "size under 0.01 lots")
            return
        session = session_label(cursor)
        blocked = self.limits_block(cursor, session)
        if blocked:
            self.skip(cursor, setup.model, setup.side, f"limit: {blocked}")
            return
        try:
            trade = self.broker.market_order(Side.BUY if setup.side == "long" else Side.SELL, stop, target, int(self.base.time[i]), bid)
        except InvalidOrder as err:
            self.skip(cursor, setup.model, setup.side, str(err))
            return
        rt = a["commission_per_lot"] * (2 if a["commission_per_side"] else 1)
        o = Open(trade, setup, plan["units"], plan["units"] / 100 * risk * pv, pv, rt, a["slippage_pips"] * self.pip, session,
                 server_day(cursor - 1), trail=trail)
        if setup.model == "B":
            o.poc = info["prior"]["poc"] / 2
            o.edge = target if self.c["model_b"]["hold_quarter"] else None
        self.open.append(o)
        d = self.day_stats.setdefault(o.day, {"trades": 0, "losses": 0, "r": 0.0, "sessions": {}})
        d["trades"] += 1
        d["sessions"][session] = d["sessions"].get(session, 0) + 1
        self.drawings.append({"type": "vprofile", "points": [{"time": setup.leg_start, "price": setup.leg[0]},
                                                             {"time": setup.profile_end - 60, "price": setup.leg[1]}],
                              "profile": {"source": "M1", "bin": self.c["bins"][self.symbol], "valueArea": self.c["profile"]["value_area"],
                                          "smoothing": self.c["profile"]["smoothing"], "lvn": self.c["profile"]["lvn"]}})
        del self.setups[(setup.model, setup.side)]

    # ------------------------------------------------------------------ management
    def manage(self, cursor: int, i: int, info: dict) -> None:
        m, bid, t = self.c["management"], int(self.base.close[i]), int(self.base.time[i])
        for o in list(self.open):
            tr = o.trade
            if tr.status is not Status.OPEN:
                continue
            direction = 1 if tr.side is Side.BUY else -1
            # Time stop: not at +0.5R within 45 minutes.
            if not o.time_checked and cursor - tr.entry_time >= m["time_stop_minutes"] * 60:
                o.time_checked = True
                if (tr.mfe_r or 0) < m["time_stop_r"]:
                    o.exit_answer = "time stop"
                    self.broker.close(tr, t, bid)
                    continue
            # Model B: out if a 30-minute candle closes back beyond the failed edge.
            if o.setup.model == "B" and cursor % self.tf == 0 and info["prior"]:
                close30 = self.close30(cursor)
                edge = info["prior"]["vah"] / 2 if direction < 0 else info["prior"]["val"] / 2
                if close30 is not None and direction * (edge - close30) > 0:
                    o.exit_answer = "state invalidation"
                    self.broker.close(tr, t, bid)
                    continue
                if o.quarter == "taken":  # variant: keep the last 25% only after a 30m close beyond the POC
                    if close30 is not None and direction * (close30 - o.poc) > 0:
                        o.quarter = "held"
                    else:
                        self.broker.close(tr, t, bid)
                        continue
            if o.edge is not None and not o.quarter and direction * (bid - o.poc) >= 0:
                self.broker.partial_close(tr, 0.75, t, bid)
                o.quarter = "taken"
            # Breakeven at +1R (or the variant's signal): stop to entry + the round trip's cost; never widened.
            if not o.be_done and self.breakeven_due(o, cursor, i):
                level = tr.entry_price + direction * (o.commission_rt / o.pv + o.slip_points)
                if direction * (level - tr.stop_loss) > 0:
                    try:
                        self.broker.modify(tr, bid, stop_loss=level)
                        o.be_done = True
                    except InvalidOrder:
                        pass  # price is below the level now: try again at a later close
                else:
                    o.be_done = True
            # Model A without a naked POC target: from +3R, the stop follows each new 15m higher low (lower high).
            if o.trail and (tr.mfe_r or 0) >= self.c["model_a"]["trail_after_r"] and cursor % 900 == 0:
                n = self.m15.closed(cursor)
                bars = self.c["model_a"]["swing_bars"]
                for k in range(n - 1 - bars, max(-1, n - 40), -1):
                    if swing(self.m15.low if direction > 0 else self.m15.high, k, bars, direction > 0):
                        level = (self.m15.low[k] - self.buffer) if direction > 0 else (self.m15.high[k] + self.buffer)
                        if direction * (level - tr.stop_loss) > 0:
                            try:
                                self.broker.modify(tr, bid, stop_loss=float(level))
                                o.exit_answer = "trail"
                            except InvalidOrder:
                                pass
                        break

    def breakeven_due(self, o: Open, cursor: int, i: int) -> bool:
        variant = self.c["management"]["breakeven_variant"]
        tr = o.trade
        if variant == "none":
            return (tr.mfe_r or 0) >= self.c["management"]["breakeven_r"]
        if cursor % 300:
            return False
        direction = 1 if tr.side is Side.BUY else -1
        lo = int(np.searchsorted(self.base.time, cursor - 600))
        minutes = {k: getattr(self.base, k)[lo:i + 1].tolist() for k in ("time", "open", "high", "low", "close")}
        candle = current_m5(minutes, cursor)
        if not candle or candle["start"] < tr.entry_time:
            return False
        if variant == "second_displacement":
            k = int(np.searchsorted(self.m5.time, candle["start"])) - 1
            atr = float(self.atr5[k]) if k >= 0 and np.isfinite(self.atr5[k]) else None
            t = self.c["trigger"]
            r = candle_rules(candle["open"], candle["high"], candle["low"], candle["close"], atr, None, "long" if direction > 0 else "short",
                             t["body"], t["range_atr"], t["close_zone"], 0)
            if r["body"]["pass"] and r["range"]["pass"] and direction * (candle["close"] - candle["open"]) > 0:
                o.displacements += 1
            return o.displacements >= 2
        # CVD pressure: each of the last three 5-minute deltas in the trade's favour.
        part = cut(self.m1, cursor - 900, cursor)
        deltas = candle_flow([cursor - 900, cursor - 600, cursor - 300], 300, cursor, part, [])["delta"]
        return all(d is not None and direction * d > 0 for d in deltas)

    def close30(self, cursor: int) -> float | None:
        """The last 30-minute candle's close (the mid, in points) from the order-flow minutes."""
        part = cut(self.m1, cursor - self.tf, cursor)
        return part["close"][-1] / 2 if part["close"] else None

    def settle(self, o: Open) -> None:
        tr = o.trade
        cost_r = (o.commission_rt + o.slip_points * o.pv) / (tr.planned_risk * o.pv)
        net_r = tr.result_r - cost_r
        money = net_r * o.risk_money
        self.balance += money
        self.equity.append((int(tr.exit_time), self.balance))
        self.losing_streak = self.losing_streak + 1 if net_r < 0 else 0
        d = self.day_stats.setdefault(o.day, {"trades": 0, "losses": 0, "r": 0.0, "sessions": {}})
        d["r"] += net_r
        d["losses"] += net_r < 0
        exit_answer = o.exit_answer if o.exit_answer in ("time stop", "state invalidation") else ""
        if tr.exit_reason is ExitReason.STOP_LOSS and o.exit_answer == "trail":
            exit_answer = "trail"
        tags = list(o.setup.tags) + (["early-BE variant"] if self.c["management"]["breakeven_variant"] != "none" else [])
        self.closed.append({
            "id": len(self.closed) + 1, "status": "CLOSED", "side": tr.side.value, "orderType": tr.order_type.value,
            "placedTime": int(tr.placed_time), "entryTime": int(tr.entry_time), "exitTime": int(tr.exit_time),
            "plannedEntry": tr.planned_entry, "entryPrice": tr.entry_price, "initialStop": tr.initial_stop, "stopLoss": tr.stop_loss,
            "takeProfit": tr.take_profit, "exitPrice": tr.exit_price, "exitReason": tr.exit_reason.value, "plannedRisk": tr.planned_risk,
            "lots": o.units / 100, "resultR": tr.result_r, "money": money, "commission": o.units / 100 * o.commission_rt,
            "mfeR": tr.mfe_r, "maeR": tr.mae_r, "tags": tags, "note": o.setup.note, "screenshots": [],
            "answers": {"model": o.setup.model, **({"exit_reason": exit_answer} if exit_answer else {})},
            "netR": net_r, "riskPercent": o.risk_money / max(self.balance - money, 1e-9) * 100,
        })

    # ------------------------------------------------------------------ the walk
    def run(self, start: int, end: int) -> None:
        b = self.base
        first, last = np.searchsorted(b.time, [start, end])
        ma, mb = self.c["model_a"], self.c["model_b"]
        for i in range(int(first), int(last)):
            t = int(b.time[i])
            self.broker.spread = max(self.min_spread, int(b.spread[i]))
            self.broker.process_candle(t, float(b.open[i]), float(b.high[i]), float(b.low[i]))
            self.collect()
            cursor = t + 60
            if not self.open and not self.setups and cursor % 300:
                continue
            info = self.day(cursor)
            if self.open:
                self.manage(cursor, i, info)
                self.collect()
            if cursor % 300 or not info["prior"]:
                continue
            want_a = ma["enabled"] and in_window(cursor, ma["window"])
            want_b = mb["enabled"] and in_window(cursor, mb["window"])
            if not (want_a or want_b or self.setups):
                continue
            st = self.state(cursor, info["prior"])
            self.cancel(cursor, st, want_a, want_b)
            if want_a:
                self.model_a(cursor, info, st)
            if want_b:
                self.model_b(cursor, info, st)
            for setup in list(self.setups.values()):
                if (setup.model == "A" and not want_a) or (setup.model == "B" and not want_b):
                    continue
                if any(o.setup.model == setup.model for o in self.open):
                    continue  # one trade at a time per model
                candle = self.trigger(cursor, setup, i)
                if candle:
                    self.enter(cursor, setup, candle, i, info)
        for o in list(self.open):  # the end of the data: close what is still open
            if o.trade.status is Status.PENDING:
                self.broker.cancel(o.trade)
                self.open.remove(o)
            elif o.trade.status is Status.OPEN:
                i = int(last) - 1
                self.broker.close(o.trade, int(b.time[i]), float(b.close[i]))
        self.collect()

    def cancel(self, cursor: int, st: dict, want_a: bool, want_b: bool) -> None:
        """Setups end: Model A when a close comes back inside value (the kill switch) or the window ends; Model B when
        value is accepted the other way or the window ends."""
        for key, s in list(self.setups.items()):
            if s.model == "A" and (not want_a or st["state"] in ("inside", "rejected_above", "rejected_below")
                                   or (st["state"].startswith("accepted_") and ("long" if st["state"].endswith("above") else "short") != s.side)):
                del self.setups[key]
            elif s.model == "B" and (not want_b or st["state"].startswith("accepted_")):
                del self.setups[key]

    def collect(self) -> None:
        """Move closed trades out of the broker (it re-reads every trade on every candle) and settle them."""
        for o in list(self.open):
            if o.trade.status is Status.CLOSED:
                self.settle(o)
                self.open.remove(o)
        self.broker.trades = [t for t in self.broker.trades if t.status in (Status.PENDING, Status.OPEN)]


def load_news(path: str | Path | None) -> list[tuple[int, str]]:
    """High-impact news times (UTC seconds) and currencies from a CSV: date_utc,time_utc,currency,impact,title."""
    if not path or not Path(path).exists():
        return []
    out = []
    with Path(path).open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if str(row.get("impact", "")).strip().lower() != "high":
                continue
            when = datetime.fromisoformat(f"{row['date_utc'].strip()}T{row['time_utc'].strip()}").replace(tzinfo=timezone.utc)
            out.append((int(when.timestamp()), row["currency"].strip().upper()))
    return sorted(out)
