# 0008: A backtest is saved as its actions and rebuilt by repeating them

- **Date:** 3 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants to stop a replay and carry on later with its trades and drawings, and have trades land in the journal), with Claude on the design. Jeevesh chose to keep the original day-7 plan and not add M1 candles for live-forming candles yet.

## What is saved

A backtest file is a recipe for the run, not a copy of the engine's insides:

| Field | Meaning |
|---|---|
| `startTime` | UTC time of the last candle shown when the replay started |
| `settings` | the account settings the run started with |
| `actions` | every order, close, cancel, stop or target move, partial close, "close all" and settings change, each with the UTC time of the live candle it was taken on |
| `furthestTime` | the last candle the replay reached |
| `drawings` | the run's drawings (time and price, as in [0007](0007-drawings.md)) |
| `trades` | every trade as it stood at the save: a receipt, and the source for the journal |

Times are stored, not candle numbers, so a save still fits after the data is rebuilt with more candles.

## How a run comes back

`rebuild` in `web/js/backtest.js` feeds the same M5 candles to a fresh engine and repeats each action at its candle, using the same `Trading` methods the buttons use. The engine has no randomness, so the same candles and the same actions give the same run. Then every rebuilt trade is compared with the receipt, field by field. If they differ (because the engine's rules changed since the save, say), the app says so instead of passing silently.

Why not save the engine's state directly? Two reasons:

1. A save could then hold a state the engine can never produce (a hand-edited file, a bug in the saving code). Repeating actions can only give results the engine actually produces.
2. "Two engines, one truth" ([0005](0005-trading-engine-in-the-browser.md)) already treats the engine as the source of every result. This keeps it that way: the file holds what you did, the engine works out what happened.

The cost is a little time when opening a backtest (it replays every candle since the start), which is small at these sizes.

A test plays 60 random runs (about 6,000 actions, 2,500 trades, with refused actions, look-backs and settings changes mixed in), saves each one through JSON, rebuilds it, and requires identical trades, actions, balance and settings. Breaking the rebuild of settings changes on purpose made that test fail.

## Where it is kept

On disk, next to the v1 journals, through the local server:

    strategies/<journal>/backtests/<id>.json
    strategies/<journal>/trades.csv

On disk rather than in the browser, because clearing browser data would lose every backtest, and files can be read, copied and backed up. The journal name for new replays is set in the Backtests dialog; it starts as `manual_backtests`, so the app does not write into `impulse_candle/trades.csv` unless Jeevesh chooses it.

Saving appends the backtest's closed trades to the journal in v1's columns, with times on the broker server clock like the v1 rows, so `python -m forex_replay report` works on it. Rows are keyed by (run id, trade id) and the run id is the backtest id, so saving again never adds a trade twice.

The server accepts writes only as `application/json`. A page on another website cannot send that to `127.0.0.1` without the browser asking the server first, and the server never agrees, so only the app can write files. Names may only use letters, digits, `-` and `_`, so a request cannot reach a file outside `strategies/`.

## Rules

- Every replay is a backtest. It is written to disk only once it has a trade or a drawing; a replay that is only a look around leaves nothing behind.
- It is saved about 1.5 seconds after anything changes (at most once per 1.5 seconds while playing), when you press ✕, when the Backtests dialog opens, and when the tab closes.
- ✕ no longer closes open trades. They stay open in the saved backtest and carry on when it is resumed. If the save fails, ✕ asks for a second click before leaving without saving.
- Resume opens the run live at the last candle it reached. Looking back works as before.
- Outside a replay, the chart keeps its own drawings in the browser. A new replay takes along only the chart drawings whose points are all before its start, so nothing drawn on future candles comes into the run. A line drawn in the past at a price seen in the future cannot be detected.
- A resumed backtest uses the settings it was saved with; leaving it brings back your own settings.
- Deleting a backtest removes its file; its trades stay in the journal.

## Not yet done

Renaming a backtest, choosing a journal per backtest after it has started, and lots and dollars in the journal (added on day 10 with notes, tags and screenshots, [0011](0011-trade-journal.md)). A backtest whose rebuild differs from its save still opens; there is no way yet to keep the old result side by side.
