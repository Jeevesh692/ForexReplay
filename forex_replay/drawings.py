"""Chart drawings anchored to candle timestamps (so they survive scrolling)."""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd


@dataclass
class Drawings:
    items: list[dict] = field(default_factory=list)

    def add_trendline(self, t1, p1: float, t2, p2: float) -> None:
        self.items.append({"kind": "trend", "t1": pd.Timestamp(t1).isoformat(), "p1": float(p1),
                           "t2": pd.Timestamp(t2).isoformat(), "p2": float(p2)})

    def add_hline(self, price: float) -> None:
        self.items.append({"kind": "hline", "price": float(price)})

    def delete_last(self) -> bool:
        if not self.items:
            return False
        self.items.pop()
        return True

    def clear(self) -> None:
        self.items.clear()

    @property
    def trendlines(self) -> list[dict]:
        return [d for d in self.items if d["kind"] == "trend"]

    @property
    def hlines(self) -> list[float]:
        return [d["price"] for d in self.items if d["kind"] == "hline"]

    def to_list(self) -> list[dict]:
        return list(self.items)

    @classmethod
    def from_list(cls, items: list[dict]) -> "Drawings":
        return cls(items=list(items or []))
