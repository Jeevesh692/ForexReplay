# 0009: Challenge mode checks prop-firm rules on every M5 candle, at its worst prices

- **Date:** 3 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants to rehearse prop-firm challenges: daily loss, maximum loss, profit target), with Claude on the rules and how they are measured

## The rules

| Rule | Passes or fails when | Measured against |
|---|---|---|
| Profit target | PASSED when the balance reaches start + target %, with no trade open | the balance (closed results), so a floating profit does not count |
| Daily loss | FAILED when equity falls more than daily % below the balance the day started with | daily % of the **starting** balance, not of the day's balance |
| Maximum loss | FAILED when equity falls below start - max % | a fixed floor; it does not trail the highest balance |

Presets: 8% target, 10% target, and 5% target (phase 2), each with 5% daily and 10% maximum loss. These are the common two-step model and match the defaults of the v1 report (`prop_firm_check` in `forex_replay/stats.py`). Real firms differ in details (some measure the daily loss from the higher of balance and equity at the day's start, some trail the floor). The rules here are written down in `web/js/challenge.js`, and changing them means changing that one file.

## When a day starts

At the broker server's midnight, which is 17:00 in New York all year. That is the boundary of the D1 candle and of MT5-based prop firms. It is 02:30 or 03:30 India time depending on US daylight saving.

## How it is measured

After the engine has processed each M5 candle, equity is worked out with every open trade at its worst price in that candle: the low for a buy, the high plus the spread for a sell. The order of prices inside a candle is unknown, so this is the conservative assumption, the same reasoning as "stop loss first" in the engine. It can be harsher than reality: a buy and a sell open together are both counted at their worst, which cannot happen at the same moment.

"Below" means strictly below; touching a limit exactly is not a breach. After an action at the live candle (a close, for example) the rules are checked again at the current price, so closing the last trade can bank the target straight away.

## What happens at the end

- **Failed:** every open trade is closed at the close of the candle where the limit broke (exit reason `CHALLENGE_STOP`), pending orders are cancelled, and the run accepts no more orders. A real firm closes at the moment of the breach, which an M5 candle cannot pin down, so the candle's close is used. The result can come out a little better or worse than the limit.
- **Passed:** pending orders are cancelled and the run accepts no more orders.
- Either way the replay pauses there and the panel says why. You can still look back and play on, but not trade.

## Fixed for the length of a run

The rules are chosen before a replay starts and cannot change during it: switching a challenge off after a bad day, or loosening the limit, would make the result meaningless. For the same reason the starting balance cannot change during a challenge. The rules are saved with the backtest ([0008](0008-backtests-saved-as-actions.md)), and the checks run inside the candle processing, so a resumed run fails or passes on the same candle. The rebuild also compares how the challenge ended with what was saved.

## Where the code is

`web/js/challenge.js` holds the rules and the state (day start, worst day, lowest equity, trading days). `web/js/trading.js` feeds it after each candle and after each action. It is a money rule, so it sits next to the account and is not part of the engine; `broker.py` and `broker.js` did not change.

## Not yet done

A trailing maximum loss, a minimum number of trading days, a time limit, a daily loss measured from the higher of balance and equity, a second phase that starts automatically after a pass, and challenge results on the analytics page (day 11).
