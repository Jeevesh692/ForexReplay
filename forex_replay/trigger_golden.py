"""Golden cases for the trigger panel: fixed inputs and Python's answers, which web/js/trigger.js must match.

    python -m forex_replay.trigger_golden   # rewrites web/tests/fixtures/trigger_golden.json

Only needed when the rules change (forex_replay/trigger.py and web/js/trigger.js together).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from .config import PROJECT_ROOT
from .trigger import atr_before, bubble_rule, candle_rules, current_m5, m5_candles, trigger

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "trigger_golden.json"
SEED = 20261112
START = 1762207200  # Mon 3 Nov 2025 22:00 UTC


def minutes(rng: random.Random) -> dict:
    """A day and a half of 1-minute candles in points, quiet and busy in turns, a few minutes missing."""
    out = {"time": [], "open": [], "high": [], "low": [], "close": []}
    price = 110_000
    for k in range(36 * 60):
        if rng.random() < 0.03:
            continue
        busy = (k // 90) % 3 == 0
        o = price
        price += rng.randint(-40, 40) * (3 if busy else 1)
        for name, v in (("time", START + 60 * k), ("open", o), ("high", max(o, price) + rng.randint(0, 15)),
                        ("low", min(o, price) - rng.randint(0, 15)), ("close", price)):
            out[name].append(v)
    return out


def build() -> dict:
    rng = random.Random(SEED)
    m1 = minutes(rng)
    m5 = m5_candles(m1)
    settings = [{}, {"body": 0.6, "range_atr": 1.0, "close_zone": 0.3, "min_rvol": 2.0}]
    candle_cases = []
    cursors = [START + 30, START + 60, START + 299, START + 300, START + 14 * 300, START + 15 * 300 + 120]
    cursors += [START + rng.randint(20 * 300, 36 * 3600) for _ in range(60)] + [START + 300 * rng.randint(20, 400) for _ in range(30)]
    for cursor in cursors:
        candle = current_m5(m1, cursor)
        atr = atr_before(m5, candle["start"]) if candle else None
        rvol = rng.choice([None, round(rng.uniform(0.2, 4.0), 3)])
        for side in ("long", "short"):
            for s in settings:
                rules = candle_rules(candle["open"], candle["high"], candle["low"], candle["close"], atr, rvol, side, **s) if candle else None
                candle_cases.append({"cursor": cursor, "rvol": rvol, "side": side, "settings": s,
                                     "expected": {"candle": candle, "atr": atr, "rules": rules}})
    bubble_cases = []
    for _ in range(120):
        low = rng.randint(0, 400)
        high = low + rng.randint(0, 120)
        zones = [{"low": z, "high": z + rng.randint(0, 40)} for z in (rng.randint(low - 60, high + 20) for _ in range(rng.randint(0, 3)))]
        items = [{"time": START + 15 * k, "price": rng.randint(-20, 520), "kind": rng.choice(["bubble", "bubble", "absorption"]),
                  "side": None, "rvol": round(rng.uniform(3, 9), 2), "size": 1, "delta": rng.randint(-20, 20)} for k in range(rng.randint(0, 8))]
        for it in items:
            if zones and rng.random() < 0.7:  # most of them inside a zone, so every outcome occurs
                z = rng.choice(zones)
                it["price"] = rng.randint(z["low"], z["high"])
            if it["kind"] == "bubble":
                it["side"] = rng.choice(["up", "down"])
        side = rng.choice(["long", "short"])
        bubble_rvol = rng.choice([3.0, 5.0])
        bubble_cases.append({"items": items, "zones": zones, "low": low, "high": high, "side": side, "bubble_rvol": bubble_rvol,
                             "expected": bubble_rule(items, zones, low, high, side, bubble_rvol)})
    enabled_cases = []
    for _ in range(40):
        rules = {name: {"pass": rng.random() < 0.6} for name in ("body", "range", "close", "rvol", "bubble")}
        enabled = {name: rng.random() < 0.6 for name in rules}
        enabled_cases.append({"rules": rules, "enabled": enabled, "expected": trigger(rules, enabled)})
    return {"seed": SEED, "minutes": m1, "candles": candle_cases, "bubbles": bubble_cases, "overall": enabled_cases}


def write_fixture(path: Path = FIXTURE) -> dict:
    data = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return data


if __name__ == "__main__":
    out = write_fixture()
    passes = {name: sum(1 for c in out["candles"] if c["expected"]["rules"] and c["expected"]["rules"][name]["pass"])
              for name in ("body", "range", "close", "rvol")}
    bubble = sum(1 for c in out["bubbles"] if c["expected"]["pass"])
    print(f"Wrote {FIXTURE.relative_to(PROJECT_ROOT)}: {len(out['candles'])} candle cases (passes {passes}), "
          f"{len(out['bubbles'])} bubble cases ({bubble} pass), {len(out['overall'])} overall cases")
