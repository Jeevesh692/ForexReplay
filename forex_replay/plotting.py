"""Static report charts (equity curve, breakdowns) for README / notebook use."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .stats import breakdown, equity_curve

PALETTE = {
    "surface": "#fcfcfb",
    "text": "#0b0b0b",
    "text_secondary": "#52514e",
    "grid": "#e1e0d9",
    "axis": "#c3c2b7",
    "positive": "#2a78d6",  # diverging pair: blue = gain
    "negative": "#e34948",  # red = loss
    "neutral": "#f0efec",
}


def _style(ax) -> None:
    ax.set_facecolor(PALETTE["surface"])
    ax.figure.set_facecolor(PALETTE["surface"])
    ax.grid(True, axis="y", color=PALETTE["grid"], linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(PALETTE["axis"])
    ax.tick_params(colors=PALETTE["text_secondary"], labelsize=9)
    ax.title.set_color(PALETTE["text"])
    ax.xaxis.label.set_color(PALETTE["text_secondary"])
    ax.yaxis.label.set_color(PALETTE["text_secondary"])


def plot_equity(journal: pd.DataFrame, title: str, ax=None):
    """Cumulative R by trade number, with drawdowns shaded."""
    r = journal["result_r"].dropna().astype(float)
    equity = np.concatenate([[0.0], equity_curve(r).to_numpy()])
    peaks = np.maximum.accumulate(equity)
    x = np.arange(len(equity))

    if ax is None:
        _, ax = plt.subplots(figsize=(8, 3.6))
    _style(ax)
    ax.axhline(0, color=PALETTE["axis"], linewidth=1)
    ax.fill_between(x, equity, peaks, where=peaks > equity, color=PALETTE["negative"],
                    alpha=0.15, linewidth=0, label="Drawdown")
    ax.plot(x, equity, color=PALETTE["positive"], linewidth=2, solid_capstyle="round")
    ax.annotate(f"{equity[-1]:+.1f}R", (x[-1], equity[-1]), xytext=(6, 0),
                textcoords="offset points", va="center", fontsize=9, color=PALETTE["text"])
    ax.set_xlim(0, max(1, x[-1]) * 1.06)
    ax.set_title(title, loc="left", fontsize=11)
    ax.set_xlabel("Trade number")
    ax.set_ylabel("Cumulative R")
    return ax


def plot_breakdown(journal: pd.DataFrame, by: str, title: str, ax=None):
    """Expectancy (average R per trade) per group, with trade counts as labels."""
    table = breakdown(journal, by)
    if ax is None:
        _, ax = plt.subplots(figsize=(7, 3.2))
    _style(ax)
    colors = [PALETTE["positive"] if v >= 0 else PALETTE["negative"] for v in table["expectancy_r"]]
    bars = ax.bar(table.index.astype(str), table["expectancy_r"], color=colors, width=0.6)
    ax.axhline(0, color=PALETTE["axis"], linewidth=1)
    for bar, (_, row) in zip(bars, table.iterrows()):
        y = bar.get_height()
        ax.annotate(f"{round(y, 2) + 0.0:+.2f}R  (n={int(row['trades'])})",
                    (bar.get_x() + bar.get_width() / 2, y),
                    xytext=(0, 4 if y >= 0 else -4), textcoords="offset points",
                    ha="center", va="bottom" if y >= 0 else "top", fontsize=8, color=PALETTE["text"])
    lo, hi = min(0.0, table["expectancy_r"].min()), max(0.0, table["expectancy_r"].max())
    pad = (hi - lo) * 0.18 or 0.1
    ax.set_ylim(lo - (pad if lo < 0 else 0), hi + (pad if hi > 0 else 0))
    ax.set_title(title, loc="left", fontsize=11)
    ax.set_ylabel("Expectancy (R per trade)")
    return ax


def save(ax, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ax.figure.tight_layout()
    ax.figure.savefig(path, dpi=130)
    plt.close(ax.figure)
    return path
