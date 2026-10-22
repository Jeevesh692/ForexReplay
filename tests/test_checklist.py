"""Checklists: your own questions per strategy, answered per trade, written to checklist_log.csv."""

import csv
import tempfile
from pathlib import Path

import pytest

from forex_replay import backtests, checklist, loglib, strategy_folders
from tests import sweep_day as D


def test_questions_are_cleaned_with_ids_made_as_in_the_browser():
    questions = strategy_folders.clean_checklist([
        {"text": " Asian high swept? ", "kind": "yesno"},
        {"text": "Entry model", "kind": "choice", "options": ["FVG", " OB ", "Breaker", ""]},
        {"text": "Confluences", "kind": "number", "options": ["ignored"]},
        {"text": "Asian high swept?!", "kind": "yesno"},
    ])
    assert questions == [  # the same cases as web/tests/strategies.test.mjs
        {"id": "asian_high_swept", "text": "Asian high swept?", "kind": "yesno"},
        {"id": "entry_model", "text": "Entry model", "kind": "choice", "options": ["FVG", "OB", "Breaker"]},
        {"id": "confluences", "text": "Confluences", "kind": "number"},
        {"id": "asian_high_swept_2", "text": "Asian high swept?!", "kind": "yesno"},
    ]
    assert strategy_folders.question_id("!!!", []) == "q"
    for bad in ([{"text": "", "kind": "yesno"}], [{"text": "x", "kind": "colour"}], [{"text": "x", "kind": "choice", "options": ["one"]}],
                [{"text": "x", "kind": "yesno"}, {"text": "x", "kind": "number"}], "not a list",
                [{"text": f"q{i}", "kind": "yesno"} for i in range(31)]):
        with pytest.raises(backtests.BacktestError):
            strategy_folders.clean_checklist(bad)


def test_answers_are_written_as_the_browser_keeps_them():
    q = {"number": {"kind": "number"}, "yes": {"kind": "yesno"}, "choice": {"kind": "choice", "options": ["FVG", "OB"]}}
    assert [checklist.answer_text(q["number"], v) for v in ("12.50", "1234567", "-0.5", "abc", "1e3", "nan")] == \
        ["12.5", "1234567", "-0.5", "", "1000", ""]
    assert [checklist.answer_text(q["yes"], v) for v in ("Yes", "No", "yes")] == ["Yes", "No", ""]
    assert [checklist.answer_text(q["choice"], v) for v in ("OB", "BB", None)] == ["OB", "", ""]


def test_a_save_writes_one_column_per_question_and_keeps_old_columns(monkeypatch):
    m5 = D.candles()
    monkeypatch.setattr(loglib, "load_base", lambda *a, **k: m5)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        questions = [{"text": "Asian high swept?", "kind": "yesno"}, {"text": "Model", "kind": "choice", "options": ["FVG", "OB"]}]
        strategy_folders.save_strategy("asian_sweep", {"label": "Asian sweep", "checklist": questions}, root)
        assert strategy_folders.read_config("asian_sweep", root)["checklist"][0]["id"] == "asian_high_swept"
        strategy_folders.save_strategy("asian_sweep", {"label": "Asian sweep (London)"}, root)  # no checklist sent: kept
        assert len(strategy_folders.read_config("asian_sweep", root)["checklist"]) == 2
        trade = D.sell_trade(answers={"asian_high_swept": "Yes", "model": "OB"})
        reply = backtests.save("asian_sweep", "bt-sweep-1", D.session([trade]) | {"journal": "asian_sweep"}, root)
        assert reply["checklist"] == {"trades": 1, "questions": 2} and "log" not in reply
        path = root / "asian_sweep" / checklist.LOG_FILE
        with path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        assert (rows[0]["date_ny"], rows[0]["side"], rows[0]["actual_r"], rows[0]["Asian high swept?"], rows[0]["Model"]) == (
            "2026-03-11", "SELL", "3.23", "Yes", "OB")
        # Rename a question: a new column; the old one keeps the earlier session's answer.
        strategy_folders.save_strategy("asian_sweep", {"label": "Asian sweep", "checklist": [
            {"id": "asian_high_swept", "text": "Asia high taken?", "kind": "yesno"}]}, root)
        later = D.session([D.sell_trade(answers={"asian_high_swept": "No"})], run="bt-2") | {"journal": "asian_sweep"}
        backtests.save("asian_sweep", "bt-2", later, root)
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            header, rows = reader.fieldnames, list(reader)
        assert header[-3:] == ["Asia high taken?", "Asian high swept?", "Model"]
        assert [(r["run_id"], r["Asia high taken?"], r["Asian high swept?"]) for r in rows] == [
            ("bt-2", "No", ""), ("bt-sweep-1", "", "Yes")]


def test_a_file_held_open_by_another_program_is_retried_then_explained(monkeypatch):
    """Windows will not replace a file OneDrive is uploading or Excel has open; seen in the app on 13 Oct."""
    import os
    real = os.replace
    calls = {"n": 0}

    def busy_twice(src, dst):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise PermissionError(5, "Access is denied")
        real(src, dst)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_file, target = Path(tmp) / "x.csv.tmp", Path(tmp) / "x.csv"
        tmp_file.write_text("new")
        monkeypatch.setattr(os, "replace", busy_twice)
        loglib.replace_file(tmp_file, target, wait=0)
        assert target.read_text() == "new" and calls["n"] == 3
        tmp_file.write_text("newer")
        monkeypatch.setattr(os, "replace", lambda s, d: (_ for _ in ()).throw(PermissionError(5, "Access is denied")))
        with pytest.raises(PermissionError, match="open in another program"):
            loglib.replace_file(tmp_file, target, tries=3, wait=0)
        assert not tmp_file.exists() and target.read_text() == "new"


def test_no_checklist_no_file():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        strategy_folders.save_strategy("plain", {"label": "Plain"}, root)
        reply = backtests.save("plain", "bt-sweep-1", D.session([D.sell_trade()]) | {"journal": "plain"}, root)
        assert "checklist" not in reply and not (root / "plain" / checklist.LOG_FILE).exists()
