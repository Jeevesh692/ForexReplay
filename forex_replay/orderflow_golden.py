"""Golden cases for the synthetic order flow: fixed inputs and Python's answers, which web/js/orderflow.js must match.

    python -m forex_replay.orderflow_golden   # rewrites web/tests/fixtures/orderflow_golden.json

Only needed when the definitions change (forex_replay/orderflow.py and web/js/orderflow.js together).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from .config import PROJECT_ROOT
from .orderflow import bubbles, candle_flow, day_resets, divergences

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "orderflow_golden.json"
SEED = 20261111
START = 1762207200  # Mon 3 Nov 2025 22:00 UTC: a trading day starts (17:00 New York, winter)
FLOW_FIRST = START + 6 * 3600  # the first six hours have only candles: the fallback's part
END = START + 2 * 86400


def walk(rng: random.Random, start: int, end: int, step: int, missing: float):
    """A price wandering in steps, with a burst now and then, and a few steps missing."""
    rows, price = [], 220_000
    for t in range(start, end, step):
        burst = rng.random() < 0.04
        move = rng.randint(-12, 12) * (6 if burst else 1)
        o, price = price, price + move
        if rng.random() < missing:
            continue
        ticks = rng.randint(0, 40) * (8 if burst else 1)
        up = rng.randint(0, ticks)
        rows.append((t, o, max(o, price) + rng.randint(0, 8), min(o, price) - rng.randint(0, 8), price, ticks, up, ticks - up))
    return rows


def build() -> dict:
    rng = random.Random(SEED)
    minutes = walk(rng, FLOW_FIRST, END, 60, 0.03)
    bars = {"seconds": 60, "time": [r[0] for r in minutes], "tick_count": [r[5] for r in minutes],
            "up_ticks": [r[6] for r in minutes], "down_ticks": [r[7] for r in minutes],
            "baseline_x2": [-1 if r[0] < FLOW_FIRST + 3600 else rng.randint(0, 120) for r in minutes]}
    early = walk(rng, START, FLOW_FIRST + 3600, 60, 0.05)  # candles overlap the order-flow start by an hour
    fallback = {"time": [r[0] for r in early], "open": [r[1] for r in early], "high": [r[2] for r in early],
                "low": [r[3] for r in early], "close": [r[4] for r in early], "volume": [r[5] for r in early]}
    s15 = walk(rng, FLOW_FIRST, FLOW_FIRST + 8 * 3600, 15, 0.02)
    buckets = {"seconds": 15, "time": [r[0] for r in s15], "open": [r[1] for r in s15], "close": [r[4] for r in s15],
               "tick_count": [r[5] for r in s15], "baseline_x2": [rng.choice([-1, 0] + [rng.randint(4, 60)] * 8) for _ in s15]}
    # Price for the chart candles, from the fallback before the flow begins and from the minutes after.
    prices = [(t, h, low) for t, _, h, low, *_ in early if t < FLOW_FIRST] + [(r[0], r[2], r[3]) for r in minutes]

    days = day_resets(START, END)
    sessions = [START + h * 3600 for h in (2, 9, 13, 26, 33, 37)]
    resets = {"day": days, "session": sorted(days + sessions), "anchor": [START + 7 * 3600 + 900]}
    flow_cases, div_cases = [], []
    for seconds in (300, 900, 3600, 14400):
        starts = list(range(START, END, seconds))
        starts = [s for k, s in enumerate(starts) if k % 17 != 5]  # a few candles missing, as over a holiday
        for cursor in (FLOW_FIRST - 1800, FLOW_FIRST + 7 * 3600 + 420, END - 3600 + 37, END):
            for mode, rs in resets.items():
                out = candle_flow(starts, seconds, cursor, bars, rs, fallback, FLOW_FIRST)
                flow_cases.append({"seconds": seconds, "cursor": cursor, "reset": mode, "expected": out})
                closed = [k for k, s in enumerate(starts) if min(s + seconds, starts[k + 1] if k + 1 < len(starts) else s + seconds) <= cursor]
                n = len(closed)
                highs, lows = [], []
                for k in range(n):
                    end = min(starts[k] + seconds, starts[k + 1]) if k + 1 < len(starts) else starts[k] + seconds
                    inside = [(h, low) for t, h, low in prices if starts[k] <= t < end]
                    highs.append(max((h for h, _ in inside), default=0))
                    lows.append(min((low for _, low in inside), default=0))
                for lookback in (5, 20):
                    div_cases.append({"seconds": seconds, "cursor": cursor, "reset": mode, "lookback": lookback,
                                      "highs": highs, "lows": lows,
                                      "expected": divergences(starts[:n], highs, lows, out["cvd"][:n], rs, lookback)})
    bubble_cases = []
    for settings in ({}, {"min_rvol": 2.0, "medium": 4.0, "large": 6.0}):
        for cursor in (FLOW_FIRST + 3 * 3600 + 7, FLOW_FIRST + 8 * 3600):
            bubble_cases.append({"start": FLOW_FIRST + 600, "end": FLOW_FIRST + 7 * 3600, "cursor": cursor, "bubble_move": 30,
                                 "absorption_move": 6, "settings": settings,
                                 "expected": bubbles(buckets, FLOW_FIRST + 600, FLOW_FIRST + 7 * 3600, cursor, 30, 6, **settings)})
    return {"seed": SEED, "start": START, "end": END, "flow_first": FLOW_FIRST, "bars": bars, "fallback": fallback,
            "buckets": buckets, "resets": resets, "flow": flow_cases, "divergences": div_cases, "bubbles": bubble_cases}


def write_fixture(path: Path = FIXTURE) -> dict:
    data = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return data


if __name__ == "__main__":
    out = write_fixture()
    divs = sum(len(c["expected"]) for c in out["divergences"])
    kinds = {(b["kind"], b["side"], b["size"]) for c in out["bubbles"] for b in c["expected"]}
    print(f"Wrote {FIXTURE.relative_to(PROJECT_ROOT)}: {len(out['flow'])} flow cases, {len(out['divergences'])} divergence cases "
          f"({divs} divergences), {len(out['bubbles'])} bubble cases; kinds {sorted(kinds, key=str)}")
