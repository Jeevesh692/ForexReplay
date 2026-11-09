"""Golden cases for the volume profile: fixed inputs and Python's answers, which web/js/profile.js must match.

    python -m forex_replay.profile_golden   # rewrites web/tests/fixtures/profile_golden.json

Only needed when the profile's definition changes (forex_replay/profile.py and web/js/profile.js together).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from .config import PROJECT_ROOT
from .profile import build_profile, day_levels

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "profile_golden.json"
SEED = 20261109


def random_case(rng: random.Random) -> dict:
    """A run of bars like a short session: a wandering mid, ranges of a few bins, tick counts 0 to 300."""
    bin_size = rng.choice([1, 2, 5, 20, 100])
    price = rng.randint(200_000, 240_000)
    lows, highs, volumes = [], [], []
    for _ in range(rng.randint(1, 120)):
        price += rng.randint(-4, 4) * bin_size // 2
        span = rng.randint(0, 6) * bin_size // 2
        low = price - rng.randint(0, span)
        lows.append(low)
        highs.append(low + span)
        volumes.append(0 if rng.random() < 0.05 else rng.randint(1, 300))
    settings = {"value_area": rng.choice([0.68, 0.70, 0.80]), "smoothing": rng.choice([1, 3, 5]), "lvn": rng.choice([0.25, 0.35, 0.5])}
    return {"lows": lows, "highs": highs, "volumes": volumes, "bin_size": bin_size, "settings": settings}


def build(seed: int = SEED) -> dict:
    rng = random.Random(seed)
    cases = [random_case(rng) for _ in range(40)]
    # A few small ones with edges in them: one bar, a single bin, flat volume, two equal peaks.
    cases += [
        {"lows": [10], "highs": [12], "volumes": [30], "bin_size": 1, "settings": {"value_area": 0.7, "smoothing": 3, "lvn": 0.35}},
        {"lows": [7], "highs": [7], "volumes": [5], "bin_size": 1, "settings": {"value_area": 0.7, "smoothing": 3, "lvn": 0.35}},
        {"lows": [0, 1, 2, 3, 4], "highs": [0, 1, 2, 3, 4], "volumes": [10, 30, 5, 30, 10], "bin_size": 1,
         "settings": {"value_area": 0.7, "smoothing": 1, "lvn": 0.35}},
        {"lows": [0, 0], "highs": [0, 0], "volumes": [0, 0], "bin_size": 1, "settings": {"value_area": 0.7, "smoothing": 3, "lvn": 0.35}},
        # The value area's two neighbours tie (20 and 20): the upper one is added first.
        {"lows": [0, 1, 2], "highs": [0, 1, 2], "volumes": [20, 60, 20], "bin_size": 1, "settings": {"value_area": 0.7, "smoothing": 1, "lvn": 0.35}},
    ]
    for case in cases:
        case["expected"] = build_profile(case["lows"], case["highs"], case["volumes"], case["bin_size"], **case["settings"])
    return {"seed": seed, "cases": cases, "levels": levels_cases(rng)}


def levels_cases(rng: random.Random) -> list[dict]:
    """5-minute bars over 9 calendar days from Mon 3 Nov 2025 (a weekend inside), and the levels at several cursors."""
    start = 1762207200  # Mon 3 Nov 2025 22:00 UTC: a trading day starts (17:00 New York, winter)
    time, low, high, ticks = [], [], [], []
    price = 230_000
    for k in range(9 * 288):
        t = start + 300 * k
        weekday = (k // 288) % 7  # 0 = the Tuesday trading day ... the weekend is days 4-5 (Sat, Sun) after Friday's
        if weekday in (4, 5):
            continue
        price += rng.randint(-30, 30)
        span = rng.randint(0, 60)
        time.append(t)
        low.append(price - span // 2)
        high.append(price - span // 2 + span)
        ticks.append(rng.randint(0, 400))
    bars = {"seconds": 300, "time": time, "low": low, "high": high, "tick_count": ticks}
    settings = {"value_area": 0.70, "smoothing": 3, "lvn": 0.35}
    out = []
    for cursor in (start + 300, start + 86400 + 3600, start + 3 * 86400 + 600, start + 6 * 86400 + 7200, start + 9 * 86400):
        for days_back in (1, 5):
            out.append({"bars": bars if not out else None, "cursor": cursor, "bin_size": 20, "days_back": days_back,
                        "settings": settings, "expected": day_levels(bars, cursor, 20, days_back, **settings)})
    return out


def write_fixture(path: Path = FIXTURE) -> dict:
    data = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return data


if __name__ == "__main__":
    out = write_fixture()
    print(f"Wrote {FIXTURE.relative_to(PROJECT_ROOT)}: {len(out['cases'])} profiles")
