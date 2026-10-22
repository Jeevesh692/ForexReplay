# 0017: Each strategy is a folder with its own sessions, journal, screenshots and log

- **Date:** 13 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (about 10 strategies, each with its own backtesting sessions and journal; leave one, test another, come back a week later where he was; desktop app first), with Claude on the design

## What a strategy is

A folder under `strategies/`. The folder already held one journal and its saved backtests ([0008](0008-backtests-saved-as-actions.md), [0011](0011-trade-journal.md)), so a strategy is that folder with a name and a choice of log:

```
strategies/<name>/strategy.json      {"label": "Liquidity sweep (Marco)", "logger": "sweep"}
strategies/<name>/backtests/*.json   its sessions
strategies/<name>/trades.csv         its journal
strategies/<name>/screenshots/       its pictures
strategies/<name>/*.xlsx             its Excel workbook (listed in the app; ignored by git like every .xlsx)
```

- **Label and folder name.** You type a label ("Asian sweep (London)"). The folder name is made from it in lower case with `_` for anything that is not a letter or digit (`asian_sweep_london`), in Python and JavaScript alike, held to the same examples by a test in each.
- **Logger.** `none`, `nbb` or `sweep`, the switch both logger specs ask for (`docs/plan-nbb-logger.md`, `docs/plan-sweep-logger.md`). Today it is only recorded; the loggers come on journal days 2 to 6.
- **Older journals** without `strategy.json` (such as `impulse_candle`) are strategies too, named after their folder, with no logger.
- Changing a strategy's label or logger never touches its sessions or journal. A damaged `strategy.json` reads as the defaults rather than breaking the list.

A word on names: the app already had "Sessions" for the market sessions shaded on the chart (Asia, London, New York). In the Strategies dialog a "session" is one saved replay of a strategy, the word Jeevesh used. The toolbar button for market sessions keeps its name.

## Switching

The Strategies dialog (the toolbar button that was "Backtests") lists every strategy, most recently used first, with its log, sessions, closed trades and the date its latest session reached.

- **Resume** opens that strategy's most recently saved session where it stopped. It is the same rebuild as before: the session on screen is saved first, then the other is rebuilt by repeating its actions on the same candles and checked against its saved trades.
- **New session** saves and leaves the session on screen, then asks for a start candle. New sessions go to the strategy last chosen, which is kept in the browser and shown in the toolbar beside "Strategies".
- Clicking a strategy lists its sessions below, each with Resume and Delete as before; "show every strategy" lists them all.

Progress lasts because it is files: a session is written a moment after each change, on leaving it, and when the tab closes. Nothing depends on the browser's storage except which strategy was chosen last.

## Online

The online version keeps the same list in the visitor's browser (strategies with their label and logger, beside the saved sessions). It has no loggers and no workbooks.

## Found and fixed

Since v2.0.5 the desktop app's store called the browser's `fetch` as a method of itself, which browsers refuse ("Illegal invocation"). Every automatic and manual screenshot failed with that message, and the save when a tab closes failed silently (its error was swallowed). Saves made while the app was open were not affected, because they went through a helper that called `fetch` correctly. The store now always calls `fetch` as a plain function, and a test uses a stand-in `fetch` that throws the same error when misused.

## Not yet done

- The loggers themselves (journal days 2 to 6) and a checklist for strategies without one (day 7).
- Renaming or deleting a strategy from the app (rename the folder by hand while the app is closed; a label can be changed by editing `strategy.json`).
- Copying a workbook into a new strategy's folder: put the `.xlsx` there yourself; the dialog lists it once it is there.
