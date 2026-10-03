# 0011: Each trade gets a note, tags and chart screenshots; the journal CSV grows to hold them

- **Date:** 4 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants notes, tags and screenshots per trade, as in FX Replay), with Claude on the design

## What is kept per trade

| Field | Rules |
|---|---|
| Note | free text, up to 2,000 characters |
| Tags | up to 10, each up to 24 characters of letters, digits, spaces and `+ & / ' . -`. Picked from chips (the run's own tags first, most used first, then suggestions: A+ setup, followed plan, broke rules, FOMO, early exit, late entry, news) or typed |
| Screenshots | up to 12 PNG files per trade |

Notes are not trading actions. They never change a result, are not repeated when a backtest is rebuilt ([0008](0008-backtests-saved-as-actions.md)), and can be written at any time: while looking back at history, after a challenge has ended, or after resuming a backtest. They are saved in the backtest file (`notes`), and each trade in the save carries its own note, tags and screenshot names for the journal.

## Screenshots

- **Automatic:** one when an order is placed and one when the trade closes, unless the switch in the journal box is off. Trades that already existed when a backtest is resumed get none; they had their moment.
- **By hand:** "Add screenshot" saves the chart as it is now.
- The picture comes from the chart library (`takeScreenshot`): candles, sessions, trade lines, markers and drawings. A caption strip on top says the symbol, timeframe, trade, entry or exit, the India time and the backtest name, because the legend in the chart's corner is page text and not part of the library's picture.
- Files go to `strategies/<journal>/screenshots/<backtest id>-t<trade>-<entry|exit|added…>.png` through the local server. The server accepts only `image/png` with a PNG signature, at most 5 MB, under a safe name; a page on another website cannot send that type without the browser asking first. They are about 50 KB each at the size checked.
- Removing a screenshot from a trade deletes its file. Deleting a backtest does not delete its screenshots (or its journal rows).
- App-made screenshots (`bt-*.png`) are ignored by git, like the backtests themselves.

The engine processes a newly revealed candle before the chart draws it. A picture taken at that moment missed the candle that hit the stop. So automatic pictures are taken a moment later, once the chart has drawn the candle (a microtask: after the current update, before the next replay tick).

## The journal CSV

Six columns are added after v1's 22: `lots`, `pnl_usd`, `commission_usd`, `note`, `tags`, `screenshots` (lists joined with `; `). A journal with only the v1 columns is rewritten with the new columns empty the next time it is opened, keeping every row. The v1 replay window writes the new columns empty.

A trade's row is written once, when it is first saved closed. Results never change after that, but what you write can, so every save also brings the note, tags and screenshots of that backtest's rows up to date (the file is rewritten only if something changed).

## Not yet done

Searching and filtering trades by tag (the analytics page, day 11, can group by tag), editing notes outside a replay without resuming the backtest, drawing on screenshots, and cleaning up screenshot files of deleted backtests.
