"""Bar-by-bar replay cursor over a candle DataFrame."""

from __future__ import annotations

from typing import Optional

import pandas as pd


class ReplayEngine:
    """Reveals candles one at a time.

    ``current`` is the number of candles revealed, so the last visible candle
    is ``current - 1``. ``furthest`` remembers the furthest candle ever
    revealed: stepping back lets you review history, but only candles beyond
    ``furthest`` are "new" and get processed by the broker. This keeps
    trades consistent when you rewind, and trading is only allowed at the
    live edge so you can't enter a trade on a move you have already seen.
    """

    def __init__(self, candles: pd.DataFrame, start_index: int = 100, window: int = 100):
        if candles.empty:
            raise ValueError("No candles to replay")
        self.candles = candles
        self.window = window
        self.current = self._clamp(start_index)
        self.furthest = self.current

    def __len__(self) -> int:
        return len(self.candles)

    def _clamp(self, count: int) -> int:
        return max(1, min(int(count), len(self.candles)))

    # ----- state ---------------------------------------------------------
    @property
    def last_index(self) -> int:
        return self.current - 1

    @property
    def last_time(self) -> pd.Timestamp:
        return self.candles.index[self.last_index]

    @property
    def last_candle(self) -> pd.Series:
        return self.candles.iloc[self.last_index]

    @property
    def at_live_edge(self) -> bool:
        return self.current == self.furthest

    @property
    def finished(self) -> bool:
        return self.furthest >= len(self.candles)

    def visible(self) -> tuple[int, pd.DataFrame]:
        """(index of first visible candle, visible candles)."""
        start = max(0, self.current - self.window)
        return start, self.candles.iloc[start:self.current]

    # ----- movement ------------------------------------------------------
    def step_forward(self) -> Optional[int]:
        """Reveal one more candle. Returns its index if it has never been seen before."""
        if self.current >= len(self.candles):
            return None
        self.current += 1
        if self.current > self.furthest:
            self.furthest = self.current
            return self.last_index
        return None

    def step_back(self) -> None:
        if self.current > 1:
            self.current -= 1

    def go_to_live_edge(self) -> None:
        self.current = self.furthest

    def nearest_index(self, when) -> int:
        return int(self.candles.index.get_indexer([pd.Timestamp(when)], method="nearest")[0])

    def jump_to(self, when) -> None:
        """Start replaying from the candle nearest to ``when`` (resets history)."""
        self.current = self.furthest = self._clamp(self.nearest_index(when) + 1)

    def restore(self, current: int, furthest: int) -> None:
        self.furthest = self._clamp(furthest)
        self.current = min(self._clamp(current), self.furthest)
