# Sweep logger: log every liquidity-sweep rule measurement for each trade, automatically

Status: planned (13 Oct 2026). Asked for by Jeevesh: the same automatic logging as the NBB logger, for Marco's
liquidity-sweep rulebook ("Liquidity Sweep Rulebook (NY Session)"). Companion file: `Sweep_Backtest_Log.xlsx`,
whose Fields sheet is the same column contract as below.

## Goal

Every time a backtest is saved, for journals that use this strategy, write next to the journal:

- `strategies/<journal>/sweep_log.csv`: one row per CLOSED trade: the trade, the 08:00 map, the sweep that set it
  up, the rule entry and stop, the nearest opposite levels, and what price did afterwards.
- `strategies/<journal>/sweep_days.csv`: one row per replayed weekday.

The workbook reads both by column NAME, so order is free and names are fixed. Jeevesh only trades; the app measures.

## Which journals get it

Add `strategies/<journal>/strategy.json` with `{"logger": "sweep"}` (or `"nbb"`). The save writes only the logger
the journal asks for; a journal without the file gets none. If the NBB logger is already built, give it the same switch.

## Rules this must keep

1. **No look-ahead.** Never read an M5 candle after the backtest's `furthestTime`. PRE fields use candles before
   08:00 New York of the trade's date. SETUP fields use candles up to the entry candle. POST fields only once
   `furthestTime` is past 16:00 New York of that date; until then `post_status = PENDING`, POST fields blank,
   and the next save fills them.
2. **UTC seconds inside the code**; New York time (`zoneinfo("America/New_York")`) only for output and day
   boundaries. Server time = New York + 7 h.
3. **Analysis only.** It never changes trades, fills or the journal. `python -m forex_replay sweep <journal>`
   rebuilds both files from every saved backtest of the journal, so a fix can be re-run over old work.
4. **Deterministic.** Same backtest and candles, byte-identical files.
5. **A looser map than the rulebook.** The app keeps swing levels down to 0.5 x ATR of move-away and up to 5
   trading days old, and logs each level's measurements. The workbook applies the rulebook's 1.0 x ATR and
   2 days (or any value in between), so thresholds can be tuned in both directions without replaying.

## Where the code goes

| File | What |
| --- | --- |
| `forex_replay/loglib.py` (new, shared with the NBB logger) | New York time helpers, 15m/30m grouping, swings, Wilder ATR, atomic CSV writing keyed by run. If `nbb.py` exists, move its copies here. |
| `forex_replay/sweep.py` (new) | Everything below. Pure functions on the M5 frame (UTC index) and a backtest dict. |
| `forex_replay/backtests.py` | In `save()`, after the journal: read `strategy.json` and call the matching logger. A logger error is reported in the response (`logError`) and never blocks the save. |
| `forex_replay/__main__.py` | `python -m forex_replay sweep <journal>` rebuild command. |
| `forex_replay/server.py` | Keep the EURUSD M5 frame in memory after the first load, shared by every save. |
| `tests/test_sweep.py` (new) | Tests listed at the end. |
| `docs/decisions/0019-sweep-logger.md` | Why a loose map, the no-look-ahead boundaries, what is not done. |

## Definitions

- **Trade date** `date_ny` = New York date of `entryTime`. **Map time** = 08:00 New York on that date.
- **30m and 5m candles** from M5 by `floor(utc / 1800)` and the M5 candles themselves. A candle counts at a moment only if it has closed.
- **ATR**: Wilder ATR(14) on 30m candles, as `web/js/indicators.js atr()`, taken at the last 30m candle closed at or before map time (`atr30`).
- **Swing high (30m)**: high strictly above the 2 candles before and the 2 after; confirmed when the 2nd after has closed. Mirror for lows. 5m swings in POST use the same rule on 5m candles.
- **Pip** = 10 points. Pips to 1 decimal, prices to 5, ratios to 2.

## The 08:00 map

Built from candles before map time. Sells fade levels ABOVE price (buy-side liquidity); buys fade levels BELOW.

| Code | Level | Kept when |
| --- | --- | --- |
| `PDH` / `PDL` | High / low of the last completed server day (closes 17:00 New York) | Not traded through since that day closed |
| `ONH` / `ONL` | Highest high / lowest low from 17:00 New York the day before to map time | Always (by definition untaken at map time) |
| `SH` / `SL` | Confirmed 30m swing high / low formed in the last 5 trading days (weekdays) | Untaken since it formed, and its move-away is at least 0.5 x atr30 |
| `EQH` / `EQL` | Two kept swings of the same side within 0.1 x atr30 of each other | Merged into one level at the more extreme of the two prices |

- **Move-away** (`respect_atr`) of a swing high = (swing high minus the lowest low after it, up to map time) / atr30. Mirror for lows. For an equal level, use the more recent swing's move-away and age.
- **Age** = time from the swing candle to map time, counting weekdays only, in days of 24 h.
- **Merging**: a swing within 0.1 x atr30 of a PD or ON level on the same side is dropped (the PD/ON level stands for it).
- **Rulebook map** (used for `map_levels_*`, `opp_taken_in_window` and the days file): the same map with move-away at least 1.0 and age at most 2.

## The sweep (SETUP), sells; buys mirror every comparison

1. Candidate levels: levels of the app's map above the 08:00 price.
2. For each, the **break** = the first 5m candle after map time whose high is above the level, and the **confirmation** = the first 5m candle from the break on whose close is below the level. Keep candidates whose confirmation candle closes at or before the trade's entry.
3. None kept: `level_found = FALSE`, `level_type = NONE`, POST = `NO_SETUP`; the trade is still logged.
4. Several kept: choose by type EQ, ON, PD, swing; then the one whose level is nearest the sweep extreme. `levels_swept_count` = how many were kept.
5. **Sweep extreme** = highest high from the break candle to the confirmation candle. `max_closes_beyond` = longest run of consecutive 5m closes above the level in that span. `candles_to_close_back` = candles from break to confirmation, both included.
6. **Rule trade**: entry = the confirmation close; stop = sweep extreme + the spread on the confirmation candle (after the minimum-spread setting) + 1 pip; `rule_risk_pips` = the distance.
7. **Opposite levels**: levels of the app's map below `rule_entry` that price has not traded through between map time and the confirmation close, sorted by distance from `rule_entry`, nearest first, up to 6. Log each one's code, distance, move-away and age.
8. `opp_taken_in_window` = TRUE if any rulebook-map level below the 08:00 price was traded through between map time and the confirmation close.

## After the setup (POST), when `furthestTime` is past 16:00 New York

On M5 candles after the confirmation candle, up to the last candle before 16:00 New York:
- `stop_hit` / `stop_time_ny`: first candle whose high reaches `rule_stop`.
- `mfe_pips_before_stop`: `rule_entry` minus the lowest low of the candles BEFORE that one (all of them if the stop was not hit). Because a candle touching both counts as a stop, its low is never counted.
- `pnl_pips_at_1600`: `rule_entry` minus the last close before 16:00, only when the stop was not hit.
- `phase2_r_gross`: the rulebook's Phase 2 with its defaults. Target = the nearest opposite level that is at least 2R away and passes the rulebook map, placed 1 pip before it. Internal levels = 5m swing lows confirmed after the entry, plus opposite levels nearer than the target. At the first internal level at least 1R away, close 50% and move the stop to entry. After each new low, when a lower 5m swing high is confirmed, move the stop to just above it (spread + 1 pip); the stop only moves toward profit. Exits: stop, target, or 16:00. Blank if no target qualifies.

## Output files

Rewrite each file atomically (tmp then replace). Keys: trades `(run_id, trade_id)`, days `(run_id, date_ny)`.
A save replaces every row of its own run and keeps other runs' rows. Sort by `date_ny`, `run_id`, `trade_id`.
Booleans `TRUE` / `FALSE`; blank = empty field. Header exactly as below, in this order.

### sweep_log.csv

| Column | Group | Format | Exact rule |
| --- | --- | --- | --- |
| `run_id` | TRADE | text | The backtest id (same as run_id in trades.csv). |
| `trade_id` | TRADE | integer | The trade's id inside its backtest. (run_id, trade_id) is unique; a re-save replaces the row. |
| `date_ny` | TRADE | YYYY-MM-DD | New York calendar date of entry_time. |
| `weekday` | TRADE | text | Weekday of date_ny. |
| `side` | TRADE | SELL / BUY | Trade direction. |
| `order_type` | TRADE | MARKET / LIMIT / STOP | How the order was placed. |
| `placed_time_ny` | TRADE | YYYY-MM-DD HH:MM | When the order was placed, New York time. |
| `entry_time_ny` | TRADE | YYYY-MM-DD HH:MM | When it filled, New York time. |
| `entry_min_ny` | TRADE | minutes | entry_time as minutes after 00:00 New York (08:45 = 525). |
| `exit_time_ny` | TRADE | YYYY-MM-DD HH:MM | When it closed (last part), New York time. |
| `entry_price` | TRADE | price | Fill price. |
| `stop_loss` | TRADE | price | The initial stop (defines 1R). |
| `take_profit` | TRADE | price | Target as placed. |
| `exit_price` | TRADE | price | Exit price of the last part. |
| `exit_reason` | TRADE | STOP_LOSS / TAKE_PROFIT / MANUAL | Why it closed. |
| `lots` | TRADE | lots | Size. |
| `actual_r` | TRADE | R | Result as you traded it, from the engine's resultR. Spread is in the fills; commission is not. |
| `pnl_usd` | TRADE | USD | Money result from the account (after commission). |
| `commission_usd` | TRADE | USD | Commission charged. |
| `risk_pips` | TRADE | pips | Distance from entry to your initial stop. |
| `spread_pips` | TRADE | pips | Spread used on the entry candle (after the app's minimum-spread setting). |
| `trade_of_day` | TRADE | integer | 1 for your first trade on date_ny in this backtest (by entry time), 2 for the second, and so on. |
| `level_attempt` | TRADE | integer | 1 if no earlier trade that day in this backtest used the same swept level; 2 for a second attempt, and so on. |
| `tags` | TRADE | text | Your tags, joined with '; '. |
| `note` | TRADE | text | Your note. |
| `atr30_pips` | PRE | pips | ATR(14) (Wilder) of 30m candles, from the last 30m candle that closed at or before 08:00 New York on date_ny. |
| `pdh` | PRE | price | High of the last completed day (days close 17:00 New York). |
| `pdl` | PRE | price | Low of that day. |
| `on_high` | PRE | price | Overnight high: highest M5 high from 17:00 New York the day before to 08:00 on date_ny. |
| `on_low` | PRE | price | Overnight low. |
| `map_levels_above` | PRE | integer | Untaken levels above the 08:00 price on the RULEBOOK map (respected >= 1.0 x ATR, swings from the last 2 trading days). Information only. |
| `map_levels_below` | PRE | integer | Same, below. |
| `level_found` | SETUP | TRUE / FALSE | TRUE when a level of the app's map, on the side your trade fades (sells: above), was traded through after 08:00 and a 5m candle then closed back inside, all before your entry. |
| `level_type` | SETUP | EQH ONH PDH SH / EQL ONL PDL SL / NONE | Which level. If several were swept, the order EQ, ON, PD, swing; then the one nearest the sweep extreme. |
| `level_price` | SETUP | price | Its price. |
| `level_respect_atr` | SETUP | x ATR | Swing and equal levels only: how far price moved away from it after it formed, before 08:00, in multiples of atr30. Blank for PD and ON levels. |
| `level_age_days` | SETUP | trading days | Swing and equal levels only: time from the swing candle to 08:00, in days of 24 h counted on weekdays. Blank for PD and ON. |
| `eq_spread_atr` | SETUP | x ATR | Equal levels only: distance between the two swings, in multiples of atr30. |
| `levels_swept_count` | SETUP | integer | How many map levels on that side were traded through between 08:00 and the confirmation. |
| `break_time_ny` | SETUP | YYYY-MM-DD HH:MM | First 5m candle after 08:00 that traded beyond the level by any amount. |
| `sweep_extreme` | SETUP | price | Most extreme price from the break candle to the confirmation candle (sells: highest high). |
| `sweep_depth_pips` | SETUP | pips | How far beyond the level that went. |
| `sweep_depth_atr` | SETUP | x ATR | sweep_depth_pips / atr30_pips. |
| `max_closes_beyond` | SETUP | integer | Longest run of consecutive 5m closes beyond the level, from the break to the confirmation. |
| `conf_time_ny` | SETUP | YYYY-MM-DD HH:MM | First 5m candle, from the break candle on, that closed back inside the level (sells: below it). Its open time. |
| `conf_min_ny` | SETUP | minutes | The minute that candle CLOSED, after 00:00 New York (08:35 open = 08:40 close = 520). |
| `candles_to_close_back` | SETUP | 5m candles | Break candle to confirmation candle, both included (a wick that closes back = 1). |
| `entry_delay_candles` | SETUP | 5m candles | 5m candles from the confirmation close to your fill (0 = filled at that close). |
| `rule_entry` | SETUP | price | Rule entry: the confirmation candle's close. |
| `rule_stop` | SETUP | price | Rule stop: sweep_extreme + spread + 1 pip (buys: minus). |
| `rule_risk_pips` | SETUP | pips | abs(rule_entry - rule_stop). |
| `stop_diff_pips` | SETUP | pips | abs(your stop_loss - rule_stop): did you place the stop the rule way. |
| `opp_taken_in_window` | SETUP | TRUE / FALSE | TRUE if any level on the opposite side of the map (rulebook thresholds) was traded through between 08:00 and the confirmation: the big move already happened. |
| `opp1_type` | SETUP | level code / blank | The 1st nearest untaken opposite-side level of the app's map at the confirmation close (sells: below rule_entry). |
| `opp1_pips` | SETUP | pips | Its distance from rule_entry. |
| `opp1_respect_atr` | SETUP | x ATR | As level_respect_atr (blank for PD and ON). |
| `opp1_age_days` | SETUP | trading days | As level_age_days (blank for PD and ON). |
| `opp2_type` | SETUP | level code / blank | The 2nd nearest untaken opposite-side level of the app's map at the confirmation close (sells: below rule_entry). |
| `opp2_pips` | SETUP | pips | Its distance from rule_entry. |
| `opp2_respect_atr` | SETUP | x ATR | As level_respect_atr (blank for PD and ON). |
| `opp2_age_days` | SETUP | trading days | As level_age_days (blank for PD and ON). |
| `opp3_type` | SETUP | level code / blank | The 3rd nearest untaken opposite-side level of the app's map at the confirmation close (sells: below rule_entry). |
| `opp3_pips` | SETUP | pips | Its distance from rule_entry. |
| `opp3_respect_atr` | SETUP | x ATR | As level_respect_atr (blank for PD and ON). |
| `opp3_age_days` | SETUP | trading days | As level_age_days (blank for PD and ON). |
| `opp4_type` | SETUP | level code / blank | The 4th nearest untaken opposite-side level of the app's map at the confirmation close (sells: below rule_entry). |
| `opp4_pips` | SETUP | pips | Its distance from rule_entry. |
| `opp4_respect_atr` | SETUP | x ATR | As level_respect_atr (blank for PD and ON). |
| `opp4_age_days` | SETUP | trading days | As level_age_days (blank for PD and ON). |
| `opp5_type` | SETUP | level code / blank | The 5th nearest untaken opposite-side level of the app's map at the confirmation close (sells: below rule_entry). |
| `opp5_pips` | SETUP | pips | Its distance from rule_entry. |
| `opp5_respect_atr` | SETUP | x ATR | As level_respect_atr (blank for PD and ON). |
| `opp5_age_days` | SETUP | trading days | As level_age_days (blank for PD and ON). |
| `opp6_type` | SETUP | level code / blank | The 6th nearest untaken opposite-side level of the app's map at the confirmation close (sells: below rule_entry). |
| `opp6_pips` | SETUP | pips | Its distance from rule_entry. |
| `opp6_respect_atr` | SETUP | x ATR | As level_respect_atr (blank for PD and ON). |
| `opp6_age_days` | SETUP | trading days | As level_age_days (blank for PD and ON). |
| `post_status` | POST | COMPLETE / PENDING / NO_SETUP | PENDING until the replay has passed 16:00 New York of date_ny (no candle past the replay's furthest point is ever read). NO_SETUP when level_found is FALSE. |
| `stop_hit` | POST | TRUE / FALSE | Did any M5 candle after the confirmation candle trade to rule_stop before 16:00 New York. |
| `stop_time_ny` | POST | YYYY-MM-DD HH:MM | When. |
| `mfe_pips_before_stop` | POST | pips | Best move in the trade's favour from rule_entry (sells: rule_entry - lowest low), over M5 candles after the confirmation candle, up to 16:00 or up to (not including) the candle that hit rule_stop. Any target closer than this was reached first. |
| `pnl_pips_at_1600` | POST | pips | rule_entry minus the close of the last M5 candle before 16:00 (sells; buys reversed), only when stop_hit is FALSE. |
| `phase2_r_gross` | POST | R | The rulebook's Phase 2 on the rule trade with the rulebook's defaults (target = nearest qualifying level at least 2R away, 1 pip before it): 50% off at the first internal level at least 1R away, stop to entry after that, then trailed beyond each new confirmed 5m swing; exits at stop, target or 16:00. Before costs. Blank if no target qualifies. |

### sweep_days.csv

| Column | Group | Format | Exact rule |
| --- | --- | --- | --- |
| `run_id` | DAY | text | Backtest id. |
| `date_ny` | DAY | YYYY-MM-DD | Every weekday New York date whose 08:00 the replay passed. One row per date per backtest. |
| `weekday` | DAY | text |  |
| `atr30_pips` | DAY | pips | As in the trade log. |
| `map_levels_above` | DAY | integer | As in the trade log. |
| `map_levels_below` | DAY | integer | As in the trade log. |
| `eq_levels` | DAY | integer | How many of those are equal highs or lows. |
| `sweeps_in_window` | DAY | integer | Rulebook-map levels that price traded beyond and then closed back inside within 3 5m candles, with the close between 08:00 and 11:00. Mechanical count: no room or daily-limit checks. |
| `trades_taken` | DAY | integer | Trades you opened on this date in this backtest. |
| `auto_setup` | DAY | TRUE / FALSE / blank | Stage 2 (optional): TRUE if the app's own detector finds a setup passing every rulebook rule. Blank until built. |

## Tests (`tests/test_sweep.py`)

1. **A built sell setup.** Synthetic day: a respected 30m swing high before 08:00, a 5m wick 2 pips above it at
   08:30 that closes back below it, equal lows 25 pips under. Check every SETUP field, the opposite-level list
   and the POST fields by hand. The same day upside down gives the buy mirror.
2. **No look-ahead.** Deleting every candle after the entry leaves PRE and SETUP unchanged; a `furthestTime`
   before 16:00 gives PENDING and blank POST fields.
3. **A run is still logged.** Three 5m closes above the level before it closes back: `max_closes_beyond = 3`;
   the workbook decides.
4. **Stop first.** A candle spanning both the stop and a target counts as the stop, and its low is not in `mfe_pips_before_stop`.
5. **Map rules.** A swing that was traded through before 08:00 is not on the map. Two swings within 0.1 x ATR
   become one EQ level. A swing within 0.1 x ATR of PDH is dropped. A swing that moved away 0.7 x ATR is on the
   app's map but not the rulebook map.
6. **Priority.** When ONH and a swing high are both swept before the entry, `level_type = ONH`.
7. **Idempotent save**, PENDING to COMPLETE after the replay passes 16:00, and `trade_of_day` / `level_attempt` counting.
8. **Header contract.** The header equals the list above, in order.
9. **Switch.** A journal with `{"logger": "nbb"}` gets no sweep file, and one without `strategy.json` gets neither.
10. Break each key test once on purpose to check it fails.

## How Jeevesh checks it by hand

1. Replay a morning, take a sweep trade at the confirmation close with the stop beyond the sweep, let it close, save.
2. In `sweep_log.csv`, `level_type` and `level_price` match the level you traded, `rule_entry` matches your fill,
   `stop_diff_pips` is about 0, and `opp1_*` is the nearest level on your chart below.
3. In the workbook, Data > Refresh All. Stats shows the trade under Actual and under the rule rows.

## Not in this stage

- **Stage 2: automatic setup finder** for every replayed day, filling `auto_setup`; this is what lets loosened rules be tested without new replays.
- **Stage 3: online version** (JavaScript port and a download button for the GitHub Pages site).
- **News**: no economic calendar yet; tag those trades `news`.

## Prompt to start it in Claude Code

> Read docs/plan-sweep-logger.md and build stage 1 with my usual daily routine: tests first where you can, both
> test suites green, the build log, a decision record (0019), commit and push. Use the column list exactly as
> written; the Excel workbook depends on those names. If the NBB logger exists, share its helpers through
> forex_replay/loglib.py. Ask me only if something in the spec contradicts the code.
