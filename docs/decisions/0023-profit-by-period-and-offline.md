# 0023: Profit by day and month, drawdown in dollars; the app works offline

- **Date:** 20 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants to backtest on a train with no internet, and to see trades, P&L, profit by day and month and drawdown per strategy and session), with Claude on the definitions

## Offline: already true, now checked

Nothing in the app needs the internet once it has been started once:
- **The page, stylesheet and app code** are files served by the app's own server on this computer.
- **The chart library** is downloaded only the first time, if `web/vendor/` lacks it; it was already on Jeevesh's computer.
- **The market data** is built from `data/` on this computer, and only when an export is newer.
- **Saving** goes to files under `strategies/`.

Checked on 20 Oct 2026 in the in-app browser: a whole session (new strategy, new session, 5 trades, saves, screenshots, the analytics page) made requests only to `localhost`. A search of the network log for `https://` found none.

## The new statistics

Defined in `forex_replay/stats.py` like every other statistic. `web/js/analytics.js` is held to them by the comparison file `stats_golden.json`, whose random journals now include dollar amounts.

- **By day and by month** (`period_table`): trades, win rate, total R and net dollars, newest first.
  - A trade counts on the day it **closed**, when its result was banked, as "worst day" already does. The day is the broker server's date, so a day ends at 17:00 New York, like the daily candle.
  - Trades of every session on that date are added together; pick one session in the Run filter to see one session.
  - A row with no dollar amount (older journals) adds to the trades and R, not to the dollars.
- **Drawdown in dollars** (`max_drawdown_usd`): the largest fall from a peak of the dollar equity curve, from 0, in the order the trades were logged. It is shown beside the drawdown in R on the Max drawdown tile.

On the analytics page, "By month" and "By day" come before the other breakdowns, each with how many periods were up. They follow the page's filters (strategy, session, side, market session, tag).

## Not yet done

A calendar view, and checking the new tables on the website's analytics (they should work there too, since the page is shared, but only the desktop app was checked). Drawdown in % of the balance per session was added later the same day (below).

## Added the same day: the dollar figures other replay tools show (v2.3.2)

Asked for: "every basic data like P&L, etc. for that session which are normally given in other FX replays". Compared with what replay tools usually show (FX Replay itself was not opened to check item by item). Added in `stats.py` (`money_stats`, and a net-dollar column on `breakdown`) and held to the browser by `stats_golden.json`:
- **Gross profit and gross loss, profit factor in dollars.**
- **Average win and loss, largest win and loss** (in dollars, the largest also in R).
- **Best day** (dollars and R), **worst day in dollars.**
- **Average planned reward:risk.**
- **Starting and ending balance, return %, and the largest fall of the balance from a peak, in % of that peak.** These are shown when one session is on the page; every saved session now records its starting balance (`result.startBalance`).
- **A Net $ column** on every breakdown (so long vs short, market sessions, weekdays and tags all show dollars).
- **An R / $ switch** on the equity curve.

Dollar wins and losses go by the sign of the dollar result after commission, so a breakeven trade in R that paid commission counts as a small dollar loss. Days are per session and closing date, as the worst day in R already was.

The comparison file's first journal is now always empty, so that case stays covered whatever the random rows turn out to be.
