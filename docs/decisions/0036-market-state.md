# 0036: Market state labels (order flow, Phase 4)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 4), with Claude on the points the brief left open (marked below)

## What it says

Where price stands against the **previous trading day's value area** (its VAL and VAH, from Phase 3), judged on 30-minute closes:

- **Accepted above / below:** 2 consecutive closes outside value.
- **Rejected above / below:** price traded outside value, then a close back inside value within 60 minutes, before a second outside close.
- **Otherwise:** Inside value, Above value or Below value (outside, but not yet accepted).

It shows in a box at the bottom right of the chart (state, VAH, VAL, and the last label with its IST time) and as small squares on the candles: "Acc ↑", "Acc ↓", "Rej ↑", "Rej ↓". Green means the label leans up (accepted above, rejected below), red means it leans down. It is switched on in the **Order flow** dialog, off by default. The candle (15, 30 or 60 minutes), the closes needed for acceptance and the rejection window are settings.

## The definition

There is one definition, written twice: `forex_replay/marketstate.py` and `web/js/marketstate.js`. They are held to `web/tests/fixtures/state_golden.json`, written by `python -m forex_replay.state_golden`. It has 252 cases: three synthetic days built to keep crossing the value area, 84 cursors, and three sets of settings. Every state and all four labels occur in them.

1. **The closes come from the order-flow 1-minute bars** (Claude's call), not from the candles on screen. The Phase 9 backtester reads the same bars, so it will label the same closes. These are mid prices; the chart's candles are bid prices, which differ by half the spread (a fraction of a pip on EURUSD).
2. **Only the current trading day** (from 17:00 New York) counts, and only 30-minute candles that had **closed** by the replay's cursor. A candle's close is its last 1-minute bar's close. The candles are counted on the UTC clock; they line up with the trading day because 17:00 New York is always on the hour, so the candle can only be 15, 30 or 60 minutes.
3. **"Traded outside"** (Claude's call) means the high of a closed 1-minute bar above VAH (or the low below VAL). So a wick through VAH that closes back inside the same 30-minute candle is a rejection.
4. **The 60 minutes** (Claude's call) are counted from the first 1-minute bar that traded outside **since the last close inside value**, to the close that comes back inside. Exactly 60 minutes counts.
5. **"Before a second outside close"** (Claude's call): between the last close inside and the one coming back, at most one close outside. Two closes outside are acceptance, so acceptance and then a return inside is not a rejection.
6. **Inside** means VAL ≤ close ≤ VAH. Closing exactly on VAH is inside.
7. **The state** comes from the last close:
   - **Accepted above/below** while the run of closes on that side is at least 2.
   - **Above/Below value** while it is shorter.
   - **After a close inside:** Rejected above/below if that rejection happened since the last outside close, otherwise Inside value.
   - **Before the day's first close:** taken from the last 1-minute close.
8. **A rejection can repeat.** Every return inside that meets the rule is labelled, so price chopping around VAL can give several "Rej ↓" in a row (seen on gold on 22 Oct 2026). This follows the brief's wording, and Jeevesh may want to change it.

## Checked

- **By hand (Python):**
  - acceptance, and not before the second close has closed
  - a wick rejection
  - a rejection after one outside close but not after two
  - the window's edge (60 minutes in, 59 out)
  - the state through a day
  - only the cursor's day counting
  - bars past the cursor making no difference
- **Golden:** JavaScript matches all 252 cases. Bars past the cursor, or the unused end of a full-size array, change nothing.
- **Real data:** Python (from the Parquet copy) and JavaScript (from the browser's files) gave the same answers at 10 cursors from Oct 2025 to Oct 2026 on EURUSD (12 labels).
- **Broken on purpose:**
  - allowing two outside closes before a rejection
  - labelling every close after acceptance
  - making the window exclusive

  Each made tests fail.

## Found while building

The prior-day lines ended at the chart's left edge when the cursor fell part-way into a candle past the last one, which is the usual case outside a replay. The chart library answers null for a position between candles there. A shared `logicalToX` in `drawings.js` now works out a position between the two whole candles, for the levels and for every drawing.

## Not yet done

- **Repeated rejections:** whether to label only the first one on each side until something else happens (point 8).
- **Who reads it:** the Model A and B rules in Phase 9 read these states.
