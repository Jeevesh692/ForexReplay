# ForexReplay v2: two-week plan and status

Goal: a browser app that covers about 70% of what TradingView replay or FX Replay offers, for testing Jeevesh's own strategies on EURUSD. A very cheap paid version is a far-future idea, not part of this plan.

The plan started on 29 Sep 2026 and is about three days behind the calendar. Whether to move the dates has not been decided.

| Day | Scope | Status |
|---|---|---|
| 1 | Data pipeline (MT5 export to UTC binary files), local server, app shell | done |
| 2 | TradingView-style chart, M5 to D1, India time | done |
| 3 | Bar replay with forming candles, session shading | done |
| 4 | Orders on the replay, engine ported and parity-tested, session settings | done |
| 5 | Account in $, lots from risk %, partial close, breakeven, close all, draggable SL/TP, commission | done |
| 6 | Drawings: trendline, horizontal line, rectangle, Fibonacci with OTE, long/short tool | done |
| 7 | Backtest sessions (save and resume a run with its trades and drawings), write trades to the journal, checkpoint | next |
| 8 | Prop-firm challenge mode (daily loss, max loss, profit target) | |
| 9 | More drawings and keyboard shortcuts (rays, text, colours, snapping, undo) | |
| 10 | Journal: notes, tags, screenshots per trade | |
| 11 | Analytics page | |
| 12 | AI trade review, or two charts side by side | |
| 13 | Speed and fixes | |
| 14 | Release, README, CV bullet | |

## Open decisions (Jeevesh has not answered these)

- **Day 12:** AI trade review or two charts. Decide by day 11. AI review needs an Anthropic API key.
- **Plan dates:** move them by three days, or drop something.
- **Commission:** is $4 per lot the full round turn, or per side?
- **Intrabar data:** a friend who scalps with 4-pip stops asked for candles that form live. Options discussed on 3 Oct: (a) fake movement from M5, rejected as dishonest; (b) M1 data, about one day; (c) tick data, about three to four days, best after day 14. Recommendation given: M1 now, ticks later. Needs a fresh MT5 export, and the MT5 login had expired.
- **commit-bot** (a tool that makes artificial commits to fill the GitHub activity graph): advised against; never chosen.

## Things known to be unfinished

See the "Not yet done" section at the end of each record in `docs/decisions/`.
