"""Order execution simulator.

Prices in the candle data are BID prices (MT5 export). Buys are filled at
the ASK (bid + spread) and closed at the bid; sells are filled at the bid and
closed at the ask.

Fill rules (all decided on closed candles, so nothing can see the future):

* Orders are only ever evaluated on candles *after* the one they were placed
  on. A market order fills at the next candle's open.
* Limit / stop orders fill when a later candle trades through their price. If
  the candle opens beyond the price (a gap), the fill happens at the open.
* When both stop-loss and take-profit fall inside one candle, the stop-loss is
  assumed to have been hit first (the conservative assumption).
* On the candle a limit/stop order fills, only the stop-loss can trigger,
  because the order of prices inside that candle is unknown. Market orders
  fill at the open, so the whole candle counts for them.
* Result in R uses the planned risk: |planned entry - stop loss|. Slippage from
  gaps therefore shows up as results worse than -1R, like in live trading.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

import pandas as pd

from .config import Instrument


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"

    @property
    def direction(self) -> int:
        return 1 if self is Side.BUY else -1


class OrderType(str, Enum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"
    STOP = "STOP"


class Status(str, Enum):
    PENDING = "PENDING"
    OPEN = "OPEN"
    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"


class ExitReason(str, Enum):
    STOP_LOSS = "STOP_LOSS"
    TAKE_PROFIT = "TAKE_PROFIT"
    MANUAL = "MANUAL"


class InvalidOrder(ValueError):
    """Raised when an order's prices don't make sense (e.g. SL above a buy)."""


@dataclass
class Trade:
    id: int
    side: Side
    order_type: OrderType
    stop_loss: float
    take_profit: float
    placed_time: pd.Timestamp
    planned_entry: float
    order_price: Optional[float] = None  # None for market orders
    status: Status = Status.PENDING
    entry_price: Optional[float] = None
    entry_time: Optional[pd.Timestamp] = None
    exit_price: Optional[float] = None
    exit_time: Optional[pd.Timestamp] = None
    exit_reason: Optional[ExitReason] = None
    best_price: Optional[float] = None  # most favourable exit-side price while open
    worst_price: Optional[float] = None  # most adverse exit-side price while open
    tags: dict = field(default_factory=dict)

    # ----- derived values -------------------------------------------------
    @property
    def planned_risk(self) -> float:
        return abs(self.planned_entry - self.stop_loss)

    @property
    def planned_reward_r(self) -> float:
        return abs(self.take_profit - self.planned_entry) / self.planned_risk

    @property
    def pnl(self) -> Optional[float]:
        if self.exit_price is None or self.entry_price is None:
            return None
        return (self.exit_price - self.entry_price) * self.side.direction

    @property
    def result_r(self) -> Optional[float]:
        pnl = self.pnl
        return None if pnl is None else pnl / self.planned_risk

    @property
    def mfe_r(self) -> Optional[float]:
        """Maximum favourable excursion in R (how far it went in your favour)."""
        if self.best_price is None or self.entry_price is None:
            return None
        return max(0.0, (self.best_price - self.entry_price) * self.side.direction / self.planned_risk)

    @property
    def mae_r(self) -> Optional[float]:
        """Maximum adverse excursion in R (how far it went against you)."""
        if self.worst_price is None or self.entry_price is None:
            return None
        return max(0.0, (self.entry_price - self.worst_price) * self.side.direction / self.planned_risk)

    @property
    def is_active(self) -> bool:
        return self.status in (Status.PENDING, Status.OPEN)

    # ----- serialisation (sessions) --------------------------------------
    def to_dict(self) -> dict:
        def ts(value):
            return None if value is None else pd.Timestamp(value).isoformat()

        return {
            "id": self.id,
            "side": self.side.value,
            "order_type": self.order_type.value,
            "stop_loss": self.stop_loss,
            "take_profit": self.take_profit,
            "placed_time": ts(self.placed_time),
            "planned_entry": self.planned_entry,
            "order_price": self.order_price,
            "status": self.status.value,
            "entry_price": self.entry_price,
            "entry_time": ts(self.entry_time),
            "exit_price": self.exit_price,
            "exit_time": ts(self.exit_time),
            "exit_reason": None if self.exit_reason is None else self.exit_reason.value,
            "best_price": self.best_price,
            "worst_price": self.worst_price,
            "tags": self.tags,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Trade":
        def ts(value):
            return None if value is None else pd.Timestamp(value)

        return cls(
            id=int(d["id"]),
            side=Side(d["side"]),
            order_type=OrderType(d["order_type"]),
            stop_loss=float(d["stop_loss"]),
            take_profit=float(d["take_profit"]),
            placed_time=ts(d["placed_time"]),
            planned_entry=float(d["planned_entry"]),
            order_price=d.get("order_price"),
            status=Status(d["status"]),
            entry_price=d.get("entry_price"),
            entry_time=ts(d.get("entry_time")),
            exit_price=d.get("exit_price"),
            exit_time=ts(d.get("exit_time")),
            exit_reason=None if d.get("exit_reason") is None else ExitReason(d["exit_reason"]),
            best_price=d.get("best_price"),
            worst_price=d.get("worst_price"),
            tags=d.get("tags") or {},
        )


class Broker:
    """Holds orders/trades and resolves them candle by candle."""

    def __init__(
        self,
        instrument: Instrument,
        spread_pips: float = 0.0,
        on_close: Optional[Callable[[Trade], None]] = None,
    ):
        self.instrument = instrument
        self.spread = instrument.from_pips(spread_pips)
        self.on_close = on_close
        self.trades: list[Trade] = []
        self._next_id = 1

    # ----- queries --------------------------------------------------------
    @property
    def pending_orders(self) -> list[Trade]:
        return [t for t in self.trades if t.status is Status.PENDING]

    @property
    def open_trades(self) -> list[Trade]:
        return [t for t in self.trades if t.status is Status.OPEN]

    @property
    def closed_trades(self) -> list[Trade]:
        return [t for t in self.trades if t.status is Status.CLOSED]

    def entry_quote(self, side: Side, bid: float) -> float:
        """Price you would get entering now: ask for buys, bid for sells."""
        return bid + self.spread if side is Side.BUY else bid

    def exit_quote(self, side: Side, bid: float) -> float:
        """Price you would get exiting now: bid for buys, ask for sells."""
        return bid if side is Side.BUY else bid + self.spread

    # ----- order entry ----------------------------------------------------
    def market_order(
        self, side: Side, stop_loss: float, take_profit: float, time: pd.Timestamp, bid: float
    ) -> Trade:
        """Queue a market order; it fills at the next candle's open."""
        expected = self.entry_quote(side, bid)
        self._validate(side, expected, stop_loss, take_profit)
        return self._add(Trade(
            id=self._take_id(), side=side, order_type=OrderType.MARKET,
            stop_loss=stop_loss, take_profit=take_profit,
            placed_time=time, planned_entry=expected,
        ))

    def pending_order(
        self, side: Side, price: float, stop_loss: float, take_profit: float,
        time: pd.Timestamp, bid: float,
    ) -> Trade:
        """Place a limit or stop order; the type is inferred from the current price."""
        self._validate(side, price, stop_loss, take_profit)
        quote = self.entry_quote(side, bid)
        if side is Side.BUY:
            order_type = OrderType.LIMIT if price <= quote else OrderType.STOP
        else:
            order_type = OrderType.LIMIT if price >= quote else OrderType.STOP
        return self._add(Trade(
            id=self._take_id(), side=side, order_type=order_type,
            stop_loss=stop_loss, take_profit=take_profit,
            placed_time=time, planned_entry=price, order_price=price,
        ))

    def cancel(self, trade: Trade) -> None:
        if trade.status is not Status.PENDING:
            raise ValueError(f"Trade {trade.id} is {trade.status.value}, only pending orders can be cancelled")
        trade.status = Status.CANCELLED

    def close(self, trade: Trade, time: pd.Timestamp, bid: float,
              reason: ExitReason = ExitReason.MANUAL) -> None:
        """Close an open trade at the current market price."""
        if trade.status is not Status.OPEN:
            raise ValueError(f"Trade {trade.id} is {trade.status.value}, only open trades can be closed")
        self._exit(trade, time, self.exit_quote(trade.side, bid), reason)

    # ----- candle processing ---------------------------------------------
    def process_candle(self, time: pd.Timestamp, o: float, h: float, l: float) -> list[Trade]:
        """Resolve fills and exits for one new candle. Returns trades closed on it."""
        closed: list[Trade] = []
        for trade in self.trades:
            if trade.status is Status.PENDING:
                if not self._try_fill(trade, time, o, h, l):
                    continue
                whole_candle = trade.order_type is OrderType.MARKET
                if whole_candle:
                    self._track_excursion(trade, h, l)
                if self._check_exit(trade, time, o, h, l, allow_tp=whole_candle, fill_candle=not whole_candle):
                    closed.append(trade)
            elif trade.status is Status.OPEN:
                self._track_excursion(trade, h, l)
                if self._check_exit(trade, time, o, h, l, allow_tp=True, fill_candle=False):
                    closed.append(trade)
        return closed

    # ----- internals -----------------------------------------------------
    def _take_id(self) -> int:
        trade_id = self._next_id
        self._next_id += 1
        return trade_id

    def _add(self, trade: Trade) -> Trade:
        self.trades.append(trade)
        return trade

    def restore(self, trades: list[Trade]) -> None:
        self.trades = list(trades)
        self._next_id = max((t.id for t in trades), default=0) + 1

    @staticmethod
    def _validate(side: Side, entry: float, stop_loss: float, take_profit: float) -> None:
        if side is Side.BUY and not (stop_loss < entry < take_profit):
            raise InvalidOrder(
                f"BUY needs stop loss < entry < take profit (got SL {stop_loss:.5f}, "
                f"entry {entry:.5f}, TP {take_profit:.5f})")
        if side is Side.SELL and not (take_profit < entry < stop_loss):
            raise InvalidOrder(
                f"SELL needs take profit < entry < stop loss (got TP {take_profit:.5f}, "
                f"entry {entry:.5f}, SL {stop_loss:.5f})")

    def _try_fill(self, trade: Trade, time, o: float, h: float, l: float) -> bool:
        s = self.spread
        if trade.side is Side.BUY:  # buys fill at the ask
            o, h, l = o + s, h + s, l + s
        price = trade.order_price
        fill: Optional[float] = None
        trade.tags.pop("filled_at_open", None)

        if trade.order_type is OrderType.MARKET:
            fill = o
        elif trade.side is Side.BUY and trade.order_type is OrderType.LIMIT and l <= price:
            fill = min(price, o)
        elif trade.side is Side.BUY and trade.order_type is OrderType.STOP and h >= price:
            fill = max(price, o)
        elif trade.side is Side.SELL and trade.order_type is OrderType.LIMIT and h >= price:
            fill = max(price, o)
        elif trade.side is Side.SELL and trade.order_type is OrderType.STOP and l <= price:
            fill = min(price, o)

        if fill is None:
            return False
        trade.status = Status.OPEN
        trade.entry_price = fill
        trade.entry_time = time
        trade.best_price = trade.worst_price = fill
        if fill == o:
            trade.tags["filled_at_open"] = True
        return True

    def _track_excursion(self, trade: Trade, h: float, l: float) -> None:
        # Excursions are measured on the exit-side quote and capped at SL / TP,
        # because the trade no longer exists beyond those levels.
        h, l = self.exit_quote(trade.side, h), self.exit_quote(trade.side, l)
        if trade.side is Side.BUY:
            trade.best_price = max(trade.best_price, min(h, trade.take_profit))
            trade.worst_price = min(trade.worst_price, max(l, trade.stop_loss))
        else:
            trade.best_price = min(trade.best_price, max(l, trade.take_profit))
            trade.worst_price = max(trade.worst_price, min(h, trade.stop_loss))

    def _check_exit(self, trade: Trade, time, o: float, h: float, l: float,
                    allow_tp: bool, fill_candle: bool) -> bool:
        o, h, l = (self.exit_quote(trade.side, p) for p in (o, h, l))
        # A gap through a level only fills at the open if the trade existed at the open.
        gap_ok = not fill_candle or trade.tags.get("filled_at_open", False)

        if trade.side is Side.BUY:
            if l <= trade.stop_loss:
                price = min(trade.stop_loss, o) if gap_ok else trade.stop_loss
                self._exit(trade, time, price, ExitReason.STOP_LOSS)
                return True
            if allow_tp and h >= trade.take_profit:
                self._exit(trade, time, max(trade.take_profit, o), ExitReason.TAKE_PROFIT)
                return True
        else:
            if h >= trade.stop_loss:
                price = max(trade.stop_loss, o) if gap_ok else trade.stop_loss
                self._exit(trade, time, price, ExitReason.STOP_LOSS)
                return True
            if allow_tp and l <= trade.take_profit:
                self._exit(trade, time, min(trade.take_profit, o), ExitReason.TAKE_PROFIT)
                return True
        return False

    def _exit(self, trade: Trade, time, price: float, reason: ExitReason) -> None:
        trade.status = Status.CLOSED
        trade.exit_price = price
        trade.exit_time = time
        trade.exit_reason = reason
        trade.tags.pop("filled_at_open", None)
        # Make sure the excursion reflects the actual exit (e.g. a gap past the stop).
        if trade.best_price is not None:
            if trade.side is Side.BUY:
                trade.best_price = max(trade.best_price, price)
                trade.worst_price = min(trade.worst_price, price)
            else:
                trade.best_price = min(trade.best_price, price)
                trade.worst_price = max(trade.worst_price, price)
        if self.on_close:
            self.on_close(trade)
