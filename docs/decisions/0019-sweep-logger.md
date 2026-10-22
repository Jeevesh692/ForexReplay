# 0019: The sweep logger measures every liquidity-sweep rule for each trade, with a looser map than the rulebook

- **Date:** 13 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the spec `docs/plan-sweep-logger.md` and `Sweep_Backtest_Log.xlsx`, for Marco's liquidity-sweep rulebook, New York session), with Claude on the points below where the spec left room

## What it does

When a session of a strategy whose `strategy.json` says `"logger": "sweep"` is saved, `forex_replay/sweep.py` writes:
- `sweep_log.csv`: one row per closed trade, 83 columns
- `sweep_days.csv`: one row per weekday whose 08:00 New York the replay passed, 10 columns

The column names and order are the spec's, checked by a test against the spec file and equal to the sample CSVs that came with the workbook. It shares `forex_replay/loglib.py` with the NBB logger ([0018](0018-nbb-logger.md)): clocks, candles cut at a moment, the same trade columns, and buys measured on mirrored candles. `python -m forex_replay sweep <strategy>` rebuilds both files.

The map is looser than the rulebook, as the spec asks. Swing levels are kept down to 0.5 × ATR of move-away and up to 5 weekdays old, with each level's move-away and age logged. So the workbook can apply the rulebook's 1.0 × ATR and 2 days, or anything in between, without replaying.

## Choices made where the spec left room

- **The 08:00 price** is the close of the last M5 candle before 08:00 New York.
- **"Untaken" and "traded through"** mean strictly beyond: a later high above a swing high, or a later low below a swing low. Touching the level exactly does not take it.
- **Order of the map rules:** a swing within 0.1 × ATR of a PD or ON level on its side is dropped first. Then the remaining swings within 0.1 × ATR of each other, chained, become one equal level. It sits at the most extreme price, with the move-away and age of its most recent swing.
- **The rulebook map** is the app's map with swing and equal levels kept only at move-away ≥ 1.0 and age ≤ 2. PD and ON levels are always on it.
- **Age** counts only Monday to Friday New York dates, in 24-hour days. Sunday evening's trading hours are not counted.
- **Opposite levels** are the map's levels on the other side (sells: below the 08:00 price) that are below the rule entry and that price did not trade through between 08:00 and the confirmation.
- **Phase 2:**
  - The target is the nearest opposite level on the rulebook map whose target price (1 pip before the level) is at least 2R from the rule entry.
  - The half comes off at the first internal level at least 1R away. That is either an opposite level nearer than the target, taken at its price when reached, or a 5m swing low confirmed after the entry, taken at the close of the candle that confirms it (the swing low itself was earlier, so that price is no longer available).
  - The trailing stop moves after each lower 5m swing high confirmed once the half is off, to the swing high + the spread on the confirming candle + 1 pip. It only moves toward profit.
  - The stop is checked before the target on every candle, as in the engine.
- **`levels_swept_count`** counts the levels on the trade's side that swept and closed back before the entry (the spec's step 4).
- **`sweeps_in_window`** checks every rulebook-map level on both sides. The break must come before 11:00, the close back within 3 M5 candles, and that close between 08:00 and 11:00.
- **Days:** a day before the furthest candle's date can no longer change, so an earlier row of it is reused. The furthest day is always worked out again, because its 08:00 to 11:00 window may still be filling.

## Found in the app

The first save made `sweep_log.csv`; the next save a moment later failed with "Access is denied". OneDrive was still uploading the new file, and Windows will not replace a file another program has open. Excel showing the CSV does the same.

Every log file is now moved into place with retries for about 3 seconds. If it is still held after that, the status bar says the file is open in another program and the next save will write it. The session itself is always saved. A test reproduces the refusal and checks both outcomes.

## Checked with the workbook

80 made-up trades on real candles (2 Feb to 27 Mar 2026, a sell at 08:45 and a buy at 09:50 New York each day) were logged and pasted into a copy of `Sweep_Backtest_Log.xlsx` in Excel 16:
- With "Only trades passing all rules" on Yes, and again on No, there were no error cells on Analysis, Day analysis or Stats.
- With No, every Stats section filled: results by target and management, window part, level swept, side, candles to close back, trade of the day, weekday, month, what each rule is worth, discipline, and days replayed.
- "Days with at least one sweep" was 30, the number of days the logger had counted with a sweep.

## Not yet done

Stage 2 (`auto_setup`) and stage 3 (online), as the spec says. No news calendar.
