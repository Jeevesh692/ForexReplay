# ForexReplay v2.1.0

Strategy journals, built from 13 Oct 2026 to the plan in `docs/plan-strategy-journals.md`.

## What is new

- **Strategies.** Each strategy is its own folder of sessions, journal, screenshots and Excel workbook. The **Strategies** dialog switches between them: Resume opens a strategy's last session where it stopped, and New session starts another. Progress is saved as you go and lasts across restarts.
- **The NBB log.** For a strategy with the NBB log, every save measures each closed trade against the NBB rulebook into `nbb_log.csv` and `nbb_days.csv`, for `NBB_Backtest_Log.xlsx`. 72 columns: bias, Asian range, PD arrays, H1/L1/H2, displacement, the rule Fibonacci, and what price did afterwards.
- **The liquidity-sweep log.** The same for Marco's liquidity-sweep rulebook: `sweep_log.csv` and `sweep_days.csv` for `Sweep_Backtest_Log.xlsx`. 83 columns: the 08:00 map, the sweep, the rule trade, the six nearest opposite levels, and the result.
- **Checklists.** Your own questions per strategy (Yes/No, a choice, or a number), answered per trade in the journal box and written to `checklist_log.csv`.
- **No look-ahead in the logs.** A field is measured only from candles the replay had shown by then. Fields about the rest of the day wait (PENDING) until you replay past 16:00 New York.
- **Rebuild a log** after a fix with `python -m forex_replay nbb <strategy>` or `python -m forex_replay sweep <strategy>`.
- **Your strategies stay on your computer.** Git ignores `strategies/`, so anyone can use the app for their own strategies (see "Use it for your own strategies" in the README) without seeing anyone else's.

## Fixed

- Screenshots had failed since v2.0.5 ("Illegal invocation"), and the save when a tab closes failed silently.
- Log files that OneDrive (or Excel) briefly holds open are retried instead of failing.

## Tests

104 Python and 141 JavaScript tests. Both logs are tested on hand-built days with every expected number worked out, including the buy mirror and no look-ahead. Each workbook was filled in Excel with 80 logged trades and recalculated with no errors.
