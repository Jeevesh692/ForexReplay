# 0021: GBPUSD and USDJPY beside EURUSD, one pair at a time, with USDJPY money converted at each price

- **Date:** 14 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("add GBP/USD and USD/JPY data too", then "add those data in the app"; export from MT5 rather than TradingView), with Claude on the design

## Where the data came from

The new candles were read from Jeevesh's MT5 terminal with MetaQuotes' own Python package (`MetaTrader5` 5.0.6231, installed with his permission). It reads price history only. The terminal was logged in to a FundedNext demo account. The existing EURUSD file came from another broker (Five Percent Online), so before trusting the new data the two were compared on March 2026:
- with no shift, FundedNext's EURUSD M5 closes matched the existing file to a median of 1 point (0.1 pip)
- shifted by one hour either way, the median difference was 65 to 66 points

So both brokers run the same server clock (New York + 7 hours), and the new pairs line up with EURUSD in time.

Files written to `data/`, in MT5's own export format:

| File | Candles | From → to (server time) |
|---|---|---|
| `GBPUSD_M5_mt5_2025-07_2026-10.csv` | 89,686 | 31 Jul 2025 → 14 Oct 2026 |
| `USDJPY_M5_mt5_2025-07_2026-10.csv` | 89,654 | 31 Jul 2025 → 14 Oct 2026 |
| `EURUSD_M1_…`, `GBPUSD_M1_…`, `USDJPY_M1_…` | 99,999 each | 8 Jul 2026 → 14 Oct 2026 |

The M1 files stop at MT5's "Max bars in chart" limit (100,000); raising it to Unlimited should give more. The app does not use M1 yet.

## One pair on screen at a time

A pair picker replaces the EURUSD label in the toolbar. Switching saves the session on screen, then reloads the app on the other pair. The address says which (`?symbol=USDJPY`), and the browser remembers the last one.

The whole app (replay clock, timeframes, both charts, trading, indicators, ADR plan) is built around one set of M5 candles. Reloading keeps every one of those rules untouched instead of making each of them switch pairs while running.

- **A session belongs to its pair.** Every saved session already recorded its symbol. Resume on a session of another pair saves the one on screen, opens the app on that pair and rebuilds the session there. It is never rebuilt on the wrong pair's candles, even where the times exist in both.
- **Drawings are kept per pair**, as they already were.
- **Account settings are shared.** That covers the balance, risk %, commission and minimum spread.
- **The data pipeline** builds every pair with an M5 export in `data/` and writes `web/data/symbols.json`, the list the picker shows. The app start, `python -m forex_replay data` and the website build all do this. A pair is offered once its export is there.

## Money on USDJPY

On EURUSD and GBPUSD a point is $1 per lot, whatever the price. On USDJPY the profit is in yen: a point (0.001) is 100 yen per lot, worth 100 / price in dollars. At 150.000 that is $0.667 a point, $6.67 a pip. So each amount is converted at the price it happens at:
- **Size from risk:** at the entry.
- **A closed part:** at the price it closed at.
- **An open trade:** at the price now.
- **Risk money:** at the planned entry.

A pair without the dollar (EURGBP, say) would need another exchange rate. The app refuses it in plain words rather than pricing it wrongly.

The trading engine is unchanged: it still works in points and R, the same in Python and JavaScript. Pips come from the data's own `pip_points`, which is 10 for both 5-digit and 3-digit quotes. The NBB and sweep logs already used it, and read the pair's candles named in the session.

Checked in the app on USDJPY:
- a 10-pip stop at 158.18 with 1% risk on $10,000 sized to 1.58 lots, risking $99.82
- the trade closed 201 points up at 158.484 for +$194.07 after $6.32 commission; worked out by hand from the saved file, it came to the same cent
- Resume on that session from the EURUSD chart reopened USDJPY and rebuilt it with every trade matching

## Not yet done

- The new data files are not in the public repository yet; Jeevesh decides whether broker data goes there. Until then the website and anyone cloning the project have EURUSD only.
- M1 candles: not used by the app (finer fills or a 1-minute chart would be a separate piece of work).
- Two pairs on screen at once, and pairs without the dollar.
