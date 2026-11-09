# 0033: Order-flow data from ticks (order flow, Phase 1)

- **Date:** 9 Nov 2026
- **Status:** accepted. The code and tests are done; the data has not been downloaded yet, because MT5 was not logged in
- **Decided by:** Jeevesh Prakash (the order-flow brief, and "FundedNext ticks via MT5"; a new `orderflow` branch; install pyarrow), with Claude on the details below

## Where the ticks come from

The brief asked for Dukascopy. Its free feed has answered every request with HTTP 429 since 2 Nov 2026; checked again on 9 Nov. It now serves data only from a "requester pays" Amazon bucket, which needs the user's own AWS account. Jeevesh chose **FundedNext's own bid/ask ticks through the MetaTrader5 package**, for three reasons:

- they are the prices of the account he trades
- they are what Phase 10's MT5 indicators will read with `CopyTicks`
- the package is already installed

**The catch:** how far back FundedNext keeps ticks is not known yet. Forex tick volume there is usually 0, so ticks are counted, not read from the volume field.

## The definitions

- **Mid:** (bid + ask) / 2, stored as 2 × the price in points. The order-flow files keep whole numbers, as the rest of the app does, and a mid can fall on half a point.
- **Tick rule:** +1 if the mid rises, −1 if it falls, and the previous sign if it is unchanged.
  - **Claude's call:** the first tick ever has sign 0.
  - **Claude's call:** the sign carries from one day to the next, because ticks are one stream.
- **Bars and buckets:** M1 and 15-second, named by their open time in UTC, each with:
  - **Prices:** open, high, low and close of the mid.
  - **Counts:** tick count, and up and down ticks (ticks with sign +1 and −1).
  - **Spread:** the mean ask − bid of its ticks, in tenths of a point.

  Only bars with at least one tick exist.
- **Trading day:** the broker-server date, so it starts at 17:00 New York in summer and winter. The server clock is New York + 7 hours, and the conversion is the one the app already uses (`datapipe.server_to_utc`). Nothing is fixed to an IST time.
- **Same slot:** a bar's distance from its trading day's 17:00 New York start. **Claude's call:** a session's London-time slots move by an hour in the weeks the UK and US clocks disagree; the brief's day is a New York day.
- **Baseline:** the median tick count of the same slot over the **previous 20 trading days that have data**, never the day itself.
  - **Claude's call:** a trading day with data but no bar in a slot counts as 0 there.
  - **Claude's call:** until 20 earlier days exist, the baseline is missing. A short history therefore starts its RVOL 20 trading days in; it is not filled from fewer days.

## Files

- **For the browser:** `web/data/<PAIR>/flow/<M1|S15>/<YYYY-MM>.bin`, 10 int32 per bar, one file per UTC month, plus a `manifest.json`. A month of 15-second buckets is a few MB at most, well under Cloudflare Pages' 25 MB per file. Checked in tests only so far; the real sizes come with the download.
- **For the Python backtester:** `data_flow/<PAIR>_<M1|S15>.parquet`, with prices as decimals.
- **Quality report:** `data_flow/<PAIR>_quality.md` and `.json`. It lists:
  - gaps of more than 5 minutes inside the week, marking the 17:00 New York daily break
  - minutes with no ticks
  - spread spikes, meaning a minute whose average spread is more than 5 × its day's median, with the median taken as at least 1 point
- **Ticks cache:** `data_ticks/<PAIR>/<server day>.parquet`. A rerun fetches only missing days and refreshes the last two. `data_ticks/` and `data_flow/` are gitignored.
- **Instrument settings:** pip, pip value per lot, bin, bubble and absorption moves, stop buffer, and minimum and maximum stop, from the brief. They are written into each pair's manifest, so the later phases read them as defaults.

## How Python and the browser agree

The browser never computes bars; it reads Python's files (`web/js/flowdata.js`). A golden sample (`web/tests/fixtures/flow_golden.*`), written by `python -m forex_replay.flow`, is read back field for field by the JavaScript test. A Python test fails if the sample is out of date.

## Not yet done

- The download itself: it needs MT5 open and logged in.
- Then: how far the history goes, the real file sizes, and the quality report's findings.
