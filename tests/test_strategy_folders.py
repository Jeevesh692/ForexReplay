import json
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from forex_replay import backtests
from forex_replay import strategy_folders as strategies
from forex_replay.server import make_server
from tests.test_backtests import backtest, closed_trade


def test_a_label_becomes_a_safe_folder_name():
    assert strategies.slug("Asian sweep (London)") == "asian_sweep_london"
    assert strategies.slug("  NBB / OTE  ") == "nbb_ote"
    assert strategies.slug("Dollar-reversal 2") == "dollar_reversal_2"
    assert strategies.slug("!!!") == ""
    assert len(strategies.slug("x" * 80)) == 48


def test_strategies_list_their_sessions_journal_and_workbooks():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        strategies.save_strategy("liquidity_sweep", {"label": "Liquidity sweep", "logger": "sweep"}, root)
        strategies.save_strategy("nbb", {"label": "NBB", "logger": "nbb"}, root)
        older = backtest([closed_trade(1)], backtest_id="bt-old", journal="liquidity_sweep")
        newer = dict(backtest([], backtest_id="bt-new", journal="liquidity_sweep"), saved="2026-10-13T09:00:00Z")
        backtests.save("liquidity_sweep", "bt-old", older, root)
        backtests.save("liquidity_sweep", "bt-new", newer, root)
        backtests.save("old_journal", "bt-1", backtest([closed_trade(1)], journal="old_journal"), root)
        (root / "liquidity_sweep" / "Sweep_Backtest_Log.xlsx").write_bytes(b"x")
        (root / "liquidity_sweep" / "~$Sweep_Backtest_Log.xlsx").write_bytes(b"x")  # Excel's lock file
        (root / "not a strategy").mkdir()
        (root / "empty").mkdir()

        listed = {s["name"]: s for s in strategies.list_strategies(root)}
        assert set(listed) == {"liquidity_sweep", "nbb", "old_journal"}
        sweep = listed["liquidity_sweep"]
        assert (sweep["label"], sweep["logger"], sweep["sessions"], sweep["trades"]) == ("Liquidity sweep", "sweep", 2, 1)
        assert sweep["latest"]["id"] == "bt-new"  # resume where you left off = the newest save
        assert sweep["workbooks"] == ["Sweep_Backtest_Log.xlsx"]
        assert listed["nbb"]["latest"] is None and listed["nbb"]["sessions"] == 0
        assert (listed["old_journal"]["label"], listed["old_journal"]["logger"]) == ("old_journal", "none")
        assert strategies.list_strategies(root)[0]["name"] == "liquidity_sweep"  # most recently used first


def test_changing_a_strategy_keeps_its_sessions_and_bad_input_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        backtests.save("nbb", "bt-1", backtest([closed_trade(1)], journal="nbb"), root)
        assert strategies.save_strategy("nbb", {"label": " NBB OTE ", "logger": "nbb"}, root)["label"] == "NBB OTE"
        assert strategies.read_config("nbb", root) == {"label": "NBB OTE", "logger": "nbb", "checklist": []}
        assert (root / "nbb" / "backtests" / "bt-1.json").exists()
        assert len(backtests.journal_rows("nbb", root)) == 1
        for name, data in [("../x", {"label": "x"}), ("nbb", {"label": ""}), ("nbb", {"label": "x" * 61}),
                           ("nbb", {"label": "x", "logger": "magic"}), ("nbb", ["x"])]:
            with pytest.raises(backtests.BacktestError):
                strategies.save_strategy(name, data, root)
        (root / "nbb" / "strategy.json").write_text("{ damaged", encoding="utf-8")
        assert strategies.read_config("nbb", root) == {"label": "nbb", "logger": "none", "checklist": []}


def test_server_lists_and_saves_strategies():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        server = make_server(port=18805, root=root, journals_root=root / "strategies")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/api/strategies"
        try:
            def put(name, payload, content_type="application/json"):
                request = urllib.request.Request(f"{base}/{name}", data=json.dumps(payload).encode(), method="PUT",
                                                 headers={"Content-Type": content_type})
                return urllib.request.urlopen(request)

            with pytest.raises(urllib.error.HTTPError) as refused:
                put("asian_sweep", {"label": "Asian sweep"}, "text/plain")
            assert refused.value.code == 400
            with put("asian_sweep", {"label": "Asian sweep"}) as r:
                assert json.loads(r.read())["logger"] == "none"
            with pytest.raises(urllib.error.HTTPError) as bad:
                put("asian_sweep", {"label": "Asian sweep", "logger": "magic"})
            assert bad.value.code == 400
            with urllib.request.urlopen(base) as r:
                assert [s["label"] for s in json.loads(r.read())["strategies"]] == ["Asian sweep"]
        finally:
            server.shutdown()
            server.server_close()
