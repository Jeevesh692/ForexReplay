# 0025: Replay on 1-hour candles for swing strategies

- **Date:** 20 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("let me replay on those higher timeframes too, I will just not use lower-timeframe data to test, those data are for my swing strategies"; "test and commit, no need for automatic log"), with Claude on the design

## What it is

A **Candles** menu beside the pair picks what the replay clock steps through:

- **1-minute** (the default, [0022](0022-one-minute-candles.md)): from 1 Aug 2025, fills on minutes.
- **1-hour (swing)**: the older H1 history from [0024](0024-longer-history-and-two-more-pairs.md), then on through hours built from the minutes. H4 and D1 are built from those hours, and fills are resolved on the hourly candles.

The rules do not change, only the base: one clock, no look-ahead, an order is never evaluated on the candle it was placed on. The clock still counts positions in its base candles; a session records `barSeconds` (60 or 3600) so Resume reopens the right mode.

## Why hours and not D1 or H4 as the base

The hour is the finest candle that has history before the minutes for every pair, so it gives the longest run (from Jan 2024, or Oct 2022 for AUDUSD) with the most honest fills. A stop and a target inside the same hour are resolved the same way the engine always resolves an ambiguous candle (the stop first).

## Costs, said plainly

- Fills are only as fine as an hour: a trade that would have hit its target then its stop within one hour counts as a loss.
- Timeframes finer than an hour are switched off in this mode.
- The NBB and sweep logs measure 5-minute candles, so 1-hour sessions belong in strategies without an automatic log. Jeevesh chose not to build a swing log.

## Not yet done

- No automatic log for swing strategies.
- No check in the code that stops a 1-hour session being saved into a strategy with an NBB or sweep logger; it is a rule of use.
