# 0010: More drawing tools, colours, a magnet, undo for drawings, and one shortcut table

- **Date:** 3 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants rays, text, colours, snapping, undo and keyboard shortcuts, as on TradingView), with Claude on the design

## New tools

| Tool | Clicks | Notes |
|---|---|---|
| Ray | 2 | starts at the first point and carries on through the second to past the edge of the chart |
| Horizontal ray | 1 | starts at the clicked candle and runs to the right; useful for a level that matters from a given time |
| Vertical line | 1 | marks a time; its India time is printed at the bottom |
| Text | 1 | click, type, Enter. Double-click a note (or "Edit text") to change it. Esc, or an empty box, keeps nothing. Up to 200 characters |

They follow [0007](0007-drawings.md): anchored in time and price, laid out by the same pure `layout`, saved and checked by `cleanDrawing`.

## Colour and line style

Trendlines, rays, horizontal and vertical lines, rectangles and text take one of eight colours; lines also take solid, dashed or dotted. The choice is made in the small bar that appears when a drawing is selected. The last choice for each tool is remembered for new drawings of that tool, as TradingView does.

Fibonacci and the position tools keep their own colours, because their colours carry meaning (the orange OTE zone, green profit and red loss).

Only colours from the fixed list are accepted when a drawing is loaded. A saved file with anything else simply loses the colour, not the drawing, so a damaged or edited save can never put arbitrary text into the page's styles.

## Magnet

When the magnet is on, a new point and a dragged handle jump to the nearest open, high, low or close of the candle under the mouse. This is a "strong" magnet: it always snaps, however far away the price is, so a click well below a candle lands on its low. Holding Ctrl turns the magnet the other way for that one move. Moving a whole drawing does not snap, so its shape is kept.

The magnet only looks at the candles on the chart, so during a replay it can only snap to prices already revealed. In a forming H1 candle it snaps to the high of the M5 candles shown so far, never to the high of the whole hour (there is a test for this).

## Undo and redo

Ctrl + Z and Ctrl + Y (or Ctrl + Shift + Z), or the arrows in the tool bar. The drawing store keeps a copy of the list before each change (add, move, restyle, edit text, delete, clear), up to 100 steps. A change that changes nothing adds no step. Loading a list (starting a replay, resuming a backtest, leaving a replay) starts a fresh history, so undo never reaches into another run.

Undo covers drawings only. Trades cannot be undone: taking back a losing trade would make the backtest a lie.

"Remove all" still takes two clicks, and the hint now says Ctrl + Z brings the drawings back.

## Shortcuts

Drawing tools use Alt + a letter, like TradingView: T trendline, R ray, H horizontal line, J horizontal ray, V vertical line, B rectangle, F Fibonacci, L long, S short, N text, M magnet. `?` (or the keyboard button) lists every shortcut.

Everything is in one table, `web/js/shortcuts.js`. The key handler and the help list both read it, so the list cannot go out of date, and a test checks that no two shortcuts share a key and that every tool has one. Keys are matched on the physical key (`event.code`), because with Alt held some keyboards turn the letter into a different character. On a Mac, Cmd counts as Ctrl. Shortcuts are ignored while typing in a box.

Alt + F would normally open the browser's menu; the app cancels that key press. That was checked with a synthetic key press in the in-app browser, not with a real keyboard in Chrome.

## Not yet done

Extended lines (both directions), arrows, channels, line width, font size for notes, a weak magnet that snaps only when close, and copying drawings between backtests.
