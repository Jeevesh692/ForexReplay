"""The sweep logger against docs/plan-sweep-logger.md, on the hand-built day in tests/sweep_day.py."""

import csv
import json
import re
import tempfile
from datetime import date
from pathlib import Path

from forex_replay import backtests, loglib, nbb, strategy_folders, sweep
from tests import sweep_day as D
from tests.nbb_day import DAY, t

PRE_AND_SETUP = ["atr30_pips", "pdh", "pdl", "on_high", "on_low", "map_levels_above", "map_levels_below", "level_found",
                 "level_type", "level_price", "level_respect_atr", "level_age_days", "eq_spread_atr", "levels_swept_count",
                 "break_time_ny", "sweep_extreme", "sweep_depth_pips", "sweep_depth_atr", "max_closes_beyond", "conf_time_ny",
                 "conf_min_ny", "candles_to_close_back", "entry_delay_candles", "rule_entry", "rule_stop", "rule_risk_pips",
                 "stop_diff_pips", "opp_taken_in_window"] + [f"opp{k}_{f}" for k in range(1, 7)
                                                           for f in ("type", "pips", "respect_atr", "age_days")]
POST = ["stop_hit", "stop_time_ny", "mfe_pips_before_stop", "pnl_pips_at_1600", "phase2_r_gross"]


def row_for(m5, trade, **session):
    data = D.session([trade], **session)
    return sweep.trade_row(trade, data, m5)


def atr_at_eight(m5):
    m30 = loglib.minutes_bars(m5.until(t(DAY, 7, 55)), 30)
    return loglib.wilder_atr(m30.high, m30.low, m30.close, 14)[-1]


def test_a_built_sell_setup_measures_every_field():
    m5 = D.candles()
    atr = atr_at_eight(m5)
    r = row_for(m5, D.sell_trade())
    expected = {
        "date_ny": "2026-03-11", "weekday": "Wednesday", "side": "SELL", "order_type": "MARKET",
        "placed_time_ny": "2026-03-11 08:35", "entry_time_ny": "2026-03-11 08:40", "entry_min_ny": "520",
        "exit_time_ny": "2026-03-11 09:15", "entry_price": "1.10070", "stop_loss": "1.10135", "take_profit": "1.09860",
        "exit_price": "1.09860", "exit_reason": "TAKE_PROFIT", "lots": "0.80", "actual_r": "3.23", "pnl_usd": "161.60",
        "commission_usd": "6.40", "risk_pips": "6.5", "spread_pips": "0.5", "trade_of_day": "", "level_attempt": "",
        "tags": "A+ setup", "note": "swept SH",
        # the map at 08:00
        "atr30_pips": f"{atr / 10:.1f}", "pdh": "1.10150", "pdl": "1.09550", "on_high": "1.10300", "on_low": "1.09700",
        "map_levels_above": "2", "map_levels_below": "3",  # ONH, SH; EQL, ONL, PDL (PDH was taken by the 21:00 spike)
        # the sweep
        "level_found": "TRUE", "level_type": "SH", "level_price": "1.10100",
        "level_respect_atr": f"{250 / atr:.2f}", "level_age_days": "0.17",  # 04:00 to 08:00
        "eq_spread_atr": "", "levels_swept_count": "1",
        "break_time_ny": "2026-03-11 08:30", "sweep_extreme": "1.10120", "sweep_depth_pips": "2.0",
        "sweep_depth_atr": f"{20 / atr:.2f}", "max_closes_beyond": "1", "conf_time_ny": "2026-03-11 08:35",
        "conf_min_ny": "520", "candles_to_close_back": "2", "entry_delay_candles": "0",
        "rule_entry": "1.10070", "rule_stop": "1.10135", "rule_risk_pips": "6.5", "stop_diff_pips": "0.0",
        "opp_taken_in_window": "FALSE",
        # the equal lows: the 06:30 swing is the more recent: highest high after it 109960, 108 points; 1.5 hours old
        "opp1_type": "EQL", "opp1_pips": "22.0", "opp1_respect_atr": f"{108 / atr:.2f}", "opp1_age_days": "0.06",
        "opp2_type": "ONL", "opp2_pips": "37.0", "opp2_respect_atr": "", "opp2_age_days": "",
        "opp3_type": "PDL", "opp3_pips": "52.0", "opp4_type": "",
        # after
        "post_status": "COMPLETE", "stop_hit": "FALSE", "stop_time_ny": "", "mfe_pips_before_stop": "21.5",
        "pnl_pips_at_1600": "20.0", "phase2_r_gross": "2.08",
    }
    assert {k: str(r.get(k, "")) for k in expected} == expected
    m = sweep.build_map(m5, DAY)
    eq = next(lv for lv in m.below if lv.kind == "EQ")
    assert (eq.price, round(eq.eq_spread, 4)) == (109850, round(2 / atr, 4))


def mirror(text):
    return f"{(220000 - round(float(text) * 1e5)) / 1e5:.5f}"


def test_the_same_day_upside_down_gives_the_buy_mirror():
    from tests.nbb_day import mirrored
    m5 = D.candles()
    sell = row_for(m5, D.sell_trade())
    trade = D.sell_trade(side="BUY", plannedEntry=109930, entryPrice=109930, exitPrice=110140, stopLoss=109865,
                         initialStop=109865, takeProfit=110140)
    buy = row_for(mirrored(m5), trade)
    for k in ("entry_price", "stop_loss", "level_price", "sweep_extreme", "rule_entry", "rule_stop"):
        assert buy[k] == mirror(sell[k]), k
    assert (buy["pdh"], buy["pdl"], buy["on_high"], buy["on_low"]) == tuple(mirror(sell[k]) for k in ("pdl", "pdh", "on_low", "on_high"))
    assert (buy["level_type"], buy["opp1_type"], buy["opp2_type"], buy["opp3_type"]) == ("SL", "EQH", "ONH", "PDH")
    assert (buy["map_levels_above"], buy["map_levels_below"]) == (sell["map_levels_below"], sell["map_levels_above"])
    same = ["atr30_pips", "level_respect_atr", "level_age_days", "levels_swept_count", "break_time_ny", "sweep_depth_pips",
            "sweep_depth_atr", "max_closes_beyond", "conf_time_ny", "conf_min_ny", "candles_to_close_back",
            "entry_delay_candles", "rule_risk_pips", "stop_diff_pips", "opp_taken_in_window", "opp1_pips",
            "opp1_respect_atr", "opp1_age_days", "opp2_pips", "opp3_pips", "post_status"] + POST
    assert {k: buy[k] for k in same} == {k: sell[k] for k in same}


def test_no_look_ahead_past_the_entry_or_the_replay():
    after = list(D.AFTER)
    after[14] = ((9, 10), 109960, 110400, 109900, 109910)  # after the entry, price runs through ONH for a moment
    m5 = D.candles(D.the_day(after=after))
    full = row_for(m5, D.sell_trade())
    cut = row_for(m5.until(t(DAY, 8, 35)), D.sell_trade())  # every candle from the entry on deleted
    assert {k: cut[k] for k in PRE_AND_SETUP} == {k: full[k] for k in PRE_AND_SETUP}
    assert str(full["levels_swept_count"]) == "1"  # ONH, taken after the entry, is not a swept level
    early = row_for(m5, D.sell_trade(), furthest=t(DAY, 12, 0))
    assert early["post_status"] == "PENDING" and all(early[k] == "" for k in POST)


def test_a_run_is_still_logged():
    after = list(D.AFTER[:6]) + [((8, 30), 110095, 110120, 110090, 110110), ((8, 35), 110110, 110125, 110105, 110115),
                                 ((8, 40), 110115, 110130, 110108, 110112), ((8, 45), 110112, 110114, 110060, 110070)]
    after += [((hh, mm + 10) if mm + 10 < 60 else (hh + 1, mm - 50), o, h, l, c) for (hh, mm), o, h, l, c in D.AFTER[8:]]
    m5 = D.candles(D.the_day(after=after))
    r = row_for(m5, D.sell_trade(placedTime=t(DAY, 8, 45), entryTime=t(DAY, 8, 50)))
    assert (r["level_type"], str(r["max_closes_beyond"]), str(r["candles_to_close_back"]), r["sweep_extreme"]) == ("SH", "3", "4", "1.10130")


def test_a_candle_through_the_stop_and_a_target_is_the_stop_and_its_low_is_not_the_best_move():
    after = list(D.AFTER)
    after[9] = ((8, 45), 110045, 110140, 109800, 110005)  # through the rule stop 110135 and the target 109860
    r = row_for(D.candles(D.the_day(after=after)), D.sell_trade())
    assert (r["stop_hit"], r["stop_time_ny"]) == ("TRUE", "2026-03-11 08:45")
    assert r["mfe_pips_before_stop"] == "3.0"  # only 08:40's low 110040 counts
    assert r["pnl_pips_at_1600"] == "" and r["phase2_r_gross"] == "-1.00"


def test_the_map_rules():
    m5 = D.candles()
    m = sweep.build_map(m5, DAY)
    kinds = lambda side: [(lv.kind, lv.price) for lv in side]
    # The 21:00 spike is a swing high, but within 0.1 x ATR of ONH (it is ONH): dropped. The two lows are one EQ level.
    assert kinds(m.above) == [("ON", 110300), ("S", 110100)]
    assert kinds(m.below) == [("PD", 109550), ("ON", 109700), ("EQ", 109850)]
    # A swing traded through before 08:00 is not on the map.
    morning = list(D.MORNING)
    morning[9] = ((7, 30), 109940, 110110, 109900, 109950)  # 07:30 trades above SH 110100
    taken = sweep.build_map(D.candles(D.the_day(morning=morning)), DAY)
    assert ("S", 110100) not in kinds(taken.above)
    # A swing that price left by only 25 points, about 0.74 x this quieter morning's ATR of 33.8 points (10 points: under
    # 0.5 x ATR, not on the map at all), is on the app's map but not the rulebook's.
    weak = list(D.MORNING[:2]) + [((4, 0), 110050, 110100, 110040, 110090)] +         [((hh, mm), 110090, 110095, 110075, 110090) for (hh, mm), *_ in D.MORNING[3:]]
    wm = sweep.build_map(D.candles(D.the_day(morning=weak)), DAY)
    sh = next(lv for lv in wm.above if lv.kind == "S")
    assert 0.5 <= sh.respect < 1.0 and not sh.rulebook()
    assert sum(lv.rulebook() for lv in wm.above) == 1  # only ONH counts on the rulebook map


def test_when_two_levels_are_swept_the_overnight_high_outranks_a_swing():
    night = [D.NIGHT[0], ((21, 0, -1), 110000, 110110, 109990, 110000)]  # a smaller spike: ONH 110110, just above SH 110100
    m5 = D.candles(D.the_day(night=night))
    m = sweep.build_map(m5, DAY)
    assert [(lv.kind, lv.price) for lv in m.above] == [("PD", 110150), ("ON", 110110), ("S", 110100)]  # PDH untaken now
    r = row_for(m5, D.sell_trade())
    assert (r["level_type"], r["level_price"], str(r["levels_swept_count"])) == ("ONH", "1.10110", "2")


def test_saving_twice_is_identical_pending_turns_complete_and_attempts_are_counted():
    m5 = D.candles()
    second = D.sell_trade(id=2, placedTime=t(DAY, 9, 20), entryTime=t(DAY, 9, 25), exitTime=t(DAY, 10, 0),
                          plannedEntry=109870, entryPrice=109870, exitPrice=109870, initialStop=109935, stopLoss=109935,
                          resultR=0.0)
    with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
        step, fresh = Path(a), Path(b)
        sweep.write_logs(D.session([D.sell_trade(), second], furthest=t(DAY, 12, 0)), step, m5)
        first = (step / sweep.LOG_FILE).read_bytes()
        sweep.write_logs(D.session([D.sell_trade(), second], furthest=t(DAY, 12, 0)), step, m5)
        assert (step / sweep.LOG_FILE).read_bytes() == first and b"PENDING" in first
        sweep.write_logs(D.session([D.sell_trade(), second]), step, m5)
        sweep.write_logs(D.session([D.sell_trade(), second]), fresh, m5)
        for name in (sweep.LOG_FILE, sweep.DAYS_FILE):
            assert (step / name).read_bytes() == (fresh / name).read_bytes(), name
        with (step / sweep.LOG_FILE).open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    assert [(r["trade_id"], r["trade_of_day"], r["level_attempt"], r["level_type"], r["post_status"]) for r in rows] == [
        ("1", "1", "1", "SH", "COMPLETE"), ("2", "2", "2", "SH", "COMPLETE")]  # the second trade faded SH again


def test_the_headers_are_the_spec_and_the_workbooks_contract():
    spec = (Path(__file__).parents[1] / "docs" / "plan-sweep-logger.md").read_text(encoding="utf-8")
    log, days = spec.split("### sweep_log.csv")[1].split("### sweep_days.csv")
    assert sweep.COLUMNS == re.findall(r"^\| `(\w+)` \|", log, re.M)
    assert sweep.DAY_COLUMNS == re.findall(r"^\| `(\w+)` \|", days.split("## Tests")[0], re.M)
    with tempfile.TemporaryDirectory() as tmp:
        sweep.write_logs(D.session([D.sell_trade()]), Path(tmp), D.candles())
        for name, columns in ((sweep.LOG_FILE, sweep.COLUMNS), (sweep.DAYS_FILE, sweep.DAY_COLUMNS)):
            with (Path(tmp) / name).open(encoding="utf-8") as f:
                assert f.readline().strip().split(",") == columns


def test_day_rows_count_the_map_and_the_sweeps_in_the_window():
    m5 = D.candles()
    rows = sweep.day_rows(D.session([D.sell_trade()], start=t(date(2026, 3, 9), 0)), m5)
    assert [r["date_ny"] for r in rows] == ["2026-03-09", "2026-03-10", "2026-03-11"]
    wed = rows[-1]
    # SH 110100: through at 08:30, back at 08:35 (2 candles), closing 08:40: one sweep. Nothing else was swept by 11:00.
    assert (wed["map_levels_above"], wed["map_levels_below"], wed["eq_levels"], wed["sweeps_in_window"], wed["trades_taken"]) == (
        2, 3, 1, 1, 1)
    late = sweep.day_rows(D.session([], start=t(date(2026, 3, 9), 9)), m5)
    assert late[0]["date_ny"] == "2026-03-10"  # Monday's 08:00 came before the start


def test_only_the_strategys_own_logger_runs(monkeypatch):
    m5 = D.candles()
    monkeypatch.setattr(loglib, "load_m5", lambda *a, **k: m5)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        strategy_folders.save_strategy("liquidity_sweep", {"label": "Sweep", "logger": "sweep"}, root)
        strategy_folders.save_strategy("nbb", {"label": "NBB", "logger": "nbb"}, root)
        reply = backtests.save("liquidity_sweep", "bt-sweep-1", D.session([D.sell_trade()]), root)
        assert reply["log"]["logger"] == "sweep" and reply["log"]["trades"] == 1
        assert (root / "liquidity_sweep" / sweep.LOG_FILE).exists() and not (root / "liquidity_sweep" / nbb.LOG_FILE).exists()
        backtests.save("nbb", "bt-sweep-1", D.session([D.sell_trade()]) | {"journal": "nbb"}, root)
        assert (root / "nbb" / nbb.LOG_FILE).exists() and not (root / "nbb" / sweep.LOG_FILE).exists()
        backtests.save("plain", "bt-sweep-1", D.session([D.sell_trade()]) | {"journal": "plain"}, root)
        assert not any((root / "plain").glob("*_log.csv"))


def test_rebuild_writes_every_saved_session_again():
    m5 = D.candles()
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        (folder / "backtests").mkdir()
        for run in ("bt-a", "bt-b"):
            (folder / "backtests" / f"{run}.json").write_text(json.dumps(D.session([D.sell_trade()], run=run)))
        assert sweep.rebuild(folder, m5) == {"sessions": 2, "trades": 2, "days": 6}


def test_weekday_days_skip_the_weekend():
    assert sweep.weekday_days(t(date(2026, 3, 13), 12), t(date(2026, 3, 16), 12)) == 1.0  # Friday noon to Monday noon
    assert sweep.weekday_days(t(DAY, 4), t(DAY, 8)) == 4 / 24
