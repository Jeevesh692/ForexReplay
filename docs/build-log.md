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

---

## Day 4: Fri 2 Oct 2026 · orders on the replay, and session settings

**Asked for (Jeevesh):** "Give me the control for those settings" (session hours and timezones), then start day 4.

**Built (Claude):**
- **Session settings.** A dialog (⚙ next to "Sessions") edits each session's name, timezone, start, end and colour, switches sessions on or off, and adds or removes them. Presets: standard sessions and ICT killzones. Each row previews its hours in India time. Settings are saved in the browser.
- `web/js/broker.js` is the trading engine, ported from `broker.py` and working in whole points. See [decision 0005](decisions/0005-trading-engine-in-the-browser.md).
- `forex_replay/golden.py` records 100 random scenarios (2,535 trades) from the Python engine for the JavaScript engine to match.
- `web/js/trading.js` feeds every newly revealed M5 candle to the engine exactly once, and accepts orders only while the replay is live.
- **Order ticket** in the right-hand panel: buy or sell, at market or at a price (limit or stop is worked out for you), stop loss and take profit typed in or picked by clicking the chart, with pips and R shown before you place the order.
- **On the chart:** entry, stop-loss and take-profit lines for active trades, and entry and exit markers with the R result for closed ones.
- **Lists** of open and pending trades (with floating R, Close and Cancel) and closed trades (reason, times, best R reached), with a running total.

**Tests:** 19 new JavaScript tests (43 in total) and 2 new Python tests (45 in total). The parity test compares all 2,535 recorded trades field by field. In the headless browser, a scripted session saved killzones and reloaded, placed a market buy and a limit sell, picked a stop loss from the chart, tried an invalid order, tried to trade while viewing history, played until both trades closed, and exited with a trade open.

**Decisions:**
- The engine runs in the browser and is held to the Python engine by recorded scenarios ([0005](decisions/0005-trading-engine-in-the-browser.md)).
- Fills are always resolved on M5 candles, even when stepping through H1 or H4.
- Sessions are user settings with presets, not constants in code.

**Found along the way:**
- The session table rows were 320 pixels tall because a cell reused a CSS class name (`preview`) left over from day 1. The class was renamed and the dead rule removed.
- The engine's rejection messages were written for programmers ("stop loss < entry < take profit"). They now read as plain sentences.

**How to check:** click ⚙, load "ICT killzones", save, and the shading and colour key change. Start a replay, press Buy, then "Buy at market", then Shift + Right: the trade opens at the next candle's open and three lines appear. Press Space and watch it hit the stop or the target.

---

## Day 5: Sat 3 Oct 2026 · account in $, lot sizing, and managing open trades

**Asked for (Jeevesh):** start day 5.

**Built (Claude):**
- `web/js/account.js` turns the engine's price results into money: lot size, profit and loss in $, commission, balance and equity. See [decision 0006](decisions/0006-account-and-trade-management.md).
- **Size on the ticket:** "Risk %" works out the lots so a stop-out loses that share of the balance (rounded down to 0.01 lots), or "Lots" uses a fixed size. The ticket shows lots, $ at risk and commission before you place the order.
- **Account strip** at the top of the panel: balance, equity, and the result of this run in $ and %.
- **Managing a trade:** BE (stop to entry), close 25% or 50%, Close, and "Close all".
- **Dragging:** stop-loss, take-profit and pending-entry lines can be dragged on the chart. A hint shows pips, R and $ while dragging; Esc cancels; an invalid position snaps back with the reason.
- The engine (`broker.py` first, then `broker.js`) gained a frozen first stop, moving levels, and partial closes.
- **Account settings** (starting balance, commission, minimum spread) in the panel, saved in the browser.
- Partial closes are marked on the chart, and the price scale keeps the lines of active trades on screen.

**Tests:** 19 new JavaScript tests (62 in total) and 7 new Python tests (52 in total). The recorded scenarios were regenerated with the new actions: 120 scenarios, 2,079 trades, 547 accepted moves, 353 refused moves, 146 partial closes; the JavaScript engine matches the Python engine on all of them. In the headless browser, a scripted session sized an order from risk, dragged a target and a stop, tried to drag a stop past the price, cancelled a drag with Esc, checked the chart still pans, used BE and both partial buttons, placed a limit order and dragged its entry and stop (it re-sized), clicked 50% and Close while the replay was playing at 100x, tried to act while viewing history, used Close all, and changed the settings and reloaded.

**Decisions:**
- Money is a separate layer on top of the engine; the engine stays in prices and R ([0006](decisions/0006-account-and-trade-management.md)).
- R is always measured against the stop the trade opened with.
- Size from risk is rounded down, never up.
- A pending order sized from risk % is re-sized when its stop or entry moves.

**Found along the way:**
- The MT5 export records a spread of 0 on about 95% of candles. With the minimum spread at 0 and no commission, most trades cost nothing, which flatters results. Commission now defaults to $7 per lot; this is an assumption to replace with the real account's figures.
- Manual closes used only the minimum spread, not the candle's recorded spread. Closing, placing and moving now all use the spread that applies at that moment.
- The trade list was rebuilt on every candle, so at high replay speeds a click on "Close" could be swallowed because the button was replaced mid-click. The list is now rebuilt only when a trade changes; floating numbers are updated in place.
- Stop and target lines could be off screen, because the price scale only fitted the candles. It now includes nearby trade lines.
- The engine's rejection messages in Python were still written for programmers; they now match the JavaScript wording.

**How to check:** start a replay. The ticket shows something like "1.00 lots · risk $100.00 + $7.00 commission". Press "Buy at market", then Shift + Right. Drag the red SL line up or down and watch the hint. Press 50%: the row says "0.50 of 1.00" and the balance goes up or down by what was banked. Press BE once the trade is in profit. Open "Account settings" at the bottom of the panel to change the starting balance, commission and minimum spread.

---

## Day 6: Sat 3 Oct 2026 · drawing tools

**Asked for (Jeevesh):** start day 6; "my broker has 4$ per lot price for my position".

**Built (Claude):**
- `web/js/drawings.js`: drawings as data anchored in time and price, handle and move rules, geometry, hit-testing, saving. See [decision 0007](decisions/0007-drawings.md).
- `web/js/drawinglayer.js`: paints drawings on the chart and handles the mouse.
- **Tools in the left bar:** trendline, horizontal line, rectangle, Fibonacci retracement (0, 0.382, 0.5, 0.618, 0.705, 0.79, 1, with the OTE band shaded), long position, short position, and "remove all".
- **Working with a drawing:** click to select, drag a handle to reshape, drag the body to move, Delete to remove, Esc to cancel. A small bar shows what is selected.
- **Long/short tool:** shows pips, R, lot size and dollars at risk. "Use in ticket" copies its entry, stop and target into the order ticket.
- Drawings are saved in the browser and stay in place across timeframes, replays and reloads.
- Commission default changed from the guessed $7 to the broker's $4 per lot. A saved setting still holding the guess is replaced; a value chosen on purpose is kept.

**Tests:** 12 new JavaScript tests (74 in total; Python stays at 52). They cover time-to-chart placement across a weekend gap and past the last candle, M5 points landing on the right H1 candle, Fibonacci prices, handle rules for the position tool, geometry, hit-testing and loading damaged saves. In the headless browser, a scripted session drew one of each tool (by clicking and by dragging), checked the chart did not pan while drawing, dragged a position's stop handle, used "Use in ticket", moved a trendline, checked an empty drag still pans, cancelled with Esc, deleted with the Delete key, switched timeframes, reloaded, drew during a replay, dragged a trade's stop line with drawings present, and cleared everything.

**Decisions:**
- Drawings are anchored in time and price, never pixels or candle numbers ([0007](decisions/0007-drawings.md)).
- One pure function lays a drawing out; painting and hit-testing both use its result.
- The position tool fills the ticket; it never places an order itself.
- A trade's stop or target line wins over a drawing under the same mouse position.

**Found along the way:**
- On a small Fibonacci the level names printed over each other; names closer than 12 pixels are now skipped.
- A drawing tool waiting for a click could have started a drag of a trade's stop line underneath; trade lines are now locked while a tool is active.

**How to check:** click the trendline tool on the left, then two points on the chart. Click the line: handles appear; drag one. Switch to H1 and back: the line stays on the same candles and prices. Click the Fibonacci tool, click a swing low then a swing high: the orange band is the OTE zone. Click the long tool and a price; drag the red and green edges; click "Use in ticket". Reload the page: the drawings are still there.

---

## Day 7: Sat 3 Oct 2026 · backtests you can save and resume, the journal, and a halfway checkpoint

**Asked for (Jeevesh):** start day 7; keep to the original plan and leave out the friend's suggestion (M1 candles for live-forming candles).

**Built (Claude):**
- Every replay is now a **backtest**, saved as you go: its trades (open ones too), its drawings, its settings and how far it got. See [decision 0008](decisions/0008-backtests-saved-as-actions.md).
- A backtest is saved as the **actions** you took, each with the time of its candle. `web/js/backtest.js` rebuilds a run by repeating them on the same candles, then checks every trade against the copy in the save and reports any difference.
- `web/js/trading.js` writes each action down (order, close, cancel, stop or target move, partial, close all, settings change) and can repeat one.
- **Backtests** button in the top bar: a list of saved backtests (name, journal, candle reached, trades, result in R and $, when saved) with Resume and Delete (two clicks). The journal for new replays is set there.
- ✕ now saves and leaves; open trades stay open in the backtest instead of being closed. The bottom bar shows the backtest's name and when it was last saved, or why it was not.
- **Journal:** saving adds the backtest's closed trades to `strategies/<journal>/trades.csv` in the v1 columns and on the broker server clock, once each. `forex_replay/backtests.py` keeps the files; `forex_replay/server.py` has four new routes for them.
- A new replay brings along only the chart drawings that sit wholly before its start.

**Tests:** 7 new JavaScript tests (81 in total) and 5 new Python tests (57 in total). The main one plays 60 random runs (5,952 actions and 2,523 trades in total, with refused actions, look-backs and settings changes mixed in), saves each through JSON, rebuilds it and requires identical trades, actions, balance and settings. To check the test can fail, the rebuild was broken on purpose (settings changes skipped): the test failed, and the change was undone. Others: a run saved and resumed half-way ends the same as one played straight through; a damaged save is reported; journal rows are written once, in server time; unsafe file names and non-JSON writes are refused.

In the in-app browser (on a throwaway journal, deleted afterwards): placed a market buy and a sell limit, drew a line, part-closed the buy, opened a third trade, left with ✕ (two trades still active), opened Backtests and pressed Resume: balance, trades, action list and position matched exactly, and the line was back. Then closed and cancelled, changed the minimum spread, traded again, reloaded the page in the middle of the replay, and resumed: everything matched, including the spread setting; leaving brought back the normal settings. A replay with no trades or drawings left no file. `python -m forex_replay report` read the journal the app wrote. No console errors.

**Decisions:**
- A backtest is saved as its actions and rebuilt by the engine, never as a copy of the engine's state ([0008](decisions/0008-backtests-saved-as-actions.md)).
- Backtests are files on disk next to the v1 journals, not browser storage, so clearing the browser cannot lose them.
- New replays journal into `manual_backtests` until Jeevesh picks another name, so nothing is written into `impulse_candle/trades.csv` by default.
- Leaving a replay no longer closes trades.
- `strategies/*/backtests/` is ignored by git: backtests are personal working files, like `impulse_candle/trades.csv`.

**Found along the way:**
- Drawings made before a replay used to come into it unchanged, including any drawn on candles the replay had hidden: a small look-ahead leak from day 6. Now only drawings wholly before the start come along.
- A settings change made while looking back would have been recorded at the candle on screen, but it takes effect at the live candle. It is now recorded at the live candle (there is a test for this).
- After leaving a replay that had nothing to save, the old "Backtest saved" message stayed in the panel. It is cleared now.
- pytest was not installed for the Python on this computer, so it was installed with `pip install --user pytest` (as the README says).

**How to check:** start a replay, place a trade and let it fill. The bottom bar says `Backtest "EURUSD from …" · saved …`. Press ✕: the trade's lines disappear. Click Backtests, then Resume: you are back at the same candle with the trade still open. Let it close, then open `strategies/manual_backtests/trades.csv`: the trade is there once, however many times it was saved.

### Checkpoint at the halfway mark

- **Where the plan stands:** days 1 to 7 are done on 3 Oct. The build log's plan runs 28 Sep to 11 Oct, which puts day 7 on 4 Oct, so the work is on schedule, not behind. (`docs/plan.md` said the plan started on 29 Sep and was three days behind; the two documents disagreed. Moving the dates is not needed for now.)
- **Tests:** 57 Python and 81 JavaScript tests, all passing. The engine parity test still matches every recorded Python trade; the engine rules did not change today.
- **Built so far:** data pipeline, chart M5 to D1 in India time, replay with forming candles, sessions, orders with SL and TP, account in $ with risk sizing and commission, partials and breakeven, draggable lines, drawings, and now saved, resumable backtests with a journal.
- **Known gaps, collected from the decision records:** typing a new stop for an open trade, trailing stops, margin (0006); colours, rays, text, snapping, undo, tool shortcuts (0007, day 9); lots and dollars in the journal, renaming backtests (0008, day 10).
- **Waiting on Jeevesh:** day 12 (AI trade review or two charts, by day 11); whether the $4 commission is round turn or per side; the friend's intrabar request stays parked (needs an MT5 export and a fresh MT5 login).

---

## Day 8: Sat 3 Oct 2026 · prop-firm challenge mode

**Asked for (Jeevesh):** start day 8.

**Built (Claude):**
- `web/js/challenge.js`: the challenge rules and state. A profit target on the balance, a daily loss limit from the day's starting balance, and a fixed maximum loss, with days starting at 17:00 New York. See [decision 0009](decisions/0009-challenge-mode.md).
- `web/js/trading.js` checks the rules after every M5 candle, with each open trade at its worst price in that candle, and again after each action. On a breach it closes open trades at that candle's close and cancels orders; on a pass it cancels orders; either way the run stops accepting orders.
- **Challenge box** in the trading panel: a switch, three presets (8% target, 10% target, phase 2 with 5%) and the three limits. During a replay it is locked and shows three bars (profit towards the target, today's loss, loss from the start), the worst day, the lowest equity and the number of trading days.
- The replay pauses the moment a challenge passes or fails, and the panel says why. Trades closed by a failure are labelled "closed: challenge failed" (`CHALLENGE_STOP` in the journal).
- The starting balance cannot change during a challenge.
- Challenge rules and how the challenge ended are saved with the backtest. A resumed backtest ends on the same candle, and the rebuild checks that. The Backtests list marks PASSED and FAILED runs.

**Tests:** 8 new JavaScript tests (89 in total; Python stays at 57). They cover a wick through the daily limit that closes back up (still a failure), touching a limit exactly (not a failure), a sell measured at the high plus the spread, the daily reset at 17:00 New York, the fixed maximum-loss floor, a target that only passes once nothing is open, and the locked starting balance. Two deliberate breaks were tried: measuring at the candle's close instead of its worst price (5 of 8 tests failed), and leaving out the spread (the sell test failed). Both changes were undone. The random rebuild test now runs half of its 60 runs as challenges with tight limits (9 passed, 16 failed, 5 still running), and every rebuild ends the same way as the original.

In the in-app browser (throwaway journal, deleted afterwards): turned on the 8% preset with a real click, started a replay, tried to change the starting balance (refused, with the reason), sold 3.50 lots risking 7% into a rising market and played. The challenge failed on Fri 14 Aug 2026, 11:30 IST. The worst price took equity to $9,464.50, which broke the $500 daily limit; the trade was closed at that candle's close for -$511.00, and the replay paused with the panel and order ticket explaining why. After a page reload, Resume rebuilt the same failure on the same candle. With the switch off, the next replay showed "off for this run" and had no limits. No console errors. Screenshots could not be taken because the app window was hidden, so the layout was checked through the page text, not by eye.

**Decisions:**
- Rules are checked on every M5 candle at its worst prices, not only at candle closes ([0009](decisions/0009-challenge-mode.md)).
- The day boundary is the broker server's midnight (17:00 New York).
- The daily limit is a % of the starting balance, measured from the day's starting balance; the maximum loss is a fixed floor.
- A breach closes trades at that candle's close and ends the run; rules and the starting balance are locked for the length of a run.
- The challenge is a money rule next to the account, not part of the engine; `broker.py` and `broker.js` are unchanged, so the parity fixture did not need regenerating.

**Found along the way:**
- "Close all" wrote its action down before closing the trades, so a challenge could not see the target banked until the next candle. The action is now recorded after the closes.
- The first failing trade was labelled "closed by you", which is wrong; it now has its own exit reason.
- With random trades and loose limits, almost every random challenge failed, so the test's limits were tightened on the target side until passes happened too. The point is to exercise both endings in the rebuild, not to model a trader.

**How to check:** in the trading panel, tick "Challenge mode" (or click "8% target"). Start a replay, set Risk % to 7 and sell with a 20-pip stop. Press Space. If price runs against you, the replay stops when the daily bar fills: the box says FAILED with the time and the reason, and the ticket is greyed out. Open Backtests: the run is marked FAILED, and Resume brings it back in the same state.

---

## Day 9: Sat 3 Oct 2026 · more drawing tools, colours, magnet, undo and shortcuts

**Asked for (Jeevesh):** start day 9.

**Built (Claude):**
- **New tools:** ray, horizontal ray, vertical line (with its India time) and text notes (click, type, Enter; double-click to change). See [decision 0010](decisions/0010-drawing-styles-magnet-undo-shortcuts.md).
- **Colour and line style** for lines, rays, rectangles and notes, from the bar that appears when a drawing is selected. Each tool remembers the last colour and style for new drawings. Fibonacci and the position tools keep their meaningful colours.
- **Magnet** (button, or Alt + M): new points and dragged handles snap to the nearest open, high, low or close of the candle under the mouse. Hold Ctrl to flip it for one move. It only sees candles on the chart, so it cannot snap to a hidden price during a replay.
- **Undo and redo** for drawings (Ctrl + Z, Ctrl + Y, or the tool-bar arrows), up to 100 steps, starting fresh with each run. Trades cannot be undone.
- **Keyboard shortcuts:** Alt + T, R, H, J, V, B, F, L, S, N for the tools, plus `?` for a list of every key. `web/js/shortcuts.js` holds the one table both the keys and the list are built from.
- The tool column scrolls in short windows instead of being cut off.

**Tests:** 6 new JavaScript tests (95 in total; Python stays at 57). They cover:
- a ray carrying on past the edge at the same slope, and not behind its first point; a horizontal ray starting at its candle; the vertical line and its label
- text notes clickable over their whole width, and empty or over-long text refused
- colours and styles kept only from the fixed list and only on the tools that take them
- the magnet picking the nearest open, high, low or close, leaving prices past the candles alone, and never snapping to the hidden part of a forming H1 candle
- undo and redo through add, move, delete and clear, with ids restored, redo cleared by a new change, no step for a non-change, the 100-step limit, and a fresh history after loading
- shortcuts matching modifiers exactly, Cmd as Ctrl, no two shortcuts on one key, and a shortcut for every tool

In the in-app browser, the real mouse and keyboard handlers were driven with dispatched events, because the app window was hidden and screenshots could not be taken. Checked:
- Alt + R ray with two clicks; Alt + J and Alt + V
- the magnet on: a horizontal line landed on the candle's low of 1.16140
- with Ctrl held, the same click did not snap
- red and dashed applied, two undos took them off, and redo put the colour back
- the next horizontal line came out red and dashed
- a text note typed and saved with Enter, changed by double-click, and nothing kept on Esc
- Delete, then Ctrl + Z brought the note back
- `?` opened the 22-row list
- Alt + F picked the Fibonacci tool, and its key press was cancelled
- a new replay started with no undo history
- drawings, colours and styles survived a reload
No console errors. The page's visual layout was not checked by eye.

**Decisions:**
- Strong magnet (always snaps); Ctrl flips it ([0010](decisions/0010-drawing-styles-magnet-undo-shortcuts.md)).
- Undo covers drawings only, never trades, and never crosses into another run.
- Only colours from a fixed list of eight are accepted from a save.
- Fibonacci and position tools are not recoloured.
- Tool shortcuts follow TradingView's Alt + letter scheme, matched on the physical key.

**Found along the way:**
- The hidden browser pane shrank the page to 0 × 0 pixels, so the first scripted clicks found no chart. The page was given a fixed 1280 × 800 size and reloaded for the check. This was the test setup, not the app.
- With twelve more buttons the tool column would have been cut off in a short window; it now scrolls.
- The horizontal line's price label used the line's colour by accident of its role name; labels now follow the drawing's chosen colour on purpose.

**How to check:** press Alt + R and click two points: the line carries on past the second. Click it, pick red and dashed in the bar above the chart. Press Ctrl + Z twice: it is blue and solid again. Turn on the magnet (the U-shaped button, or Alt + M) and draw a horizontal line near a candle: it sits exactly on that candle's high, low, open or close. Press Alt + N, click, type a note, press Enter. Press `?` for every shortcut.

---

## Day 10: Sun 4 Oct 2026 · trade journal: notes, tags, screenshots

**Asked for (Jeevesh):** add basic indicators to day 13 together with speed and fixes; start day 10.

**Built (Claude):**
- **Plan:** day 13 is now "speed and fixes, plus basic indicators". Proposed set: SMA, EMA, RSI and VWAP, computed from revealed candles only; which ones exactly is still Jeevesh's call.
- **Journal box** under the trade lists. Click any trade (open, pending or closed) to write a note, toggle tags or type your own, and see its screenshots (click one for full size, × removes it). Trades with a note show ✎, and 📷 with a count.
- **Screenshots:** taken automatically when an order is placed and when it closes (a switch turns this off), and by hand with "Add screenshot". Each has a caption strip (symbol, timeframe, trade, entry or exit, time, backtest). They are saved as PNG files in `strategies/<journal>/screenshots/`. See [decision 0011](decisions/0011-trade-journal.md).
- `web/js/tradenotes.js` keeps the notes and tags and tidies anything loaded. `web/js/journalpanel.js` is the box; `web/js/screenshots.js` takes and uploads pictures.
- Notes are saved with the backtest and come back on Resume. They are not trading actions and never affect a rebuild.
- **Journal CSV:** new columns `lots`, `pnl_usd`, `commission_usd`, `note`, `tags`, `screenshots`. Old journals are widened automatically, keeping every row, and a note written after a trade closed updates its row.
- **Server:** `GET`, `PUT` and `DELETE /api/screenshots/<journal>/<name>.png`, accepting only real PNG files under safe names.

**Tests:** 5 new JavaScript tests (100 in total) and 4 new Python tests (61 in total). They cover:
- tag tidying, and damaged entries keeping only what is usable (an unsafe screenshot name like `../../etc/passwd` is dropped)
- notes, tags and screenshots kept per trade, an emptied entry disappearing, and tag choices ordered by use
- notes travelling in the backtest save and on each trade, without disturbing the rebuild
- an old v1 journal widened with its rows kept
- money and notes reaching the journal, and a later note updating the row while a changed result is ignored
- screenshots refused unless they are PNG with a safe name, and the server refusing non-PNG uploads

In the in-app browser (throwaway journal, deleted afterwards):
- a market buy got an entry screenshot when placed and an exit screenshot when it closed
- a click on its row opened the journal; a typed note, a chip tag and a typed tag were saved
- the journal CSV row had the lots, -$104.00, $4.00 commission, the note, both tags and all three screenshot names
- the saved pictures were decoded: 952 × 754 pixels with thousands of green and red candle pixels, about 50 KB each. Two were opened and looked at: the entry shows the stop and target lines, the exit shows the stop-out candle and the -1.00R marker
- Space typed in the note box did not play the replay
- leaving and resuming brought back the note, tag and both screenshots, with no new automatic pictures
No console errors.

**Decisions:**
- Notes are metadata saved with the backtest, not engine actions ([0011](decisions/0011-trade-journal.md)).
- Screenshots are files on disk next to the journal, not pictures inside the backtest file.
- Automatic screenshots at placement and exit are on by default.
- The journal CSV is widened in place rather than written to a new file, so v1 and v2 trades stay in one journal.
- Notes may change a journal row after it is written; results may not.

**Found along the way:**
- The first exit screenshot showed the chart one candle too early: the engine hears about a candle before the chart draws it. Automatic pictures now wait until the chart has drawn it, and the second check showed the stop-out candle and the exit marker.
- The keyboard shortcuts ignored typing in one-line boxes but not in the new multi-line note box, so Space while typing would have played the replay. Multi-line boxes are now ignored too.
- Resume failed with "journal.pick is not a function": inside the resume code, the name `journal` already meant the journal folder name. The box's variable is now `journalBox`.
- A note typed and then followed within 0.4 seconds by a tag click could have been wiped from the box before it was saved. The box now never redraws text that is still waiting to be saved.

**How to check:** start a replay and buy at market. Let the trade close. Click it in "Closed": the journal box opens with two screenshots (entry and exit). Click one to see it full size. Type a note, click "A+ setup", type a tag of your own and press Enter. Leave with ✕, then Resume from Backtests: the note, tags and pictures are still there. Open `strategies/manual_backtests/trades.csv`: the last columns hold the lots, dollars, note, tags and screenshot names.

---

## Day 11: Sun 4 Oct 2026 · analytics page

**Asked for (Jeevesh):** start day 11.

**Built (Claude):**
- **Analytics tab** next to Chart and Data. It reads a journal's `trades.csv` and filters by run, side, session and tag. See [decision 0012](decisions/0012-analytics-page.md).
- **Tiles:** trades, win rate, expectancy, total R and $, profit factor, payoff, maximum drawdown, streaks, average MFE, worst day, average duration, commission.
- **Equity curve** in R, trade by trade, with a crosshair, and a **histogram** of results in half-R bands.
- **Worth knowing:** the v1 prop-firm check at a chosen risk %, losing trades that had been +1R first, and challenge runs passed and failed.
- **Breakdowns** by session, weekday, side, exit reason, tag and run, and a **trades table** with notes, tags and screenshot links.
- `web/js/analytics.js` computes the statistics with the definitions of `forex_replay/stats.py`. `forex_replay/stats_golden.py` records what `stats.py` says about 40 random journals, and the JavaScript must match every number.
- Server: `GET /api/journals` and `GET /api/journal/<name>` (read only).

**Tests:** 5 new JavaScript tests (105 in total) and 3 new Python tests (64 in total).
- The parity test compares more than 2,000 numbers (17 statistics, four breakdowns and the prop-firm figures for 39 non-empty journals, plus an empty one) with what `stats.py` recorded.
- To check it can fail, the code was broken on purpose twice, and each time the test failed; both changes were undone. The breaks: grouping the worst day by date only (not run and date), and counting exactly +0.05R as a win.
- Other tests: empty cells never count as zero; drawdown from the starting zero; streaks through breakevens; a trade with two tags in both tag groups; histogram buckets; give-backs; money totals; filters.
- Python tests: the recorded file is still what `stats.py` gives and covers the awkward cases; journals are listed and read safely.

In the in-app browser:
- **Jeevesh's `impulse_candle` journal** (read only, not changed): 24 trades, 50.0% win rate, -0.23R expectancy, -5.53R total, profit factor 0.54, payoff 0.54, 6.60R drawdown, streaks 3 / 5, MFE 1.45R, worst day -2.0R. All match `python -m forex_replay report` on the same file, once the rounding fix below was in.
- **A throwaway journal of 32 trades** made through the app, with tags and a note containing HTML: +13.82R total, +0.43R expectancy, 4.08R drawdown, 990 min average. All match the report.
- **Filters and safety:** the FOMO tag filter showed 6 of 32 trades. The HTML note appeared as plain text and did not run. Both hover readouts worked.
- **Screenshots** were taken and looked at; they led to the fixes below.
- No console errors. The throwaway journal was deleted afterwards.

**Decisions:**
- The page reads the journal CSV, not the backtest files ([0012](decisions/0012-analytics-page.md)).
- Statistics are computed in the browser for instant filtering, and held to `stats.py` by a recorded comparison, like the engines.
- Trades are taken in logged order, as `stats.py` does.
- The prop-firm line keeps v1's fixed 8 / 5 / 10 rules; per-run challenge results come from challenge mode itself.

**Found along the way:**
- The page said 33 min average duration where the report said 32: the average is exactly 32.5. Python prints halves to the even number; the page now rounds the same way.
- The report says when only some trades have an MFE; the page now does too ("only 3 of 24 have it").
- In the first screenshot the Total R numbers sat on top of their bars in the breakdown tables. The number now has its own column. The histogram's axis title was cramped against the tick labels and got more room.
- A test script ran past the browser tool's time limit, because every simulated candle redraws the chart. It was left to finish rather than run again.

**How to check:** click "Analytics" in the top bar. Pick a journal; the tiles, the equity curve and the tables fill in. Choose a tag in the filter row and every number changes to just those trades. Compare with `python -m forex_replay report strategies/<journal>/trades.csv`: the same numbers.
