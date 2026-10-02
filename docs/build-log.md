# Build log: ForexReplay v2

ForexReplay v2 is being built by Jeevesh Prakash working with Claude, an AI coding agent. Jeevesh sets the goals, makes the product and trading decisions, reviews each day's work and tests it. Claude proposes designs, writes the code and tests, and explains each day's code in a short walkthrough. Every entry records what was asked, what was built, and what was decided or changed.

Plan: two weeks, 28 Sep to 11 Oct 2026 (day 1 started early, on 27 Sep).

---

## Day 1: Sun 27 Sep 2026 · data pipeline and app shell

**Asked for (Jeevesh):** start the v2 build. EURUSD only, nothing below M5, data from Aug 2025, all times in India time. It must be presentable for AI-engineering roles and understood well enough to explain.

**Built (Claude):**
- Exported EURUSD M5 from the MT5 terminal (Symbols → Bars → Export): 82,604 candles, 1 Aug 2025 to 11 Sep 2026.
- `forex_replay/datapipe.py` reads both MT5 export formats, merges them (the newer file wins), converts broker server time to UTC, checks quality and writes monthly binary files. See [decision 0002](decisions/0002-market-data-and-clock.md).
- `forex_replay/server.py` is a local web server using only the standard library. It rebuilds data when an export is newer and downloads the chart library once.
- `web/` is the app shell: a TradingView-style layout (top bar, drawing toolbar, trading panel, status bar) and a data check page.
- `start_app.bat` starts the app with a double-click.
- Tests: 5 new Python tests for the pipeline (including daylight-saving weeks) and 3 for the server, plus 5 JavaScript tests. One JavaScript test reads the exact files Python wrote, so the two sides can't drift apart.

**Decisions:**
- Browser app on TradingView Lightweight Charts ([0001](decisions/0001-browser-app.md)).
- Broker server time is New York + 7h. This was verified from the data, not assumed: the week opens Monday 00:05 server time even in the March weeks where US and EU daylight saving differ.
- Prices are stored as integer points so that later fills are exact.

**Found along the way:**
- The MT5 login had expired, so the newest candles stop at 11 Sep 2026.
- Browsers disagree on "Sep" vs "Sept" in dates, so month names now come from the app's own list.

**How to check:** double-click `start_app.bat`. The browser should show "82,569 five-minute EURUSD candles", 0 bad candles, a price line from Aug 2025 to Sep 2026, the latest 200 candles drawn by TradingView's library, and "Chart library … ready" in the bottom bar.

---

## Day 2: Fri 2 Oct 2026 · the chart and timeframes

**Asked for (Jeevesh):** start day 2.

**Built (Claude):**
- `web/js/timeframes.js` builds M15, M30, H1, H4 and D1 candles from M5, with candle boundaries on the broker server clock so they match MetaTrader. It supports forming candles for replay. See [decision 0003](decisions/0003-timeframes-and-chart-time.md).
- `web/js/chart.js` is the real chart on TradingView Lightweight Charts: candles and volume, zoom and pan, a free crosshair, and India time on the axis.
- A legend in the chart's top-left corner shows the time, open, high, low, close, change and volume of the candle under the crosshair.
- Timeframe buttons keep your place in history when you switch. A "Go to" box jumps to a date and time in India time, and "Latest" returns to the newest candle. The last timeframe is remembered between visits.
- The day-1 data check moved to a "Data" tab. The browser tab now has an icon.
- The pipeline now writes `reference.json` (every H4 and D1 candle computed with pandas), and it rebuilds automatically when its output format changes.

**Tests:** 6 new JavaScript tests and 1 new Python test. One of them compares all 1,734 H4 and 289 D1 candles built in JavaScript with the pandas reference. Totals: 43 Python, 11 JavaScript. The interface was also driven in a headless browser: every timeframe, go-to-date, the crosshair legend and the Data tab, with no console errors.

**Decisions:**
- Higher-timeframe candles start on the broker server clock, not UTC or India time, so they match MetaTrader ([0003](decisions/0003-timeframes-and-chart-time.md)).
- India time on the axis is done by shifting timestamps at the chart boundary only.

**Found along the way:**
- The chart library read the computer's language setting and crashed on an unusual one in the test browser, so the chart's locale is now fixed to `en-IN`.
- The library wrote "Sept" where the rest of the app writes "Sep", so axis labels now use the app's own month names.

**How to check:** start the app. The chart opens on M15. Click M5 to D1 and the chart stays at the same place in history. Compare the last H4 candle with MetaTrader's H4 chart: open, high, low and close should be identical. Type a date into "Go to" and the chart centres on it.

---

## Day 3: Fri 2 Oct 2026 · replay and sessions

**Asked for (Jeevesh):** start day 3.

**Built (Claude):**
- `web/js/replay.js` is the replay clock: one position (M5 candles revealed), play and pause, six speeds, step forward and back, and a `furthest` marker for honest look-backs. See [decision 0004](decisions/0004-one-replay-clock.md).
- `TimeframeView` in `web/js/timeframes.js` gives each timeframe a display that contains only revealed candles plus one forming candle.
- Replay controls in the top bar: click "Replay", then click the candle to start from. Space plays and pauses, the arrow keys step, Shift + Right moves one M5 candle, End returns to live, and ✕ exits.
- The chart updates only the candles that changed while playing, and follows the newest candle when it is on screen.
- `web/js/sessions.js` and a chart primitive shade the Asia, London and New York sessions on M5 to H1, with a toggle and a colour key.

**Tests:** 13 new JavaScript tests (24 in total; Python stays at 43). The main one moves every timeframe view along 300 random replay moves and checks it against a fresh aggregate each time. In the headless browser, a scripted replay (pick a candle, step, switch timeframes, play, step back, return to live, exit) checked after every action that the chart held zero candles from after the replay clock.

**Decisions:**
- One clock for the whole app; every timeframe is derived from it ([0004](decisions/0004-one-replay-clock.md)).
- Sessions are defined in Tokyo, London and New York time, not in fixed India-time hours.

**Found along the way:**
- At 30x the first timer design revealed 40 candles a second, because it rounded candles-per-tick. The tick length is now derived from the speed, so every speed is exact.
- After switching timeframe mid-replay, the chart could land away from the replay edge and stop following it. Switching now stays at the newest candle if you were looking at it.
- Session name labels inside the chart overlapped where London and New York overlap, so the names moved to a colour key in the status bar.

**How to check:** go to a date, click "Replay", click a candle. Candles to its right disappear. Press Space: candles appear one by one. Switch to H1 while it plays: the last candle grows and the legend says "forming". Press Left: the clock turns amber and says "viewing history". Press End to return.
