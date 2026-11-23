# 0037: Synthetic order flow (order flow, Phase 5)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 5), with Claude on the points the brief left open (marked below)

## What there is

All of it is in the **Order flow** dialog, each item off until chosen:

- **RVOL panel:** each candle's ticks against the same time of day over the last 20 trading days, as bars. They are amber at 3x and over, green at 1.5x and over, grey below.
- **CVD panel:** up ticks minus down ticks, added up, with each candle's delta as bars if wanted.
- **Bubbles:** 15-second bursts with RVOL ≥ 3 that moved price at least 1.5 pips (EURUSD) or $0.50 (gold). They are green up and red down, and sized by RVOL: small 3–5x, medium 5–8x, large 8x and over.
- **Absorption:** bursts with RVOL ≥ 3 that moved price at most 0.3 pip (EURUSD) or $0.10 (gold), drawn as hollow grey circles.
- **CVD divergence:** off by default. It marks "div" on a candle making a new high or low that CVD did not confirm.

The legend shows RVOL, CVD and delta for the candle under the mouse, and its bubbles and absorption ("high activity, no progress"). **Alt + O** is the master switch: it hides or shows the whole automatic order-flow layer:
- the prior day's levels
- naked POCs
- the market state
- RVOL, CVD and bubbles

Profiles stay, since they are your own drawings. Every number is a setting, and the moves are kept per pair.

## The definition

There is one definition, written twice: `forex_replay/orderflow.py` and `web/js/orderflow.js`. They are held to `web/tests/fixtures/orderflow_golden.json`, written by `python -m forex_replay.orderflow_golden`:
- 48 cases of candle RVOL, delta and CVD (four timeframes, four cursors, three kinds of reset)
- 96 divergence cases
- 4 bubble cases, covering bubbles up and down and absorption, each in all three sizes

1. **RVOL of a chart candle** (Claude's call) is its minutes' ticks ÷ the sum of their same-slot medians. So it works on any timeframe, and a 15-minute candle is compared with the same 15 minutes of the last 20 days. It is blank when a minute has no baseline yet (the first 20 days of data) or the medians add up to 0.
2. **Delta of a minute** is its up ticks − down ticks. The 15-second buckets of a minute add up to the same numbers, so the CVD is built from the 1-minute bars (Claude's call): the same answer, and a 15th of the data.
3. **CVD** is the running sum of the minutes' deltas, back to 0 at each reset, shown at each candle's last minute.
   - **Resets** (setting): at each session open (the default, from your Sessions settings), at each trading day (17:00 New York), or at a candle you pick.
   - **Claude's call:** a reset inside a candle starts that candle's CVD part-way through, so on H4 the CVD resets mid-candle and is not moved to the next one.
   - **With an anchor,** candles before it show no CVD.
4. **The fallback** (the brief's): delta = tick volume × (close − open) ÷ (high − low) of a 1-minute candle, 0 for a flat one. It is used only **before the order-flow data begins** (Claude's call), which in practice means gold before 25 Aug 2026. It is not used for quiet minutes inside the tick data. Those candles have no RVOL.
5. **Bubbles and absorption** come from the 15-second buckets.
   - Each is drawn at its bucket's place inside its candle, spread across the candle like a footprint, at its close price.
   - **Claude's call:** a move between the two thresholds is neither.
   - **Loading:** the buckets load **a month at a time**, only the months on screen, because the whole of EURUSD is 75 MB.
6. **Divergence** (Claude's reading of "within a lookback"):
   - **Bearish:** a closed candle's high is above every earlier high of its reset period, and its CVD is not above the highest CVD of the `lookback` candles before it (20 by default, within the period).
   - **Bullish:** the mirror for lows.
   - **Edge cases:** the first candle of a period is never marked. If a candle makes both a new high and a new low, bearish wins.
7. **No look-ahead:** only minutes and buckets that had closed by the replay's cursor count, and divergence is judged on closed candles only.

## Speed

- **The panels:** a step of the replay works out again only the candles from the first one still open, reading minutes from the last reset before it. A test holds this step-by-step answer to a full recompute, cursor after cursor, back and forth.
- **The bubbles:** worked out for the candles on screen and kept until the cursor, the view or the settings change.

## Checked

- **Real data:** Python (from the Parquet copies) and JavaScript (from the browser's files) give identical totals for October 2026:
  - **EURUSD:** 3,729 bubbles and absorption; the same CVD sum over the 15-minute candles; RVOL on 2,096 candles
  - **XAUUSD:** 1,214, and 2,012
- **What October looked like:**
  - **EURUSD:** 549 bubbles (284 up) and 3,180 absorption; 908 of them between 16:00 and 18:59 New York, the rollover.
  - **XAUUSD:** 1,110 bubbles (566 up) and 104 absorption.
- **Broken on purpose:**
  - CVD not going back to 0 at a reset
  - a bubble needing more than the move instead of at least
  - a changed fallback formula

  Each made tests fail.

## Found while building

- **The month loader never loaded in a browser.** It kept the browser's `fetch` as its own property, and calling it that way throws "Illegal invocation", which Node's test did not show. The month was already marked as loading, so it stayed stuck. It now wraps `fetch`.
- **With an anchor,** the CVD before it ran from the data's first minute (about −80,000 on EURUSD) and flattened the line after it. Those candles are now blank.

## Not yet done, and open for Jeevesh

- **The rollover** (17:00 New York) makes many EURUSD absorption circles and bubbles, because few ticks are normal there and spreads jump. Should a window around it be left out?
- **The fallback's sizes** are far bigger than the tick delta's (MT5's candle volume counts more than our up and down ticks), so the CVD line jumps where the tick data begins. Fine for gold's history; worth knowing.
- **15-second profiles** (Phase 3, "Built from: 15-second buckets") still load every month at once. They should use the month loader too.
