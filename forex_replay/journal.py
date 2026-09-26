"""CSV trade journal: one row per closed trade."""

from __future__ import annotations

import csv
from pathlib import Path

import pandas as pd

from .broker import Trade
from .config import Instrument
from .sessions import session_of

COLUMNS = [
    "trade_id", "run_id", "symbol", "side", "order_type",
    "placed_time", "entry_time", "exit_time",
    "entry_price", "exit_price", "stop_loss", "take_profit",
    "risk_pips", "pnl_pips", "result_r", "planned_rr", "mfe_r", "mae_r",
    "exit_reason", "session", "weekday", "duration_min",
]
TIME_COLUMNS = ["placed_time", "entry_time", "exit_time"]


def trade_to_row(trade: Trade, instrument: Instrument, run_id: str) -> dict:
    digits = instrument.digits

    def fmt_time(value):
        return "" if value is None else pd.Timestamp(value).strftime("%Y-%m-%d %H:%M:%S")

    def rnd(value, places):
        return "" if value is None else round(float(value), places)

    duration = None
    if trade.entry_time is not None and trade.exit_time is not None:
        duration = (trade.exit_time - trade.entry_time).total_seconds() / 60

    return {
        "trade_id": trade.id,
        "run_id": run_id,
        "symbol": instrument.symbol,
        "side": trade.side.value,
        "order_type": trade.order_type.value,
        "placed_time": fmt_time(trade.placed_time),
        "entry_time": fmt_time(trade.entry_time),
        "exit_time": fmt_time(trade.exit_time),
        "entry_price": rnd(trade.entry_price, digits),
        "exit_price": rnd(trade.exit_price, digits),
        "stop_loss": rnd(trade.stop_loss, digits),
        "take_profit": rnd(trade.take_profit, digits),
        "risk_pips": rnd(instrument.to_pips(trade.planned_risk), 1),
        "pnl_pips": rnd(None if trade.pnl is None else instrument.to_pips(trade.pnl), 1),
        "result_r": rnd(trade.result_r, 2),
        "planned_rr": rnd(trade.planned_reward_r, 2),
        "mfe_r": rnd(trade.mfe_r, 2),
        "mae_r": rnd(trade.mae_r, 2),
        "exit_reason": "" if trade.exit_reason is None else trade.exit_reason.value,
        "session": session_of(trade.entry_time) if trade.entry_time is not None else "",
        "weekday": "" if trade.entry_time is None else pd.Timestamp(trade.entry_time).day_name(),
        "duration_min": rnd(duration, 0),
    }


class TradeJournal:
    """Appends closed trades to a CSV file (created with a header if missing).

    Each trade is identified by (run_id, trade_id), so reloading a saved
    session and replaying forward again never logs the same trade twice.
    """

    def __init__(self, path: str | Path, instrument: Instrument, run_id: str):
        self.path = Path(path)
        self.instrument = instrument
        self.run_id = run_id
        self._logged: set[tuple[str, str]] = set()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists() or self.path.stat().st_size == 0:
            with self.path.open("w", newline="", encoding="utf-8") as f:
                csv.DictWriter(f, fieldnames=COLUMNS).writeheader()
            return
        with self.path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames != COLUMNS:
                raise ValueError(
                    f"{self.path} has an unexpected header. Move it aside or start a new journal.")
            self._logged = {(row["run_id"], row["trade_id"]) for row in reader}

    def log(self, trade: Trade) -> bool:
        """Append a closed trade. Returns False if it was already in the journal."""
        key = (self.run_id, str(trade.id))
        if key in self._logged:
            return False
        with self.path.open("a", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=COLUMNS).writerow(
                trade_to_row(trade, self.instrument, self.run_id))
        self._logged.add(key)
        return True


def load_journal(path: str | Path) -> pd.DataFrame:
    """Read a journal CSV into a DataFrame with parsed timestamps, in logged order."""
    df = pd.read_csv(path)
    for col in TIME_COLUMNS:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")
    return df


def trades_to_frame(trades: list[Trade], instrument: Instrument, run_id: str = "") -> pd.DataFrame:
    """Same shape as a loaded journal, built from in-memory closed trades."""
    rows = [trade_to_row(t, instrument, run_id) for t in trades]
    df = pd.DataFrame(rows, columns=COLUMNS)
    for col in TIME_COLUMNS:
        df[col] = pd.to_datetime(df[col], errors="coerce")
    numeric = ["entry_price", "exit_price", "stop_loss", "take_profit", "risk_pips",
               "pnl_pips", "result_r", "planned_rr", "mfe_r", "mae_r", "duration_min"]
    df[numeric] = df[numeric].apply(pd.to_numeric, errors="coerce")
    return df
