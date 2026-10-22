# 0024: Longer H1, H4 and D1 history before the minutes, and USDCAD and AUDUSD

- **Date:** 20 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("add as much data as you can for all three pairs in higher timeframes... up to 4 years of data for daily... and add data for two more currency pairs which have the highest liquidity"), with Claude on the choice of pairs and the design

## Two more pairs: USDCAD and AUDUSD

After EURUSD, USDJPY and GBPUSD, the most traded pairs are USDCNY, USDCAD and AUDUSD. USDCNY is left out because most brokers, FundedNext included, do not offer it. So the two added are **USDCAD** and **AUDUSD**, each with 1-minute candles from 1 Aug 2025 (about 450,000 a pair) from the same FundedNext account as the others.

- **AUDUSD** is quoted in dollars, priced like EURUSD.
- **USDCAD's** profit is in Canadian dollars and is converted to US dollars at each price, the same rule USDJPY already used ([0021](0021-more-pairs.md)). Checked in the app: a 10-pip stop at 1.3669 with 1% risk sized to 1.36 lots risking $99.49; by hand, 1.36 × 100 CAD ÷ 1.3669 = $99.49.

## Older history on the hourly, 4-hour and daily charts

MT5's own H1, H4 and D1 candles, up to 4 years before today, are kept as `data/<pair>_<H1|H4|D1>_mt5_*.csv.gz`. The data pipeline keeps the ones that closed before the first minute and writes them to `web/data/<pair>/<tf>/history.bin`, listed in the pair's manifest. On those charts the history comes first. It never changes during a replay, and indicators use it (an EMA 200 on D1 has real values from the first replay day).

A replay still runs on the minutes only. Clicking a history candle to start one says where the minutes begin. Every history candle closed before the first minute, so a replay never sees anything from its own future through it.

**Do the history and the minute-built candles follow the same rules?** Where MT5's H1, H4 and D1 candles overlap the minutes (Aug 2025 on, checked for EURUSD, USDJPY and AUDUSD), they are identical to the candles built from the minutes: 7,224 H1, 1,806 H4 and 301 D1 candles a pair, 100%. So there is no seam where the two meet.

**How far back it goes is what FundedNext has.** Asked repeatedly, the server gave:

| Pair | History before the minutes |
|---|---|
| AUDUSD | 20 Oct 2022 to 31 Jul 2025 (the full 4 years; the server holds D1 back to 1993) |
| EURUSD, GBPUSD, USDJPY, USDCAD | 1 Jan 2024 to 31 Jul 2025 (all FundedNext has) |

More years for those four would need another broker's demo account. Its prices would differ slightly (as Five Percent Online's did, [0022](0022-one-minute-candles.md)), so it was not mixed in.

## Not yet done

- M15 and M30 have no older history (MT5 has them, but they were not asked for).
- The NBB and sweep logs still measure from the minutes only; their daily and weekly structure could use the older daily candles.
- FundedNext also has 1-minute candles from 1 Jan 2024 for every pair. Replaying from then would mean about 1 million minutes a pair, roughly twice the loading time; it was not asked for.
