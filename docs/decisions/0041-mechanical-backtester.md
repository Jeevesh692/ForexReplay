# 0041: The mechanical backtester, Models A and B (order flow, Phase 9)

- **Date:** 9 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the order-flow brief, Phase 9), with Claude on the points the brief left open (marked below)

## What it is

```bash
python -m forex_replay mbt run [--config configs/mechanical.yaml] [--set model_a.leg_atr=2.5] [--name leg25] [--pairs EURUSD] [--from 2025-09-01] [--to 2026-10-31]
python -m forex_replay mbt compare <strategy> [--config ...]
```

**Settings:** every number is in `configs/mechanical.yaml`; the defaults are in `forex_replay/mechanical/config.py`.
- **`--set`** changes one setting without editing the file.
- **A misspelt setting** is refused, not silently ignored.
- **A run's files** go to `mechanical_output/<name>/` (gitignored), with the settings it used saved beside them:
  - **`trades.csv` and `trades.xlsx`:** the Phase 8 log's columns exactly. The rows are made by `oflog.trade_row` itself.
  - **`summary.md`:** the summary below.
  - **`skipped.csv`:** every setup and trigger the rules turned down, with the reason.
  - **`equity.csv`:** the balance after each trade.

## Built on the app's own parts, not copies (Claude's call)

There is a separate `backtester` branch (4 Nov, the Asia Sweep backtester) with its own costs and data loading. It was **not** used, so that there is still one definition of each thing:
- **Fills:** `broker.py`, the engine the replay is held to (stop first when both are hit in one candle, gaps, bid and ask).
- **Rules:** the Phase 2–7 definitions.
- **Summary:** `stats.py`, the app's statistics.
- **Candles:** the app's own 1-minute candles (bid), and the order-flow files the browser reads.

## The rules, where the brief left room

**Model A** (trend; the mirror for shorts):
1. **State:** "accepted above", from the market state (Phase 4) at each 5-minute close inside the window (18:30–21:30 IST by default).
2. **The break** is the start of the first 30-minute candle of the accepting run.
   - **The leg** runs from the last 15-minute swing low (lower than 2 candles on each side) before the break, to the highest high since.
   - **ATR(14)** on 15 minutes, at the last closed 15-minute candle.
3. **The leg's profile** (Phase 2) runs from the swing low's candle to the moment the setup is found. Of its LVN zones, the one whose middle lies in 30–70% of the leg, the nearest to 50%.
4. **Kill switch:** the setup ends when a close comes back inside value, value is accepted the other way, or the window ends.
5. **Trigger:** the trigger panel's rules (Phase 6) on a closed 5-minute candle that traded into the zone, after the setup was found. The order goes in at that close and fills at the next minute's open (the broker's market-order rule).
6. **Stop:** below the lower of the trigger candle's low and the zone's low, minus the buffer. Skipped if outside the pair's minimum and maximum.
7. **Target:**
   - **A POC target:** the nearest naked POC (Phase 3, last 5 days) at least 2R away. Used if it is within 4R.
   - **Otherwise:** no fixed target (Claude's reading of "3R with trailing beyond"). The cost check uses 3R, and from +3R the stop follows each new 15-minute swing low.
   - **Too small:** a target under 2R after costs (Phase 7) is skipped.

**Model B** (a failed break; the mirror for downside):
1. **The day opened inside the prior value.** "Balanced" (Claude's call): the prior day's POC lies in the middle 50% of that day's range.
2. **State:** "rejected above".
   - **The failed high:** the highest high in the rejection window before the rejection close.
   - **The reclaim leg:** from that high to the lowest low after it.
   - **Its profile:** of the LVN zones inside the leg, the one nearest its middle.
   - **"Do not take the first move back":** only candles closing after the rejection can trigger.
3. **Trigger and stop:** the pullback trades up into the zone and the short trigger passes. The stop is above the higher of the trigger candle's high and the zone's high, plus the buffer.
4. **Target:** the prior day's POC, at least 1.5R after costs, exit full.
5. **Out early:** when a 30-minute candle closes back above VAH.
6. **Variants:**
   - **`double_failure_only`:** two 15-minute swing highs above VAH in the rejection window.
   - **`hold_quarter`:** 75% closed at the POC; the last 25% kept for the opposite value edge only if the next 30-minute close is beyond the POC.

**Management:**
- **Breakeven at +1R:** the stop goes to entry + the round trip's commission and slippage (the spread is already in the fill), so a breakeven exit is 0R after costs.
- **Breakeven variants:** the second displacement candle (body and range rules) or CVD pressure (the last three 5-minute deltas in your favour).
- **Time stop:** at 45 minutes, out if the trade never reached +0.5R.
- **Stops are never widened.**
- **One trade at a time per model.**

**Limits:**
- **Trade counts:** 2 a session (the standard sessions, `sessions.session_label`) and 3 a day.
- **Stopping the day:** after 2 losses, or at +2R after costs.
- **Stopping the week:** at −3% of the week's starting balance.
- **News:** no entries 15 minutes either side of high-impact news for the pair's currencies (gold counts as USD). The news list is `configs/news.csv`, which starts empty: **you fill it**.
- **Risk:** 0.5%, or 0.25% after 2 losses in a row until a win. The size is the account's rule (`costs.units_for_risk`).

**The summary** uses `stats.py` on R after costs:
- trades, win rate, expectancy, total, profit factor
- maximum drawdown in R and in % of the account
- the longest losing streak
- results by pair, session, model and tag
- **"rejection → reached POC":** every rejection of the prior value in the period, both sides, and the share where price reached the prior day's POC by the day's end.

## The comparison with your manual trades

Each saved session of a strategy is replayed by the engine over the same pair and dates (from a day before its start). Trades on the same side placed within 15 minutes of each other are paired:
- **same:** stop and target within 1 pip
- **different:** both are shown
- **yours only:** the reason is what the rules turned down within 15 minutes, otherwise "outside both models' windows" or the market state at the time
- **the rules' only:** a trade the rules took that you did not

## Checked

- **A made-up market** built so that Model A must trade (`tests/test_mechanical.py`):
  - the pullback candles turned down ("close, rvol")
  - the trigger at the 13:20 UTC close, filled at 1.10190
  - the stop 1 pip under the zone
  - breakeven at +1R to entry + 6 points, stopped there for exactly 0.00R after costs
  - the same decision with the data cut a minute after the fill (no look-ahead)
  - limits, news and settings
  - the comparison: same, different, yours only
- **Broken on purpose:**
  - breakeven without costs
  - a stop ignoring the zone

  Each made a test fail.
- **Real data, the baseline settings:**
  - **EURUSD,** 28 Aug 2025 to 14 Oct 2026:
    - 4 trades (all Model A), −3.26R after costs, 1.60% drawdown
    - 756 setups or triggers turned down, with their reasons
    - of 491 trigger checks, the rules failed RVOL 412 times, the close 367, the range 336 and the body 234; only 26 failed on RVOL alone
  - **XAUUSD,** 21 Sep to 22 Oct 2026 (the tick history is short): no trades.
  - **Rejections:** 567 of 942 reached the prior POC (60%).
  - **Speed:** about 14 seconds a month of EURUSD.
- **The comparison on your "marco" strategy** (read only; its folder untouched):
  - 37 trades: 20 outside both windows, 16 with no setup (the state named), 1 turned down by Model B
  - 1 trade the rules took that you did not

## Found while building

- **The log's LVN zone differed from the engine's.** The profile drawing saved for the log ran to the entry, while the engine read the zone when it found the setup. The drawing now ends where the engine's profile did, and the log shows the same zone and retracement.
- **Finding a timestamp's trading day** cost 2 ms through pandas and took most of the time. A trading day always changes on a whole UTC hour, so `profile.server_day` now remembers its answer per hour. It was checked identical on 47,175 times over two years, and the run became twice as fast.
- **Three mistakes in my own made-up market:**
  - **A wrong hour:** 13:00 UTC is minute 900 of a day starting at 22:00.
  - **A dip** that ran into the next 15-minute candle, which tied its low.
  - **A morning too quiet** to give the leg a heavy base.

  The engine was right each time.

## Not yet done, and open for Jeevesh

- **Very few trades:** with all four trigger rules on, the baseline takes a handful of trades a year. Which rules to loosen, if any, is yours to choose: try `--set trigger.min_rvol=1.2` and the like.
- **The news file** needs your high-impact events.
- **Gold** has about a month of usable history (the ticks begin on 25 Aug 2026, then 20 days of baseline).
- **In-sample / out-of-sample tuning,** as the Strategy Lab plan does, is not part of this phase.
