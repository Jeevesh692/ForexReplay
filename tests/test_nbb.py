"""The NBB logger against docs/plan-nbb-logger.md, on the hand-built day in tests/nbb_day.py."""

import csv
import json
import re
import tempfile
from datetime import date
from pathlib import Path

import numpy as np

from forex_replay import backtests, loglib, nbb, strategy_folders
from tests import nbb_day as D

PRE_AND_SETUP = ["adr5_pips", "daily_structure", "weekly_structure", "bias", "asian_high", "asian_low", "asian_range_pips",
                 "open_0000", "pdh", "pdl", "pwh", "pwl", "nearest_pd_type", "open_dist_pips", "setup_found", "h2_price",
                 "h2_time_ny", "h2_beyond_asian_pips", "pd_hit_type", "pd_hit_beyond_pips", "h1_price", "h1_time_ny",
                 "h1_candles_before_h2", "l1_price", "disp_time_ny", "disp_range_atr", "disp_body_pct",
                 "disp_candles_after_h2", "user_fib_found", "user_fib_1", "user_fib_0"]
POST = ["time_062_ny", "deepest_level_kz", "deepest_level_total", "resolution", "resolution_time_ny", "level_at_1600",
        "be_triggered", "target_momentum", "phase2_r_gross"]


def row_for(m5, trade, **session):
    data = D.session([trade], **session)
    return nbb.trade_row(trade, data, m5)


def expected_atr_ratio(m5):
    """The displacement candle's range over ATR(14) of the 15m candles before it (worked by the shared ATR)."""
    m15 = loglib.minutes_bars(m5.until(D.t(D.DAY, 7, 25)), 15)
    j = m15.index_of_time(D.t(D.DAY, 3, 15))
    atr = loglib.wilder_atr(m15.high, m15.low, m15.close, 14)
    return f"{165 / atr[j - 1]:.2f}"


def test_a_built_sell_setup_measures_every_field():
    m5 = D.candles()
    r = row_for(m5, D.sell_trade())
    expected = {
        # the trade
        "date_ny": "2026-03-11", "weekday": "Wednesday", "killzone": "NY", "side": "SELL", "order_type": "LIMIT",
        "placed_time_ny": "2026-03-11 07:25", "entry_time_ny": "2026-03-11 07:30", "exit_time_ny": "2026-03-11 08:20",
        "entry_price": "1.10086", "stop_loss": "1.10200", "take_profit": "1.09900", "exit_price": "1.09900",
        "exit_reason": "TAKE_PROFIT", "lots": "0.50", "actual_r": "1.63", "pnl_usd": "89.00", "commission_usd": "4.00",
        "risk_pips": "11.4", "spread_pips": "0.5",  # the 0.5-pip minimum beats the candle's 0.2
        "tags": "A+ setup; followed plan", "note": "textbook",
        # before 00:00
        "adr5_pips": "60.0", "daily_structure": "NONE", "weekly_structure": "NONE", "bias": "NONE",
        "asian_high": "1.10010", "asian_low": "1.09990", "asian_range_pips": "2.0", "open_0000": "1.10000",
        "pdh": "1.10150", "pdl": "1.09550", "pwh": "1.10150", "pwl": "1.09550",
        # Each history day's 09:00-13:00 H4 candle tops at 1.10000 while the 01:00-05:00 one bottomed at 1.10018:
        # a bearish H4 gap 1.10000-1.10018, never filled; the 00:00 open sits on its edge.
        "nearest_pd_type": "FVG_H4", "open_dist_pips": "0.0",
        # the setup, from candles up to 07:25
        "setup_found": "TRUE", "h2_price": "1.10200", "h2_time_ny": "2026-03-11 02:45", "h2_beyond_asian_pips": "19.0",
        "pd_hit_type": "PWH", "pd_hit_beyond_pips": "5.0",  # PWH outranks PDH and the gap
        "h1_price": "1.10100", "h1_time_ny": "2026-03-11 01:30", "h1_candles_before_h2": "5", "l1_price": "1.10000",
        "disp_time_ny": "2026-03-11 03:15", "disp_range_atr": expected_atr_ratio(m5), "disp_body_pct": "0.91",
        "disp_candles_after_h2": "2",
        "fib_1": "1.10200", "fib_0": "1.09900", "fib_0_time_ny": "2026-03-11 03:35", "leg_pips": "30.0",
        "opp_pd_between": "FALSE", "opp_pd_type": "", "entry_fib_level": "0.620", "stop_fib_level": "1.000",
        "user_fib_found": "TRUE", "user_fib_1": "1.10200", "user_fib_0": "1.09900",
        # after, up to 16:00
        "post_status": "COMPLETE", "time_062_ny": "2026-03-11 07:30",
        "deepest_level_kz": "0.667", "deepest_level_total": "0.667",  # 07:30's high 110100: 200 / 300
        "resolution": "TARGET", "resolution_time_ny": "2026-03-11 08:15", "level_at_1600": "",
        "be_triggered": "TRUE", "target_momentum": "TRUE",
        # half at 0.0: 0.5 * 186/114 = 0.816; the runner (stop at 0.0) to 110200 - 600: 0.5 * 486/114 = 2.132
        "phase2_r_gross": "2.95",
    }
    assert {k: str(r.get(k, "")) for k in expected} == expected


def mirror_price(text):
    return f"{(220000 - round(float(text) * 1e5)) / 1e5:.5f}"


def test_the_same_day_upside_down_gives_the_buy_mirror():
    m5 = D.candles()
    sell = row_for(m5, D.sell_trade())
    flipped = D.mirrored(m5)
    trade = D.sell_trade(side="BUY", orderPrice=109914, plannedEntry=109914, entryPrice=109914, exitPrice=110100,
                         stopLoss=109800, initialStop=109800, takeProfit=110100)
    drawings = [{"type": "fib", "points": [{"time": D.t(D.DAY, 2, 45), "price": 109800}, {"time": D.t(D.DAY, 3, 30), "price": 110100}]}]
    buy = row_for(flipped, trade, drawings=drawings)
    prices = ["entry_price", "stop_loss", "take_profit", "exit_price", "open_0000", "h2_price", "h1_price", "l1_price",
              "fib_1", "fib_0", "user_fib_1", "user_fib_0"]
    for k in prices:
        assert buy[k] == mirror_price(sell[k]), k
    assert (buy["pdh"], buy["pdl"], buy["pwh"], buy["pwl"]) == tuple(mirror_price(sell[k]) for k in ("pdl", "pdh", "pwl", "pwh"))
    assert (buy["asian_high"], buy["asian_low"]) == (mirror_price(sell["asian_low"]), mirror_price(sell["asian_high"]))
    assert buy["pd_hit_type"] == "PWL" and buy["nearest_pd_type"] == "FVG_H4"
    same = ["killzone", "adr5_pips", "asian_range_pips", "open_dist_pips", "setup_found", "h2_time_ny", "h2_beyond_asian_pips",
            "pd_hit_beyond_pips", "h1_time_ny", "h1_candles_before_h2", "disp_time_ny", "disp_range_atr", "disp_body_pct",
            "disp_candles_after_h2", "fib_0_time_ny", "leg_pips", "opp_pd_between", "entry_fib_level", "stop_fib_level",
            "user_fib_found", "risk_pips"] + POST
    assert {k: buy[k] for k in same} == {k: sell[k] for k in same}


def test_no_look_ahead_past_the_order_or_the_replay():
    spike = list(D.AFTER)
    spike[6] = ((9, 0), 109845, 110300, 109700, 109710)  # after the order, price runs above H2 for a moment
    m5 = D.candles(D.the_day(after=spike))
    full = row_for(m5, D.sell_trade())
    cut = row_for(m5.until(D.t(D.DAY, 7, 25)), D.sell_trade())  # every candle after the order deleted
    assert {k: cut[k] for k in PRE_AND_SETUP} == {k: full[k] for k in PRE_AND_SETUP}
    assert full["h2_price"] == "1.10200"  # the high of the day when the order was placed, not later
    early = row_for(m5, D.sell_trade(), furthest=D.t(D.DAY, 12, 0))  # the replay stopped before 16:00
    assert early["post_status"] == "PENDING"
    assert all(early[k] == "" for k in POST)
    assert {k: early[k] for k in PRE_AND_SETUP} == {k: full[k] for k in PRE_AND_SETUP}


def test_a_weak_displacement_is_logged_and_no_h1_means_no_setup():
    weak = list(D.SHAPE)
    weak[9] = ((3, 15), 110110, 110115, 109990, 109995)  # closes just under L1 with a small range
    m5 = D.candles(D.the_day(shape=weak))
    r = row_for(m5, D.sell_trade())
    assert r["setup_found"] == "TRUE" and r["disp_time_ny"] == "2026-03-11 03:15"
    assert r["disp_body_pct"] == "0.92"  # 115 / 125: still logged; the workbook decides
    no_h1 = [((hh, mm), 110000 + 10 * k, 110000 + 10 * k + 8, 110000 + 10 * k - 2, 110000 + 10 * k + 6)
             for k, ((hh, mm), *_) in enumerate(D.SHAPE[:7])] + list(D.SHAPE[7:])  # a straight climb: no swing high
    r = row_for(D.candles(D.the_day(shape=no_h1)), D.sell_trade())
    assert (r["setup_found"], r["post_status"], r["h1_price"], r["fib_0"]) == ("FALSE", "NO_SETUP", "", "")
    assert r["h2_price"] == "1.10200"  # what was measured is still there


def test_one_candle_through_both_ends_resolves_as_the_stop():
    after = list(D.AFTER)
    after[3] = ((8, 15), 109960, 110250, 109850, 109890)  # 08:15 spans both 0.0 and 1.0
    r = row_for(D.candles(D.the_day(after=after)), D.sell_trade())
    assert (r["resolution"], r["resolution_time_ny"]) == ("STOP", "2026-03-11 08:15")
    assert r["deepest_level_total"] == "1.167"  # the stop candle counts: every entry filled on it


def test_a_lower_low_before_the_touch_moves_the_leg():
    shape = list(D.SHAPE) + [((4, 0), 109985, 109990, 109850, 109860),   # after the fix: a lower low 109850
                             ((4, 15), 109860, 109900, 109855, 109895)]  # closes above 109990? no: still loose
    shape += [((4, 30), 109895, 110000, 109890, 109995)]                 # closes above 04:15's high: fixed again
    after = [((7, 30), 109995, 110100, 109985, 110090)] + list(D.AFTER[1:])
    r = row_for(D.candles(D.the_day(shape=shape, after=after)), D.sell_trade())
    assert (r["fib_0"], r["fib_0_time_ny"], r["leg_pips"]) == ("1.09850", "2026-03-11 04:05", "35.0")
    # 0.62 of the new leg is 109850 + 217 = 110067; 07:30 reaches it
    assert r["time_062_ny"] == "2026-03-11 07:30"


def test_saving_twice_is_identical_and_pending_turns_complete():
    m5 = D.candles()
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        early = D.session([D.sell_trade()], furthest=D.t(D.DAY, 12, 0))
        nbb.write_logs(early, folder, m5)
        first = (folder / nbb.LOG_FILE).read_bytes()
        nbb.write_logs(early, folder, m5)
        assert (folder / nbb.LOG_FILE).read_bytes() == first
        assert "PENDING" in first.decode()
        other = D.session([D.sell_trade(id=7)], run="bt-nbb-0")
        nbb.write_logs(other, folder, m5)  # another session's rows are kept
        nbb.write_logs(D.session([D.sell_trade()]), folder, m5)
        with (folder / nbb.LOG_FILE).open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        assert [(r["run_id"], r["trade_id"], r["post_status"]) for r in rows] == [
            ("bt-nbb-0", "7", "COMPLETE"), ("bt-nbb-1", "1", "COMPLETE")]


def test_the_headers_are_the_spec_and_the_workbooks_contract():
    spec = (Path(__file__).parents[1] / "docs" / "plan-nbb-logger.md").read_text(encoding="utf-8")
    log, days = spec.split("### nbb_log.csv")[1].split("### nbb_days.csv")
    assert nbb.COLUMNS == re.findall(r"^\| `(\w+)` \|", log, re.M)
    assert nbb.DAY_COLUMNS == re.findall(r"^\| `(\w+)` \|", days.split("## Tests")[0], re.M)
    with tempfile.TemporaryDirectory() as tmp:
        nbb.write_logs(D.session([D.sell_trade()]), Path(tmp), D.candles())
        for name, columns in ((nbb.LOG_FILE, nbb.COLUMNS), (nbb.DAYS_FILE, nbb.DAY_COLUMNS)):
            with (Path(tmp) / name).open(encoding="utf-8") as f:
                assert f.readline().strip().split(",") == columns


def test_one_day_row_per_weekday_the_replay_passed():
    m5 = D.candles()
    data = D.session([D.sell_trade()], start=D.t(date(2026, 3, 9), 0), furthest=D.t(D.DAY, 12, 0))  # Mon 00:00 to Wed 12:00
    rows = nbb.day_rows(data, m5)
    assert [(r["date_ny"], r["weekday"], r["trades_taken"]) for r in rows] == [
        ("2026-03-09", "Monday", 0), ("2026-03-10", "Tuesday", 0), ("2026-03-11", "Wednesday", 1)]
    wed = rows[-1]
    assert (wed["adr5_pips"], wed["bias"], wed["asian_range_pips"], wed["nearest_pd_type"], wed["open_dist_pips"]) == (
        "60.0", "NONE", "2.0", "", "")  # no bias: no bias-side array
    later = nbb.day_rows(D.session([], start=D.t(date(2026, 3, 9), 3), furthest=D.t(D.DAY, 12, 0)), m5)
    assert [r["date_ny"] for r in later] == ["2026-03-10", "2026-03-11"]  # Monday's 00:00 came before the start


def test_structure_follows_breaks_of_confirmed_swings():
    high = [10, 12, 15, 12, 11, 13, 14, 16, 13, 12]
    low = [8, 9, 11, 9, 7, 10, 11, 13, 10, 9]
    close = [9, 11, 14, 10, 8, 12, 13, 15.5, 11, 6]
    # swing high 15 (k=2) confirmed at j=4; j=7 closes 15.5 above it: BULL. Swing low 7 (k=4) confirmed at j=6;
    # j=9 closes 6 below it: BEAR.
    assert nbb.structure(high[:8], low[:8], close[:8]) == "BULL"
    assert nbb.structure(high, low, close) == "BEAR"
    assert nbb.structure(high[:5], low[:5], close[:5]) == "NONE"


def test_a_save_writes_the_strategys_log_and_a_logger_error_never_blocks_it(monkeypatch):
    m5 = D.candles()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        strategy_folders.save_strategy("nbb", {"label": "NBB", "logger": "nbb"}, root)
        monkeypatch.setattr(loglib, "load_m5", lambda *a, **k: m5)
        reply = backtests.save("nbb", "bt-nbb-1", D.session([D.sell_trade()]), root)
        assert reply["log"] == {"logger": "nbb", "trades": 1, "days": 3} and "logError" not in reply
        assert (root / "nbb" / nbb.LOG_FILE).exists() and (root / "nbb" / nbb.DAYS_FILE).exists()
        backtests.save("plain", "bt-1", D.session([D.sell_trade()], run="bt-1") | {"journal": "plain"}, root)
        assert not (root / "plain" / nbb.LOG_FILE).exists()  # no strategy.json: no log

        def broken(*a, **k):
            raise RuntimeError("market data missing")
        monkeypatch.setattr(loglib, "load_m5", broken)
        reply = backtests.save("nbb", "bt-nbb-1", D.session([D.sell_trade()]), root)
        assert reply["ok"] and "market data missing" in reply["logError"]
        assert json.loads((root / "nbb" / "backtests" / "bt-nbb-1.json").read_text())["id"] == "bt-nbb-1"


def test_rebuild_writes_every_saved_session_again():
    m5 = D.candles()
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        (folder / "backtests").mkdir()
        for run in ("bt-a", "bt-b"):
            (folder / "backtests" / f"{run}.json").write_text(json.dumps(D.session([D.sell_trade()], run=run)))
        (folder / nbb.LOG_FILE).write_text("stale\n")
        assert nbb.rebuild(folder, m5) == {"sessions": 2, "trades": 2, "days": 6}
        with (folder / nbb.LOG_FILE).open(newline="", encoding="utf-8") as f:
            assert [r["run_id"] for r in csv.DictReader(f)] == ["bt-a", "bt-b"]


def test_the_shared_atr_is_wilders_as_in_the_browser():
    high, low, close = np.array([12, 13, 15, 14]), np.array([10, 11, 12, 11]), np.array([11, 12, 14, 12])
    out = loglib.wilder_atr(high, low, close, 2)
    # true ranges 2, 2, 3, 3; first ATR = mean of the first 2 = 2; then (2*1 + 3)/2 = 2.5; (2.5 + 3)/2 = 2.75
    assert np.isnan(out[0]) and list(out[1:]) == [2.0, 2.5, 2.75]


def test_reusing_finished_rows_gives_the_same_files_as_working_everything_out_again():
    m5 = D.candles()
    with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
        step, fresh = Path(a), Path(b)
        nbb.write_logs(D.session([D.sell_trade()], furthest=D.t(D.DAY, 12, 0)), step, m5)  # saved as it went
        nbb.write_logs(D.session([D.sell_trade()]), step, m5)
        nbb.write_logs(D.session([D.sell_trade(note="changed my mind", tags=["late entry"])]), step, m5)  # a later edit
        nbb.write_logs(D.session([D.sell_trade(note="changed my mind", tags=["late entry"])]), fresh, m5)
        for name in (nbb.LOG_FILE, nbb.DAYS_FILE):
            assert (step / name).read_bytes() == (fresh / name).read_bytes(), name
        assert "changed my mind" in (step / nbb.LOG_FILE).read_text(encoding="utf-8")
