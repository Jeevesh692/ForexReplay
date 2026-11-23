# 0040: The order-flow trade log and workbook (order flow, Phase 8)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 8), with Claude on the points the brief left open (marked below)

## What it is

**A new automatic log** (Claude's call: the repository's existing kind of log, as for NBB and the liquidity sweep). A strategy whose log is **"Order flow (AMT, Models A/B)"** writes, on every save:

- **`strategies/<strategy>/orderflow_log.csv`:** one row per closed trade. Each session's rows are replaced and other sessions' rows kept, as in the other logs.
- **`strategies/<strategy>/OrderFlow_Backtest_Log.xlsx`:** the same rows on a **"Log"** sheet, numbers as numbers, with a header, filters and frozen columns. The brief said to append to an existing workbook format if there was one; there was none for order flow, so one is made. **Only the Log sheet is rewritten:** any sheets you add (summaries, charts) are kept. If the workbook is open in Excel, Windows locks it; the CSV is still written, and the save says the workbook was not.

`python -m forex_replay orderflow <strategy>` rebuilds both from every saved session.

## Filled in by the app

Everything is measured at **the moment the order was placed**: the close of the 1-minute candle the replay was on, so nothing later is used. It uses the same Python definitions as the app's panels (Phases 2–7), so the numbers are the ones you saw. In the browser check, the trigger numbers in the log were exactly the panel's.

| Column(s) | What |
|---|---|
| the trade's own (date, side, prices, lots, R, P&L, commission, tags, note) | as in every strategy log (`loglib.trade_fields`) |
| `pair`, `session` | the session: Asia, London or New York, each in its own city's clock (the app's standard sessions), joined when two are open |
| `state`, `state_close_ist` | the market state (Phase 4), and the 30-minute close that decided it: the last Accepted or Rejected label of that kind, or the last close for Inside / Above / Below |
| `lvn_low`, `lvn_high`, `lvn_retracement_pct` | the LVN zone (Phase 3) of your profile drawings that holds the entry, else the nearest one the trigger candle traded into; how far into its profile's leg it sits, from the top for a long, from the bottom for a short |
| `near_old_va` | y when a VAH or VAL of the last 5 finished days is within 3 pips of that zone (or of the entry, with no zone) |
| `trigger_candle_ist`, `body_pct`, `range_atr`, `close_location_pct`, `rvol`, `bubble_rvol` | the trigger panel's numbers (Phase 6) for the 5-minute candle judged at that moment; the bubble's RVOL only when the bubble rule was on |
| `stop_pips`, `cost_r` | the position tool's cost of a round trip in R (Phase 7) |
| `result_r_after_costs` | the result minus commission and slippage in R. The spread is already in the result, since fills are at the bid and ask (Claude's call: not taken off twice) |
| `mfe_r`, `mae_r` | as the engine measured them |
| `prior_poc`, `reached_poc` | the prior day's POC, and whether price reached it after entry by the end of that trading day, even if stopped first. "pending" while the replay has not reached the day's end |
| `of_exit_reason` | from the engine: target; stop; breakeven (stop within 1 pip of entry); trail (stop moved more than 1 pip into profit); manual. Your answer replaces it |
| `screenshots` | the trade's pictures, as `screenshots/<file>` |

## From you, in the journal box

A strategy made with this log gets **two checklist questions** (Claude's call; you can edit them like any checklist):
- **Model:** A or B.
- **Exit reason (when the app cannot tell):** time stop, state invalidation, trail, breakeven, target or stop.

The brief's **preset tags** ("A+ double failure", "early-BE variant", "news day") are among the journal box's tag suggestions.

Logging a trade is therefore one choice (the model), plus a tag or an exit reason when needed, well under the brief's 10 seconds. Writing the row takes the computer about 1.5–2 seconds.

## The settings travel with the save

The session file now carries the order-flow settings in use: the profile defaults, the bin for the pair, the market state's candle and rules, the bubble thresholds, the trigger panel's rules and the slippage. So the log measures with **your** settings (Claude's call). Saves from before Phase 8 have none and get the app's defaults.

## Checked

- **By hand, on a made-up market** (`tests/test_oflog.py`):
  - **The trade:** its answers and tags, the session label.
  - **State:** "accepted above", decided at the 23:00 UTC close.
  - **Costs:** 0.060R, and 1.94R after costs.
  - **The trigger candle:** the closed one, with its last minute.
  - **POC:** reached y / n / pending.
  - **Exits:** every automatic exit reason, and your answer replacing it.
  - **LVN:** the zone and its leg from a profile drawing.
  - **The files:** the CSV, and the workbook keeping your own sheet while its Log sheet is rewritten.
  - **The default checklist,** which never replaces your own.
- **In the browser:**
  1. A strategy "zz of test" was made with the log and got the two questions.
  2. A long limit at 1.11720 (10-pip stop) on EURUSD, 13 Oct 2026, closed at its target (+2.00R).
  3. In the journal box: model A, tag "news day".
  4. Leaving the replay saved it. The CSV and the workbook (46 columns) held the trade, the answers, the state (rejected below, decided at 07:30 IST), the trigger numbers (10:50 IST candle: body 44%, range 1.46×, close at 4%, RVOL 0.87, the panel's own numbers), costs 0.060R, 1.94R after costs, POC reached, and both screenshots.
  5. The test strategy was then removed.
- **Broken on purpose:**
  - every exit reason read as "stop" (caught)
  - the decision taken at the start of the order's minute instead of its close. This was **not** caught at first, because the made-up candle came out the same, so a check of the closed candle's close position (58%, against 50% a minute early) was added. It is caught now.

## Not yet done

- **The CSV from before:** older saves' rows are rebuilt only when that session is saved again, or with the rebuild command.
- **Profiles drawn after the trade:** the profile drawings are the session's as saved, so a profile drawn after the trade still gives the trade a zone. Its prices are still only from bars up to the order.
- **The website:** the static website (browser storage) does not write this log, like the other logs.
