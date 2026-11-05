# 0030: Setup finder

- **Date:** 5 Nov 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash ("add this indicator on forex replay, as I only exit based on my discretion", and "I should be able to jump when the setup appears and it tells me to buy or sell at the instant so that I don't miss"), with Claude on the details below

## Why

His RSI + Bollinger strategy (the "technical analysis based" journal) was reviewed in a chat with Claude on 4 and 5 Nov 2026, and the same rules were backtested mechanically in Python on Jan 2024 to Oct 2026. On the setups he and the rules both took, entering on the close of the first reversal candle made about +29R on EURUSD, against about +5R for his own later entries. His losing stretch from Apr to Oct 2026 came mostly from entering one to four 4-hour candles late, with stops wider than 1.8 ATR. His choice of which setups to skip did help. So the app finds the setup and says so at the moment its candle closes, and he decides whether to take it and when to get out.

## The rules (the defaults are exactly the ones backtested)

On a closed 4-hour candle k, a SELL (a BUY is the mirror image):

- RSI 14 reached 70 on candle k or the one before it,
- price reached the upper Bollinger band (20, 2) within the last 3 candles, measured against the band of the candle before k,
- candle k closed below its open.

Entry is the close of candle k, at market, so the order fills at the next candle's open. The stop goes 2 pips beyond the highest high (sell) or lowest low (buy) of the last 3 candles, and the target is 1R. A setup is **skipped** when the stop is wider than 1.8 × ATR 14 (a late, stretched entry) or under 5 pips. Every number can be changed in the Indicators dialog, and **Back to the tested rules** restores the defaults.

## How it works, and why

- **Always 4-hour candles, whatever chart is on screen (Claude's call).** The strategy is an H4 strategy. The finder keeps its own H4 view of the replay's base candles, with the older H4 history in front for the indicators' warm-up.
- **No look-ahead.** Only candles that had closed at the replay clock are read (`SetupFinder.closedCount`). A test changes every later candle and requires the same setups, and a real-data test walks the clock to every 4-hour close and must find exactly the setups the whole history holds.
- **N plays forward, it does not search ahead.** Like the other jumps, it reveals every base candle in order and checks at each one, so stops, targets and challenge limits work as if played through. It stops at the first setup's close, or where an open trade changes, or after 60 days.
- **Stopping at setups (on by default when the finder is on):** playing pauses at each setup, and J, 1, 2 and 3 stop there too. At fast speeds several candles arrive at once, so playing can stop a few minutes after the close; the hint says how many.
- **The card.** BUY or SELL, entry, stop (in pips and ATR), target, lot size from your risk %, and **Buy / Sell at market**, which places the market order with that stop and target and tags the trade "setup finder". **Ticket** copies the levels into the order ticket instead. The card shows until the next 4-hour candle closes, and says "Taken" once an order on that side has been placed since the setup's close.
- **Markers.** An arrow for each setup and a grey "skip" dot for each skipped one, on whichever candle of each chart holds the setup's close. When setups fall on back-to-back candles, only the first is labelled.
- **Back-to-back setups are kept.** The next red candle can meet the same rules (RSI was 70 a candle ago). The backtest only skipped those because a trade was already open. A first-reversal-candle-only rule was tried in Python: EURUSD +22.1R on 94 setups against +23.7R on 104, so it changed little and was left out.
- **Settings live in this browser** (`forexreplay.setups`), like the indicator settings, not in the strategy.

## Not yet done

- The RSI here is Wilder's, seeded with a simple average, like the RSI line on the chart. The Python backtest used pandas' exponential average, so a reading right at 70 can fall on either side and a setup or two can differ. On 30 Sep 2026 both found the same BUY at 1.13407 with a 1.13097 stop.
- No alert outside the app. The TradingView script sent in the chat does that on live charts.
- No per-strategy settings, and no setup statistics in Analytics yet (the trades carry the "setup finder" tag for that).
- Only checked on EURUSD (minutes and 1-hour swing mode). On the other four pairs the mechanical version was roughly break-even or worse in the backtest.
