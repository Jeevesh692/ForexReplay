"""Synthetic order flow (order flow, Phase 5): RVOL, bubbles, absorption, delta, CVD and divergence.

One definition, written twice: here and in web/js/orderflow.js, held to web/tests/fixtures/orderflow_golden.json
(python -m forex_replay.orderflow_golden). Decision 0037.

Prices and moves are in the order-flow files' units (2 x points); baselines are stored x 2 (-1: not 20 days yet).

  * RVOL of a bar: tick_count / its same-slot 20-day median = 2 x tick_count / baseline_x2. None while the
    baseline is missing or 0. RVOL of a chart candle: its minutes' ticks / the sum of their medians.
  * Bubble (a 15-second bucket): RVOL >= 3 and |close - open| >= the pair's bubble move (EURUSD 1.5 pips,
    gold 0.50); up or down by the move. Size 1 below 5x, 2 below 8x, 3 from 8x.
  * Absorption: RVOL >= 3 and |close - open| <= the absorption move (EURUSD 0.3 pip, gold 0.10).
  * Delta of a minute: up_ticks - down_ticks. Where there are no ticks (before the order-flow data begins),
    the brief's fallback from a 1-minute candle: tick volume x (close - open) / (high - low), 0 for a flat one.
  * CVD: the running sum of the minutes' deltas, back to 0 at each reset time (the trading day, each session
    open, or an anchor); a candle shows it at its last minute.
  * Divergence: a closed candle making a new high of its reset period while the CVD at its close is not above
    the highest CVD of the `lookback` candles before it (bearish), and the mirror for lows (bullish).
Only minutes and buckets that had closed by the cursor count.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right

DEFAULTS = {"min_rvol": 3.0, "medium": 5.0, "large": 8.0}


def rvol(ticks: int, baseline_x2: int):
    """Relative tick volume, or None without a usable baseline."""
    if baseline_x2 is None or baseline_x2 <= 0:
        return None
    return 2 * ticks / baseline_x2


def classify_bucket(open_, close, ticks, baseline_x2, bubble_move, absorption_move,
                    min_rvol: float = 3.0, medium: float = 5.0, large: float = 8.0):
    """A bubble, an absorption, or None, for one 15-second bucket."""
    r = rvol(ticks, baseline_x2)
    if r is None or r < min_rvol:
        return None
    move = close - open_
    size = 3 if r >= large else 2 if r >= medium else 1
    if abs(move) >= bubble_move:
        return {"kind": "bubble", "side": "up" if move > 0 else "down", "size": size, "rvol": r}
    if abs(move) <= absorption_move:
        return {"kind": "absorption", "side": None, "size": size, "rvol": r}
    return None


def bubbles(buckets, start: int, end: int, cursor: int, bubble_move, absorption_move, **settings) -> list[dict]:
    """Every bubble and absorption among the buckets in [start, end) that had closed by the cursor."""
    seconds, times = buckets["seconds"], buckets["time"]
    out = []
    for i in range(bisect_left(times, start), len(times)):
        t = times[i]
        if t >= end or t + seconds > cursor:
            break
        c = classify_bucket(buckets["open"][i], buckets["close"][i], buckets["tick_count"][i], buckets["baseline_x2"][i],
                            bubble_move, absorption_move, **settings)
        if c:
            out.append({"time": t, "price": buckets["close"][i], **c})
    return out


def fallback_delta(volume, open_, high, low, close) -> float:
    """Delta estimated from a candle alone: tick volume x (close - open) / (high - low)."""
    return 0.0 if high == low else volume * (close - open_) / (high - low)


def candle_flow(starts: list[int], seconds: int, cursor: int, bars, resets: list[int], fallback=None, flow_first=None) -> dict:
    """Per chart candle: ticks, baseline_x2 sum, rvol, delta and cvd (None where the candle has no minute).

    starts: the chart candles' open times; a candle runs to the next one's start or `seconds` on, whichever is
    first. bars: the order-flow 1-minute bars (time, tick_count, up_ticks, down_ticks, baseline_x2). fallback:
    1-minute candles (time, open, high, low, close, volume) used before `flow_first` (the first order-flow bar)."""
    n = len(starts)
    ticks, base, delta, cvd = [None] * n, [None] * n, [None] * n, [None] * n
    complete = [True] * n  # every minute has a baseline
    minutes = []  # (time, delta, ticks or None, baseline_x2 or None)
    if fallback is not None and flow_first is not None:
        for i, t in enumerate(fallback["time"]):
            if t >= flow_first or t + 60 > cursor:
                break
            minutes.append((t, fallback_delta(fallback["volume"][i], fallback["open"][i], fallback["high"][i],
                                              fallback["low"][i], fallback["close"][i]), None, None))
    for i, t in enumerate(bars["time"]):
        if t + 60 > cursor:
            break
        minutes.append((t, bars["up_ticks"][i] - bars["down_ticks"][i], bars["tick_count"][i], bars["baseline_x2"][i]))
    running, period = 0, None
    for t, d, k, b in minutes:
        p = bisect_right(resets, t)
        if p != period:
            running, period = 0, p
        running += d
        c = bisect_right(starts, t) - 1
        if c < 0:
            continue
        end = min(starts[c] + seconds, starts[c + 1]) if c + 1 < n else starts[c] + seconds
        if t >= end:
            continue
        delta[c] = (delta[c] or 0) + d
        cvd[c] = running
        if k is not None:
            ticks[c] = (ticks[c] or 0) + k
            if b < 0:
                complete[c] = False
            else:
                base[c] = (base[c] or 0) + b
    rv = [rvol(ticks[c], base[c]) if ticks[c] is not None and complete[c] and base[c] else None for c in range(n)]
    return {"ticks": ticks, "base": base, "rvol": rv, "delta": delta, "cvd": cvd}


def divergences(starts: list[int], highs, lows, cvd, resets: list[int], lookback: int = 20) -> list[dict]:
    """Candles making a new high (low) of their reset period while CVD makes no new high (low) over `lookback`."""
    out = []
    first = 0  # the first candle of the current period
    for i in range(len(starts)):
        if i == 0 or bisect_right(resets, starts[i]) != bisect_right(resets, starts[i - 1]):
            first = i
            continue
        if cvd[i] is None:
            continue
        window = [v for v in cvd[max(first, i - lookback):i] if v is not None]
        if not window:
            continue
        if highs[i] > max(highs[first:i]) and cvd[i] <= max(window):
            out.append({"index": i, "side": "bearish"})
        elif lows[i] < min(lows[first:i]) and cvd[i] >= min(window):
            out.append({"index": i, "side": "bullish"})
    return out


def day_resets(first: int, last: int) -> list[int]:
    """Trading-day starts (17:00 New York) from `first` to `last`, UTC seconds."""
    from .profile import server_days

    hours = list(range(first - first % 3600, last + 3600, 3600))
    days = server_days(hours)
    return [h for k, h in enumerate(hours) if k > 0 and days[k] != days[k - 1]]
