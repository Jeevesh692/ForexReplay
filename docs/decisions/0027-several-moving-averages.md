# 0027: Five SMAs and five EMAs on the chart at once

- **Date:** 28 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("I want to do an EMA, SMA crossover strategy, so I need multiple EMA and SMA on my chart with different time periods"), with Claude on how many lines, the colours and the storage

## What changed

Before, the Indicators dialog had one SMA and one EMA ([0014](0014-indicators-and-replay-speed.md)). Now it has **five lines of each**. Every line has its own tick box, period (2 to 500) and colour. They show on both charts, each chart on its own timeframe, and the legend and the price-axis label name every line ("EMA 21"). So two lines in similar colours can still be told apart.

Default periods are the common crossover pairs: SMA 10, 20, 50, 100, 200 and EMA 9, 21, 50, 100, 200. All are off until ticked.

## Why five fixed lines, not "add as many as you like"

A crossover uses two or three lines. Five of each covers a fast/slow pair, a trend filter and spares, and a fixed list keeps the dialog one simple table with nothing to add or delete. If more are ever needed, `MA_LINES` in `web/js/indicators.js` is the only number to change.

## Why a colour picker

Ten lines cannot all be told apart by colour, least of all by someone colour-blind. Letting Jeevesh pick colours means the two lines of a crossover can be made as different as he likes. The defaults are ten different colours, and the labels carry each line's name, so colour is never the only clue.

## Kept the same

- **Settings saved before:** they still load. A single saved SMA or EMA becomes line 1 of its kind, with its period and on/off kept. Line 1 keeps the id it always had (`sma`, `ema`).
- **The definitions:** the SMA and EMA formulas are unchanged, so the Python reference values (`indicator_golden.py`) still apply and were not regenerated.
- **Step by step:** the step-by-step engine now works out any number of lines. Its SMA uses a running sum (add the new close, drop the one N candles back) instead of adding up N closes for every candle. A test checks it against the full calculation through a random replay, with five lines on.

## Not yet done

- Nothing marks or counts the crossovers themselves (an arrow where EMA 9 crosses EMA 21, or a crossover statistic). The lines are for reading the chart by eye; automatic crossover strategies belong to the Strategy Lab plan.
- Line width and style are not settable.
