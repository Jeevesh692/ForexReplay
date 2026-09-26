import tempfile
from pathlib import Path

import pandas as pd
import pytest
from conftest import make_candles

from forex_replay.broker import Broker, Side
from forex_replay.config import EURUSD_M5
from forex_replay.data import load_candles, validate_candles
from forex_replay.drawings import Drawings
from forex_replay.journal import COLUMNS, TradeJournal, load_journal
from forex_replay.persistence import SessionState, load_session, save_session
from forex_replay.replay import ReplayEngine

FLAT = [(1.1, 1.1005, 1.0995, 1.1)] * 10


def test_rewinding_does_not_reprocess_candles():
    engine = ReplayEngine(make_candles(FLAT), start_index=3)
    assert engine.step_forward() == 3
    engine.step_back()
    engine.step_back()
    assert not engine.at_live_edge
    assert engine.step_forward() is None  # already seen: nothing new to process
    assert engine.step_forward() is None
    assert engine.at_live_edge
    assert engine.step_forward() == 4


def test_jump_to_nearest_candle():
    candles = make_candles(FLAT)
    engine = ReplayEngine(candles, start_index=2)
    engine.jump_to("2025-03-03 10:21")
    assert engine.last_time == pd.Timestamp("2025-03-03 10:20")
    assert engine.at_live_edge


def test_validation_rejects_bad_ohlc():
    bad = make_candles([(1.1, 1.09, 1.08, 1.1)])  # high below open
    with pytest.raises(ValueError):
        validate_candles(bad)


def test_load_candles_renames_tick_volume():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "c.csv"
        path.write_text("time,open,high,low,close,tick_volume\n"
                        "2025-01-01 00:00:00,1.1,1.2,1.0,1.1,5\n")
        df = load_candles(path)
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]


def test_journal_logs_each_trade_once():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "trades.csv"
        journal = TradeJournal(path, EURUSD_M5, run_id="r1")
        b = Broker(EURUSD_M5, on_close=journal.log)
        t = b.market_order(Side.BUY, 1.0990, 1.1010, pd.Timestamp("2025-03-03 10:00"), 1.1000)
        b.process_candle(pd.Timestamp("2025-03-03 10:05"), 1.1000, 1.1011, 1.0999)
        assert journal.log(t) is False  # duplicate ignored
        # a fresh journal object for the same run also knows about it
        assert TradeJournal(path, EURUSD_M5, run_id="r1").log(t) is False
        df = load_journal(path)
    assert list(df.columns) == COLUMNS
    assert len(df) == 1
    assert df.loc[0, "result_r"] == pytest.approx(1.0)
    assert df.loc[0, "exit_reason"] == "TAKE_PROFIT"


def test_session_round_trip():
    b = Broker(EURUSD_M5)
    b.pending_order(Side.SELL, 1.1010, 1.1020, 1.0990, pd.Timestamp("2025-03-03 10:00"), 1.1000)
    drawings = Drawings()
    drawings.add_hline(1.1)
    drawings.add_trendline("2025-03-03 10:00", 1.1, "2025-03-03 10:30", 1.2)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "session.json"
        save_session(path, SessionState("r1", 50, 60, b.trades, drawings))
        state = load_session(path)
    assert (state.run_id, state.current, state.furthest) == ("r1", 50, 60)
    assert state.trades[0].to_dict() == b.trades[0].to_dict()
    assert state.drawings.items == drawings.items
