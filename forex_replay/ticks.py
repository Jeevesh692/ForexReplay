"""Tick download for the order-flow toolkit: FundedNext's bid/ask ticks through the MetaTrader5 package.

    python -m forex_replay ticks download EURUSD XAUUSD --from 2025-08-01

Needs the MT5 terminal open and logged in. Each broker-server day is cached as one Parquet file in
data_ticks/<PAIR>/<YYYY-MM-DD>.parquet (gitignored), so a rerun only fetches days not cached yet, plus the
last two cached days (they may have been cut off by the previous run).

What is stored: the "info" ticks (COPY_TICKS_INFO: every change of bid or ask), with
    time_msc  milliseconds, on the broker SERVER clock (New York + 7 hours), as MT5 gives them
    bid, ask  prices
    volume    MT5's tick volume (0 for forex on most brokers: tick counts are counted in flow.py instead)
Converting to UTC happens in flow.py, with the same rule as datapipe.server_to_utc. Weekend days are cached
as empty files so they are not asked for again.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from .config import PROJECT_ROOT

TICKS_DIR = PROJECT_ROOT / "data_ticks"
COLUMNS = ["time_msc", "bid", "ask", "volume"]


def day_path(symbol: str, day: date, root: Path = TICKS_DIR) -> Path:
    return root / symbol / f"{day.isoformat()}.parquet"


def cached_days(symbol: str, root: Path = TICKS_DIR) -> list[date]:
    folder = root / symbol
    return sorted(date.fromisoformat(p.stem) for p in folder.glob("*.parquet")) if folder.exists() else []


def days_to_fetch(symbol: str, start: date, end: date, root: Path = TICKS_DIR, refresh_last: int = 2) -> list[date]:
    """Server days from start to end (inclusive) not cached yet, plus the last `refresh_last` cached ones."""
    have = set(cached_days(symbol, root))
    recent = set(sorted(d for d in have if start <= d <= end)[-refresh_last:]) if refresh_last else set()
    out, d = [], start
    while d <= end:
        if d not in have or d in recent:
            out.append(d)
        d += timedelta(days=1)
    return out


def ticks_to_frame(ticks) -> pd.DataFrame:
    """MT5's structured array -> the columns kept, in a stable order."""
    if ticks is None or len(ticks) == 0:
        return pd.DataFrame({c: pd.Series(dtype="int64" if c == "time_msc" else "float64") for c in COLUMNS})
    frame = pd.DataFrame(ticks)
    return frame[COLUMNS].astype({"time_msc": "int64", "bid": "float64", "ask": "float64", "volume": "float64"})


def download(symbols: list[str], start: date, end: date | None = None, root: Path = TICKS_DIR) -> dict:
    """Fetch and cache each missing server day. Returns {symbol: {"days": n, "ticks": n, "first": day}}."""
    import MetaTrader5 as mt5  # only here: the rest of the project does not need MT5 installed

    if not mt5.initialize():
        raise RuntimeError(f"MT5 did not start: {mt5.last_error()}. Open MetaTrader 5 and log in, then run this again.")
    end = end or (datetime.now(timezone.utc) + timedelta(hours=3)).date()  # roughly today on the server clock
    report = {}
    try:
        for symbol in symbols:
            if not mt5.symbol_select(symbol, True):
                raise RuntimeError(f"{symbol} is not in this MT5 account's symbols")
            fetched = ticks = 0
            first = None
            for day in days_to_fetch(symbol, start, end, root):
                # MT5 reads these datetimes on its server clock: one server day, 00:00 to 24:00
                begin = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
                frame = ticks_to_frame(mt5.copy_ticks_range(symbol, begin, begin + timedelta(days=1), mt5.COPY_TICKS_INFO))
                path = day_path(symbol, day, root)
                path.parent.mkdir(parents=True, exist_ok=True)
                frame.to_parquet(path, index=False)
                fetched += 1
                ticks += len(frame)
                if len(frame) and first is None:
                    first = day
            report[symbol] = {"days": fetched, "ticks": ticks, "first": first.isoformat() if first else None}
            print(f"{symbol}: {fetched} days fetched, {ticks:,} ticks", flush=True)
    finally:
        mt5.shutdown()
    return report


def load_ticks(symbol: str, root: Path = TICKS_DIR, start: date | None = None, end: date | None = None) -> pd.DataFrame:
    """Every cached tick of a symbol in time order (server-clock milliseconds)."""
    frames = [pd.read_parquet(day_path(symbol, d, root)) for d in cached_days(symbol, root)
              if (start is None or d >= start) and (end is None or d <= end)]
    frames = [f for f in frames if len(f)]
    if not frames:
        return ticks_to_frame(None)
    out = pd.concat(frames, ignore_index=True).sort_values("time_msc", kind="stable")
    return out.drop_duplicates(subset=["time_msc", "bid", "ask"], keep="last").reset_index(drop=True)
