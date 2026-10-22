# ForexReplay

A forex bar-replay and backtesting tool for EURUSD, GBPUSD, USDJPY, USDCAD and AUDUSD (one pair on screen at a time; decisions 0021, 0024). Owner: Jeevesh Prakash (GitHub `Jeevesh692/ForexReplay`, branch `main`).

- **v1** (`forex_replay/`): Python package. Matplotlib replay, event-driven backtest, journal CSV, R-multiple stats.
- **v2** (`web/`): a TradingView-style browser app in plain JavaScript modules, served by a small Python server. Built to the 14-day plan in `docs/plan.md` and released as v2.0.0 on 4 Oct 2026.
- **Strategy journals** (done, v2.1.0 on 13 Oct 2026): each strategy a folder with its own sessions, journal, screenshots and automatic rule log for Jeevesh's Excel workbooks, to `docs/plan-strategy-journals.md`. "start journal day N" does a day of it. The loggers follow `docs/plan-nbb-logger.md` and `docs/plan-sweep-logger.md` exactly: the workbooks read the CSVs by column name.
- **Strategy Lab** (later): indicator strategies on H4/D1 with tuning on in-sample data and out-of-sample checks, to `docs/plan-strategy-lab.md`. "start lab day N" does a day of that plan, with the same daily routine.

The project is also a portfolio piece for AI-engineering applications: "a complex app built with an AI agent, directed and understood by me". So the record of who decided what matters as much as the code. Keep it honest.

## How Jeevesh works with you

- He says "start day N" (or "start journal day N" for `docs/plan-strategy-journals.md`, "start lab day N" for `docs/plan-strategy-lab.md`). Do that day, end to end, then report.
- He is a self-taught programmer and trades this strategy himself. Explain in plain words; no jargon without a one-line meaning.
- Never state a number you have not just read or computed. If something was not checked, say so.
- Ask only when a wrong guess would be expensive. Otherwise decide, and say what you decided.

## The daily routine (do all of it, every day)

1. Build the day's features with tests.
2. Run both test suites (below). Check the app in a real browser, not only in tests.
3. Add a day entry to `docs/build-log.md` in the existing format: asked for, built, tests, decisions, found along the way, how to check.
4. If a design choice was made, add `docs/decisions/NNNN-title.md` in the existing format (date, status, decided by, reasoning, not yet done).
5. Update the "So far" line near the top of `README.md` and the status table in `docs/plan.md`.
6. Commit as `v2 day N: summary` (`journal day N: summary` for the journal plan) with a bullet list, then push to `origin main` without asking (Jeevesh's standing instruction, 3 Oct 2026). `strategies/` is ignored by git (except its README): each person's strategies stay on their own computer (13 Oct 2026, so a friend can use the features without Jeevesh's strategies). Never commit anything from it, and never delete his folders in it; test sessions you create there must be removed after a check, and leave the replay (or close the browser tab with the server stopped) first, or the page saves them again.
7. Finish with: what was built, how to check it by hand, how you know it is right, a short walkthrough of the ideas, and **three questions** that test whether he understood the day. Grade his answers honestly next time.

## Run and test

```
python -m forex_replay app          # or double-click start_app.bat; serves http://127.0.0.1:8765
python -m forex_replay site --out <folder outside OneDrive>   # the static website (backtests saved in the browser)
python -m pytest                    # Python tests (pip install pytest)
node --test web/tests/*.test.mjs    # JavaScript tests (needs Node.js; check `node --version`)
python -m forex_replay.golden       # regenerate the engine comparison fixture (only when engine rules change)
python -m forex_replay.stats_golden # regenerate the statistics comparison fixture (only when stats.py changes)
python -m forex_replay.indicator_golden # regenerate the indicator reference values (only when an indicator definition changes)
python -m forex_replay nbb <strategy>  # rebuild a strategy's NBB log from every saved session (after a logger fix)
python -m forex_replay sweep <strategy>  # the same for the liquidity-sweep log
```

Expected today: 113 Python tests, 148 JavaScript tests, all passing.

## Rules that must not be broken

- **No look-ahead.** The chart and the engine may only ever see candles the replay clock has revealed. Orders, closes and stop moves are accepted only at the live edge of the replay. A `Candles` object's arrays can be longer than its `length` (a replay's display reuses full-size arrays): never read past `length`.
- **One replay clock** (`web/js/replay.js`): one position in the base candles (M1 since v2.3, decision 0022); every timeframe is derived from it.
- **Fills are resolved on the base (1-minute) candles** whatever timeframe is on screen. An order is never evaluated on the candle it was placed on.
- **The logs measure M5 built from the minutes, and only M5 candles that had closed** at the moment in question (`loglib.closed_cut`); never the forming one.
- **The chart holds a window of at most 6,000 candles** (`chart.js`): the library's update cost grows with every candle it holds while the mouse is over the chart. Indicators are still computed on every candle.
- **Two engines, one truth.** `forex_replay/broker.py` and `web/js/broker.js` implement the same rules. Change Python first, then JavaScript, then run `python -m forex_replay.golden`; the JavaScript parity test must match every recorded trade.
- **Prices are whole points** in the browser (1.08500 is 108500). Lot sizes are whole numbers of 0.01 lots. No floats for either.
- **Times are UTC seconds everywhere.** India time (+5:30) is applied only inside `web/js/chart.js` and `web/js/time.js`. MT5 server time is New York + 7 hours; conversion is in `forex_replay/datapipe.py`.
- **The engine knows prices and R; money lives in `web/js/account.js`.** On USDJPY a point's dollar value depends on the price (`pointValueFor`): every amount is converted at the price it happens at, never with a fixed rate.
- **One set of statistics.** `forex_replay/stats.py` defines them; `web/js/analytics.js` must match `web/tests/fixtures/stats_golden.json`.
- **Drawings are anchored in time and price**, never pixels or candle numbers.
- **No build step, no npm packages.** Plain ES modules. The only third-party code is TradingView Lightweight Charts v5 (Apache 2.0) in `web/vendor/`, downloaded on first run; keep `attributionLogo: true`.
- `web/data/` and `web/vendor/` are generated and gitignored. Never commit them.

## Where things are

| Area | Files |
|---|---|
| Data pipeline, server | `forex_replay/datapipe.py`, `forex_replay/server.py` |
| Candles, timeframes | `web/js/data.js`, `web/js/timeframes.js` |
| Replay | `web/js/replay.js` |
| Chart | `web/js/chart.js` (candles, sessions, trade lines and markers, line dragging, crosshair sync, indicator lines) |
| Indicators | `web/js/indicators.js` (SMA, EMA, RSI, VWAP and the step-by-step engine), `forex_replay/indicator_golden.py` |
| Two charts | `web/js/layergroup.js` (both charts' drawing layers as one); panes in `web/js/main.js` |
| Sessions | `web/js/sessions.js`, `web/js/sessionsettings.js` |
| Trading | `web/js/broker.js` (engine), `web/js/trading.js` (clock to engine), `web/js/account.js` (money), `web/js/challenge.js` (prop-firm rules), `web/js/adrplan.js` + `web/js/adrpanel.js` (ADR plan: thresholds as multiples of ADR10), `web/js/tradingpanel.js` (panel) |
| Drawings | `web/js/drawings.js` (model, geometry), `web/js/drawinglayer.js` (paint, mouse, magnet, text box) |
| Shortcuts | `web/js/shortcuts.js` (one table for keys and the help list) |
| Journal | `web/js/tradenotes.js` (notes, tags), `web/js/journalpanel.js` (the box), `web/js/screenshots.js` (pictures), `forex_replay/journal.py` (CSV) |
| Backtests | `web/js/backtest.js` (save, rebuild, check), `web/js/backtestpanel.js` (autosave, the Strategies dialog), `forex_replay/backtests.py` (files, journal) |
| Strategies | `web/js/strategies.js` (names, list), `forex_replay/strategy_folders.py` (`strategies/<name>/strategy.json`: label and logger). Not `forex_replay/strategies/`, which is v1's strategy code |
| Analytics | `web/js/analytics.js` (statistics, held to `forex_replay/stats.py`), `web/js/analyticsview.js` (the tab), `forex_replay/stats_golden.py` |
| Strategy logs | `forex_replay/loglib.py` (shared: clocks, candles cut at a moment, bigger timeframes, ATR, CSV keyed by session), `forex_replay/nbb.py` (the NBB log, to `docs/plan-nbb-logger.md`), `forex_replay/sweep.py` (the sweep log, to `docs/plan-sweep-logger.md`), `forex_replay/checklist.py` (checklist answers); called from `backtests.run_logger` by the strategy's `strategy.json` |
| Storage, website | `web/js/store.js` (files through the server, or the browser online), `forex_replay/site.py` (static build) |
| Wiring | `web/js/main.js`, `web/index.html`, `web/css/app.css` |
| Tests | `tests/`, `web/tests/` |

Read `docs/decisions/` before changing how something works; each record says why it is the way it is.

## Facts about the data and account

- Data: M1 for EURUSD, GBPUSD and USDJPY (31 Jul 2025 to 14 Oct 2026) and USDCAD and AUDUSD (to 20 Oct 2026), from a FundedNext demo account (read with the `MetaTrader5` Python package), kept as `data/*_M1_*.csv.gz` (about 5 MB each, in git). The replay reads only the M1 exports.
- Older H1, H4 and D1 candles (`data/*_{H1,H4,D1}_*.csv.gz`) are shown before the minutes on those charts (decision 0024): from 1 Jan 2024 for four pairs, from 20 Oct 2022 for AUDUSD (FundedNext's limit; 4 years at most). A replay cannot start inside them; they closed before the first minute.
- Older M5 exports stay in `data/` for reference and are not read (EURUSD from Five Percent Online, whose prices differ slightly from FundedNext's; same server clock).
- FundedNext's M1 records zero spread on 69% of EURUSD minutes, 4% of GBPUSD and 0% of USDJPY (the old Five Percent EURUSD M5: about 95%). Commission is $4 per lot (his broker's figure; treated as round turn, not yet confirmed whether it is per side).
- Chart clock is India time.
