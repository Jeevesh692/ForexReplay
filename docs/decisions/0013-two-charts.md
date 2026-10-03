# 0013: Two charts side by side, on one clock, sharing one set of drawings

- **Date:** 4 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (chose two charts over AI trade review for day 12), with Claude on the design

## Layout

"2 charts" in the top bar splits the chart area in half. The left chart is the main chart: the timeframe buttons, the replay steps (→, ←) and the backtest's saved timeframe follow it. The right chart has its own timeframe menu and starts on H4. Both the layout and the second timeframe are remembered in the browser.

## One clock, two views

Both charts follow the one replay clock ([0004](0004-one-replay-clock.md)): whatever candle the clock reveals appears on both, as a forming candle on the higher timeframe. Neither can show a candle the clock has not reached.

Each chart has its own `TimeframeView`, even when both show the same timeframe. A view reports what changed since it was last asked; a shared one would tell the first chart and then report "nothing changed" to the second. There is a test for this.

## Shared drawings

A drawing is a time and a price ([0007](0007-drawings.md)), so the same list can be painted on both charts with no conversion. Each chart has its own drawing layer over the one `DrawingStore`, and `web/js/layergroup.js` makes the layers act as one:
- A tool picked in the tool bar (or with a shortcut) waits on both charts. The first chart clicked draws it, and the tool then switches off on both.
- One drawing is selected at a time, on whichever chart.
- Undo, the magnet, colours and the text box work the same on both.

So a level marked on H4 appears on M15 at the same price, which is the point of having the higher timeframe beside you.

## The rest

- Trade lines and markers are shown on both charts. Lines can be dragged on either: a price is a price.
- Picking a price for the ticket, or the candle to start a replay, works on either chart.
- Session shading, "Go to", "Latest" and End apply to both.
- **Crosshair:** hovering one chart puts the other's crosshair on the candle containing the same moment (on H4, the 4-hour candle containing that M15 candle), and its legend shows that candle. Only the chart under the mouse sends its time, so the two cannot echo each other. The library sends no hover event for a crosshair placed by code, so the legend is updated directly.
- **Journal screenshots** capture both charts side by side, and the caption names both timeframes ("M15 + H4").
- With one chart, the second chart's drawing layer leaves the group, so a hidden chart takes no part in drawing.

## Not yet done

More than two charts, a vertical split, a different symbol on the second chart, linking the two charts' scrolling, and saving the side timeframe with the backtest.
