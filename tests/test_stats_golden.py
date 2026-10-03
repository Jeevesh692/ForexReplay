"""The analytics page is tested against web/tests/fixtures/stats_golden.json.
These tests make sure that file really is what stats.py says about its journals."""

import json

from forex_replay.stats_golden import FIXTURE, build


def test_fixture_still_matches_stats_py():
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == json.loads(json.dumps(build()))


def test_fixture_covers_the_awkward_cases():
    journals = json.loads(FIXTURE.read_text(encoding="utf-8"))["journals"]
    stats = [j["stats"] for j in journals if j["stats"]]
    assert any(j["stats"] is None for j in journals)                      # an empty journal
    assert any(s["profit_factor"] == "inf" for s in stats) or any(s["payoff_ratio"] == "inf" for s in stats)
    assert any(s["avg_mfe_r"] == "nan" for s in stats) or any(r["mfe_r"] == "" for j in journals for r in j["rows"])
    assert any(r["result_r"] == "" for j in journals for r in j["rows"])  # rows without a result are skipped
    assert any("\n" in r["note"] for j in journals for r in j["rows"])     # notes with line breaks survive the CSV
    assert sum(len(j["rows"]) for j in journals) > 800
