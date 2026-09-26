"""Loading and validating OHLC candle data."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

REQUIRED_COLUMNS = ("time", "open", "high", "low", "close")


def load_candles(path: str | Path) -> pd.DataFrame:
    """Load an MT5-style OHLC export into a time-indexed DataFrame.

    Expected columns: time, open, high, low, close and optionally tick_volume.
    The result has columns open, high, low, close, volume and a sorted,
    unique DatetimeIndex. Raises ValueError if the data is unusable.
    """
    df = pd.read_csv(path)
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{path}: missing columns {missing}")

    df["time"] = pd.to_datetime(df["time"])
    if "tick_volume" in df.columns:
        df = df.rename(columns={"tick_volume": "volume"})
    if "volume" not in df.columns:
        df["volume"] = 0

    df = df[["time", "open", "high", "low", "close", "volume"]].set_index("time")
    validate_candles(df)
    return df


def validate_candles(df: pd.DataFrame) -> None:
    """Fail loudly on data problems that would silently corrupt a replay."""
    if df.empty:
        raise ValueError("No candles loaded")
    if df[["open", "high", "low", "close"]].isna().any().any():
        raise ValueError("Candle data contains missing prices")
    if not df.index.is_monotonic_increasing:
        raise ValueError("Candles are not sorted by time")
    if df.index.has_duplicates:
        raise ValueError("Candle data contains duplicate timestamps")

    body_high = df[["open", "close"]].max(axis=1)
    body_low = df[["open", "close"]].min(axis=1)
    bad = (df["high"] < body_high) | (df["low"] > body_low)
    if bad.any():
        first = df.index[bad.to_numpy().argmax()]
        raise ValueError(f"{int(bad.sum())} candles have inconsistent OHLC (first at {first})")
