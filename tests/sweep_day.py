"""A hand-built liquidity-sweep sell day on synthetic candles, for tests/test_sweep.py.

Prices in points (110000 = 1.10000); times New York (UTC-4 in March 2026). The history days are the
NBB ones (tests/nbb_day.py): no 30m swings, PDH 110150, PDL 109550, ADR 60 pips.

The night before Wed 11 Mar, from Tue 17:00 (30m candles, each split into M5 candles: the high in the
first, the low in the second, the rest at the close):
    flat 109990-110010, with a spike down to 109700 at 19:00 and up to 110300 at 21:00
        -> overnight low ONL 109700 and high ONH 110300; PDH 110150 is taken by the spike, PDL stays
    04:00  swing high SH 110100 (later highs no higher: untaken; price falls 250 points after it)
    05:00  swing low 109850, 06:30 swing low 109852: 2 points apart, within 0.1 x ATR -> one level EQL 109850
    07:30  closes 109950: the 08:00 price
The map at 08:00, above: ONH 110300, SH 110100. Below: EQL 109850, ONL 109700, PDL 109550.

After 08:00 (M5 candles):
    08:30  high 110120 trades through SH 110100 and closes 110110 above it (1 close beyond)
    08:35  closes 110070 back below: the confirmation. Rule entry 110070; rule stop 110120 + spread 5
           (the 0.5-pip minimum) + 10 = 110135; rule risk 6.5 pips
    The trade: sell at market placed 08:35, filled 08:40 at 110070, stop 110135.
    08:50  low 109990, a 5m swing low confirmed at 09:00's close: 80 points = 1.2R away -> half off at
           09:00's close 110010 (0.46R), stop to entry
    09:15  low 109855 reaches the target 109850 + 10 = 109860 (21 pips = 3.2R) -> the rest off (1.62R)
    then flat at 109870 to 16:00
Phase 2 = 0.5 * 60/65 + 0.5 * 210/65 = 2.08R. Best move 110070 - 109855 = 21.5 pips; at 16:00 +20.0 pips.
"""

from datetime import date, timedelta

from tests.nbb_day import DAY, flat, history_day, t
from forex_replay.loglib import Candles


def split30(start: int, o, h, l, c):
    """One 30m candle as six M5 candles: the high in the first, the low in the second, then flat at the close."""
    return [(start, o, h, min(o, c), o), (start + 300, o, max(o, c), l, c)] + [(start + 300 * k, c, c, c, c) for k in range(2, 6)]


NIGHT = [  # (NY hour, minute, the day before or not), open, high, low, close of 30m candles
    ((19, 0, -1), 110000, 110010, 109700, 110000), ((21, 0, -1), 110000, 110300, 109990, 110000),
]
MORNING = [
    ((3, 0), 110000, 110030, 109990, 110020), ((3, 30), 110020, 110060, 110010, 110050),
    ((4, 0), 110050, 110100, 110040, 110060), ((4, 30), 110060, 110070, 109990, 110000),
    ((5, 0), 110000, 110010, 109850, 109900), ((5, 30), 109900, 109960, 109890, 109950),
    ((6, 0), 109950, 109970, 109900, 109910), ((6, 30), 109910, 109915, 109852, 109890),
    ((7, 0), 109890, 109950, 109880, 109940), ((7, 30), 109940, 109960, 109900, 109950),
]
AFTER = [  # M5 candles from 08:00: (hh, mm), open, high, low, close
    ((8, 0), 109950, 109980, 109940, 109970), ((8, 5), 109970, 110000, 109960, 109990),
    ((8, 10), 109990, 110050, 109980, 110040), ((8, 15), 110040, 110080, 110030, 110070),
    ((8, 20), 110070, 110095, 110060, 110090), ((8, 25), 110090, 110098, 110080, 110095),
    ((8, 30), 110095, 110120, 110090, 110110), ((8, 35), 110110, 110115, 110060, 110070),
    ((8, 40), 110070, 110075, 110040, 110045), ((8, 45), 110045, 110050, 110000, 110005),
    ((8, 50), 110005, 110010, 109990, 109995), ((8, 55), 109995, 110030, 109992, 110020),
    ((9, 0), 110020, 110025, 110000, 110010), ((9, 5), 110010, 110015, 109950, 109960),
    ((9, 10), 109960, 109965, 109900, 109910), ((9, 15), 109910, 109915, 109855, 109870),
]


def the_day(night=NIGHT, morning=MORNING, after=AFTER):
    prev = DAY - timedelta(days=1)
    rows = flat(t(prev, 17), t(DAY, 3), 110000)
    for (hh, mm, back), o, h, l, c in night:
        rows += split30(t(DAY if back == 0 else prev, hh, mm), o, h, l, c)
    for (hh, mm), o, h, l, c in morning:
        rows += split30(t(DAY, hh, mm), o, h, l, c)
    for (hh, mm), o, h, l, c in after:
        rows.append((t(DAY, hh, mm), o, h, l, c))
    rows += flat(t(DAY, *after[-1][0]) + 300, t(DAY, 17), after[-1][4], 0)
    return rows


def candles(day_rows=None):
    rows = []
    for d in [date(2026, 3, 2) + timedelta(days=k) for k in range(9)]:
        if d.weekday() < 5:
            rows += history_day(d)
    rows = {r[0]: r for r in rows}
    rows.update({r[0]: r for r in (day_rows if day_rows is not None else the_day())})  # the day replaces what it covers
    return Candles.from_rows([(*r, 2) for r in sorted(rows.values())])


def sell_trade(**changes):
    trade = {
        "id": 1, "status": "CLOSED", "side": "SELL", "orderType": "MARKET",
        "placedTime": t(DAY, 8, 35), "entryTime": t(DAY, 8, 40), "exitTime": t(DAY, 9, 15),
        "orderPrice": None, "plannedEntry": 110070, "entryPrice": 110070, "exitPrice": 109860,
        "stopLoss": 110135, "initialStop": 110135, "takeProfit": 109860, "plannedRisk": 65, "pnl": 210,
        "plannedRewardR": 3.23, "mfeR": 3.3, "maeR": 0.1, "resultR": 3.23, "lots": 0.8, "money": 161.6,
        "commission": 6.4, "exitReason": "TAKE_PROFIT", "tags": ["A+ setup"], "note": "swept SH",
    }
    trade.update(changes)
    return trade


def session(trades, furthest=None, start=None, run="bt-sweep-1"):
    return {
        "version": 1, "id": run, "journal": "liquidity_sweep", "name": "test", "symbol": "EURUSD", "digits": 5,
        "pipPoints": 10, "startTime": start if start is not None else t(date(2026, 3, 9), 0),
        "furthestTime": furthest if furthest is not None else t(DAY, 16, 55),
        "settings": {"minSpreadPips": 0.5}, "actions": [], "trades": trades, "drawings": [],
        "saved": "2026-10-13T12:00:00Z",
    }
