# 0029: Bollinger Bands

- **Date:** 4 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("add bollinger bands indicator"), with Claude on the definition and defaults

## The definition

TradingView's, so the bands match what you see there:

- **Basis:** the SMA of the last N closes. It is the same number the SMA line gives.
- **Upper and lower:** basis ± k × the standard deviation of those same N closes.
- **Which standard deviation:** the **population** one, dividing by N, not N − 1. That is TradingView's default for Bollinger Bands, and John Bollinger's own.
- **Defaults:** period 20 and 2 standard deviations, Bollinger's standard settings. The period can be 2 to 500, and the standard deviations 0.1 to 10 in steps of 0.1.

## How it is built

The same way as the other indicators:

- **Two writings:** it is written once in JavaScript (`indicators.js` `bollinger`) and once in plain Python (`indicator_golden.py`). A test requires the same numbers on 900 candles, for 20 / 2 and 10 / 1.5.
- **Accuracy:** the standard deviation is worked out in two passes (first the mean, then the squared differences). A running sum of squares would lose accuracy on prices in points, which are numbers around 110,000.
- **Replays:** the step-by-step engine reuses the same one-candle function, and the replay test checks it against the full calculation with Bollinger on. During a replay the bands use only candles that have been revealed, and the forming candle's values move as it forms, like every other indicator.

## Not yet done

- The space between the bands is not shaded: the chart library has no fill between two lines.
- There is no %B or bandwidth.
