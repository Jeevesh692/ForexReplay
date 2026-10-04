"""Reference values for the chart indicators (web/js/indicators.js).

The indicators are written out here a second time in plain Python, step by step as their
definitions read, and run on a random walk of M5 candles that crosses several broker-server
days. A JavaScript test must get the same numbers. Two independent writings of the same
definition rarely make the same mistake.

    python -m forex_replay.indicator_golden   # rewrites web/tests/fixtures/indicators_golden.json
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

import pandas as pd

from .config import PROJECT_ROOT
from .datapipe import utc_to_server

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "indicators_golden.json"
SEED = 20261004
CANDLES = 900
PERIODS = {"sma": [5, 20], "ema": [9, 50], "rsi": [7, 14]}


def sma(values, n):
    return [sum(values[i - n + 1:i + 1]) / n if i >= n - 1 else None for i in range(len(values))]


def ema(values, n):
    out = [None] * len(values)
    if len(values) < n:
        return out
    k = 2 / (n + 1)
    out[n - 1] = sum(values[:n]) / n
    for i in range(n, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out


def rsi(values, n):
    out = [None] * len(values)
    if len(values) <= n:
        return out
    changes = [values[i] - values[i - 1] for i in range(1, len(values))]
    gain = sum(max(c, 0) for c in changes[:n]) / n
    loss = sum(max(-c, 0) for c in changes[:n]) / n

    def value():
        return 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)

    out[n] = value()
    for i in range(n + 1, len(values)):
        c = changes[i - 1]
        gain = (gain * (n - 1) + max(c, 0)) / n
        loss = (loss * (n - 1) + max(-c, 0)) / n
        out[i] = value()
    return out


def atr(highs, lows, closes, n):
    """Wilder's average true range, started from the simple average of the first n true ranges."""
    tr = [highs[0] - lows[0]] + [max(h - l, abs(h - pc), abs(l - pc))
                                 for h, l, pc in zip(highs[1:], lows[1:], closes[:-1])]
    out = [None] * len(tr)
    if len(tr) < n:
        return out
    out[n - 1] = sum(tr[:n]) / n
    for i in range(n, len(tr)):
        out[i] = (out[i - 1] * (n - 1) + tr[i]) / n
    return out


def adr(times, highs, lows, n):
    """Average daily range of the last n completed server days, and the day's low + ADR and high - ADR so far."""
    days = utc_to_server(pd.to_datetime(times, unit="s", utc=True)).date
    ranges, out_adr, out_high, out_low = [], [], [], []
    day, hi, lo = None, None, None
    for d, h, l in zip(days, highs, lows):
        if d != day:
            if day is not None:
                ranges.append(hi - lo)
            day, hi, lo = d, h, l
        hi, lo = max(hi, h), min(lo, l)
        if len(ranges) >= n:
            a = sum(ranges[-n:]) / n
            out_adr.append(a); out_high.append(lo + a); out_low.append(hi - a)
        else:
            out_adr.append(None); out_high.append(None); out_low.append(None)
    return out_adr, out_high, out_low


def vwap(times, highs, lows, closes, volumes):
    # A new day starts at the broker server's midnight (New York 17:00), the date of server time.
    days = utc_to_server(pd.to_datetime(times, unit="s", utc=True)).date
    out, day, pv, vol = [], None, 0.0, 0.0
    for d, h, l, c, v in zip(days, highs, lows, closes, volumes):
        if d != day:
            day, pv, vol = d, 0.0, 0.0
        typical = (h + l + c) / 3
        pv += typical * v
        vol += v
        out.append(pv / vol if vol > 0 else typical)
    return out


def candles(rng: random.Random, count: int = CANDLES, step: int = 300) -> dict:
    t0 = 1772668800 - 3 * 3600  # Wed 4 Mar 2026 21:00 UTC: a few hours before a server midnight
    rows = {"time": [], "open": [], "high": [], "low": [], "close": [], "volume": []}
    price = 110_000
    for i in range(count):
        o = price + rng.randint(-5, 5)
        c = o + rng.randint(-40, 40)
        rows["time"].append(t0 + i * step)
        rows["open"].append(o)
        rows["high"].append(max(o, c) + rng.randint(0, 20))
        rows["low"].append(min(o, c) - rng.randint(0, 20))
        rows["close"].append(c)
        rows["volume"].append(0 if rng.random() < 0.03 else rng.randint(1, 900))  # a few candles with no volume
        price = c
    return rows


def build(seed: int = SEED) -> dict:
    rows = candles(random.Random(seed))
    closes = rows["close"]
    expected = {f"{name}{n}": fn(closes, n) for name, fn in (("sma", sma), ("ema", ema), ("rsi", rsi)) for n in PERIODS[name]}
    expected["vwap"] = vwap(rows["time"], rows["high"], rows["low"], closes, rows["volume"])
    flat = closes[:30] + [closes[29]] * 20  # no losses at all for a while: RSI must be 100, not a division by zero
    expected["rsi14_rising"] = rsi(sorted(flat), 14)
    # ATR and ADR on hourly candles over about two months, so ADR has many completed days to average.
    hourly = candles(random.Random(seed + 1), count=1500, step=3600)
    for n in (7, 14):
        expected[f"atr{n}"] = atr(rows["high"], rows["low"], closes, n)
        expected[f"atr{n}_hourly"] = atr(hourly["high"], hourly["low"], hourly["close"], n)
    for n in (5, 14):
        a, hi, lo = adr(hourly["time"], hourly["high"], hourly["low"], n)
        expected[f"adr{n}"], expected[f"adr{n}_high"], expected[f"adr{n}_low"] = a, hi, lo
    return {"seed": seed, "candles": rows, "hourly": hourly, "rising": sorted(flat), "expected": expected}


def write_fixture(path: Path = FIXTURE) -> dict:
    fixture = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, separators=(",", ":")), encoding="utf-8")
    return fixture


if __name__ == "__main__":
    data = write_fixture()
    print(f"Wrote {FIXTURE.relative_to(PROJECT_ROOT)}: {CANDLES} candles, {len(data['expected'])} series")
