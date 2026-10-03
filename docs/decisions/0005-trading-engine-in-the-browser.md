# 0005: The trading engine runs in the browser, proven against the Python engine

- **Date:** 2 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (fills must be realistic and impossible to cheat; sessions must be his to configure), with Claude on the design

## Why port the engine instead of calling Python

The replay runs in the browser. If every candle had to go to Python and back to resolve orders, playing at 100 candles a second would stutter, and a hosted version would need a server per user. So the engine from `forex_replay/broker.py` was ported to `web/js/broker.js`, rule for rule.

## The risk of a port, and how it is controlled

Two implementations of the same rules can drift apart without anyone noticing. To prevent that:

1. `forex_replay/golden.py` runs 100 random scenarios through the **Python** engine: random-walk candles with gaps, market, limit and stop orders, invalid orders, manual closes and cancels, with spreads of 0 to 15 points. It records every order and all 2,535 resulting trades in `web/tests/fixtures/broker_golden.json`.
2. A JavaScript test replays the same scenarios and requires **identical** results: which orders are rejected, every fill price and candle, every exit price, candle and reason, the order in which trades close, and R, MFE and MAE.
3. A Python test re-runs the Python engine over the recorded scenarios, so the fixture cannot go stale if `broker.py` changes.

The port matched on the first run. Both engines work in whole points (1.08500 → 108500), so there is no floating-point disagreement to explain away.

## Execution rules (unchanged from v1)

- An order is never evaluated on the candle it was placed on. A market order fills at the next candle's open.
- Limit and stop orders fill when a later candle trades through the price; a gap fills at the open.
- If stop loss and take profit are inside the same candle, the stop loss is assumed first.
- On the candle a limit or stop order fills, only the stop loss can trigger.
- R uses planned risk, so gap slippage shows up as a loss worse than −1R.

## What is new in v2

- **Fills are resolved on M5 candles whatever timeframe is on screen.** The replay clock reports each M5 candle the first time it is revealed (`ReplayClock.onReveal`), and `web/js/trading.js` feeds them to the engine once, in order. Stepping one H1 candle processes its twelve M5 candles one by one.
- **Orders are accepted only when the replay is live.** While looking back at history the ticket is disabled, so a trade cannot be entered on a move already watched.
- **Spread per candle.** The MT5 export records the broker's spread for every candle. The engine uses the wider of that and a minimum spread you set.
- **Starting a replay starts a new run.** Leaving a replay with trades open asks for a second click, then closes them at the current price and cancels pending orders.

## Sessions are settings, not code

The session list (name, timezone, start, end, colour, on/off) is edited in the app and saved in the browser. Two presets ship: standard sessions and ICT killzones. Each row shows its hours in India time for the date being viewed, so the effect of a timezone choice is visible before saving.

## Update, 3 Oct 2026

Day 5 added moving stops, partial closes and a frozen first stop to both engines, and regenerated the recorded scenarios (now 120 scenarios, 2,079 trades). See [decision 0006](0006-account-and-trade-management.md).

## Not yet done

Account balance in $, lot sizing from risk %, partial close, breakeven and dragging lines on the chart came on day 5. Since day 7, trades are saved with their backtest and written to the journal ([0008](0008-backtests-saved-as-actions.md)).
