# 0007: Drawings are data in time and price; one pure file decides geometry

- **Date:** 3 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants TradingView-style drawing tools, with the OTE levels he trades), with Claude on the design

## A drawing is anchored in time and price

Every drawing is plain data: a type and points of `{ time (UTC seconds), price (points) }`. Nothing is stored in pixels or candle numbers. So a line drawn on M5 is in the right place on H1, after scrolling, during a replay and after a reload.

The chart places candles by index, so weekends take no width. `timeToLogical` and `logicalToTime` in `web/js/drawings.js` convert between a time and a position on the chart:

- A time inside the data maps to the candle that contains it.
- A time past the last candle (the empty space on the right, or the future during a replay) is placed as if candles continued at the timeframe's spacing. When those candles are later revealed, the point is on the candle with that time.

## Two files

| File | Does | Tested |
|---|---|---|
| `web/js/drawings.js` | what a drawing is, how handles move it, where its lines, boxes and labels go (`layout`), what is under the mouse (`hit`), saving and loading | in Node, with a made-up screen of 10 pixels per candle |
| `web/js/drawinglayer.js` | converts pixels to time and price, paints with the chart library's primitive hook, listens to the mouse | in a headless browser |

The same `layout` result is used to paint a drawing and to decide whether the mouse is on it, so what you see and what you can grab cannot disagree.

## The tools

| Tool | Clicks | Notes |
|---|---|---|
| Trendline | 2 | a segment between two points |
| Horizontal line | 1 | price label at the right |
| Rectangle | 2 | reshaped from any corner |
| Fibonacci retracement | 2 | first click is where the move starts (level 1), second where it ends (level 0). Levels 0, 0.382, 0.5, 0.618, 0.705, 0.79, 1. The 0.618 to 0.79 band (OTE) is shaded. Levels run to the right edge. |
| Long / short position | 1 | starts with a 10-pip stop and a 20-pip target, 24 candles wide. Shows pips, R, and the lot size and dollars at risk from the account's size setting. Stop, entry and target cannot be dragged out of order. |

"Use in ticket" copies a position drawing's entry, stop and target into the order ticket as an order at that price. It does not place the order: the trade still goes through the ticket and the engine, and only while the replay is live.

## Mouse rules

The same as TradingView: pick a tool, click (or press, drag and release), and the tool switches off. Click a drawing to select it; drag a handle to reshape it or its body to move it; Delete removes it; Esc cancels. A click on empty chart deselects and the chart pans as usual.

When a trade's stop or target line and a drawing are under the mouse together, the trade line wins. While a drawing tool is waiting for its clicks, trade lines cannot be dragged, so a click meant for a drawing can never move a stop.

## Saving

Drawings are saved in the browser (`forexreplay.drawings.EURUSD`) on every change and survive reloads and replays. Anything read back is checked (`cleanDrawing`); a damaged entry is dropped instead of reaching the chart. "Remove all" takes two clicks because it cannot be undone.

## Since v2.0.0

A position placed at the newest candle runs past the right edge of the chart. Its stop, target and width handles and its labels are now placed on the part you can see, and the stop and target can also be typed (see the build log, "After v2.0.0").

## Not yet done

Colours and line styles, rays, text notes, snapping, undo and keyboard shortcuts came on day 9 ([0010](0010-drawing-styles-magnet-undo-shortcuts.md)); extended lines did not. (Since day 7, a replay's drawings are saved with its backtest; see [0008](0008-backtests-saved-as-actions.md).)
