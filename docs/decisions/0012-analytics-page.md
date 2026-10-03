# 0012: The analytics page reads the journal, and its statistics are held to stats.py

- **Date:** 4 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants an analytics page for his backtests), with Claude on the design

## The source is the journal CSV

The page reads `strategies/<journal>/trades.csv` through the server (`GET /api/journals`, `GET /api/journal/<name>`), not the backtest files. The journal is the complete record:
- it holds the v1 trades too
- it keeps trades after a backtest is deleted
- it is what `python -m forex_replay report` reads, so the page and the report can be compared on the same file

The backtest list is used only for names (a run is shown as "EURUSD from Thu 30 Jul 2026, 11:25" rather than its id) and for challenge outcomes. Opening the tab saves the replay on screen first, so its latest trades are included.

## Two copies of the statistics, held to one truth

The page filters instantly, so it computes the statistics itself (`web/js/analytics.js`) instead of asking the server each time. The definitions belong to `forex_replay/stats.py`: what counts as a win (more than +0.05R), breakeven, drawdown from the starting zero, streaks that a breakeven does not break, the worst day per run and exit date, profit factor and payoff (infinite when there is no loss), and the per-group breakdowns.

The same method as the two engines ([0005](0005-trading-engine-in-the-browser.md)) keeps the copies equal:
- `python -m forex_replay.stats_golden` writes 40 random journals as real CSV files, with empty cells, rows without a result, and notes with commas, quotes and line breaks. It reads them back as the server does and records what `stats.py` says about them in `web/tests/fixtures/stats_golden.json`.
- A JavaScript test must reproduce every number: 17 statistics, four breakdowns and the prop-firm figures for each journal.
- A Python test checks the recorded file is still what `stats.py` produces.

Change `stats.py` first, then `analytics.js`, then regenerate.

An empty cell is "no value", never zero: JavaScript's `Number("")` is 0, which would have silently pulled averages towards zero. Displayed whole numbers are rounded the way Python prints them (halves to even), so the page and the report show the same average duration.

## What the page shows

- **Filters:** journal, run, side, session, tag, plus the risk % used for the prop-firm line.
- **Tiles:** trades (won, lost, breakeven), win rate, expectancy, total R (and $ where recorded), profit factor, payoff, maximum drawdown, longest streaks, average MFE (with how many trades have it), worst day, average duration, commission.
- **Equity curve:** cumulative R after each trade, in logged order like `stats.py` (two replays of the same weeks are not interleaved). A crosshair shows the trade under the pointer.
- **Histogram:** trades per half-R band, losses red and wins green, with a count on hover.
- **Worth knowing:** v1's prop-firm check at the chosen risk; losing trades that had been +1R in profit first (what a breakeven stop at +1R would have saved); challenge runs passed and failed.
- **Breakdowns:** by session, weekday, side, exit reason, tag (a trade with two tags counts in both) and run.
- **Trades table:** the latest 300, with notes, tags and links to screenshots.

Charts follow the project's chart rules: one axis, a 2px line with a light wash, columns at most 24px with rounded tops, text in text colours, and red and green that pass a colour-blindness and contrast check against the dark background. Everything from the journal is escaped before it is shown; a note containing HTML appears as text.

## Not yet done

Sessions in the journal are v1's fixed broker-clock hours, not the session settings of day 4. Dates are on the broker clock as written in the journal, not India time. Missing: a date-range filter, comparing two filtered sets side by side, R-multiple percentiles, and exporting the page.
