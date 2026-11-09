"""Market state labels (order flow, Phase 4): where price is relative to the previous day's value area.

One definition, written twice: here and in web/js/marketstate.js, held to web/tests/fixtures/state_golden.json
(python -m forex_replay.state_golden). Decision 0036.

On the closes of a bigger candle (30 minutes by default) built from the order-flow 1-minute bars of the
current trading day (from 17:00 New York), counting only candles that had closed by the cursor:

  * ACCEPTED above (below): `accept` consecutive closes above VAH (below VAL), 2 by default. The label sits on
    the close that completes the run.
  * REJECTED above (below): price traded above VAH (below VAL), seen on any closed 1-minute bar's high (low),
    since the last close inside value; then a close back inside value within `window` seconds of that first
    trade outside, with at most one outside close in between ("before a second outside close").
  * Inside is VAL <= close <= VAH.

The state at the cursor comes from the last close: Accepted above while the run of closes above is at least
`accept` long, Above value while it is shorter; after a close inside, Rejected above/below if that rejection
happened since the last outside close, otherwise Inside value. Before the day's first close, from the last
1-minute close. Prices are in the order-flow files' units (2 x points).
"""

from __future__ import annotations

from bisect import bisect_left

from .profile import server_day, server_days

TIMEFRAMES = (900, 1800, 3600)  # 15, 30 or 60 minutes: they divide the hour, and a trading day starts on the hour
DEFAULTS = {"timeframe": 1800, "accept": 2, "window": 3600}


def market_state(bars, cursor: int, val, vah, timeframe: int = 1800, accept: int = 2, window: int = 3600) -> dict:
    """Events of the cursor's trading day so far, and the state at the cursor.

    bars: dict of arrays (time, high, low, close) and `seconds`, sorted by time. val, vah: the previous day's
    value area (None when there is none). Returns {"events": [{time, kind, side, price}], "state", "price"};
    an event's time is the close of the candle that made it."""
    if val is None or vah is None:
        return {"events": [], "state": "no_value", "price": None}
    if timeframe not in TIMEFRAMES:
        raise ValueError(f"timeframe must be one of {TIMEFRAMES}")
    seconds, times = bars["seconds"], bars["time"]
    today = server_day(cursor - 1)
    rows = []
    for i in range(bisect_left(times, cursor - 86400 - seconds), len(times)):
        if times[i] + seconds > cursor:
            break
        rows.append(i)
    rows = [i for i, d in zip(rows, server_days([times[i] for i in rows])) if d == today]

    events = []
    first_out = {"above": None, "below": None}  # first trade outside since the last close inside value
    s = {"outside": 0, "run_side": None, "run": 0, "rejected": None, "last_side": None}

    def finish(bucket: int, close) -> None:
        end = bucket + timeframe
        side = "above" if close > vah else "below" if close < val else "inside"
        if side == "inside":
            for out in ("above", "below"):
                t0 = first_out[out]
                if t0 is not None and s["outside"] <= 1 and end - t0 <= window:
                    events.append({"time": end, "kind": "rejected", "side": out, "price": close})
                    s["rejected"] = out
            first_out["above"] = first_out["below"] = None
            s.update(outside=0, run_side=None, run=0)
        else:
            s["outside"] += 1
            s["rejected"] = None
            s["run"] = s["run"] + 1 if s["run_side"] == side else 1
            s["run_side"] = side
            if s["run"] == accept:
                events.append({"time": end, "kind": "accepted", "side": side, "price": close})
        s["last_side"] = side

    current, last_close = None, None
    for i in rows:
        bucket = times[i] - times[i] % timeframe
        if bucket != current:
            if current is not None:
                finish(current, last_close)
            current = bucket
        if first_out["above"] is None and bars["high"][i] > vah:
            first_out["above"] = times[i]
        if first_out["below"] is None and bars["low"][i] < val:
            first_out["below"] = times[i]
        last_close = bars["close"][i]
    if current is not None and current + timeframe <= cursor:
        finish(current, last_close)

    if not rows:
        state = "no_bars"
    elif s["last_side"] is None:
        state = "above" if last_close > vah else "below" if last_close < val else "inside"
    elif s["last_side"] == "inside":
        state = f"rejected_{s['rejected']}" if s["rejected"] else "inside"
    else:
        state = f"accepted_{s['run_side']}" if s["run"] >= accept else s["run_side"]
    return {"events": events, "state": state, "price": last_close}
