# Strategy journals: plan and status

Goal: one place per strategy. Each of Jeevesh's strategies (about 10: liquidity sweep, Asian sweep, dollar reversal, NBB and others) gets its own backtesting sessions, journal, screenshots and, where a rulebook exists, an automatic log that his Excel workbook reads. He only trades; the app records. He can leave one strategy, test another, and come back days later to exactly where he was. Asked for by Jeevesh on 13 Oct 2026.

Say "start journal day N" to do a day.

## Decided (13 Oct 2026, Jeevesh)

- **Desktop app first.** Everything is written under `strategies/<strategy>/` on his computer, so the Excel workbooks refresh straight from the CSV files beside them and nothing is lost when the browser's data is cleared. The online version gets the loggers later (stage 3 in both logger specs).
- **The two logger specs are the contract.** `docs/plan-nbb-logger.md` and `docs/plan-sweep-logger.md` (written with Jeevesh on 13 Oct, together with `NBB_Backtest_Log.xlsx` and `Sweep_Backtest_Log.xlsx`) fix every column name and rule. The workbooks read the CSVs by column name, so the names do not change.

## What already exists (v2.0.5)

- Every replay with a trade or a drawing is saved as you go to `strategies/<journal>/backtests/<id>.json`, and when you leave it or close the tab. Resume rebuilds it on the same candles. Progress survives a restart, because it is a file.
- Closed trades go to `strategies/<journal>/trades.csv`, with notes, tags and screenshot names.
- Screenshots (by hand, or automatically when a trade is placed and when it closes) go to `strategies/<journal>/screenshots/`.

What is missing is a way to treat each journal folder as a strategy: see them all, switch between them, and have each one write its own log.

## Days

| Day | Scope | Status |
|---|---|---|
| 1 | **Strategies.** A Strategies dialog: every strategy with its sessions, trades, last save and which log it writes. Create a strategy by name (a folder and `strategy.json` with its label and logger: none, NBB or sweep). "Resume where I left off" and "New session" per strategy; switching saves the session on screen first. The strategy on screen is shown in the toolbar. The Excel workbook sits in the strategy's folder. | done (13 Oct) |
| 2 | **Logger groundwork and NBB pre-session fields.** `forex_replay/loglib.py` (New York time, 15m/30m/D1/W1 candles, swings, Wilder ATR, atomic CSV keyed by run). The M5 candles kept in memory by the server. The save calls the strategy's logger; a logger error is reported, never blocks the save. `python -m forex_replay nbb <strategy>` rebuilds the log from every saved session (and `sweep` on day 5). NBB PRE fields: ADR5, daily and weekly structure, bias, Asian range, 00:00 open, PDH/PDL/PWH/PWL, PD arrays and the nearest one. `nbb_days.csv`. | |
| 3 | **NBB setup fields.** H2, H1, L1, displacement, the rule Fibonacci walk, the opposite PD array, entry and stop levels, your own Fibonacci drawing. | |
| 4 | **NBB after the setup.** POST fields with PENDING until 16:00 New York has been replayed, resolution, deepest levels, Phase 2 simulation. Header contract test. Checked end to end with `NBB_Backtest_Log.xlsx`. | |
| 5 | **Sweep logger, map and setup.** The 08:00 map (PDH/PDL, overnight, 30m swings, equal levels; the loose map and the rulebook map), the sweep, the rule trade, the six nearest opposite levels. | |
| 6 | **Sweep after the setup, and days.** stop_hit, MFE, 16:00 result, Phase 2, `sweep_days.csv`, header contract. Checked end to end with `Sweep_Backtest_Log.xlsx`. | |
| 7 | **Strategies without a logger.** Your own checklist per strategy (questions with Yes/No, a choice, or a number, such as "Asian range swept?"), asked in the journal box for each trade and written as extra columns in `trades.csv`. Fixes, documentation, release v2.1. | |

## Rules this keeps

- No look-ahead: a logger never reads a candle past the session's furthest point. Fields that need the rest of the day stay PENDING until the replay has passed it; the next save fills them.
- Analysis only: a logger never changes trades, fills or the journal, and can be rebuilt from the saved sessions after a fix.
- The same session and candles always give the same CSV, byte for byte.

## Open questions

- The other strategies' rules (Asian sweep, dollar reversal and the rest): for an automatic log like NBB and sweep, each needs its own spec with exact definitions. Until then, day 7's checklist covers them.
- Commission: $4 per lot is still treated as round turn (both workbooks use 0.4 pips).
