# ForexReplay v2.0.0

The browser version of ForexReplay: a TradingView-style bar-replay and backtesting app for EURUSD, built from 27 Sep to 4 Oct 2026 with an AI coding agent (Claude) to a 14-day plan.

## Start

```bash
pip install -r requirements.txt
python -m forex_replay app        # or double-click start_app.bat
```

Opens http://127.0.0.1:8765. The first start builds the market data from the MT5 export in `data/` and downloads TradingView Lightweight Charts.

## What is in it

- **Replay** on one M5 clock driving M5 to D1, with forming higher-timeframe candles; trading only at the live edge.
- **Two charts** side by side on the same clock, with shared drawings and a linked crosshair.
- **Orders:** market, limit and stop orders with draggable stop and target, filled on M5 candles; an account in dollars with risk-based lot sizing, commission, partial closes and breakeven.
- **Prop-firm challenge mode:** profit target, daily loss and maximum loss, checked on every M5 candle.
- **Drawings:** trendline, ray, horizontal and vertical lines, rectangle, Fibonacci with OTE, long/short tool, text, with colours, magnet, undo and shortcuts.
- **Indicators:** SMA, EMA, daily VWAP, RSI, from revealed candles only.
- **Backtests** saved as you go and resumed by rebuilding them from their actions.
- **Journal** with notes, tags and automatic screenshots, plus an analytics page.

## Tests

66 Python and 115 JavaScript tests. The browser's trading engine, statistics and indicators are each held to a Python original by a recorded comparison file.

A fresh clone was checked on 4 Oct 2026: both suites pass, and the app builds its data, downloads the chart library and loads.

## Known limits

- EURUSD only, from one MT5 export (1 Aug 2025 to 11 Sep 2026).
- Fills are modelled at M5 resolution; there is no tick or M1 data yet.
- See "Not yet done" at the end of each record in `docs/decisions/`.

Full history: `docs/build-log.md`.
