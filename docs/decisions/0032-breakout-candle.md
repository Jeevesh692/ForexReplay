# 0032: Breakout candle marker for the NY Opening Range Breakout

- **Date:** 5 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (the rules below, exactly; "do not change them"), with Claude on how it is built and shown

## The rules (Jeevesh's)

- **Opening range:** the high (ORH) and low (ORL) of the M5 candles opening 09:30 to 09:55 New York, from `latestOpeningRange()`. ORW = ORH − ORL.
- **Buffer b:** a price per symbol: $1.00 on gold, 1 pip on every currency pair. It can be changed in the Opening range row of the Indicators dialog.
- **Breakout window:** the M5 candles opening 10:00 to 10:55 New York.
- **The breakout candle:** the first M5 candle in the window that closes above ORH + b or below ORL − b. Later candles that day are never checked.
- **Displacement:** the candle counts only if its body (|close − open|) is at least 60% of its range (high − low), and its range is at least 0.5 × ORW.
- **No breakout:** if nothing closes outside by the end of the window, there is no breakout that day.

## What it shows

- **The arrow:** on the breakout candle, pointing up for a close above the range and down for a close below.
  - **Green**, "Displacement – enter next open", if it passes both tests.
  - **Grey**, "Not displacement – no trade", if it fails, followed by the test or tests that failed.
- **No breakout:** a small grey "No breakout" dot on the 10:55 candle.
- **The legend:** hovering on the breakout candle shows, for example, "body 79% · size 6.81 / needs 5.21". "Needs" is half of ORW.
- **Timeframes:** M1, M5 and M15. On M1 and M15 the marker sits on the candle that holds the M5 candle's close. It is not shown on H1 and above.
- **Only the latest day:** as with the range lines, only the latest day's marker shows, so a jump to the next day clears the old one.
- **Switching it off:** it is part of the Opening range indicator, as a "mark the breakout candle" tick box, on by default.

## How it is built, and why

- **Its own module (`web/js/breakout.js`), judged on closed M5 candles built from the minutes, whatever is on screen.** `BreakoutFinder` builds M5 once from the base candles and, like the setup finder, counts only the M5 candles that had fully closed at the replay's position. So:
  - the marker appears the minute the breakout candle closes, and never while it forms
  - "No breakout" appears only once the 10:55 candle has closed

  The forming candle is never read.
- **Whole numbers for the tests:** prices are in points, and both tests compare whole numbers (5 × body ≥ 3 × range, and 2 × range ≥ ORW). So no rounding can tip a candle exactly on 60% either way.
- **Drawn with the trade markers,** which only paint what is on screen. Judging a day costs a dozen candles and is cached until another M5 candle closes.
- **Buffer stored per symbol (Claude's call):** `buffers` in the indicator settings, in price, for the pair on screen. One setting with a single number could not be right for both gold and EURUSD.
- **The window (Claude's call):** it is the hour after the range ends. With the default 09:30 + 30 minutes that is exactly 10:00 to 10:55. If the range's start or length is changed, the window follows.
- **In base 1-hour (swing) mode** M5 cannot be built from hours, so nothing is marked.
- **Labels kept inside the chart:** marker labels used to be centred on their candle. A long one on the newest candle ran under the price axis, so labels now stay inside the chart's edges (`chart.js`, `TradeMarkers.paint`).

## Checked

On real gold data, matching Jeevesh's own figures:

- **5 Aug 2025:**
  - **The 10:00 New York candle** wicks above ORH + $1 but closes inside, so it is not counted.
  - **The 10:20 candle:** close 3382.17, body 79%, size 6.81 against 5.21 needed. Green.
- **6 Aug 2025:**
  - **The 10:00 candle** closes 3373.59, below ORH + $1, so it is not counted.
  - **The 10:20 candle:** close 3375.89, body 85%, size 3.55 against 4.16 needed. Grey, with the size test failed.

## Not yet done

- No trade is placed. "Enter next open" is a prompt; the order is still yours.
- A London range would use a London clock; this is New York only, like the range itself.
- The marker is not saved in the session's actions. It is worked out again from the candles every time, so it always matches them.
