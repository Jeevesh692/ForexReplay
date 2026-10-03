import csv
import json
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from forex_replay import backtests
from forex_replay.journal import COLUMNS
from forex_replay.server import make_server

UTC_2026_03_05_0900 = 1772701200  # Thu 5 Mar 2026 09:00 UTC; server time is UTC+2 in winter


def closed_trade(trade_id=1, **changes):
    trade = {
        "id": trade_id, "status": "CLOSED", "side": "BUY", "orderType": "MARKET",
        "placedTime": UTC_2026_03_05_0900, "entryTime": UTC_2026_03_05_0900 + 300,
        "exitTime": UTC_2026_03_05_0900 + 3600,
        "entryPrice": 108500, "exitPrice": 108700, "stopLoss": 108400, "takeProfit": 108700,
        "plannedRisk": 100, "pnl": 200, "resultR": 2.0, "plannedRewardR": 2.0,
        "mfeR": 2.0, "maeR": 0.3, "exitReason": "TAKE_PROFIT",
    }
    trade.update(changes)
    return trade


def backtest(trades, backtest_id="bt-1", journal="test_journal"):
    return {
        "version": 1, "id": backtest_id, "journal": journal, "name": "test", "symbol": "EURUSD",
        "digits": 5, "pipPoints": 10, "startTime": UTC_2026_03_05_0900, "furthestTime": UTC_2026_03_05_0900 + 7200,
        "settings": {"startingBalance": 10000}, "actions": [], "drawings": [], "trades": trades,
        "saved": "2026-10-03T12:00:00Z",
    }


def read_journal(root):
    with (root / "test_journal" / "trades.csv").open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_saving_writes_the_file_and_journals_closed_trades_once():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        open_trade = closed_trade(2, status="OPEN", exitTime=None, exitPrice=None, pnl=None, resultR=None)
        result = backtests.save("test_journal", "bt-1", backtest([closed_trade(1), open_trade]), root)
        assert result["journalAdded"] == 1
        assert json.loads((root / "test_journal" / "backtests" / "bt-1.json").read_text())["id"] == "bt-1"

        # Saved again after the second trade closed: only the new one is added.
        later = closed_trade(2, exitPrice=108400, pnl=-100, resultR=-1.0, exitReason="STOP_LOSS")
        assert backtests.save("test_journal", "bt-1", backtest([closed_trade(1), later]), root)["journalAdded"] == 1
        assert backtests.save("test_journal", "bt-1", backtest([closed_trade(1), later]), root)["journalAdded"] == 0
        rows = read_journal(root)
        assert [r["trade_id"] for r in rows] == ["1", "2"]
        assert list(rows[0].keys()) == COLUMNS


def test_journal_rows_use_v1_format_and_the_broker_server_clock():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        backtests.save("test_journal", "bt-1", backtest([closed_trade(1)]), root)
        row = read_journal(root)[0]
        assert row["run_id"] == "bt-1"
        assert row["entry_time"] == "2026-03-05 11:05:00"  # 09:05 UTC + 2h server time in March
        assert row["entry_price"] == "1.085" and row["stop_loss"] == "1.084"
        assert row["risk_pips"] == "10.0" and row["pnl_pips"] == "20.0" and row["result_r"] == "2.0"
        assert row["session"] == "London" and row["weekday"] == "Thursday" and row["duration_min"] == "55.0"


def test_unsafe_names_and_damaged_backtests_are_refused():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for journal, backtest_id in [("..", "x"), ("a/b", "x"), ("ok", "../../evil"), ("", "x")]:
            with pytest.raises(backtests.BacktestError):
                backtests.path_for(journal, backtest_id, root)
        with pytest.raises(backtests.BacktestError):
            backtests.save("test_journal", "bt-2", backtest([]), root)  # id inside says bt-1
        damaged = backtest([])
        del damaged["actions"]
        with pytest.raises(backtests.BacktestError):
            backtests.save("test_journal", "bt-1", damaged, root)
        assert not any(root.rglob("*.json"))


def test_list_and_delete_keep_the_journal():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        backtests.save("test_journal", "bt-1", backtest([closed_trade(1)]), root)
        listed = backtests.list_backtests(root)
        assert [b["id"] for b in listed] == ["bt-1"] and "actions" not in listed[0]
        backtests.delete("test_journal", "bt-1", root)
        assert backtests.list_backtests(root) == []
        assert len(read_journal(root)) == 1
        with pytest.raises(FileNotFoundError):
            backtests.load("test_journal", "bt-1", root)


def test_server_saves_only_json_and_serves_the_list():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        server = make_server(port=18785, root=root, journals_root=root / "strategies")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/api/backtests"
        try:
            body = json.dumps(backtest([closed_trade(1)])).encode()

            def put(content_type):
                request = urllib.request.Request(f"{base}/test_journal/bt-1", data=body, method="PUT",
                                                 headers={"Content-Type": content_type})
                return urllib.request.urlopen(request)

            with pytest.raises(urllib.error.HTTPError) as refused:  # what a form on another site could send
                put("text/plain")
            assert refused.value.code == 400
            with put("application/json") as r:
                assert json.loads(r.read())["journalAdded"] == 1
            with urllib.request.urlopen(base) as r:
                assert [b["id"] for b in json.loads(r.read())["backtests"]] == ["bt-1"]
            with urllib.request.urlopen(f"{base}/test_journal/bt-1") as r:
                assert json.loads(r.read())["trades"][0]["id"] == 1
            with pytest.raises(urllib.error.HTTPError) as missing:
                urllib.request.urlopen(f"{base}/test_journal/nope")
            assert missing.value.code == 404
        finally:
            server.shutdown()
            server.server_close()
