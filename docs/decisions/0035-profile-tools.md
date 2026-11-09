# 0035: Volume-profile drawing tools (order flow, Phase 3)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 3), with Claude on the points the brief left open (marked below)

## What there is

- **Fixed range profile** (`vprofile`, Alt + P): two clicks, a start candle and an end candle, on any timeframe. Both candles are inside the range.
- **Anchored profile** (`aprofile`, Alt + A): one click. It runs from that candle to the replay's cursor and grows as the replay moves.
- **Drawn for you** (switched on in the **Order flow** dialog, both off by default):
  - the prior trading day's POC, VAH and VAL, across the current trading day (pPOC, pVAH, pVAL)
  - naked POCs of the last 5 days (1 to 30), each running right from its day until the first later bar touches it ("nPOC hit"), or to now if none has

Each profile shows a histogram (a bar per bin, the POC bin in its own colour, the value area darker), POC, VAH and VAL lines with prices, and LVN zones shaded red.

## Settings

Every number is a setting, as the brief asks. The **Order flow** button on the toolbar sets the defaults for new profiles, the bin for each pair, and the automatic levels. **Profile settings** under a selected profile changes only that one. The settings are:

- built from 1-minute bars or 15-second buckets
- bin size (EURUSD 0.0001, gold 0.50 by default, from Phase 1's instrument settings)
- value area 70%
- LVN below 35% of the smoothed POC
- smoothing over 3 bins
- histogram width 35% of the range, on the left or the right
- POC, VAH and VAL lines stopping at the range's end or extended to the right edge
- the colours

A profile's settings are saved with the drawing, so a session resumes with them; the defaults are saved in the browser.

## Decisions

1. **Built from the order-flow bars, never from the candles on screen** (Claude's call). The candles' volume is only a tick count per candle; the order-flow bars give the same answer on every timeframe. So a profile drawn on M15 and one drawn over the same hours on H1 are the same profile.
2. **No look-ahead:** a profile uses only bars that had **closed** by the replay's cursor, by the same rule as Phase 2. A fixed range whose end is past the cursor is cut at the cursor and finishes itself as the replay reaches it.
   - **Claude's call:** outside a replay, the cursor is the close of the chart's last candle. Gold's order-flow files run on to 9 Nov 2026 while its candles stop on 23 Oct, and without this the levels were worked out for a day the chart does not show.
3. **The trading day** starts at 17:00 New York (the server date, as in Phase 1), so pPOC and the nPOCs change at 02:30 IST in summer and 03:30 IST in winter.
4. **Only finished days give levels.** The day still running never gives a prior-day level or a naked POC. A naked POC is touched by a bar of a **later** day whose low-to-high range contains it.
5. **The POC line is drawn at the middle of its bin** (Claude's call), for both the prior day and the naked POCs.
6. **One definition, twice.** `day_levels` in `forex_replay/profile.py` and `dayLevels` in `web/js/profile.js`, held to 10 golden cases in `web/tests/fixtures/profile_golden.json`: five cursors over 9 days with a weekend, each with 1 and 5 days back, including touched and untouched naked POCs.
7. **Speed** (Claude's call): profiles are cached per drawing, settings and cursor. The levels use only the last naked-days + 10 days of bars, starting at a day boundary so the first day is whole, and finished days are cached.

## Found while building

- `dayLevels` called without a cache computed **nothing**: `cache && cache.get(key)` gives `null` rather than `undefined` when there is no cache, so the "not cached yet" branch never ran. The app always passes a cache and the golden test passed one too, so only the new "no cache" test caught it. Fixed.

## Not yet done

- The market-state labels that read these levels: Phase 4.
- The levels use the default profile settings (and the 1-minute bars), not a profile's own.
