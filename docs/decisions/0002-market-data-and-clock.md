# 0002: Market data (EURUSD M5 from MT5), stored in UTC, shown in India time

- **Date:** 27 Sep 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (EURUSD only, M5 is the lowest timeframe needed, data from Aug 2025, India time), with Claude on the storage format and time conversion

## Data source

The source is the MetaTrader 5 "Export Bars" file from the broker Jeevesh trades with, so price levels match the account being tested. The export also carries the broker's spread for each candle. The original plan was a free Dukascopy feed; the broker's own feed replaced it because it removes the mismatch between test data and the traded account.

## The clock problem

MT5 exports candles in **broker server time**, not UTC. The data shows the trading week opening at Monday 00:05 server time **every** week of the year, including the three weeks in March (and one in autumn) when the US has changed its clocks and Europe hasn't yet. The only clock that behaves like that is **New York time + 7 hours**. So:

```
UTC = (server time - 7 hours), read as America/New_York, converted to UTC
```

This is exact through daylight-saving changes. The New York clock changes at 02:00 on a Sunday, when the market is closed, so no candle falls in an ambiguous hour. The pipeline would raise an error if one ever did.

Everything is stored in UTC and shown in **India Standard Time (UTC+5:30)**, which has no daylight saving. From day 3, session shading uses each session's own city clock (Tokyo, London, New York), so London's open correctly moves between 12:30 and 13:30 IST through the year.

## Storage format

One binary file per UTC month (`web/data/EURUSD/M5/2025-08.bin`) plus `manifest.json` and `quality.json`. Each candle is 7 little-endian 32-bit integers:

| Field | Meaning |
| --- | --- |
| time | candle open, UTC unix seconds |
| open, high, low, close | price in points (price × 100,000) |
| volume | tick volume |
| spread | broker spread in points |

Prices are stored as **integers** so that fills are exact: a stop at 1.08500 is hit by a low of exactly 1.08500, with no floating-point near-misses. A year of M5 is about 2.3 MB, small enough to load entirely into the browser.

## Quality checks (run on every rebuild)

- Candles with impossible OHLC values stop the build.
- Where two exports contain the same candle, the newer file wins; the count is reported.
- Gaps are classified as weekend closes, holiday closes, or short gaps inside the week. Most short gaps are the broker's daily rollover pause around 02:30 IST.

## Known limits

- The MT5 terminal's login had expired on 27 Sep 2026, so the export ends on 11 Sep 2026. Logging in and exporting again, then restarting the app, rebuilds the data automatically.
- The spread column is mostly 0 (a raw-spread account), so commission and a minimum spread setting are added on day 4.
