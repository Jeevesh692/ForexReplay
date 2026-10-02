# 0004: One replay clock, and sessions defined in their own city clocks

- **Date:** 2 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (replay must never show the future; sessions matter for the strategy), with Claude on the design

## The risk: leaking the future

A replay tool is only worth using if it cannot show you what happens next. The usual leak is the higher timeframe: you replay on M5, glance at H1, and the H1 candle already shows the full hour, including its final high and low.

## Decision: one clock, every view derived from it

The app has a single number, `position`: how many M5 candles have been revealed (`web/js/replay.js`). Nothing else stores time.

- Each timeframe has a `TimeframeView` (`web/js/timeframes.js`). It holds the full candles privately and exposes `display`: the candles complete at `position` plus one **forming** candle built only from revealed M5 candles.
- The chart is only ever given `display`. Candles after the clock are never passed to the chart library, so no zoom, scroll or timeframe switch can reveal them.
- While replaying, the Data tab is hidden, because its overview line shows the whole price history.

**Stepping** moves the clock to the end of the current chart candle (Right arrow), or by one M5 candle (Shift + Right). **Playing** reveals M5 candles at 1 to 100 per second, so a higher-timeframe candle visibly grows as it would live.

## Looking back without cheating

`furthest` records how far the replay has got. Stepping back only moves `position`; the clock is "live" only when `position === furthest`. From day 4, orders are accepted only when live, so you cannot rewind and enter a trade on a move you have already watched. This carries over the rule from the v1 engine.

## Fast updates

Moving forward, a view reports exactly which candles changed and the chart updates only those. Moving back or jumping redraws from clean data. A test drives each view along 300 random moves and checks after every move that it equals a fresh aggregate of the revealed candles, for all six timeframes.

## Sessions

Sessions are defined in their own city's clock (`web/js/sessions.js`):

| Session | Hours | In India time |
| --- | --- | --- |
| Asia | 09:00–18:00 Tokyo | 05:30–14:30 all year |
| London | 08:00–17:00 London | 12:30–21:30 in summer, 13:30–22:30 in winter |
| New York | 08:00–17:00 New York | 17:30–02:30 in summer, 18:30–03:30 in winter |

The alternative, fixed India-time hours, would be wrong for about half the year and for the weeks in March and autumn when the US and UK change clocks on different dates. The shading is drawn behind the candles with the chart library's primitive hook, on M5 to H1 only, and only up to the replay position.
