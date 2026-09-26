"""Automated strategies for ``python -m forex_replay backtest``."""

from .asian_breakout import AsianBreakout, AsianBreakoutParams

STRATEGIES = {
    AsianBreakout.name: AsianBreakout,
}

__all__ = ["AsianBreakout", "AsianBreakoutParams", "STRATEGIES"]
