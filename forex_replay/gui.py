"""Interactive bar-replay window (matplotlib)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from pathlib import Path
from typing import Optional

import matplotlib.pyplot as plt
import pandas as pd

from . import chart
from .broker import Broker, InvalidOrder, Side, Trade
from .config import Instrument
from .drawings import Drawings
from .journal import TradeJournal, load_journal
from .persistence import SessionState, load_session, save_session
from .replay import ReplayEngine
from .stats import format_report

KEY_HELP = """\
Controls
  Right / Left   next / previous candle        Space   play / pause
  Up / Down      faster / slower playback      End     back to the live candle
  B / N          new BUY / SELL order: click entry (limit/stop) or press Enter
                 for market, then click stop loss, then take profit
  Esc            cancel the current action     C       close latest open trade
  X              cancel latest pending order   T       list active trades
  O              statistics                    I       info for hovered candle
  L              trendline (two clicks)        H       horizontal line (one click)
  Backspace      delete last drawing           Delete  clear all drawings
  F5 / F9        save / load session           ?       show this help
"""

APP_KEYS = {"right", "left", "up", "down", "end", " ", "b", "n", "enter", "escape", "c", "x",
            "t", "o", "i", "l", "h", "backspace", "delete", "f5", "f9", "?"}


class Mode(Enum):
    IDLE = auto()
    ORDER = auto()
    TRENDLINE = auto()
    HLINE = auto()


@dataclass
class OrderDraft:
    side: Side
    entry: Optional[float] = None  # None = market order
    market: bool = False
    stop_loss: Optional[float] = None

    @property
    def step(self) -> str:
        if self.entry is None and not self.market:
            return "entry"
        return "stop loss" if self.stop_loss is None else "take profit"


def _free_app_keys_from_matplotlib() -> None:
    """Matplotlib binds keys like 'l' (log scale), 'c' and arrows (view history)
    by default; remove those so they only do what this app says they do."""
    for name in list(plt.rcParams):
        if name.startswith("keymap."):
            plt.rcParams[name] = [k for k in plt.rcParams[name] if k not in APP_KEYS]


class ReplayApp:
    def __init__(
        self,
        candles: pd.DataFrame,
        instrument: Instrument,
        journal_dir: str | Path,
        start=None,
        spread_pips: float = 0.0,
        window: int = 100,
        speed_ms: int = 200,
        risk_pct: float = 1.0,
    ):
        self.candles = candles
        self.instrument = instrument
        self.journal_dir = Path(journal_dir)
        self.trades_path = self.journal_dir / "trades.csv"
        self.session_path = self.journal_dir / "session.json"
        self.risk_pct = risk_pct

        self.run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.journal = TradeJournal(self.trades_path, instrument, self.run_id)
        self.broker = Broker(instrument, spread_pips, on_close=self._on_trade_closed)
        self.engine = ReplayEngine(candles, start_index=window, window=window)
        if start is not None:
            self.engine.jump_to(start)
        self.drawings = Drawings()

        self._opens = candles["open"].to_numpy()
        self._highs = candles["high"].to_numpy()
        self._lows = candles["low"].to_numpy()

        self.mode = Mode.IDLE
        self.draft: Optional[OrderDraft] = None
        self.line_start: Optional[tuple[pd.Timestamp, float]] = None
        self.hovered_index: Optional[int] = None
        self.playing = False
        self.speed_ms = speed_ms
        self.message = "Press ? for controls"

        _free_app_keys_from_matplotlib()
        self.fig = plt.figure(figsize=(12, 7))
        self.fig.patch.set_facecolor(chart.THEME["background"])
        grid = self.fig.add_gridspec(2, 1, height_ratios=[4, 1], hspace=0.05)
        self.ax_price = self.fig.add_subplot(grid[0])
        self.ax_volume = self.fig.add_subplot(grid[1], sharex=self.ax_price)
        self.fig.subplots_adjust(left=0.05, right=0.93, top=0.93, bottom=0.08)

        self.fig.canvas.mpl_connect("key_press_event", self.on_key)
        self.fig.canvas.mpl_connect("button_press_event", self.on_click)
        self.fig.canvas.mpl_connect("motion_notify_event", self.on_move)
        self.timer = self.fig.canvas.new_timer(interval=self.speed_ms)
        self.timer.add_callback(self._on_timer)

        self.render()

    # ------------------------------------------------------------------ run
    def run(self) -> None:
        print(KEY_HELP)
        plt.show()

    # --------------------------------------------------------------- replay
    def step_forward(self) -> None:
        idx = self.engine.step_forward()
        if idx is not None:
            self.broker.process_candle(self.candles.index[idx], self._opens[idx],
                                       self._highs[idx], self._lows[idx])
        if self.engine.current >= len(self.candles):
            self._set_playing(False)
            self.message = "End of data."

    def _on_timer(self) -> None:
        self.step_forward()
        self.render()

    def _set_playing(self, playing: bool) -> None:
        self.playing = playing
        if playing:
            self.timer.start()
        else:
            self.timer.stop()

    # --------------------------------------------------------------- trades
    def _on_trade_closed(self, trade: Trade) -> None:
        self.journal.log(trade)
        text = (f"#{trade.id} {trade.side.value} closed by {trade.exit_reason.value}: "
                f"{trade.result_r:+.2f}R (MFE {trade.mfe_r:.2f}R)")
        print(text)
        self.message = text

    def _require_live_edge(self) -> bool:
        if not self.engine.at_live_edge:
            self.message = "You're looking at history. Press End to return to the live candle to trade."
            return False
        return True

    def _submit_draft(self, take_profit: float) -> None:
        draft, self.draft, self.mode = self.draft, None, Mode.IDLE
        bid = float(self.engine.last_candle["close"])
        time = self.engine.last_time
        try:
            if draft.market:
                trade = self.broker.market_order(draft.side, draft.stop_loss, take_profit, time, bid)
            else:
                trade = self.broker.pending_order(draft.side, draft.entry, draft.stop_loss,
                                                  take_profit, time, bid)
        except InvalidOrder as err:
            self.message = f"Order rejected: {err}"
            print(self.message)
            return
        risk_pips = self.instrument.to_pips(trade.planned_risk)
        self.message = (f"#{trade.id} {trade.side.value} {trade.order_type.value} placed | "
                        f"risk {risk_pips:.1f} pips | target {trade.planned_reward_r:.2f}R")
        print(self.message)

    def close_latest_trade(self) -> None:
        if not self._require_live_edge():
            return
        open_trades = self.broker.open_trades
        if not open_trades:
            self.message = "No open trades."
            return
        self.broker.close(open_trades[-1], self.engine.last_time,
                          float(self.engine.last_candle["close"]))

    def cancel_latest_order(self) -> None:
        pending = self.broker.pending_orders
        if not pending:
            self.message = "No pending orders."
            return
        self.broker.cancel(pending[-1])
        self.message = f"Order #{pending[-1].id} cancelled."

    def print_active_trades(self) -> None:
        active = [t for t in self.broker.trades if t.is_active]
        print("\n========== ACTIVE TRADES ==========")
        if not active:
            print("None.")
        for t in active:
            entry = t.entry_price if t.entry_price is not None else t.planned_entry
            print(f"#{t.id} {t.status.value:<7} {t.side.value:<4} {t.order_type.value:<6} "
                  f"entry {entry:.5f} | SL {t.stop_loss:.5f} | TP {t.take_profit:.5f}")
        print("===================================\n")

    def print_statistics(self) -> None:
        print()
        print(format_report(load_journal(self.trades_path), self.risk_pct))
        print()

    def print_hovered_candle(self) -> None:
        if self.hovered_index is None:
            self.message = "Move the mouse over a candle first."
            return
        c = self.candles.iloc[self.hovered_index]
        body = self.instrument.to_pips(abs(c["close"] - c["open"]))
        rng = self.instrument.to_pips(c["high"] - c["low"])
        direction = "Bullish" if c["close"] >= c["open"] else "Bearish"
        print(f"\n{self.candles.index[self.hovered_index]} {direction} | O {c['open']:.5f} "
              f"H {c['high']:.5f} L {c['low']:.5f} C {c['close']:.5f} | body {body:.1f} pips | "
              f"range {rng:.1f} pips | volume {int(c['volume'])}\n")

    # -------------------------------------------------------------- session
    def save(self) -> None:
        save_session(self.session_path, SessionState(
            run_id=self.run_id, current=self.engine.current, furthest=self.engine.furthest,
            trades=self.broker.trades, drawings=self.drawings))
        self.message = f"Session saved to {self.session_path}"

    def load(self) -> None:
        if not self.session_path.exists():
            self.message = "No saved session for this journal yet (F5 saves one)."
            return
        state = load_session(self.session_path)
        self.run_id = state.run_id
        self.journal = TradeJournal(self.trades_path, self.instrument, self.run_id)
        self.engine.restore(state.current, state.furthest)
        self.broker.restore(state.trades)
        self.drawings = state.drawings
        self.mode, self.draft, self.line_start = Mode.IDLE, None, None
        self.message = f"Session loaded ({len(state.trades)} trades)."

    # --------------------------------------------------------------- events
    def _event_to_candle(self, event) -> Optional[int]:
        if event.inaxes not in (self.ax_price, self.ax_volume) or event.xdata is None:
            return None
        start, window = self.engine.visible()
        idx = int(round(event.xdata))
        return min(max(idx, start), start + len(window) - 1)

    def on_move(self, event) -> None:
        self.hovered_index = self._event_to_candle(event)

    def on_click(self, event) -> None:
        toolbar = getattr(self.fig.canvas, "toolbar", None)
        if toolbar is not None and getattr(toolbar, "mode", ""):
            return  # zoom / pan tool is active
        if event.inaxes is not self.ax_price or event.ydata is None:
            return
        price = round(float(event.ydata), self.instrument.digits)

        if self.mode is Mode.HLINE:
            self.drawings.add_hline(price)
            self.mode = Mode.IDLE
            self.message = f"Horizontal line at {price:.5f}"
        elif self.mode is Mode.TRENDLINE:
            point = (self.candles.index[self._event_to_candle(event)], price)
            if self.line_start is None:
                self.line_start = point
                self.message = "Trendline: click the second point."
            else:
                self.drawings.add_trendline(*self.line_start, *point)
                self.line_start, self.mode = None, Mode.IDLE
                self.message = "Trendline added."
        elif self.mode is Mode.ORDER and self.draft is not None:
            if self.draft.step == "entry":
                self.draft.entry = price
                self.message = f"{self.draft.side.value} entry {price:.5f}. Click stop loss."
            elif self.draft.step == "stop loss":
                self.draft.stop_loss = price
                self.message = f"Stop loss {price:.5f}. Click take profit."
            else:
                self._submit_draft(price)
        self.render()

    def on_key(self, event) -> None:
        key = event.key
        if key not in APP_KEYS:
            return
        if key == "right":
            self.step_forward()
        elif key == "left":
            self.engine.step_back()
        elif key == "end":
            self.engine.go_to_live_edge()
        elif key == " ":
            self._set_playing(not self.playing)
            self.message = "Playing." if self.playing else "Paused."
        elif key in ("up", "down"):
            factor = 0.5 if key == "up" else 2
            self.speed_ms = int(min(2000, max(25, self.speed_ms * factor)))
            self.timer.interval = self.speed_ms
            self.message = f"Playback speed: one candle every {self.speed_ms} ms"
        elif key in ("b", "n"):
            if self._require_live_edge():
                side = Side.BUY if key == "b" else Side.SELL
                self.mode, self.draft = Mode.ORDER, OrderDraft(side)
                self.message = f"{side.value}: click entry price (limit/stop) or press Enter for market."
        elif key == "enter":
            if self.mode is Mode.ORDER and self.draft is not None and self.draft.step == "entry":
                self.draft.market = True
                self.message = f"{self.draft.side.value} at market (fills next candle open). Click stop loss."
        elif key == "escape":
            self.mode, self.draft, self.line_start = Mode.IDLE, None, None
            self.message = "Cancelled."
        elif key == "c":
            self.close_latest_trade()
        elif key == "x":
            self.cancel_latest_order()
        elif key == "t":
            self.print_active_trades()
        elif key == "o":
            self.print_statistics()
        elif key == "i":
            self.print_hovered_candle()
        elif key == "l":
            self.mode, self.line_start = Mode.TRENDLINE, None
            self.message = "Trendline: click the first point."
        elif key == "h":
            self.mode = Mode.HLINE
            self.message = "Horizontal line: click a price."
        elif key == "backspace":
            self.message = "Last drawing deleted." if self.drawings.delete_last() else "No drawings."
        elif key == "delete":
            self.drawings.clear()
            self.message = "All drawings cleared."
        elif key == "f5":
            self.save()
        elif key == "f9":
            self.load()
        elif key == "?":
            print(KEY_HELP)
        self.render()

    # -------------------------------------------------------------- drawing
    def _status_lines(self) -> tuple[str, str]:
        last = self.engine.last_candle
        closed = self.broker.closed_trades
        total_r = sum(t.result_r for t in closed)
        head = (f"{self.instrument.symbol} {self.instrument.timeframe}   {self.engine.last_time:%a %d %b %Y %H:%M}   "
                f"O {last['open']:.5f}  H {last['high']:.5f}  L {last['low']:.5f}  C {last['close']:.5f}")
        account = (f"Open {len(self.broker.open_trades)}  Pending {len(self.broker.pending_orders)}  "
                   f"Closed {len(closed)}  This run {total_r:+.2f}R")
        if not self.engine.at_live_edge:
            account += f"   |   VIEWING HISTORY ({self.engine.furthest - self.engine.current} candles back)"
        return head, account

    def render(self) -> None:
        ax_p, ax_v = self.ax_price, self.ax_volume
        ax_p.clear()
        ax_v.clear()
        chart.style_axes(ax_p)
        chart.style_axes(ax_v)

        start, window = self.engine.visible()
        chart.draw_candles(ax_p, ax_v, window, start)
        right_edge = chart.set_view(ax_p, ax_v, window, start, chart.trade_levels(self.broker.trades))
        chart.draw_drawings(ax_p, self.candles, self.drawings)
        chart.draw_trades(ax_p, self.candles, self.broker.trades, start, right_edge)
        chart.time_axis(ax_v, self.candles)
        plt.setp(ax_p.get_xticklabels(), visible=False)
        ax_p.yaxis.tick_right()
        ax_v.yaxis.tick_right()

        head, account = self._status_lines()
        ax_p.set_title(head, color=chart.THEME["text"], fontsize=10, loc="left")
        box = {"facecolor": chart.THEME["background"], "alpha": 0.85, "edgecolor": "none", "pad": 3}
        ax_p.text(0.005, 0.985, account, transform=ax_p.transAxes, va="top", fontsize=9,
                  color=chart.THEME["text"], zorder=10, bbox=box)
        ax_p.text(0.005, 0.935, self.message, transform=ax_p.transAxes, va="top", fontsize=9,
                  color=chart.THEME["muted"], zorder=10, bbox=box)
        self.fig.canvas.draw_idle()
