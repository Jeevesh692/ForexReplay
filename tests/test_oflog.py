"""The order-flow trade log (order flow, Phase 8): a made-up market where the answers are known."""

import csv
import math

import numpy as np
import pytest

from forex_replay import oflog, strategy_folders
from forex_replay.flow import FIELDS
from forex_replay.loglib import Candles

D0 = 1762207200  # Mon 3 Nov 2025 22:00 UTC: a trading day starts (17:00 New York, winter)
D1 = D0 + 86400  # the next trading day


def market(extra_day2=None):
    """Day 1: price swings 40 points either side of 1.10000. Day 2: it opens and stays at about 1.10200 (above value).
    Returns the base candles (points) and the order-flow minutes (2 x points), the same prices."""
    rows = []
    for k in range(1440):
        rows.append((D0 + 60 * k, 110000 + int(40 * math.sin(k / 30))))
    for k in range(600):
        rows.append((D1 + 60 * k, (extra_day2 or (lambda k: 110200 + (k % 7)))(k)))
    t = np.array([r[0] for r in rows], dtype=np.int64)
    c = np.array([r[1] for r in rows], dtype=np.int64)
    o = np.r_[c[0], c[:-1]]
    hi, lo = np.maximum(o, c) + 3, np.minimum(o, c) - 3
    base = Candles(t, o, hi, lo, c, np.zeros(len(t), dtype=np.int64))
    m1 = {name: np.zeros(len(t), dtype=np.int32) for name in FIELDS}
    m1.update(time=t, open=2 * o, high=2 * hi, low=2 * lo, close=2 * c, tick_count=np.full(len(t), 10),
              up_ticks=np.full(len(t), 6), down_ticks=np.full(len(t), 4), baseline_x2=np.full(len(t), 20))
    m1["seconds"] = 60
    return base, m1


def session(trade_overrides=None, furthest=D1 + 590 * 60, drawings=None):
    placed = D1 + 179 * 60  # the order is placed at the close of the 02:59 UTC minute of day 2
    trade = {
        "id": 1, "status": "CLOSED", "side": "BUY", "orderType": "MARKET", "placedTime": placed, "entryTime": placed + 60,
        "exitTime": placed + 3600, "plannedEntry": 110200, "entryPrice": 110200, "initialStop": 110100, "stopLoss": 110100,
        "takeProfit": 110400, "exitPrice": 110400, "exitReason": "TAKE_PROFIT", "plannedRisk": 100, "lots": 0.5,
        "resultR": 2.0, "money": 100.0, "commission": 2.0, "mfeR": 2.1, "maeR": -0.3, "note": "", "tags": ["news day"],
        "screenshots": ["bt-x-t1-entry.png"], "answers": {"model": "A"},
    }
    trade.update(trade_overrides or {})
    return {"id": "bt-test", "symbol": "EURUSD", "digits": 5, "pipPoints": 10, "barSeconds": 60, "timeframe": "M15",
            "settings": {"commissionPerLot": 4, "minSpreadPips": 0}, "actions": [], "furthestTime": furthest,
            "drawings": drawings or [], "trades": [trade]}


def row_for(**kw):
    base, m1 = market(kw.pop("day2", None))
    data = session(**kw)
    return oflog.trade_row(data["trades"][0], data, oflog.Context(data, base, m1, s15_reader=lambda months: None))


def test_the_trade_and_its_answers():
    r = row_for()
    assert (r["pair"], r["model"], r["tags"], r["screenshots"]) == ("EURUSD", "A", "news day", "screenshots/bt-x-t1-entry.png")
    assert r["session"] == "Asia"  # 03:00 UTC: Tokyo is open (12:00 there), London not yet
    assert (r["stop_pips"], r["mfe_r"], r["mae_r"]) == ("10.0", "2.10", "-0.30")
    assert r["of_exit_reason"] == "target"


def test_the_market_state_and_its_deciding_close():
    r = row_for()
    assert r["state"] == "accepted_above"  # day 2 never comes back inside day 1's value
    # Day 2 starts 22:00 UTC; the second 30-minute close above value is at 23:00 UTC = 04:30 IST.
    assert r["state_close_ist"] == oflog.ist_text(D1 + 3600)
    assert abs(float(r["prior_poc"]) - 1.10000) < 0.0005


def test_costs_and_the_result_after_costs():
    r = row_for()
    # 10-pip stop, spread 0, slippage 0.2 pip, $4 a lot: (2 + 4) / 100 = 0.06R, both in the plan and off the result.
    assert r["cost_r"] == "0.060"
    assert r["result_r_after_costs"] == "1.94"


def test_the_trigger_candle_is_the_one_that_had_closed():
    r = row_for()
    assert r["trigger_candle_ist"] == oflog.ist_text(D1 + 175 * 60)  # placed at 03:00 UTC: the 02:55 candle had closed
    assert r["rvol"] == "1.00"  # 10 ticks a minute against a median of 10
    # The whole candle, its last minute included: open 1.10206, high 1.10209, low 1.10197, close 1.10204 -> 58% up
    # the range. Judged a minute early (without the 02:59 minute) it would close at 1.10203, 50% up.
    assert r["close_location_pct"] == "58"


def test_reached_poc_yes_no_and_pending():
    assert row_for()["reached_poc"] == "pending"  # never back to 1.10000, and the replay stopped before the day's end
    assert row_for(furthest=D1 + 86400)["reached_poc"] == "n"
    back = lambda k: 110200 if k < 300 else 110000  # in the afternoon price comes back to day 1's POC
    assert row_for(day2=back)["reached_poc"] == "y"


def test_exit_reasons_from_the_stop_and_from_your_answer():
    be = row_for(trade_overrides={"exitReason": "STOP_LOSS", "stopLoss": 110200, "exitPrice": 110200, "resultR": 0})
    assert be["of_exit_reason"] == "breakeven"
    trail = row_for(trade_overrides={"exitReason": "STOP_LOSS", "stopLoss": 110300, "exitPrice": 110300, "resultR": 1})
    assert trail["of_exit_reason"] == "trail"
    assert row_for(trade_overrides={"exitReason": "STOP_LOSS", "exitPrice": 110100, "resultR": -1})["of_exit_reason"] == "stop"
    assert row_for(trade_overrides={"exitReason": "MANUAL"})["of_exit_reason"] == "manual"
    told = row_for(trade_overrides={"exitReason": "MANUAL", "answers": {"exit_reason": "time stop"}})
    assert told["of_exit_reason"] == "time stop"


def test_a_profile_drawing_gives_the_lvn_zone_and_its_retracement():
    # Day 2: an hour at 1.10200, an hour at 1.10120, then two hours at 1.10200. A fixed range profile over the first
    # two hours has a gap between the two prices; the trade is placed back at 1.10200, where no zone is.
    two = lambda k: 110120 if 60 <= k < 120 else 110200 + (k % 3)
    base, m1 = market(two)
    vprofile = {"type": "vprofile", "points": [{"time": D1, "price": 110100}, {"time": D1 + 7200 - 900, "price": 110200}],
                "profile": {"source": "M1", "bin": 0.00002, "valueArea": 0.7, "smoothing": 1, "lvn": 0.35}}
    zones = oflog.zones_at(oflog.Context(session(drawings=[vprofile]), base, m1, lambda m: None), D1 + 3 * 3600)
    assert zones, "a zone between the two prices"
    z = zones[0]
    assert 2 * 110120 < z["low"] <= z["high"] < 2 * 110200
    lows, highs = m1["low"][(m1["time"] >= D1) & (m1["time"] < D1 + 7200)], m1["high"][(m1["time"] >= D1) & (m1["time"] < D1 + 7200)]
    assert z["bottom"] <= lows.min() and z["top"] > highs.max()  # the leg: the profile's lowest bin to its highest
    assert z["top"] - z["bottom"] < highs.max() - lows.min() + 2 * 4  # and no more than a bin either side


def test_the_log_and_the_workbook(tmp_path):
    from openpyxl import Workbook, load_workbook

    base, m1 = market()
    data = session()
    mine = Workbook()
    mine.active.title = "My summary"
    mine.active["A1"] = "keep me"
    mine.save(tmp_path / oflog.WORKBOOK)
    out = oflog.write_logs(data, tmp_path, base, m1, s15_reader=lambda months: None)
    assert out["trades"] == 1 and out["workbook"] == oflog.WORKBOOK
    with (tmp_path / oflog.LOG_FILE).open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert [r["run_id"] for r in rows] == ["bt-test"] and list(rows[0]) == oflog.COLUMNS
    wb = load_workbook(tmp_path / oflog.WORKBOOK)
    assert wb["My summary"]["A1"].value == "keep me", "your own sheets stay"
    log = wb[oflog.SHEET]
    assert [c.value for c in log[1]] == oflog.COLUMNS
    values = dict(zip(oflog.COLUMNS, [c.value for c in log[2]]))
    assert values["result_r_after_costs"] == pytest.approx(1.94) and values["state"] == "accepted_above"
    oflog.write_logs(data, tmp_path, base, m1, s15_reader=lambda months: None)  # saved again: still one row
    assert load_workbook(tmp_path / oflog.WORKBOOK)[oflog.SHEET].max_row == 2


def test_a_new_order_flow_strategy_asks_the_model_and_the_exit(tmp_path):
    out = strategy_folders.save_strategy("of_test", {"label": "Order flow", "logger": "orderflow"}, root=tmp_path)
    assert [q["id"] for q in out["checklist"]] == ["model", "exit_reason"]
    kept = strategy_folders.save_strategy("of_test", {"label": "Order flow", "logger": "orderflow",
                                                      "checklist": [{"text": "Mine?", "kind": "yesno"}]}, root=tmp_path)
    assert [q["text"] for q in kept["checklist"]] == ["Mine?"], "your own questions are never replaced"
