# NBB logger: write every NBB rule measurement for each trade, automatically

Status: planned (13 Oct 2026). Asked for by Jeevesh: "it will log all the details automatically for me and I will only trade".
Companion files: `NBB_Backtest_Log.xlsx` (the analysis workbook; its Fields sheet is the same column contract as below)
and the rulebook "Market Maker + OTE Rulebook (NBB)".

## Goal

Every time a backtest is saved, write two CSV files next to the journal:

- `strategies/<journal>/nbb_log.csv`: one row per CLOSED trade, with the trade itself plus every measurement
  the NBB rules need (bias, Asian range, ADR, PD arrays, H1/L1/H2, displacement, the rule Fibonacci, and what
  price did afterwards).
- `strategies/<journal>/nbb_days.csv`: one row per New York date the replay passed, with the pre-session checks.

The workbook reads these files by column NAME (Power Query or paste), so order is free but names are fixed.
Jeevesh only trades; the app measures.

## Rules this must keep (from CLAUDE.md, plus two of its own)

1. **No look-ahead.** Never read an M5 candle after the backtest's `furthestTime`. PRE fields use candles
   before 00:00 New York of the trade's date. SETUP fields use candles up to `placedTime` only. POST fields use
   candles after the setup, and only once `furthestTime` has passed 16:00 New York of that date; until then
   `post_status = PENDING` and the POST fields stay blank. The next save fills them.
2. **Times are UTC seconds inside the code.** New York time only in output strings and for day boundaries
   (use `zoneinfo("America/New_York")`). Server time = New York + 7 h (datapipe).
3. **This is analysis, not the trading engine.** It never changes trades, fills or the journal. A bug here can
   be fixed and every log rebuilt from the saved backtests (`python -m forex_replay nbb <journal>`).
4. **Deterministic.** The same backtest file and candles always give byte-identical CSVs.

## Where the code goes

| File | What |
| --- | --- |
| `forex_replay/nbb.py` (new) | All of the logic below. Pure functions on a pandas M5 frame (UTC index, prices in points or decimals, spread in points) plus a backtest dict. |
| `forex_replay/backtests.py` | In `save()`, after the journal is written: `nbb.write_logs(data, root / journal)`. Wrapped so an NBB failure is logged and reported in the response (`nbbError`) but never blocks the save. |
| `forex_replay/__main__.py` | `python -m forex_replay nbb <journal>`: rebuild both CSVs from every saved backtest of that journal. |
| `forex_replay/server.py` | Keep the EURUSD M5 frame in memory after the first load (find_exports, then read_mt5_csv, then merge_exports, then server_to_utc), shared by every save. |
| `tests/test_nbb.py` (new) | Tests listed at the end. |
| `docs/decisions/0018-nbb-logger.md` | Why Python, why CSV, the no-look-ahead boundaries, what is not done. |

Why Python and not the browser: the server already writes the journal at save time, pandas makes the
multi-timeframe work short, and a rebuild command can re-run new rules over old backtests. The cost: the
online version (GitHub Pages, no server) gets no NBB log until stage 3.

## Definitions (use these exactly)

- **Trade date** `date_ny`: the New York calendar date of the trade's `entryTime`. **Day start** = 00:00 New York on that date.
- **Killzone** of a time: 02:00-05:00 New York = LONDON, 07:00-10:00 = NY, else NONE (end exclusive).
- **15m candles**: M5 grouped by `floor(utc / 900)`. **D1 / W1**: server-clock days and Monday-start weeks, as `reference_candles` builds them. A D1/H4/W1 candle counts only if it closed before the moment being measured.
- **Swing high** on any timeframe: a candle whose high is strictly above the highs of the 2 candles before and the 2 after; it is *confirmed* when the 2nd candle after it has closed. Swing low mirrors it.
- **ATR(14)**: Wilder, exactly as `web/js/indicators.js atr()`.
- **ADR(5)**: mean (high - low) of the last 5 completed server days before day start (as `adrBefore()`, period 5).
- **Pip** = 10 points on EURUSD (`pipPoints`). Output pips with 1 decimal, prices with 5, ratios with 2-3.
- **Structure** (daily or weekly): walk the completed candles of the last 120 days (30 weeks) in order. Track the latest confirmed swing high and swing low that have not been broken yet. A close above that swing high sets BULL and marks it broken; a close below that swing low sets BEAR and marks it broken. The value is the state after the last candle; NONE if nothing broke.
- **PD arrays** (all from completed candles before day start; D1 looks back 20 candles, H4 back 60). Bearish versions, for sells:
  - `PDH` / `PWH`: previous completed day's / week's high. Valid while price has not traded above it since.
  - `FVG_D1|H4`: candles k-2, k-1, k with `low[k-2] > high[k]`; zone `[high[k], low[k-2]]`. Valid while no later candle traded through the whole zone (a later high at or above `low[k-2]`).
  - `OB_D1|H4`: candle k closes up (`close > open`) and one of the next 3 candles closes below the latest confirmed swing low before k; zone `[low[k], high[k]]`. Valid while no later close is above `high[k]`.
  - `BRK_D1|H4`: candle k closes down and one of the next 3 candles closes above the latest confirmed swing high before k (a bullish order block); later a candle closes below `low[k]`. Zone `[low[k], high[k]]`. Valid while no close back above `high[k]` after that break.
  - Bullish versions (`PDL`, `PWL`, and the same codes) mirror these, for buys.
  - Priority when several qualify: PWH, PDH, BRK, OB, FVG; D1 before H4; then the nearest.

## The setup, step by step (sells; buys mirror every comparison)

Inputs: the trade, its date, M5 candles up to `placedTime`.

1. **H2** = the highest M5 high from day start up to `placedTime`; `h2_time` its candle. (For buys, the lowest low.)
2. **H2 candle (15m)** = the 15m candle containing `h2_time`. **H1** = the most recent confirmed 15m swing high whose confirming candle closed before the H2 candle opened, searched up to 64 candles back, with `H1 < H2`. **L1** = the lowest 15m low strictly between the H1 and H2 candles. No H1: `setup_found = FALSE`.
3. **Displacement** = the first 15m candle after the H2 candle with `close < L1`, that closes before `placedTime`, with no M5 high above H2 in between. Record `range / ATR14` (ATR of 15m candles ending at the candle before it), `body / range`, and its distance in candles from the H2 candle. None found: `setup_found = FALSE`.
4. **Rule Fibonacci**: 1.0 = H2. 0.0 = the leg low, starting with the displacement candle's low. Walk forward 15m candle by candle:
   - while not fixed: a lower low moves 0.0 down; a candle that closes above the previous candle's high fixes it;
   - once fixed: if price touches the 0.62 level `fib0 + 0.62 * (fib1 - fib0)` inside a killzone, the fib is final; if price makes a lower low first, 0.0 moves down and it is no longer fixed;
   - stop at the end of the trade's killzone (or the NY killzone if the trade has none), or at `furthestTime`, whichever comes first; the fib as it stands then is final.
   This walk may run past `placedTime`: it is the rule's fib, used for POST fields only. If it needs candles past `furthestTime`, mark POST as PENDING.
5. **Opposite array in the way**: any bullish PD array (as defined above, built at day start) with any part between the 0.62 price and `fib0`.
6. `entry_fib_level = (entryPrice - fib0) / (fib1 - fib0)`; `stop_fib_level` the same with the initial stop. (Same formula works for buys.)
7. **Your drawing**: the latest Fibonacci in the backtest's `drawings` whose second point time is at or before `placedTime` and whose direction matches the trade (sells: first point above second). Log its two prices.

## After the setup (POST), when `furthestTime` is past 16:00 New York of the date

Work on M5 candles from the time `fib0` was set. A fib level of a price is `(price - fib0) / (fib1 - fib0)`; for sells read highs for "how far back up" and lows for "back at the target"; buys mirror it.

- `time_062_ny`: first M5 candle inside the killzone whose level reached 0.62.
- `deepest_level_kz`: highest level reached by candles inside the killzone (the trade's, or NY if it has none), after `fib0` was set and before resolution. Blank if resolution came before the killzone opened.
- `resolution`: the first of: level <= 0 (TARGET), level >= 1 (STOP), or 16:00 New York (TIME). One M5 candle touching both = STOP (same rule as the engine).
- `deepest_level_total`: highest level reached before resolution. `level_at_1600`: level of the close of the last M5 candle before 16:00, when the resolution is TIME.
- `be_triggered`, `target_momentum`, `phase2_r_gross`: simulate the rulebook's Phase 2 on a 0.62 limit filled at `time_062` with the stop at 1.0, gross of costs. Break-even after a 15m close beyond 0.20. At 0.0: half closes. If that 15m candle closed beyond 0.0 with body >= 50% of its range, the other half stays, stop at 0.0, then trails to just beyond each newly confirmed 15m swing high; it closes at `fib1 - ADR5` or 16:00. Otherwise the other half closes at that candle's close. No fill (`time_062` blank): `phase2_r_gross` blank.

## Output files

Rewrite each file atomically (tmp then replace). Keys: trades `(run_id, trade_id)`, days `(run_id, date_ny)`.
A save recomputes and replaces every row of its own run; other runs' rows are kept. Sort by `date_ny`, then `run_id`, then `trade_id`.
Booleans as `TRUE` / `FALSE`. Blank = empty field. Header exactly as below, in this order.

### nbb_log.csv

| Column | Group | Format | Exact rule |
| --- | --- | --- | --- |
| `run_id` | TRADE | text | The backtest id (same as run_id in trades.csv). |
| `trade_id` | TRADE | integer | The trade's id inside its backtest. (run_id, trade_id) is unique; a re-save replaces the row, never duplicates it. |
| `date_ny` | TRADE | YYYY-MM-DD | New York calendar date of entry_time. The trade's 'day' for every PRE field. |
| `weekday` | TRADE | text | Weekday of date_ny. |
| `killzone` | TRADE | NY / LONDON / NONE | Where entry_time falls, in New York time: 07:00-10:00 = NY, 02:00-05:00 = LONDON, anything else = NONE. |
| `side` | TRADE | SELL / BUY | Trade direction. |
| `order_type` | TRADE | LIMIT / MARKET / STOP | How the order was placed. |
| `placed_time_ny` | TRADE | YYYY-MM-DD HH:MM | When the order was placed, New York time. |
| `entry_time_ny` | TRADE | YYYY-MM-DD HH:MM | When it filled, New York time. |
| `exit_time_ny` | TRADE | YYYY-MM-DD HH:MM | When it closed (last part), New York time. |
| `entry_price` | TRADE | price | Fill price. |
| `stop_loss` | TRADE | price | The initial stop (the one that defines 1R). |
| `take_profit` | TRADE | price | Target as placed. |
| `exit_price` | TRADE | price | Exit price of the last part. |
| `exit_reason` | TRADE | STOP_LOSS / TAKE_PROFIT / MANUAL | Why it closed. |
| `lots` | TRADE | lots | Size. |
| `actual_r` | TRADE | R | Result as you actually traded it (partials, break-even and all), from the engine's resultR. Spread is in the fills; commission is not. |
| `pnl_usd` | TRADE | USD | Money result from the account (after commission). |
| `commission_usd` | TRADE | USD | Commission charged. |
| `risk_pips` | TRADE | pips | Distance entry to initial stop. |
| `spread_pips` | TRADE | pips | Spread used on the entry candle (after the app's minimum-spread setting). |
| `tags` | TRADE | text | Your tags, joined with '; '. |
| `note` | TRADE | text | Your note. |
| `adr5_pips` | PRE | pips | Mean (high - low) of the last 5 COMPLETED daily candles (days close 17:00 New York) before 00:00 NY of date_ny. Same arithmetic as adrBefore() in adrplan.js with period 5. |
| `daily_structure` | PRE | BULL / BEAR / NONE | Completed daily candles only. Swing high = high above the 2 candles before and the 2 after (mirror for lows). Walk forward: a close above the latest confirmed, unbroken swing high sets BULL; a close below the latest confirmed, unbroken swing low sets BEAR. The value is the state after the last completed day. NONE if no break in the last 120 days. |
| `weekly_structure` | PRE | BULL / BEAR / NONE | Same rule on completed weekly candles (weeks built from the completed daily candles, Monday-start on the server clock). |
| `bias` | PRE | SELL / BUY / NONE | SELL if both are BEAR, BUY if both are BULL, otherwise NONE. |
| `asian_high` | PRE | price | Highest high of M5 candles from 20:00 to 00:00 New York (the evening before date_ny). |
| `asian_low` | PRE | price | Lowest low of the same candles. |
| `asian_range_pips` | PRE | pips | asian_high - asian_low. |
| `open_0000` | PRE | price | Open of the M5 candle that starts at 00:00 New York on date_ny. |
| `pdh` | PRE | price | High of the last completed daily candle before 00:00 NY. |
| `pdl` | PRE | price | Low of the same candle. |
| `pwh` | PRE | price | High of the last completed week. |
| `pwl` | PRE | price | Low of the last completed week. |
| `nearest_pd_type` | PRE | PDH PWH FVG_D1 FVG_H4 OB_D1 OB_H4 BRK_D1 BRK_H4 (mirror PDL PWL ...) / NONE | The bias-side PD array nearest to open_0000 (side of the trade if bias is NONE). Sells: arrays at or above the open; buys: at or below. Definitions in the spec, section 'PD arrays'. |
| `open_dist_pips` | PRE | pips | Distance from open_0000 to that array's near edge; 0 when the open is inside it. |
| `setup_found` | SETUP | TRUE / FALSE | TRUE when H2, H1, L1 and a displacement candle were all found by the rules below, using candles up to placed_time only. |
| `h2_price` | SETUP | price | Sells: highest M5 high from 00:00 NY of date_ny to placed_time (the high of the day so far). Buys: lowest low (L2). |
| `h2_time_ny` | SETUP | YYYY-MM-DD HH:MM | Time of the M5 candle that made it. |
| `h2_beyond_asian_pips` | SETUP | pips | Sells: h2_price - asian_high. Buys: asian_low - h2_price. Positive = it ran through the Asian range. |
| `pd_hit_type` | SETUP | same codes as nearest_pd_type / NONE | The bias-side PD array H2 traded into: a zone counts when H2 is inside or beyond it; PDH/PWH (PDL/PWL) count when H2 is beyond them. If several, the order PWH, PDH, BRK, OB, FVG (D1 before H4). |
| `pd_hit_beyond_pips` | SETUP | pips | For PDH/PWH/PDL/PWL hits: how far H2 went beyond the level. Blank for zones. |
| `h1_price` | SETUP | price | The most recent confirmed 15m swing high before the H2 candle (2 candles each side, all closed before the H2 candle). Buys: swing low. |
| `h1_time_ny` | SETUP | YYYY-MM-DD HH:MM | Its time. |
| `h1_candles_before_h2` | SETUP | 15m candles | How many 15m candles from H1 to the H2 candle. Searched up to 64 back; the 20-candle limit is applied in Excel. |
| `l1_price` | SETUP | price | Lowest 15m low strictly between the H1 and H2 candles (buys: highest high). |
| `disp_time_ny` | SETUP | YYYY-MM-DD HH:MM | The first 15m candle after the H2 candle that closes below L1 (buys: above H1), before price trades beyond H2 again and before placed_time. |
| `disp_range_atr` | SETUP | ratio | That candle's (high - low) divided by ATR(14) of 15m candles ending at the candle before it. |
| `disp_body_pct` | SETUP | fraction 0-1 | abs(close - open) / (high - low) of that candle. |
| `disp_candles_after_h2` | SETUP | 15m candles | 15m candles from the H2 candle to the displacement candle. |
| `fib_1` | SETUP | price | Rule Fibonacci 1.0 = h2_price. |
| `fib_0` | SETUP | price | Rule Fibonacci 0.0 = the leg low: lowest low from the displacement candle on, fixed when a 15m candle closes above the previous candle's high. If price makes a lower low before touching the 0.62 level, it moves to the new low and waits to be fixed again. Final value = the leg at the moment 0.62 is first touched inside the killzone (or at the killzone's end if never). |
| `fib_0_time_ny` | SETUP | YYYY-MM-DD HH:MM | Time of that low. |
| `leg_pips` | SETUP | pips | fib_1 - fib_0 in pips (always positive). |
| `opp_pd_between` | SETUP | TRUE / FALSE | TRUE if an opposite-side PD array (sells: PDL, PWL, bullish D1/H4 FVG, OB or breaker) lies between the 0.62 price and fib_0. |
| `opp_pd_type` | SETUP | code / blank | Which one, if any. |
| `entry_fib_level` | SETUP | fib level | Where your actual fill sits on the rule Fibonacci: (entry - fib_0) / (fib_1 - fib_0) for sells, mirror for buys. |
| `stop_fib_level` | SETUP | fib level | Where your initial stop sits on the same scale. |
| `user_fib_found` | SETUP | TRUE / FALSE | TRUE if you had a Fibonacci drawing in the trade's direction whose second click (0.0) was before placed_time. The latest such drawing is used. |
| `user_fib_1` | SETUP | price | Your drawing's 1.0 price (first click). |
| `user_fib_0` | SETUP | price | Your drawing's 0.0 price (second click). Compare with fib_1 / fib_0 to see if you drew it the rule way. |
| `post_status` | POST | COMPLETE / PENDING / NO_SETUP | PENDING while the replay has not yet passed 16:00 NY of date_ny (no candle after the replay's furthest point is ever read). NO_SETUP when setup_found is FALSE. The other POST fields are blank unless COMPLETE. |
| `time_062_ny` | POST | YYYY-MM-DD HH:MM / blank | First M5 candle inside the trade's killzone (or, with no killzone, the NY killzone) whose high (sells) reached the 0.62 price of the final rule Fibonacci. |
| `deepest_level_kz` | POST | fib level | Highest fib level reached during the killzone's hours (sells: by highs; buys: by lows), counting only candles after fib_0 was set and before resolution. Blank if resolution came before the killzone opened. Decides which entry levels would have filled. |
| `deepest_level_total` | POST | fib level | Same, but up to resolution or 16:00 NY. Decides whether a tighter stop (0.9) would have been hit. |
| `resolution` | POST | TARGET / STOP / TIME | After fib_0 is final, the first of: price back at fib_0 (TARGET), price at fib_1 (STOP), or 16:00 NY (TIME). Same M5 candle touching both = STOP, like the engine. |
| `resolution_time_ny` | POST | YYYY-MM-DD HH:MM | When it happened. |
| `level_at_1600` | POST | fib level | Fib level of the 16:00 NY close when resolution is TIME (blank otherwise). |
| `be_triggered` | POST | TRUE / FALSE | TRUE if, after a 0.62 fill, a 15m candle closed beyond the 0.20 level before resolution. |
| `target_momentum` | POST | TRUE / FALSE | TRUE if the 15m candle that reached fib_0 closed beyond it with body >= 50% of its range. |
| `phase2_r_gross` | POST | R | Result of the rulebook's Phase 2 management on a 0.62 entry with the stop at 1.0: break-even after a 15m close beyond 0.20; half off at 0.0; the runner kept only on a momentum close, its stop at 0.0 then trailed beyond each new confirmed 15m swing; runner closed at h2_price - ADR5 (sells; buys + ADR5) or 16:00 NY. Before spread and commission. |

### nbb_days.csv

One row per New York date whose 00:00 lies between the backtest's `startTime` and `furthestTime`, Monday to Friday only.

| Column | Group | Format | Exact rule |
| --- | --- | --- | --- |
| `run_id` | DAY | text | Backtest id. |
| `date_ny` | DAY | YYYY-MM-DD | Every New York date whose 00:00 the replay passed (start to furthest point). One row per date per backtest. |
| `weekday` | DAY | text |  |
| `adr5_pips` | DAY | pips | As in the trade log. |
| `daily_structure` | DAY | BULL / BEAR / NONE | As in the trade log. |
| `weekly_structure` | DAY | BULL / BEAR / NONE | As in the trade log. |
| `bias` | DAY | SELL / BUY / NONE | As in the trade log. |
| `asian_range_pips` | DAY | pips | As in the trade log. |
| `nearest_pd_type` | DAY | code / NONE | As in the trade log, on the bias side (blank if bias is NONE). |
| `open_dist_pips` | DAY | pips | As in the trade log. |
| `trades_taken` | DAY | integer | Trades you opened with entry on this date in this backtest. |
| `auto_setup_ny` | DAY | TRUE / FALSE / blank | Stage 2 (optional): TRUE if the rule detector finds a valid setup whose 0.62 was touched in the NY killzone. Blank until built. |
| `auto_setup_london` | DAY | TRUE / FALSE / blank | Stage 2 (optional): same for the London killzone. |

## Tests (`tests/test_nbb.py`)

1. **A built setup is found.** Synthetic M5 day: a tight Asian range, a run above PDH making the high of the day after a lower swing high, a strong 15m close below L1, a pullback to 0.62, then a drop to 0.0. Every SETUP and POST field equals hand-worked values. Then the same day flipped upside down gives the buy mirror.
2. **No look-ahead.** For the same backtest, deleting every candle after `placedTime` leaves every PRE and SETUP field unchanged. Deleting every candle after `furthestTime` (set before 16:00) gives `post_status = PENDING` and blank POST fields.
3. **Weak displacement** (range under 1 x ATR) still logs the trade, with the measured ratio; the workbook decides. **No H1** gives `setup_found = FALSE` and `post_status = NO_SETUP`.
4. **Resolution order.** One M5 candle spanning both 0.0 and 1.0 resolves as STOP.
5. **Re-anchoring.** A lower low before the 0.62 touch moves `fib0`.
6. **Idempotent save.** Saving the same backtest twice gives identical files; saving after the replay passes 16:00 turns PENDING into COMPLETE.
7. **Header contract.** The header equals the column list above, in order (the same list the workbook's Fields sheet shows).
8. **Day rows.** A replay from Monday 00:00 to Wednesday 12:00 New York gives Monday, Tuesday and Wednesday rows.
9. Break each key test once on purpose to check it fails (as with the earlier days).

## How Jeevesh checks it by hand

1. Replay a day, draw the fib, place a 0.62 sell limit with the stop at H2, let it close, save.
2. Open `strategies/<journal>/nbb_log.csv`: the row's `h2_price`, `fib_0` and `user_fib_*` match the chart; `entry_fib_level` is about 0.62.
3. In the workbook, Data > Refresh All. Stats shows the trade under Actual and under Rule entry.

## Not in this stage

- **Stage 2: automatic setup finder.** Run steps 1-6 for every replayed day and killzone without a trade (H2 = high of day up to each 15m candle) and fill `auto_setup_ny` / `auto_setup_london`. That shows missed setups and lets loosened thresholds be tested without new replays.
- **Stage 3: online version.** A JavaScript port and a "Download NBB CSVs" button for the GitHub Pages site.
- **News.** No economic calendar in the app yet; trades tagged `news` can be filtered in the workbook.

## Prompt to start it in Claude Code

> Read docs/plan-nbb-logger.md and build stage 1 with my usual daily routine: tests first where you can, both
> test suites green, the build log, a decision record (0018), commit and push. Use the column list exactly as
> written; the Excel workbook depends on those names. Ask me only if something in the spec contradicts the code.
