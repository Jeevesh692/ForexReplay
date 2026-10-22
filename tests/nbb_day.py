"""A hand-built NBB sell day on synthetic candles, for tests/test_nbb.py.

Prices are in points (110000 = 1.10000). Times are New York; March 2026 is after the US clock
change (8 Mar), so New York = UTC-4. Every number the tests expect is worked out in the comments.

History, Mon 2 Mar to Tue 10 Mar: every weekday is the same shape, so there are no swings and the
structure is NONE (bias NONE: the trade's side is used). Each server day (17:00 to 17:00 New York):
    17:00-00:00  flat 109990-110010 (this is also the Asian range, 20:00-00:00: 2.0 pips)
    00:00-08:00  up to 110150, 08:00-12:00 down to 109550, 12:00-17:00 back to 110000
So every completed day has high 110150 and low 109550: ADR(5) = 600 points = 60.0 pips,
PDH = PWH = 110150, PDL = PWL = 109550.

The day, Wed 11 Mar (15m candles, each split into three M5 candles: the high comes in the first,
the low in the second):
    01:00-02:30  climb with a 15m swing high H1 = 110100 at 01:30; L1 = 110000 (02:15)
    02:45        H2 = 110200: high of the day, 20 pips over the Asian high, 5 pips over PWH/PDH
    03:15        displacement: closes 109960 below L1, range 165 points
    03:30        lower low 109900 (M5 03:35) moves the leg's 0.0 down
    03:45        closes 109985 above 03:30's high 109970: the leg is fixed
    04:00-07:15  flat 109985-109995: no 0.62 touch, no lower low
    07:30        high 110100 reaches 0.62 = 109900 + 0.62 * 300 = 110086 in the NY killzone: final
    08:00        closes 109960 = level 0.20: break-even
    08:15        low 109880 reaches 0.0 (M5 08:20): TARGET; closes 109890 below 0.0, body 70 of 85: momentum
    08:30-09:15  down to 109590, through the runner's target 110200 - 600 = 109600
    09:30-16:00  flat at 109600
The trade: a sell limit at 110086 placed at 07:25 with the stop at H2 (110200), filled at 07:30.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from forex_replay.loglib import Candles

NY = ZoneInfo("America/New_York")
DAY = date(2026, 3, 11)


def t(day: date, hh: int, mm: int = 0) -> int:
    return int(datetime.combine(day, time(hh, mm), NY).timestamp())


def split15(start: int, o, h, l, c):
    """One 15m candle as three M5 candles: the high in the first, the low in the second."""
    return [(start, o, h, min(o, c), o), (start + 300, o, max(o, c), l, c), (start + 600, c, c, c, c)]


def flat(start: int, end: int, price: int, wiggle: int = 10):
    out, k = [], 0
    while start < end:
        out.append((start, price, price + wiggle, price - wiggle, price))
        start += 300
        k += 1
    return out


def ramp(start: int, end: int, a: int, b: int):
    """Straight line from a to b, each M5 candle spanning its step."""
    n = (end - start) // 300
    out = []
    for k in range(n):
        p0, p1 = a + (b - a) * k // n, a + (b - a) * (k + 1) // n
        out.append((start + 300 * k, p0, max(p0, p1), min(p0, p1), p1))
    return out


def history_day(d: date):
    """The server day ending 17:00 New York on weekday d (it starts 17:00 the evening before)."""
    prev = d - timedelta(days=1)
    rows = flat(t(prev, 17), t(d, 0), 110000)
    rows += ramp(t(d, 0), t(d, 8), 110000, 110150)
    rows += ramp(t(d, 8), t(d, 12), 110150, 109550)
    rows += ramp(t(d, 12), t(d, 17), 109550, 110000)
    return rows


SHAPE = [  # (NY hh:mm, open, high, low, close) of 15m candles on the day
    ((1, 0), 110000, 110040, 109990, 110030), ((1, 15), 110030, 110070, 110020, 110060),
    ((1, 30), 110060, 110100, 110050, 110080), ((1, 45), 110080, 110085, 110040, 110050),
    ((2, 0), 110050, 110060, 110020, 110030), ((2, 15), 110030, 110040, 110000, 110020),
    ((2, 30), 110020, 110090, 110010, 110080), ((2, 45), 110080, 110200, 110070, 110150),
    ((3, 0), 110150, 110160, 110100, 110110), ((3, 15), 110110, 110115, 109950, 109960),
    ((3, 30), 109960, 109970, 109900, 109910), ((3, 45), 109910, 109990, 109905, 109985),
]
AFTER = [
    ((7, 30), 109990, 110100, 109985, 110090), ((7, 45), 110090, 110095, 110040, 110050),
    ((8, 0), 110050, 110055, 109955, 109960), ((8, 15), 109960, 109965, 109880, 109890),
    ((8, 30), 109890, 109895, 109800, 109810), ((8, 45), 109810, 109850, 109790, 109845),
    ((9, 0), 109845, 109850, 109700, 109710), ((9, 15), 109710, 109720, 109590, 109600),
]


def the_day(shape=SHAPE, after=AFTER, quiet=(109990, 5)):
    rows = flat(t(DAY - timedelta(days=1), 17), t(DAY, 1), 110000)
    for (hh, mm), o, h, l, c in shape:
        rows += split15(t(DAY, hh, mm), o, h, l, c)
    last = shape[-1][0]
    quiet_start = t(DAY, *last) + 900
    quiet_end = t(DAY, *after[0][0])
    rows += flat(quiet_start, quiet_end, quiet[0], quiet[1])
    for (hh, mm), o, h, l, c in after:
        rows += split15(t(DAY, hh, mm), o, h, l, c)
    rows += flat(t(DAY, *after[-1][0]) + 900, t(DAY, 17), 109600, 0)
    return rows


def candles(day_rows=None):
    rows = []
    for d in [date(2026, 3, 2) + timedelta(days=k) for k in range(9)]:
        if d.weekday() < 5:
            rows += history_day(d)
    rows += day_rows if day_rows is not None else the_day()
    rows = sorted({r[0]: r for r in rows}.values())
    return Candles.from_rows([(*r, 2) for r in rows])  # spread 2 points (0.2 pips)


def mirrored(c: Candles, pivot: int = 220000) -> Candles:
    """The same day upside down: price p becomes pivot - p (110000 stays 110000)."""
    return Candles(c.time, pivot - c.open, pivot - c.low, pivot - c.high, pivot - c.close, c.spread)


def sell_trade(**changes):
    trade = {
        "id": 1, "status": "CLOSED", "side": "SELL", "orderType": "LIMIT",
        "placedTime": t(DAY, 7, 25), "entryTime": t(DAY, 7, 30), "exitTime": t(DAY, 8, 20),
        "orderPrice": 110086, "plannedEntry": 110086, "entryPrice": 110086, "exitPrice": 109900,
        "stopLoss": 110200, "initialStop": 110200, "takeProfit": 109900,
        "plannedRisk": 114, "pnl": 186, "plannedRewardR": 1.63, "mfeR": 1.8, "maeR": 0.1,
        "resultR": 1.63, "lots": 0.5, "money": 89.0, "commission": 4.0, "exitReason": "TAKE_PROFIT",
        "tags": ["A+ setup", "followed plan"], "note": "textbook",
    }
    trade.update(changes)
    return trade


def session(trades, furthest=None, start=None, drawings=None, run="bt-nbb-1"):
    return {
        "version": 1, "id": run, "journal": "nbb", "name": "test", "symbol": "EURUSD", "digits": 5, "pipPoints": 10,
        "startTime": start if start is not None else t(date(2026, 3, 9), 0),
        "furthestTime": furthest if furthest is not None else t(DAY, 16, 55),
        "settings": {"minSpreadPips": 0.5}, "actions": [], "trades": trades,
        "drawings": drawings if drawings is not None else [
            {"type": "fib", "points": [{"time": t(DAY, 2, 45), "price": 110200}, {"time": t(DAY, 3, 30), "price": 109900}]}],
        "saved": "2026-10-13T12:00:00Z",
    }
