import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def make_candles(ohlc, start="2025-03-03 10:00", freq="5min"):
    """Build a candle DataFrame from a list of (open, high, low, close) tuples."""
    index = pd.date_range(start, periods=len(ohlc), freq=freq, name="time")
    df = pd.DataFrame(ohlc, columns=["open", "high", "low", "close"], index=index)
    df["volume"] = 100
    return df
