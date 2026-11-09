"""Golden cases for the position tool: fixed inputs and Python's answers, which web/js/costs.js must match.

    python -m forex_replay.costs_golden   # rewrites web/tests/fixtures/costs_golden.json

Only needed when the sums change (forex_replay/costs.py and web/js/costs.js together).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from .config import PROJECT_ROOT
from .costs import position_plan

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "costs_golden.json"
SEED = 20261113
PAIRS = {  # pip points, dollars per point per lot (at a typical price), a typical price in points
    "EURUSD": (10, 1.0, 110_000), "XAUUSD": (10, 1.0, 400_000), "USDJPY": (10, 100_000 / 150_000, 150_000),
}


def build() -> dict:
    rng = random.Random(SEED)
    cases = []
    for k in range(240):
        symbol = rng.choice(list(PAIRS))
        pip, pv, price = PAIRS[symbol]
        side = rng.choice(["long", "short"])
        direction = 1 if side == "long" else -1
        entry = price + rng.randint(-2000, 2000)
        risk = rng.choice([0, rng.randint(1, 20), rng.randint(20, 400), rng.randint(400, 2000)])
        reward = rng.randint(1, 3000)
        stop, target = entry - direction * risk, entry + direction * reward
        if k % 17 == 3:
            target = entry - direction * reward  # target on the wrong side
        inputs = {
            "side": side, "entry": entry, "stop": stop, "target": target,
            "balance": rng.choice([100, 5000, 10000, 100000]), "risk_percent": rng.choice([0.25, 0.5, 1.0]),
            "point_value": pv, "pip_points": pip, "spread_points": rng.randint(0, 30),
            "commission_per_lot": rng.choice([0, 4.0, 7.0]), "per_side": rng.random() < 0.3, "slippage_pips": rng.choice([0, 0.2, 0.5]),
            "min_stop_pips": rng.choice([None, 6, 20]), "max_stop_pips": rng.choice([None, 20, 80]), "min_target_r": rng.choice([None, 1.5, 2.0]),
        }
        args = {k2: v for k2, v in inputs.items() if k2 not in ("side", "entry", "stop", "target")}
        cases.append({"inputs": inputs, "expected": position_plan(side, entry, stop, target, **args)})
    return {"seed": SEED, "cases": cases}


def write_fixture(path: Path = FIXTURE) -> dict:
    data = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return data


if __name__ == "__main__":
    out = write_fixture()
    warn = {}
    for c in out["cases"]:
        for w in c["expected"].get("warnings", ["error"]):
            warn[w] = warn.get(w, 0) + 1
    print(f"Wrote {FIXTURE.relative_to(PROJECT_ROOT)}: {len(out['cases'])} cases; {warn}")
