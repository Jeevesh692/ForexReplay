# ForexReplay on a CV

Every number here was checked on 4 Oct 2026 against the repository (see the build log). Use only the lines you can explain in an interview: the code was written by Claude, and these bullets are worded around what Jeevesh did.

## One bullet

**ForexReplay** (personal project, 2026) · github.com/Jeevesh692/ForexReplay
- Directed an AI coding agent (Claude) through a 14-day plan to build a TradingView-style forex replay and backtesting app (JavaScript and Python), making the product and trading decisions and reviewing each day's work against a written build log and 14 design records.

## Three bullets

- Specified and directed the build of a browser bar-replay and backtesting app for EURUSD with an AI coding agent: multi-timeframe replay without look-ahead, a broker-accurate fill engine, prop-firm challenge rules, drawings, a trade journal and analytics.
- Kept the browser's trading engine, statistics and indicators identical to their Python originals with recorded comparison tests (2,079 trades, 40 journals, 900 candles); 181 automated tests in all.
- Found by measurement a 35× replay slowdown (101 ms to about 3 ms per candle) and a look-ahead bug in the indicators, both caught by checking the running app rather than trusting the tests.

## In an interview: what to be ready to explain

These are the ideas behind the project; the build log and decision records explain each one.

1. **No look-ahead.** One replay clock; every timeframe derived from it; orders only at the live edge. How the indicator bug broke that rule, and the test that now catches it (day 13).
2. **Fill rules.** Why fills are resolved on M5 candles, why an order never fills on the candle it was placed on, and why the stop is assumed hit first when both levels are inside one candle (decision 0005).
3. **Two engines, one truth.** Why the browser engine is held to the Python one by recorded scenarios rather than by reading the code twice (decision 0005).
4. **Saving a backtest as actions, not state.** Why repeating the actions on the same candles is safer than storing the engine's insides, and how the receipt check catches a changed engine (decision 0008).
5. **Challenge rules at M5 resolution.** Why equity is checked at each candle's worst price (decision 0009).
6. **Measuring before optimising.** How the slow replay was found to be the chart library's markers plugin, not the trading engine (decision 0014).
7. **Working with an AI agent.** What was decided by you versus proposed by Claude: the "Decided by" line of each design record says it.

Each build-log day ends with three questions. Answering them, out loud or in writing, is the quickest way to be ready for the questions above.
