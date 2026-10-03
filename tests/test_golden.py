"""The JavaScript engine is tested against web/tests/fixtures/broker_golden.json.
These tests make sure that file really is what the Python engine produces."""

import json

from forex_replay.golden import FIXTURE, replay_recorded


def load():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_still_matches_the_python_engine():
    fixture = load()
    for scenario in fixture["scenarios"]:
        assert replay_recorded(scenario) == scenario["trades"], scenario["name"]


def test_fixture_covers_every_kind_of_order_and_exit():
    summary = load()["summary"]
    for key in ("stop_loss", "take_profit", "manual", "cancelled", "rejected_orders",
                "limit_orders", "stop_orders", "market_orders",
                "partial_closes", "moves_accepted", "moves_rejected"):
        assert summary[key] > 100, key
    assert summary["stopped_in_profit"] > 25  # rarer: a stop moved past the entry and then hit
