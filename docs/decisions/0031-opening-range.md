# 0031: Opening range indicator

- **Date:** 5 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("build a indicator for me which gives the mid-or of each session, in line form and disappears after I jump to another session"), with Claude on the definition and defaults

## What it draws

For the NY Opening Range Breakout (playbook strategy 4):

- **The range:** the high and low of the candles that **opened** in [start, start + minutes), New York time. The default is 09:30 for 30 minutes: the six M5 candles 09:30 to 09:55.
- **Three lines:** the midpoint (yellow, 2 px, the strategy's stop reference), and the high and low (dashed purple). The high and low can be switched off; the mid cannot.
- **New York time:** the start is New York wall-clock time, so the range lands at 19:00 IST in US summer and 20:00 IST in winter without any setting.

## Only the latest range

Jeevesh asked for the lines to disappear when he jumps to another day. So only the **latest** range the candles have reached is drawn: its lines run from its first candle to the last candle shown, and every earlier day is blank.

- **A weekend or holiday** has no candles in the window, so Monday before 09:30 still shows Friday's range.
- **While the range is forming** (a replay inside 09:30 to 10:00) its high and low are those of the candles revealed so far. A jump to 10:00 New York reveals every candle that opened before it, so the range is complete on landing.
- **No look-ahead:** the range is worked out from the candles on the chart only, as for every indicator.
- **The one exception to "a past value never changes":** a new day blanks the old day's lines. The step-by-step engine says so (`redraw: true` on the lines) and the chart then sends the whole line again instead of only the changed candles. That happens once a day, and on every step while a range forms.

## Timeframes

A candle must open inside the window. On M1 to M30 the 09:30 to 10:00 range is the same; on H1 and above no candle opens inside it, so nothing is drawn. No special case was needed.

## How it is built

- `latestOpeningRange()` in `indicators.js`, used by both `computeIndicators` and the step-by-step engine, so they cannot differ. The replay test checks the engine against the full calculation with the range on.
- No Python reference: the range is a high and a low over a time window, with no arithmetic to drift. The tests work the values out by hand instead (summer and winter, M5 and M15 against M1, H1 blank, two days, a weekend, a forming range).
- Checked on the real gold data for 5 Aug 2025: at the 10:00 New York jump it gives high 3379.65, low 3369.23, mid 3374.44, the same as a separate pandas calculation.

## Not yet done

- The zone is fixed to New York. A London range (08:00 London) can be set as 03:00 New York in winter, but that is off by an hour in the weeks when the UK and US clocks change on different dates.
- The lines are not stopped at the strategy's time exit (11:30 New York); they run to the last candle shown.
- There are no ORH + buffer lines, and nothing marks the breakout candle.
