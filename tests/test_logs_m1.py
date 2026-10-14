"""The NBB and sweep logs on sessions replayed on 1-minute candles (v2.3): the rules stay on M5 candles built
from the minutes, and a 5-minute candle counts only once it has closed."""

import csv
import tempfile
from pathlib import Path

import numpy as np

from forex_replay import loglib, nbb, sweep
from forex_replay.loglib import Candles
from tests import nbb_day, sweep_day
from tests.nbb_day import DAY, t


def to_minutes(m5: Candles) -> Candles:
    """Each M5 candle as five M1 candles whose M5 is exactly the original (the high first, then the low)."""
    rows = []
    for i in range(len(m5)):
        tt, o, h, l, c, s = (int(a[i]) for a in (m5.time, m5.open, m5.high, m5.low, m5.close, m5.spread))
        rows += [(tt, o, h, min(o, c), o, s), (tt + 60, o, max(o, c), l, c, s)] + [(tt + 60 * k, c, c, c, c, s) for k in (2, 3, 4)]
    return Candles.from_rows(rows)


def test_m5_built_from_minutes_is_the_original():
    m5 = nbb_day.candles()
    built = loglib.five_minute(to_minutes(m5))
    for f in ("time", "open", "high", "low", "close", "spread"):
        assert np.array_equal(getattr(built, f), getattr(m5, f)), f


def test_closed_cut_counts_only_finished_five_minute_candles():
    eight = t(DAY, 8, 0)
    assert loglib.closed_cut(eight + 35 * 60, 300) == eight + 35 * 60      # M5 sessions: unchanged
    assert loglib.closed_cut(eight + 37 * 60, 60) == eight + 30 * 60       # 08:37: the 08:30 candle (closed 08:35)
    assert loglib.closed_cut(eight + 39 * 60, 60) == eight + 35 * 60       # 08:39 closes at 08:40: the 08:35 candle has closed


def logged(module, data, base):
    with tempfile.TemporaryDirectory() as tmp:
        module.write_logs(data, Path(tmp), base)
        with (Path(tmp) / module.LOG_FILE).open(newline="", encoding="utf-8") as f:
            trade_rows = list(csv.DictReader(f))
        with (Path(tmp) / module.DAYS_FILE).open(newline="", encoding="utf-8") as f:
            day_rows = list(csv.DictReader(f))
    return trade_rows, day_rows


def test_a_minute_session_logs_what_the_five_minute_one_did_when_the_times_line_up():
    # The same trade on minutes: placed in the last minute of the M5 candle the 5-minute session placed it on
    # (07:29 instead of 07:25 for NBB, 08:39 instead of 08:35 for the sweep), so the same M5 candles had closed by
    # then, and replayed to the last minute of the same final M5 candle. Every measured column must be the same;
    # only placed_time_ny shows the minute.
    for module, day, trade in ((nbb, nbb_day, nbb_day.sell_trade()), (sweep, sweep_day, sweep_day.sell_trade())):
        m5 = day.candles()
        five = day.session([trade])
        minute = dict(five, barSeconds=60, furthestTime=five["furthestTime"] + 240,
                      trades=[dict(trade, placedTime=trade["placedTime"] + 240)])
        (a,), days_a = logged(module, five, m5)
        (b,), days_b = logged(module, minute, to_minutes(m5))
        assert (a.pop("placed_time_ny"), b.pop("placed_time_ny")) == (
            loglib.ny_text(trade["placedTime"]), loglib.ny_text(trade["placedTime"] + 240))
        assert a == b, module.__name__
        assert days_a == days_b, module.__name__


def test_a_minute_entry_never_sees_the_five_minute_candle_still_forming():
    # The sweep confirms on the 08:35 candle, which closes at 08:40. Entered at 08:38 on minutes, it had not
    # confirmed yet: no setup. Entered at 08:40, it had.
    base = to_minutes(sweep_day.candles())
    early = sweep_day.sell_trade(placedTime=t(DAY, 8, 37), entryTime=t(DAY, 8, 38))
    data = dict(sweep_day.session([early]), barSeconds=60)
    row = sweep.trade_row(early, data, loglib.five_minute(base), base)
    assert (row["level_found"], row["post_status"]) == ("FALSE", "NO_SETUP")
    on_time = sweep_day.sell_trade(placedTime=t(DAY, 8, 39), entryTime=t(DAY, 8, 40))
    row = sweep.trade_row(on_time, dict(sweep_day.session([on_time]), barSeconds=60), loglib.five_minute(base), base)
    assert (row["level_found"], row["level_type"], row["entry_delay_candles"]) == ("TRUE", "SH", 0)
    # Deleting every minute from the 08:38 entry on changes nothing measured before it.
    full = sweep.trade_row(early, data, loglib.five_minute(base), base)
    cut = base.until(t(DAY, 8, 37))
    again = sweep.trade_row(early, data, loglib.five_minute(cut), cut)
    measured = [c for c in sweep.COLUMNS[25:] if c not in ("post_status",) and not c.startswith(("stop_", "mfe", "pnl_pips", "phase2"))]
    assert {k: again[k] for k in measured} == {k: full[k] for k in measured}


def test_the_entry_spread_comes_from_the_minute_it_filled_on():
    base = to_minutes(nbb_day.candles())
    i = base.index_at(t(DAY, 7, 30))
    spread = base.spread.copy()
    spread[i] = 9  # 0.9 pips on the fill minute only
    base = Candles(base.time, base.open, base.high, base.low, base.close, spread)
    trade = nbb_day.sell_trade()
    data = dict(nbb_day.session([trade]), barSeconds=60)
    assert nbb.trade_row(trade, data, loglib.five_minute(base), base)["spread_pips"] == "0.9"
