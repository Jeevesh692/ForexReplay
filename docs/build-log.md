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
