# 0022: The replay runs on 1-minute candles; the logs still measure 5-minute ones, built from the minutes

- **Date:** 14 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("make the app use 1-minute candles", after the M1 history was exported), with Claude on the design

## What changed

Every pair is now built from its **M1** export (FundedNext, 31 Jul 2025 to 14 Oct 2026, about 445,000 candles a pair):
- **One clock:** the replay clock moves one minute at a time.
- **Every timeframe from the minutes:** M1 (new on the chart), M5, M15, M30, H1, H4, D1, each with its forming candle.
- **Fills on the minutes:** an order is filled on M1 candles, never on the minute it was placed. Stop-first when a minute touches both stop and target, as before.

The two rules in CLAUDE.md that said M5 now say M1 (the base candles). The engine itself did not change: it never knew which candle size it was given.

**All three pairs come from one broker.** EURUSD used to come from a Five Percent Online export. FundedNext's EURUSD minutes, built into M5, match that file on only 0.25% of candles: same clock, slightly different prices. FundedNext's own GBPUSD M5 matched M5 built from its minutes on 100% of candles. So EURUSD now comes from FundedNext too. The old Five Percent file stays in `data/` but is no longer read: the pipeline reads only M1 exports.

Jeevesh had no saved sessions, so nothing needed converting. A session now records its base candle (`barSeconds: 60`). Resume refuses, in plain words, to rebuild a session on a different candle size than it was replayed on.

## The logs

The NBB and sweep specs are written in 5-minute candles (5m swings, "candles to close back", 15m and 30m built from M5), and the workbooks expect that. So the logs still measure on M5, built from the session's minutes the broker's way (first open, highest high, lowest low, last close).

**A 5-minute candle counts only once it has closed.** An order at 08:37 sees the 08:30 candle (closed 08:35), never the 08:35 one still forming; an order at 08:39, filled 08:40, sees it. Tests:
- A session on minutes logs exactly what the same session on 5-minute candles logged, when the times line up.
- A sweep confirmed on the 08:35 candle is not found for an entry at 08:38, and is found for one at 08:40.
- Deleting every minute after an entry changes nothing measured before it.
- Letting the logs see the forming candle on purpose made 2 tests fail.

The entry's spread now comes from the exact minute it filled on.

## Data on GitHub

The three M1 exports are kept compressed (`.csv.gz`, about 5 MB each instead of 27 MB). The pipeline reads them directly, so a clone, a friend's copy and the website all have the minutes.

## The chart holds a window of candles, not all of them

Showing 445,000 minutes made the app slow. Measured 14 Oct 2026:
- **Switching timeframe** took 2 to 5 seconds. The chart library alone needed about 2 seconds to take in 445,000 candles.
- **Each 1-minute replay step** took 114 ms. The cause was found by elimination: while the mouse is over the chart, the library works out the crosshair again on every update, across every candle it holds. In a bare chart, an update took 3 ms at 2,000 candles, 9 ms at 10,000, 26 ms at 30,000 and 96 ms at 89,000.

That last cost was already there before this change: with 83,000 M5 candles, a replay step with the mouse over the chart took about 90 ms. The day-13 measurement of about 3 ms per step must have been taken with the mouse elsewhere.

So the chart is handed a **window**: the newest 3,000 candles of the timeframe, or 3,000 around a date you jump to.
- **Scrolling near either edge reaches further.** The window holds at most 6,000 candles.
- **"Latest" returns** the window to the newest candles.
- **Indicators still use every candle.** They are worked out on all of them and then cut to the window, so no value depends on it.
- **No candle positions shift.** The drawing layer and overlays see the window as their candles, and the few calls that come from outside in absolute positions (replay updates, clicks, the legend) are translated in one place, `chart.js`.

After the change, measured in the app with 445,279 GBPUSD minutes:

| Action | Before | After |
|---|---|---|
| Switching timeframe | 2–5 s | 0.2–0.6 s |
| Jumping to Aug 2025 | — | 0.76 s |
| Back to the newest candles | — | 0.43 s |
| One 1-minute step, mouse over the chart | 114 ms | 9 ms |
| Loading the app | — | about 4–7 s |

## Not yet done

- **Fast playback is limited.** At the fastest speed (300 minutes a second), each screen update reveals 15 candles and costs roughly 15 chart updates, so playback may not keep up with the speed chosen while the mouse is over the chart.
- **The website loads 12 MB a pair.** It now has the minutes too.
- **The old M5 exports** stay in `data/` (and in git) for reference; nothing reads them.
