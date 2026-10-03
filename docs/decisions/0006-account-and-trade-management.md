# 0006: Money lives in an account layer; the engine stays in prices and R

- **Date:** 3 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants balance in $, sizing from risk %, partial close, breakeven and draggable stops, as on TradingView and FX Replay), with Claude on the design

## Two layers

| Layer | File | Knows about | Proven by |
|---|---|---|---|
| Engine | `web/js/broker.js` (and `forex_replay/broker.py`) | prices in points, fills, stops, targets, R | recorded scenarios from the Python engine |
| Account | `web/js/account.js` | lots, dollars, commission, balance, equity | its own unit tests |

The engine never sees a dollar. It reports how many points a trade made and what fraction of it was closed where; the account multiplies that by the lot size. So the fill rules stay small enough to prove against Python, and the money rules can be read and changed without touching them.

## What the engine gained

Three things had to go into the engine, because they change which candle closes a trade and at what R:

1. **A frozen first stop.** R is measured against the stop the trade had when it opened (`initialStop`). Moving the stop to breakeven or trailing it does not change what 1R means. Without this, a trade at breakeven would have zero risk and its R would be a division by zero.
2. **Moving levels.** The stop loss, take profit and (for limit and stop orders) the entry can be moved. An open trade's stop must stay on the losing side of the current price and its target on the winning side. A pending order's plan can change freely, so its risk changes with it. A change takes effect from the next candle.
3. **Partial close.** Part of an open trade is closed at the current price. The trade's R is the size-weighted average of all its parts: half closed at +1R and half at +3R is +2R.

All three were written in Python first and then in JavaScript. The recorded scenarios were regenerated to include them: 120 scenarios, 2,079 trades, 547 accepted moves, 353 refused moves and 146 partial closes. The JavaScript engine matches all of them.

## Money rules

- EURUSD on a US-dollar account: 1 lot is 100,000 units, so a pip is $10 per lot.
- Sizes are whole numbers of 0.01 lots, stored as integers, so they never pick up rounding errors.
- **Size from risk is rounded down.** 1% of $10,000 over a 13-pip stop is 0.769 lots; the app uses 0.76, not 0.77, so the loss at the stop is never more than you asked for. If even 0.01 lots would risk more, the order is refused with the reason.
- Risk % is taken from the **balance** (closed results), not from equity.
- **Commission** is a round-turn charge per lot, taken in full when the trade opens. It is not part of the risk used for sizing: a full stop-out costs the risk plus the commission. An order that never fills pays nothing. The rate is fixed when the order is placed.
- R in the lists is the price result, before commission. Dollars are after commission. A small winner can therefore show a positive R and a negative dollar result.
- A pending order sized from risk % is **re-sized when its stop or entry is moved**, so it still risks that %. An open trade keeps its size.
- Margin and leverage are not modelled.

## Defaults that are assumptions

Starting balance $10,000, risk 1%, commission $7 per lot, minimum spread 0. The MT5 export records a spread of 0 on about 95% of candles, which looks like a raw-spread account, and those normally charge commission; $7 is a common figure, not Jeevesh's broker's actual rate. All four are settings in the app and should be set to the real account.

**Update, same day:** Jeevesh gave his broker's commission as $4 per lot. That is now the default, and a saved setting that still held the guessed $7 is replaced with it.

## Dragging lines

The chart library has no draggable lines. `web/js/chart.js` watches the mouse itself: within 5 pixels of a stop-loss, take-profit or pending-entry line, a press starts a drag and stops the chart from panning. On release the new price goes through the same `modifyTrade` call as everything else, so a drag can never do something the engine would refuse; a refused drag snaps back with the reason. Lines can be dragged only while the replay is live.

The price scale now stretches to keep the lines of active trades on screen, unless a line is more than 1.5 times the visible candle range away.

## Not yet done

Typing a new stop or target for an open trade (dragging and breakeven cover it for now), trailing stops, margin, and saving trades to the journal (day 7).
