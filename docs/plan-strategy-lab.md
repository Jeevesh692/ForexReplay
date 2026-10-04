# Strategy Lab: plan and status

Goal: test simple indicator strategies on higher timeframes (H4, D1) from inside the app, tune their settings on in-sample data, and judge them on out-of-sample data they never saw, with every trade inspectable on the chart. Asked for by Jeevesh on 4 Oct 2026, after v2.0.2.

Say "start lab day N" to do a day.

## Decided (4 Oct 2026, Jeevesh)

- **Data:** export a much longer EURUSD history from MT5 (H1 and D1 as far back as it goes, plus M5 for recent years). The ~18 months of M5 on disk (25 Feb 2025 to 11 Sep 2026) is about 400 daily candles: too few trades on D1 to tune anything without fitting noise.
- **How strategies are defined:** ready-made templates whose numbers are set in the app. Each template's rules are written out in plain words beside it. No coding needed.
- **First template:** Bollinger bands. The framework is general, so RSI, EMA crossover and others can be added later as further templates.

## Days

| Day | Scope | Status |
|---|---|---|
| 1 | Longer history: the pipeline reads MT5 H1 and D1 exports of any length, checks them, and joins them with M5 (M5 where it exists, H1 before that). Fills are resolved on the finest data available for each period, with the same conservative rules. Tests against pandas. | waiting for the MT5 export |
| 2 | Strategy engine in Python: templates, signals on the close of the chosen timeframe's candle, entry from the next candle, exits (stop and target in ATR or pips, opposite signal, back to the middle band). Bollinger template (mean reversion and breakout). Bollinger bands and ATR added to the indicators in both languages and held to each other. A strategy run is written as a backtest and journal, so it opens in Analytics and on the chart. | |
| 3 | Strategy Lab tab: template, timeframe, settings, exits, costs, date range; run; summary, equity curve and trade list. Click a trade and the chart jumps to it, ready to replay. | |
| 4 | Tuning: a parameter grid on the in-sample period only; choice of objective (expectancy, profit factor, a Sharpe-style ratio on R); a minimum number of trades; a heatmap of results across the grid; the chosen settings run once on the out-of-sample period; the number of combinations tried is shown with the result. | |
| 5 | Robustness: walk-forward (rolling in-sample and out-of-sample windows), results by year, sensitivity to spread and commission, and shuffling the order of trades to see the range of drawdowns. | |
| 6 | Speed, fixes, documentation, release v2.1. | |

## How fills work on older data

Where M5 exists, fills are resolved on M5 as now. Before that, they are resolved on H1 candles with the same rules: never on the signal candle; stop first when stop and target are both inside one candle; a gap fills at the open. H1 is coarser, so a stop and target both inside one hour count as a loss more often than they would on M5. That makes old results slightly pessimistic, never flattering. The app will say which resolution each part of a test used.

## Exporting the history from MT5 (Jeevesh)

1. Open MT5 and log in to your broker account.
2. Tools → Options → Charts: set **Max bars in chart** to **Unlimited**, then restart MT5.
3. View → Symbols (Ctrl + U) → the **Bars** tab.
4. Choose **EURUSD**, timeframe **D1**, and a start date far back (for example 2000.01.01) up to today. Press **Request**, wait for the bars to load, then **Export Bars**. Save it into the project's `data` folder as `EURUSD_D1_mt5.csv`.
5. Do the same for **H1** (`EURUSD_H1_mt5.csv`) and for **M5** (`EURUSD_M5_mt5_new.csv`, as far back as it gives).
6. Note how far back each one goes (the first line of the file). Brokers keep different amounts of history.

The pipeline assumes the same broker server clock as before (New York + 7 hours). If the export comes from a different broker, say so before lab day 1.

## Open questions

- More templates after Bollinger bands: RSI reversal, EMA crossover, Donchian breakout were offered.
- Other symbols (GBPUSD, XAUUSD) would need their own exports and point sizes.
