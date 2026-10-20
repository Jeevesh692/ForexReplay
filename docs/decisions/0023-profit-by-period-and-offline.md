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

Drawdown in % of the balance per session (the prop-firm check gives % at a fixed risk per trade), a calendar view, and the new tables on the website's analytics (they work there too, since the page is shared, but only the desktop app was checked).
