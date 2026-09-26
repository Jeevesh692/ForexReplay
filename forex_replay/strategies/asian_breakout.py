"""Example strategy: Asian-range breakout into the London session.

It exists to demonstrate the automated backtest mode; it is not a
recommendation. Rules (times are in the data's broker-server clock, see
forex_replay/sessions.py):

1. Record the high and low of the Asian session (00:00-10:00).
2. At the London open, if the range is between ``min_range_pips`` and
   ``max_range_pips``, place a buy stop above the range and a sell stop below
   it (one-cancels-other).
3. Stop loss at the middle of the range; take profit at ``reward_r`` x risk.
4. Unfilled orders are cancelled at ``cancel_hour``; open trades are closed
   at ``exit_hour``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..backtest import Context, Strategy
from ..broker import InvalidOrder, Side, Status, Trade
from ..config import Instrument
from ..sessions import session_bounds


@dataclass
class AsianBreakoutParams:
    min_range_pips: float = 10
    max_range_pips: float = 40
    buffer_pips: float = 1
    reward_r: float = 1.5
    cancel_hour: int = 15
    exit_hour: int = 22


class AsianBreakout(Strategy):
    name = "asian_breakout"

    def __init__(self, instrument: Instrument, params: AsianBreakoutParams | None = None):
        self.instrument = instrument
        self.params = params or AsianBreakoutParams()
        self.range_start, self.range_end = session_bounds("Asia")
        self._day = None
        self._high: Optional[float] = None
        self._low: Optional[float] = None
        self._orders_placed = False
        self._orders: list[Trade] = []

    def _new_day(self, day) -> None:
        self._day = day
        self._high = self._low = None
        self._orders_placed = False
        self._orders = []

    def on_candle(self, ctx: Context) -> None:
        p = self.params
        day, hour = ctx.time.date(), ctx.time.hour
        if day != self._day:
            self._new_day(day)

        if self.range_start <= hour < self.range_end:
            self._high = ctx.high if self._high is None else max(self._high, ctx.high)
            self._low = ctx.low if self._low is None else min(self._low, ctx.low)
            return

        # One-cancels-other: once one side fills, drop the other.
        if any(t.status in (Status.OPEN, Status.CLOSED) for t in self._orders):
            for t in self._orders:
                if t.status is Status.PENDING:
                    ctx.cancel(t)

        if not self._orders_placed and hour < p.cancel_hour and self._high is not None:
            self._orders_placed = True
            self._place_orders(ctx)

        if hour >= p.cancel_hour:
            for t in self._orders:
                if t.status is Status.PENDING:
                    ctx.cancel(t)
        if hour >= p.exit_hour:
            for t in self._orders:
                if t.status is Status.OPEN:
                    ctx.close_trade(t)

    def _place_orders(self, ctx: Context) -> None:
        p, pip = self.params, self.instrument.pip_size
        range_pips = (self._high - self._low) / pip
        if not (p.min_range_pips <= range_pips <= p.max_range_pips):
            return
        mid = (self._high + self._low) / 2
        buy_at = self._high + p.buffer_pips * pip
        sell_at = self._low - p.buffer_pips * pip

        # Only place a side if price hasn't already broken out past it.
        try:
            if ctx.close < buy_at:
                risk = buy_at - mid
                self._orders.append(ctx.pending(Side.BUY, buy_at, mid, buy_at + p.reward_r * risk))
            if ctx.close > sell_at:
                risk = mid - sell_at
                self._orders.append(ctx.pending(Side.SELL, sell_at, mid, sell_at - p.reward_r * risk))
        except InvalidOrder:
            pass
