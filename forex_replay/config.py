"""Instrument settings and project paths."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_FILE = PROJECT_ROOT / "data" / "EURUSD_M5.csv"
JOURNALS_DIR = PROJECT_ROOT / "strategies"
RESULTS_DIR = PROJECT_ROOT / "results"


@dataclass(frozen=True)
class Instrument:
    """Describes the traded symbol so nothing is hardcoded to EURUSD."""

    symbol: str = "EURUSD"
    timeframe: str = "M5"
    pip_size: float = 0.0001
    digits: int = 5

    def to_pips(self, price_distance: float) -> float:
        return price_distance / self.pip_size

    def from_pips(self, pips: float) -> float:
        return pips * self.pip_size


EURUSD_M5 = Instrument()
