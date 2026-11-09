"""The trigger panel's rules (order flow, Phase 6): is the current 5-minute candle a trigger, long or short?

One definition, written twice: here and in web/js/trigger.js, held to web/tests/fixtures/trigger_golden.json
(python -m forex_replay.trigger_golden). Decision 0038.

The candle: the 5-minute candle of the last 1-minute candle the cursor has revealed, built from those minutes
(on the UTC five-minute grid). While it is forming it is judged on its minutes so far; when the cursor is on
its close, it is the candle that has just closed, which is when a trade would be taken.

  * Body:  |close - open| >= 50% of high - low.
  * Range: high - low >= 1.2 x ATR(14) of the 5-minute candles, taken at the candle before this one (so the
    candle is not in its own average). ATR is Wilder's, as the chart's indicator (indicator_golden.atr).
  * Close: in the top 25% of the range (long), the bottom 25% (short).
  * RVOL:  the candle's ticks / its minutes' same-slot medians (orderflow.candle_flow) >= 1.5.
  * Bubble (off by default): the candle trades into an LVN zone of a profile, and inside that zone during the
    candle there is a same-direction bubble of RVOL >= 3 and no opposite absorption: for a long, absorption
    where the up ticks beat the down ticks (buyers absorbed); for a short, the mirror.
The trigger is on when every rule switched on passes. Prices of the candle are in points; zones and bubbles are
in the order-flow units (2 x points).
"""

from __future__ import annotations

from bisect import bisect_left

from .indicator_golden import atr as wilder_atr

DEFAULTS = {"body": 0.5, "range_atr": 1.2, "close_zone": 0.25, "min_rvol": 1.5, "atr_period": 14, "bubble_rvol": 3.0}
RULES = ("body", "range", "close", "rvol", "bubble")


def current_m5(minutes, cursor: int):
    """The 5-minute candle of the last revealed 1-minute candle: {start, open, high, low, close, minutes, closed}.

    minutes: dict of lists (time, open, high, low, close), sorted. None before the first minute has closed."""
    times = minutes["time"]
    last = bisect_left(times, cursor - 60 + 1) - 1  # the last minute with time + 60 <= cursor
    if last < 0:
        return None
    start = times[last] - times[last] % 300
    first = bisect_left(times, start)
    rows = range(first, last + 1)
    return {"start": start, "open": minutes["open"][first], "high": max(minutes["high"][i] for i in rows),
            "low": min(minutes["low"][i] for i in rows), "close": minutes["close"][last], "minutes": last - first + 1,
            "closed": start + 300 <= cursor}


def m5_candles(minutes) -> dict:
    """Every 5-minute candle built from the minutes (the UTC five-minute grid)."""
    out = {"time": [], "open": [], "high": [], "low": [], "close": []}
    for i, t in enumerate(minutes["time"]):
        start = t - t % 300
        if out["time"] and out["time"][-1] == start:
            out["high"][-1] = max(out["high"][-1], minutes["high"][i])
            out["low"][-1] = min(out["low"][-1], minutes["low"][i])
            out["close"][-1] = minutes["close"][i]
        else:
            for k, v in (("time", start), ("open", minutes["open"][i]), ("high", minutes["high"][i]),
                         ("low", minutes["low"][i]), ("close", minutes["close"][i])):
                out[k].append(v)
    return out


def atr_before(m5, start: int, n: int = 14):
    """ATR(n) of the 5-minute candles at the last candle opening before `start`, or None if not yet n candles."""
    k = bisect_left(m5["time"], start) - 1
    if k < n - 1:
        return None
    return wilder_atr(m5["high"][:k + 1], m5["low"][:k + 1], m5["close"][:k + 1], n)[k]


def candle_rules(open_, high, low, close, atr, rvol, side: str, body: float = 0.5, range_atr: float = 1.2,
                 close_zone: float = 0.25, min_rvol: float = 1.5) -> dict:
    """The four candle rules: {name: {pass, value, need}}. side: "long" or "short"."""
    rng = high - low
    long = side == "long"
    return {
        "body": {"pass": rng > 0 and abs(close - open_) >= body * rng, "value": abs(close - open_) / rng if rng > 0 else None, "need": body},
        "range": {"pass": atr is not None and atr > 0 and rng >= range_atr * atr, "value": rng / atr if atr else None, "need": range_atr},
        "close": {"pass": rng > 0 and (close >= high - close_zone * rng if long else close <= low + close_zone * rng),
                  "value": (close - low) / rng if rng > 0 else None, "need": close_zone},
        "rvol": {"pass": rvol is not None and rvol >= min_rvol, "value": rvol, "need": min_rvol},
    }


def bubble_rule(items, zones, candle_low, candle_high, side: str, bubble_rvol: float = 3.0) -> dict:
    """The bubble rule: {pass, zone, same, opposite}. items: bubbles and absorption of the candle (time, price,
    kind, side, rvol, delta); zones: [{low, high}]; the candle's low and high in the same units."""
    want = "up" if side == "long" else "down"
    best = None
    for z in sorted(zones, key=lambda z: (z["low"], z["high"])):
        if z["low"] > candle_high or z["high"] < candle_low:
            continue  # the candle did not trade into this zone
        inside = [it for it in items if z["low"] <= it["price"] <= z["high"]]
        same = sum(1 for it in inside if it["kind"] == "bubble" and it["side"] == want and it["rvol"] >= bubble_rvol)
        opposite = sum(1 for it in inside if it["kind"] == "absorption" and (it["delta"] > 0 if side == "long" else it["delta"] < 0))
        found = {"pass": same > 0 and opposite == 0, "zone": {"low": z["low"], "high": z["high"]}, "same": same, "opposite": opposite}
        if found["pass"]:
            return found
        best = best or found
    return best or {"pass": False, "zone": None, "same": 0, "opposite": 0}


def trigger(rules: dict, enabled: dict) -> bool:
    """On when every rule switched on passes (and at least one is on)."""
    on = [name for name in RULES if enabled.get(name) and name in rules]
    return bool(on) and all(rules[name]["pass"] for name in on)
