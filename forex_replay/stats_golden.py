"""Reference statistics for the browser's analytics page.

The analytics page (web/js/analytics.js) computes win rate, expectancy, profit factor,
drawdown, streaks and the rest in JavaScript, so it can redraw instantly when you filter.
The definitions belong to stats.py, which the `report` command uses. To keep the two from
drifting apart, this module writes random journals as CSV files, reads them back the way the
server does, and records what stats.py says about them. A JavaScript test must get the same
numbers from the same rows.

    python -m forex_replay.stats_golden    # rewrites web/tests/fixtures/stats_golden.json
"""

from __future__ import annotations

import csv
import json
import math
import random
import tempfile
from pathlib import Path

from .config import PROJECT_ROOT
from .journal import COLUMNS, load_journal
from .stats import breakdown, compute_stats, prop_firm_check

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "stats_golden.json"
SEED = 20261004
JOURNALS = 40
GROUPS = ["session", "weekday", "side", "exit_reason"]
RISK_PCT = 1.0


def number(value: float):
    """JSON has no infinity or NaN: write them as strings."""
    if isinstance(value, float) and math.isinf(value):
        return "inf"
    if isinstance(value, float) and math.isnan(value):
        return "nan"
    return value


def random_rows(rng: random.Random) -> list[dict]:
    rows = []
    runs = [f"run-{i}" for i in range(rng.randint(1, 3))]
    for i in range(rng.randint(0, 60)):
        result = rng.choice([round(rng.uniform(-1.3, 3.5), 2), -1.0, 0.0, 0.03, 2.0])
        day = f"2026-0{rng.randint(1, 9)}-{rng.randint(1, 28):02d}"
        legacy = rng.random() < 0.2  # v1 rows: no MFE, sometimes no duration
        rows.append({
            **dict.fromkeys(COLUMNS, ""),
            "trade_id": str(i + 1), "run_id": rng.choice(runs), "symbol": "EURUSD",
            "side": rng.choice(["BUY", "SELL"]), "order_type": "MARKET",
            "entry_time": f"{day} {rng.randint(0, 23):02d}:{rng.choice(['00', '30'])}:00",
            "exit_time": f"{day} {rng.randint(0, 23):02d}:{rng.choice(['05', '45'])}:00",
            "result_r": "" if rng.random() < 0.05 else str(result),  # a few rows without a result
            "mfe_r": "" if legacy else str(round(max(result, 0) + rng.uniform(0, 1.5), 2)),
            "exit_reason": rng.choice(["STOP_LOSS", "TAKE_PROFIT", "MANUAL"]),
            "session": rng.choice(["Asia", "London", "London/NY overlap", "New York"]),
            "weekday": rng.choice(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]),
            "duration_min": "" if legacy and rng.random() < 0.5 else str(rng.randint(5, 600)),
            "note": rng.choice(["", "a, b \"quoted\"", "line one\nline two"]),  # the CSV must survive these
        })
    return rows


def expected(path: Path) -> dict:
    journal = load_journal(path)
    stats = compute_stats(journal)
    if stats is None:
        return {"stats": None, "breakdowns": {}, "prop": None}
    breakdowns = {}
    for by in GROUPS:
        table = breakdown(journal, by)
        breakdowns[by] = {str(group): {k: number(float(v)) for k, v in row.items()} for group, row in table.iterrows()}
    check = prop_firm_check(stats, RISK_PCT)
    return {
        "stats": {k: number(float(v)) for k, v in vars(stats).items()},
        "breakdowns": breakdowns,
        "prop": {"return_pct": check.return_pct, "max_drawdown_pct": check.max_drawdown_pct,
                 "worst_day_pct": number(check.worst_day_pct)},
    }


def build(seed: int = SEED) -> dict:
    rng = random.Random(seed)
    journals = []
    with tempfile.TemporaryDirectory() as tmp:
        for n in range(JOURNALS):
            path = Path(tmp) / f"j{n}.csv"
            with path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=COLUMNS)
                writer.writeheader()
                writer.writerows(random_rows(rng))
            with path.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))  # exactly what the server sends the browser
            journals.append({"rows": rows, **expected(path)})
    return {"seed": seed, "risk_pct": RISK_PCT, "groups": GROUPS, "journals": journals}


def write_fixture(path: Path = FIXTURE) -> dict:
    fixture = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, separators=(",", ":")), encoding="utf-8")
    return fixture


if __name__ == "__main__":
    data = write_fixture()
    trades = sum(len(j["rows"]) for j in data["journals"])
    print(f"Wrote {FIXTURE.relative_to(PROJECT_ROOT)}: {len(data['journals'])} journals, {trades} rows")
