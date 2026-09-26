"""Automated (headless) backtests using the same broker as the replay window.

A strategy sees each candle only after it has closed and can place orders
that are resolved from the *next* candle onward, so it cannot peek ahead.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

import pandas as pd

from .broker import Broker, Side, Trade
from .config import Instrument
from .journal import trades_to_frame
from .stats import Stats, compute_stats


class Context:
    """What a strategy can see and do on each candle."""

    def __init__(self, candles: pd.DataFrame, broker: Broker):
        self.candles = candles
        self.broker = broker
        self.index = -1
        self._times = candles.index
        self._o = candles["open"].to_numpy()
        self._h = candles["high"].to_numpy()
        self._l = candles["low"].to_numpy()
        self._c = candles["close"].to_numpy()

    # current (just closed) candle
    @property
    def time(self) -> pd.Timestamp:
        return self._times[self.index]

    @property
    def open(self) -> float:
        return float(self._o[self.index])

    @property
    def high(self) -> float:
        return float(self._h[self.index])

    @property
    def low(self) -> float:
        return float(self._l[self.index])

    @property
    def close(self) -> float:
        return float(self._c[self.index])

    def history(self, n: int) -> pd.DataFrame:
        """The last n closed candles, including the current one."""
        return self.candles.iloc[max(0, self.index - n + 1): self.index + 1]

    # orders
    def market(self, side: Side, stop_loss: float, take_profit: float) -> Trade:
        return self.broker.market_order(side, stop_loss, take_profit, self.time, self.close)

    def pending(self, side: Side, price: float, stop_loss: float, take_profit: float) -> Trade:
        return self.broker.pending_order(side, price, stop_loss, take_profit, self.time, self.close)

    def cancel(self, trade: Trade) -> None:
        self.broker.cancel(trade)

    def close_trade(self, trade: Trade) -> None:
        self.broker.close(trade, self.time, self.close)


class Strategy(ABC):
    name = "strategy"

    def on_start(self, ctx: Context) -> None:
        """Called once before the first candle."""

    @abstractmethod
    def on_candle(self, ctx: Context) -> None:
        """Called after every candle closes."""


@dataclass
class BacktestResult:
    strategy: str
    trades: list[Trade]
    journal: pd.DataFrame
    stats: Optional[Stats]


def run_backtest(candles: pd.DataFrame, strategy: Strategy, instrument: Instrument,
                 spread_pips: float = 0.0) -> BacktestResult:
    broker = Broker(instrument, spread_pips)
    ctx = Context(candles, broker)
    strategy.on_start(ctx)

    for i in range(len(candles)):
        ctx.index = i
        broker.process_candle(ctx.time, ctx._o[i], ctx._h[i], ctx._l[i])
        strategy.on_candle(ctx)

    # Flatten anything still open at the end of the data.
    for trade in broker.open_trades:
        ctx.close_trade(trade)
    for trade in broker.pending_orders:
        broker.cancel(trade)

    closed = broker.closed_trades
    closed.sort(key=lambda t: t.exit_time)
    journal = trades_to_frame(closed, instrument, run_id=strategy.name)
    return BacktestResult(strategy.name, closed, journal, compute_stats(journal))
