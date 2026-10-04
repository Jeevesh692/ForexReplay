# 0014: Indicators from revealed candles only, worked out step by step; replay speed measured and fixed

- **Date:** 4 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (asked for basic indicators on day 13 alongside speed and fixes; the set SMA, EMA, RSI, VWAP was proposed and not changed), with Claude on the design and the measurements

## Indicators

| Indicator | Definition | Where |
|---|---|---|
| SMA (20) | mean of the last n closes | on the candles |
| EMA (50) | weight 2 / (n + 1), started from the simple average of the first n closes | on the candles |
| VWAP | typical price (high + low + close) / 3 times volume, over the volume so far that day; starts again at 17:00 New York (the broker's midnight); MT5 tick volume | on the candles |
| RSI (14) | Wilder: first averages are simple averages of n changes, then (previous × (n − 1) + change) / n; no losses gives 100 | own panel under the chart, lines at 70 and 30 |

Periods can be changed (2 to 500). The settings apply to both charts, each on its own timeframe, and are remembered in the browser. The legend shows each indicator's value at the candle under the mouse.

**No look-ahead.** The indicators are worked out from the chart's candles, which during a replay are only those the clock has revealed, plus the forming one (whose value moves until it closes, as on TradingView's replay).

On day 13 the browser check found that SMA, EMA and RSI were reading the full storage behind the replay's candle list, not just its first `length` candles. That storage can still hold candles the clock has hidden, so the lines ran into the future. The calculation now reads only the first `length` candles. The no-look-ahead test now shows everything first and then starts a replay (as the app does), and checks that every line stops at the last revealed candle; with the old code it fails.

**Held to a second writing.** `forex_replay/indicator_golden.py` writes the same four definitions again in plain Python. It records them on 900 random candles across five broker-server days, with some candles of zero volume and a stretch with no losses. `web/tests/indicators.test.mjs` must match every value. Deliberately breaking each of the four in turn made the test fail every time.

**Step by step.** Working all four out again over 21,000 candles on every replay step took about 19 ms. `IndicatorEngine` keeps each indicator's running state per candle (the EMA itself, Wilder's average gain and loss, the day's volume totals) and recomputes only from the first candle that changed. A test plays 400 random replay steps (forward, back, back to live) on M5, M15 and H1 and requires the engine to equal the full calculation after every step.

Colours were checked for colour-blind separation and contrast on the chart background: SMA teal, EMA purple, VWAP amber, RSI blue. Lines on the candles are 1 px so the candles stay readable; RSI is 2 px in its own panel.

## ATR and ADR (v2.0.3)

ATR: Wilder's average true range over n candles of the chart's timeframe, started from the simple average of the first n true ranges, shown in pips in its own panel. ADR: the mean high − low of the last n *completed* broker-server days, never including today, shown in the legend in pips, with optional levels for today (low so far + ADR, high so far − ADR) on intraday charts. Both are held to the plain-Python reference like the others. Trading days are identified by their broker-clock date (`serverDate`), not by a start time in UTC, which differed either side of a US clock change.

## Replay speed

Measured in the in-app browser: the time per M5 candle of the replay, with 40 closed trades, one open trade and 21,000 M15 candles on the chart.

| | ms per candle |
|---|---|
| Before (day 12) | 101 |
| After, one chart | 2.9 (3.9 in a later run) |
| After, two charts | 3.2 |
| After, all four indicators on | 8.7 |

The engine itself took 0.01 ms throughout. The time went to:

1. **The chart library's markers plugin**, which re-indexes every candle on every candle update: about 16 ms with it attached, 0.8 ms without. Markers are now drawn by our own primitive (`TradeMarkers` in `web/js/chart.js`), like the session bands, and only for candles on screen.
2. **Two redraws per candle.** The panel, lines and markers were redrawn once when the engine heard about the candle and again when the clock did. Now all redrawing for one step happens once, right after it (a microtask: before the browser paints, after the step's own work).
3. **The closed-trades list was rebuilt on every candle** (about 7.5 ms with 40 trades). It is rebuilt only when a trade is added or its journal marks or the picked trade change.
4. **Trade lines and markers were deleted and recreated on every candle.** They are now sent to the chart only when they change.

With all four indicators on, most of the remaining time is the chart library updating four more lines (about 2.2 ms per line update on a chart this long). The indicator calculation itself measured 0.01 ms per step.

These are timings of the app's own work per step in a browser window that was not on screen. The browser slows timers in hidden windows, so playing at 100× for real could not be timed here, and the time the browser spends painting is not included.

## Not yet done

More indicators (Bollinger bands, ATR, MACD), indicators with their own settings per chart, and playing the replay at full speed with the window on screen to time it end to end.
