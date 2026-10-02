# 0003: Higher timeframes follow the broker clock; the chart axis shows India time

- **Date:** 2 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (charts must match MetaTrader and read in India time), with Claude on the implementation

## Where should an H4 or daily candle start?

Only M5 candles are stored. Every higher timeframe is built from them in the browser (`web/js/timeframes.js`), so the question is where each bigger candle begins.

| Option | Result |
| --- | --- |
| UTC boundaries (00:00, 04:00, … UTC) | Simple, but H4 and D1 candles would differ from MetaTrader's |
| India-time boundaries | Daily candle would start at Indian midnight, in the middle of the New York session |
| **Broker server clock (New York + 7h)** | Candles match MetaTrader exactly; the daily candle runs New York close to New York close, the forex convention |

**Decision:** bucket on the broker server clock. H4 candles start at 00:00, 04:00, … server time, and D1 at 00:00 server time, which is 17:00 in New York. In India time that is 02:30 in the US summer and 03:30 in the US winter. Up to H1 the choice makes no difference, because the server clock differs from UTC by whole hours.

The server offset (+3h during US daylight saving, +2h otherwise) is computed in JavaScript from the US rule: second Sunday of March to first Sunday of November.

## Forming candles

`aggregate(m5, timeframe, upTo)` uses only the first `upTo` M5 candles. During replay (day 3) `upTo` is the replay position, so the last higher-timeframe candle is still forming and contains nothing from the future. This is the property that makes multi-timeframe replay honest.

## How we know the JavaScript is right

The Python pipeline writes `reference.json`: every H4 and D1 candle computed independently with pandas. A JavaScript test rebuilds them from M5 and compares all 1,734 H4 and 289 D1 candles field by field. The two implementations share no code, so agreement is real evidence.

## India time on the chart axis

TradingView Lightweight Charts draws timestamps as UTC and has no timezone setting. Following the approach its documentation describes, every timestamp is shifted by +5:30 on the way into the chart and shifted back on the way out (`toChartTime` / `fromChartTime` in `web/js/chart.js`). Only that file ever sees shifted times; everything else in the app works in real UTC. India has no daylight saving, so one fixed shift is exact.
