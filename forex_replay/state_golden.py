"""Golden cases for the market state labels: fixed inputs and Python's answers, which web/js/marketstate.js must match.

    python -m forex_replay.state_golden   # rewrites web/tests/fixtures/state_golden.json

Only needed when the definition changes (forex_replay/marketstate.py and web/js/marketstate.js together).
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

from .config import PROJECT_ROOT
from .marketstate import market_state
from .profile import day_levels

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "state_golden.json"
SEED = 20261110
START = 1762207200  # Mon 3 Nov 2025 22:00 UTC: a trading day starts (17:00 New York, winter)
BIN = 20  # 1 EURUSD pip in the order-flow units
VARIANTS = [(1800, 2, 3600), (900, 3, 1800), (3600, 1, 7200)]  # (timeframe, accept, window)


def bars(rng: random.Random) -> dict:
    """Three trading days of 1-minute bars swinging around a centre that moves each day, so price keeps crossing
    the previous day's value area. A few minutes are missing, as in real data."""
    time, high, low, close = [], [], [], []
    price = 220_000
    for day in range(3):
        centre = 220_000 + rng.randint(-300, 300) * (day > 0)
        amplitude, period = rng.randint(150, 400), rng.randint(70, 260) * 60
        phase = rng.random() * 2 * math.pi
        for minute in range(1440):
            if rng.random() < 0.02:
                continue
            t = START + day * 86400 + minute * 60
            target = centre + amplitude * math.sin(2 * math.pi * (t - START) / period + phase)
            o = price
            price = int(o + 0.15 * (target - o) + rng.randint(-25, 25))
            time.append(t)
            high.append(max(o, price) + rng.randint(0, 20))
            low.append(min(o, price) - rng.randint(0, 20))
            close.append(price)
    return {"seconds": 60, "time": time, "high": high, "low": low, "close": close, "tick_count": [rng.randint(1, 200) for _ in time]}


def build() -> dict:
    rng = random.Random(SEED)
    b = bars(rng)
    cursors = [START + 600]  # inside the first day: no value area yet
    cursors += list(range(START + 86400 + 60, START + 3 * 86400, 37 * 60))  # every 37 minutes through days 2 and 3
    cursors += [START + 86400 + k * 1800 for k in (1, 2, 5, 17, 30)]  # exactly on candle closes
    cases = []
    for cursor in cursors:
        prior = day_levels(b, cursor, BIN, 1)["prior"]
        val, vah = (prior["val"], prior["vah"]) if prior else (None, None)
        for timeframe, accept, window in VARIANTS:
            cases.append({"cursor": cursor, "val": val, "vah": vah, "timeframe": timeframe, "accept": accept, "window": window,
                          "expected": market_state(b, cursor, val, vah, timeframe, accept, window)})
    return {"seed": SEED, "bars": b, "cases": cases}


def write_fixture(path: Path = FIXTURE) -> dict:
    data = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return data


if __name__ == "__main__":
    out = write_fixture()
    states = {c["expected"]["state"] for c in out["cases"]}
    kinds = {(e["kind"], e["side"]) for c in out["cases"] for e in c["expected"]["events"]}
    print(f"Wrote {FIXTURE.relative_to(PROJECT_ROOT)}: {len(out['cases'])} cases; states {sorted(states)}; events {sorted(kinds)}")
