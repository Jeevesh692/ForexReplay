# 0018: The NBB logger measures every NBB rule for each trade, in Python, at save time

- **Date:** 13 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the spec `docs/plan-nbb-logger.md` and `NBB_Backtest_Log.xlsx`, written with another chat: "it will log all the details automatically for me and I will only trade"; desktop app first), with Claude on the points below where the spec left room

## What it does

When a session of a strategy whose `strategy.json` says `"logger": "nbb"` is saved, `forex_replay/nbb.py` writes `nbb_log.csv` (one row per closed trade, 72 columns) and `nbb_days.csv` (one row per weekday whose 00:00 New York the replay passed, 13 columns) beside the journal. The column names and their order are the spec's, checked by a test against the spec file itself. A logger error is shown in the status bar ("NBB log not written: ...") and never stops the session being saved. `python -m forex_replay nbb <strategy>` rebuilds both files from every saved session, so a fix can be re-run over old work.

Why Python and at save time: the server already writes the journal then, and a rebuild command can re-run changed rules over old sessions (the spec's reasoning). The online version has no logger yet.

## Choices made where the spec left room

**Which candles.** The logger reads the same M5 files the browser replays (`web/data`, built from the MT5 exports by `datapipe.py`), not the raw exports. So it measures exactly the candles you traded on, with the same start date (1 Aug 2025). They are read once and kept in memory until the data is rebuilt.

**No look-ahead, made structural.** Each part cuts the candles before it measures anything (`Candles.until`) and builds 15m, H4, D1 and weekly candles from that cut. PRE: candles before 00:00 New York. SETUP: candles up to the order. POST: candles up to 16:00, only once the replay has passed 16:00 (PENDING until then; the next save fills them). A test deletes every candle after the order, with price running above H2 later in the day, and checks that every PRE and SETUP field stays the same. Removing both of the code's guards on purpose made it fail.

**The rule Fibonacci is the one exception the spec itself makes.** `fib_0` is defined as the leg "at the moment 0.62 is first touched inside the killzone", which can come after the order. So `fib_0`, `fib_0_time_ny`, `leg_pips`, `opp_pd_between`, `opp_pd_type`, `entry_fib_level` and `stop_fib_level` use candles after the order, but never past the replay's furthest candle. While the killzone has not been fully replayed they are provisional, and the row says PENDING. The no-look-ahead test covers the other SETUP fields.

**Buys are measured on mirrored candles.** Every price is negated, so highs become lows, and the sell rules run on that. Prices are negated back for output. This means one set of rules, not two that could drift apart. A test turns the hand-built sell day upside down and checks that every buy field is the mirror of the sell.

**Nearest and hit.** `nearest_pd_type` is the nearest array to the 00:00 open, with the priority (PWH, PDH, BRK, OB, FVG; D1 before H4) only breaking ties. `pd_hit_type` takes the priority first, then the nearest. The arrays are the trade's side for `pd_hit_type` (an H2 high can only trade into bearish arrays). For `nearest_pd_type` they are the bias side, or the trade's side when the bias is NONE, as the spec says.

**Structure.** The latest confirmed swing high and low. Once one is broken, a break needs the next swing to form. An older, still-unbroken swing is not remembered.

**Fixed leg inside one 15m candle.** Once the leg is fixed, the M5 candles decide which came first, a 0.62 touch inside a killzone or a lower low. Fixing (a 15m close above the previous candle's high) is checked when the 15m candle closes. "Inside a killzone" means either killzone, London or NY.

**Deepest levels include the stop candle.** If price went from 0.6 to beyond 1.0 in one M5 candle, every entry level filled on that candle and was stopped. Leaving the candle out would show an entry at 0.62 as never filled and hide a loss. A candle that reaches the target is left out, because whether an entry filled before the target on it is unknown.

**Phase 2 details.**
- On the fill candle, only the stop is checked (the order of the touches inside it is unknown).
- Break-even (after a 15m close beyond 0.20) applies before the half is taken.
- The runner's trailing stop goes exactly at each newly confirmed 15m swing high, with no extra buffer, and only ever moves toward profit.
- `be_triggered` and `target_momentum` are FALSE when there was no fill, or price never reached 0.0.

**Smaller points.**
- H2 is the first candle to make the day's high.
- ADR(5) uses the 5 server days that closed before the server day containing 00:00 New York.
- ATR(14) on 15m runs from the first candle of the data, as the browser's indicator does.
- `placed_time_ny` is the open time of the last candle shown when the order was placed, as the app records it.

**Speed.** The app saves about every 1.5 seconds while a replay plays. A trade row that is COMPLETE or NO_SETUP, and a day already logged, can no longer change, so a save reuses them. It refreshes only what can still change: the note, the tags, your Fibonacci drawing, and the day's trade count. A test checks that saving step by step gives byte-for-byte the same files as working everything out at once. Measured on the real data:
- a trade takes about 0.13 to 0.2 seconds
- a day takes about 0.03 seconds
- 80 trades and 40 days at once took 11.4 seconds, a cost paid only the first time

## Checked with the workbook

80 made-up trades on real candles (2 Feb to 27 Mar 2026, London and NY, buys and sells) were logged and pasted into a copy of `NBB_Backtest_Log.xlsx` in Excel 16, the workbook's own "No Power Query?" route:
- Analysis, Day analysis and Stats recalculated with no error cells.
- With "Only trades passing all rules" set to No, every section filled: results by entry, killzone, side, PD array hit, weekday and month; what each rule is worth; discipline; days replayed.
- With it on Yes, every count was 0. The made-up trades were not NBB setups, and none passed every rule.

## Not yet done

- Stage 2 (the automatic setup finder for days without a trade: `auto_setup_ny`, `auto_setup_london` stay blank) and stage 3 (the online version), as the spec says.
- News: no economic calendar; tag news trades `news`.
- The sweep logger (journal days 5 and 6) shares `forex_replay/loglib.py`.
