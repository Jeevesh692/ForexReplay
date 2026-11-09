# 0038: The trigger panel (order flow, Phase 6)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 6), with Claude on the points the brief left open (marked below)

## What it shows

"Trigger 5m" sits in the side panel above the ADR plan. It has:
- a Long / Short choice
- the candle being judged, for example "05:40 IST · closed" or "14:00 IST · forming, 4 of 5 min"
- one row per rule, each with its own on/off box, a light and the value

| Rule | Passes when | On by default |
|---|---|---|
| Body | close − open is at least 50% of high − low | yes |
| Range | high − low is at least 1.2 × ATR(14) of the 5-minute candles | yes |
| Close | the close is in the top 25% of the range (long), the bottom 25% (short) | yes |
| RVOL | the candle's RVOL is at least 1.5 | yes |
| Bubble | the candle trades into an LVN zone, and inside it there is a same-direction bubble of 3x or more and no opposite absorption | no |

The light in the panel's title is green only when **every rule switched on** passes for the chosen side. If none is on, it is never green. Every number is a setting under "Settings", and hovering a row explains it.

## The definition

There is one definition, written twice: `forex_replay/trigger.py` and `web/js/trigger.js`. They are held to `web/tests/fixtures/trigger_golden.json`, written by `python -m forex_replay.trigger_golden`:
- 384 candle cases: 96 cursors, both sides, two sets of settings
- 120 bubble-rule cases
- 40 cases of the overall light

1. **Which candle** (Claude's call) is the 5-minute candle of the last 1-minute candle the replay has revealed.
   - **While it forms,** it is judged on its minutes so far.
   - **At a 5-minute close,** the cursor is on the boundary, so it is the candle that has **just closed**. That is the moment the brief's models enter ("enter at close").
   - **Missing minutes** do not stop a candle closing at its time.
2. **The candle's prices** come from the chart's own 1-minute candles (what you see), on the UTC five-minute grid. A test checks that they are the very candles the chart builds. RVOL and bubbles come from the order-flow data.
3. **ATR** (Claude's call) is Wilder's ATR(14), the chart's own indicator, taken at **the candle before** this one. So a big candle does not raise the average it is measured against. There is no ATR until 14 candles exist.
4. **RVOL** is Phase 5's: the candle's ticks ÷ its minutes' same-slot medians, from the minutes closed so far.
5. **"At least" means at least:** a candle exactly on a line passes. Tests check each line exactly.
6. **The bubble rule** (Claude's reading of "the marked LVN zone" and "opposite absorption"):
   - **The zones** are the LVN zones of every profile drawing on the chart, worked out at the cursor. A zone counts if the candle's range reaches it.
   - **For a long:** a green bubble of at least 3x inside the zone during the candle, and no absorption inside it where up ticks beat down ticks. Buyers absorbed is a sign against a long.
   - **For a short:** the mirror.
   - **For this,** Phase 5's bubbles now carry their bucket's delta (up − down ticks).
   - **If no zone is reached,** the rule fails with "not in an LVN" or "no LVN: draw a profile".
7. **No look-ahead:** the candle uses only revealed minutes, and ATR only earlier candles. RVOL and bubbles use only minutes and buckets closed by the cursor.

## Checked

- **By hand:**
  - the candle forming and closing
  - ATR's first value and Wilder's next step
  - a strong bull candle passing long and failing short
  - a flat candle
  - no ATR yet
  - candles exactly on every line
  - the bubble rule with and against absorption
  - a candle that never reaches the zone
  - the overall light
- **Golden:** JavaScript matches every case.
- **Real data:** Python, reading the raw M1 file on its own, gives the panel's numbers for the last EURUSD candle (14 Oct 2026, 14:00 IST, 4 minutes):
  - body 0.90
  - close 0.075 of the range
  - ATR 2.741 pips
  - range 1.459 × ATR
- **Broken on purpose:**
  - the absorption sign reversed (caught)
  - the close counted only after its time (caught)
  - "at least" made "more than" for the range. This was **not** caught until the exact-line tests were added; now it is.

## Not yet done

- **Trading from the panel:** a button to enter at the close comes with the position tool (Phase 7).
- **Which zone:** the bubble rule uses every profile's LVN zones; choosing one marked zone could come later if wanted.
