"""Candlestick chart rendering with plain matplotlib.

Everything is drawn in "candle index" x-coordinates (candle i sits at x = i),
so drawings and trades line up exactly with the candles and weekend gaps don't
leave holes in the chart.
"""

from __future__ import annotations

from typing import Iterable

import numpy as np
import pandas as pd
from matplotlib.axes import Axes
from matplotlib.patches import Rectangle
from matplotlib.ticker import FuncFormatter, MaxNLocator

from .broker import Status, Trade
from .drawings import Drawings

THEME = {
    "background": "#1e1e1e",
    "grid": "#333333",
    "spine": "#666666",
    "text": "#e0e0e0",
    "muted": "#9e9e9e",
    "up": "#26a69a",
    "down": "#ef5350",
    "entry": "#e0e0e0",
    "pending": "#ffb74d",
    "trendline": "#ffeb3b",
    "hline": "#4dd0e1",
}
RIGHT_MARGIN = 8  # empty candles of space to the right of the last candle


def style_axes(ax: Axes) -> None:
    ax.set_facecolor(THEME["background"])
    ax.grid(True, color=THEME["grid"], linestyle="--", linewidth=0.6)
    ax.set_axisbelow(True)
    ax.tick_params(colors=THEME["text"], labelsize=9)
    for spine in ax.spines.values():
        spine.set_color(THEME["spine"])


def draw_candles(ax_price: Axes, ax_volume: Axes, window: pd.DataFrame, start: int) -> None:
    if window.empty:
        return
    x = np.arange(start, start + len(window))
    o, h, l, c = (window[col].to_numpy() for col in ("open", "high", "low", "close"))
    colors = np.where(c >= o, THEME["up"], THEME["down"])

    ax_price.vlines(x, l, h, colors=colors, linewidth=0.9, zorder=2)
    body_low = np.minimum(o, c)
    body_height = np.maximum(np.abs(c - o), (h.max() - l.min()) * 0.0015)  # dojis stay visible
    ax_price.bar(x, body_height, bottom=body_low, width=0.65, color=colors,
                 edgecolor=colors, linewidth=0.5, zorder=3)
    ax_volume.bar(x, window["volume"].to_numpy(), width=0.65, color=colors, alpha=0.7)


def time_axis(ax: Axes, candles: pd.DataFrame) -> None:
    index = candles.index

    def label(x, _pos):
        i = int(round(x))
        if 0 <= i < len(index):
            return index[i].strftime("%d %b\n%H:%M")
        return ""

    ax.xaxis.set_major_locator(MaxNLocator(nbins=10, integer=True))
    ax.xaxis.set_major_formatter(FuncFormatter(label))


def _x_of(candles: pd.DataFrame, when) -> float | None:
    if when is None:
        return None
    pos = candles.index.get_indexer([pd.Timestamp(when)])[0]
    return None if pos < 0 else float(pos)


def draw_drawings(ax: Axes, candles: pd.DataFrame, drawings: Drawings) -> None:
    for d in drawings.trendlines:
        x1, x2 = _x_of(candles, d["t1"]), _x_of(candles, d["t2"])
        if x1 is not None and x2 is not None:
            ax.plot([x1, x2], [d["p1"], d["p2"]], color=THEME["trendline"], linewidth=1.8, zorder=4)
    for price in drawings.hlines:
        ax.axhline(price, color=THEME["hline"], linewidth=1.2, linestyle="--", zorder=4)


def trade_levels(trades: Iterable[Trade]) -> list[float]:
    """Price levels of active trades, used so the y-axis keeps them in view."""
    levels: list[float] = []
    for t in trades:
        if t.is_active:
            levels += [t.planned_entry, t.stop_loss, t.take_profit]
    return levels


def draw_trades(ax: Axes, candles: pd.DataFrame, trades: Iterable[Trade],
                visible_start: int, right_edge: float) -> None:
    for t in trades:
        if t.status is Status.CANCELLED:
            continue
        label = f"#{t.id} {t.side.value} {t.order_type.value}"

        if t.status is Status.PENDING:
            x0 = _x_of(candles, t.placed_time)
            x0 = max(x0 if x0 is not None else visible_start, visible_start - 0.5)
            ax.hlines(t.planned_entry, x0, right_edge, colors=THEME["pending"], linestyles=":", linewidth=1.5, zorder=5)
            ax.hlines(t.stop_loss, x0, right_edge, colors=THEME["down"], linestyles="--", linewidth=1, zorder=5)
            ax.hlines(t.take_profit, x0, right_edge, colors=THEME["up"], linestyles="--", linewidth=1, zorder=5)
            ax.text(right_edge, t.planned_entry, f" {label}", color=THEME["pending"], fontsize=8,
                    va="center", ha="right", zorder=6)
            continue

        x0 = _x_of(candles, t.entry_time)
        if x0 is None:
            continue
        if t.status is Status.OPEN:
            x1, alpha = right_edge, 0.18
        else:
            x1, alpha = _x_of(candles, t.exit_time), 0.10
            if x1 is None or x1 < visible_start:
                continue
            x1 = max(x1, x0 + 1)

        entry = t.entry_price
        ax.add_patch(Rectangle((x0, min(entry, t.stop_loss)), x1 - x0, abs(entry - t.stop_loss),
                               facecolor=THEME["down"], alpha=alpha, edgecolor="none", zorder=1))
        ax.add_patch(Rectangle((x0, min(entry, t.take_profit)), x1 - x0, abs(t.take_profit - entry),
                               facecolor=THEME["up"], alpha=alpha, edgecolor="none", zorder=1))
        ax.hlines(entry, x0, x1, colors=THEME["entry"], linewidth=1.2, zorder=5)

        if t.status is Status.OPEN:
            ax.text(right_edge, entry, f" {label}", color=THEME["entry"], fontsize=8,
                    va="center", ha="right", zorder=6)
        else:
            won = (t.result_r or 0) > 0
            ax.plot([x0, x1], [entry, t.exit_price], color=THEME["up" if won else "down"],
                    linewidth=1.2, linestyle=":", zorder=5)
            ax.plot([x1], [t.exit_price], marker="o", markersize=4,
                    color=THEME["up" if won else "down"], zorder=6)
            ax.text(x1, t.exit_price, f" {t.result_r:+.2f}R", color=THEME["text"], fontsize=8,
                    va="bottom", zorder=6)


def set_view(ax_price: Axes, ax_volume: Axes, window: pd.DataFrame, start: int,
             extra_levels: list[float]) -> float:
    """Set axis limits; returns the x coordinate of the right edge."""
    right_edge = start + len(window) - 0.5 + RIGHT_MARGIN
    ax_price.set_xlim(start - 0.5, right_edge)
    lows = [window["low"].min(), *extra_levels]
    highs = [window["high"].max(), *extra_levels]
    lo, hi = min(lows), max(highs)
    pad = (hi - lo) * 0.06 or 0.0005
    ax_price.set_ylim(lo - pad, hi + pad)
    ax_volume.set_ylim(0, max(1, window["volume"].max()) * 1.1)
    ax_price.yaxis.set_major_locator(MaxNLocator(12))
    ax_volume.yaxis.set_major_locator(MaxNLocator(3))
    return right_edge
