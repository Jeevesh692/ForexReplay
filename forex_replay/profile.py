"""Volume profile (order flow, Phase 2): one definition, also written in web/js/profile.js.

Both are held to the same answers by web/tests/fixtures/profile_golden.json (python -m forex_replay.profile_golden).

The steps, in the units the browser uses: prices are whole numbers (the order-flow files store 2 x the price
in points), and the bin size is in the same units.

1. Bins: bin k holds prices from k x bin to (k + 1) x bin, on one grid from zero, so two profiles over the same
   prices share their bins. A bar covers the bins from the one holding its low to the one holding its high.
2. Volume: each bar's tick_count is spread evenly over the bins it covers.
3. POC: the bin with the most volume. If several tie, the one nearest the middle of the profile; if still
   tied, the lower. VALUE AREA: start at the POC and add the larger of the two bins just outside it, one bin a
   step, until the area holds `value_area` (70%) of all volume. A tie adds the upper bin first. VAL is the
   bottom of the lowest bin in it, VAH the top of the highest.
4. Smoothing: a centred moving average over `smoothing` bins (3; 1 = none), fewer at the edges.
   HVNs and LVNs are found on the smoothed volumes; POC and value area use the raw ones.
5. HVN: a smoothed bin higher than the one below it and at least as high as the one above (a peak; the first
   bin of a flat top). A bin at the edge must be higher than its one neighbour, so a flat profile has none.
6. LVN zone: a run of consecutive smoothed bins below `lvn` (35%) of the smoothed POC volume, with a heavier
   bin (at or above that level) on both sides, so a thin tail at the top or bottom is not a zone.
   Reported as a price range: the bottom of its lowest bin to the top of its highest.
"""

from __future__ import annotations


def build_profile(lows, highs, volumes, bin_size: int, value_area: float = 0.70, smoothing: int = 3, lvn: float = 0.35) -> dict | None:
    """lows, highs: whole-number prices; volumes: each bar's tick count; bin_size in the same price units."""
    if bin_size <= 0:
        raise ValueError("bin size must be positive")
    bars = [(int(lo), int(hi), float(v)) for lo, hi, v in zip(lows, highs, volumes) if v > 0]
    if not bars:
        return None
    first = min(lo // bin_size for lo, _, _ in bars)
    last = max(hi // bin_size for _, hi, _ in bars)
    raw = [0.0] * (last - first + 1)
    for lo, hi, v in bars:
        a, b = lo // bin_size - first, hi // bin_size - first
        share = v / (b - a + 1)
        for k in range(a, b + 1):
            raw[k] += share
    n = len(raw)

    # POC: the biggest bin; among equals, the one nearest the middle, then the lower.
    top = max(raw)
    middle = (n - 1) / 2
    poc = min((k for k in range(n) if raw[k] == top), key=lambda k: (abs(k - middle), k))

    # Value area: grow from the POC, one bin a step, the larger neighbour first (the upper one on a tie).
    total = sum(raw)
    lo_k = hi_k = poc
    inside = raw[poc]
    while inside < value_area * total - 1e-12 and (lo_k > 0 or hi_k < n - 1):
        below = raw[lo_k - 1] if lo_k > 0 else -1.0
        above = raw[hi_k + 1] if hi_k < n - 1 else -1.0
        if above >= below:
            hi_k += 1
            inside += above
        else:
            lo_k -= 1
            inside += below

    smooth = smoothed(raw, smoothing)
    hvns = [k for k in range(n) if is_peak(smooth, k)]
    level = lvn * max(smooth)
    zones = []
    k = 0
    while k < n:
        if smooth[k] < level:
            start = k
            while k < n and smooth[k] < level:
                k += 1
            if start > 0 and k < n:  # heavier bins on both sides: a valley, not a tail
                zones.append({"low": (first + start) * bin_size, "high": (first + k) * bin_size, "bins": [start, k - 1]})
        else:
            k += 1

    edge = lambda k: (first + k) * bin_size  # the bottom of bin k
    return {
        "first_bin": first, "bin_size": bin_size, "volumes": raw, "smoothed": smooth, "total": total,
        "poc": poc, "poc_low": edge(poc), "poc_high": edge(poc + 1),
        "va_bins": [lo_k, hi_k], "val": edge(lo_k), "vah": edge(hi_k + 1), "va_volume": inside,
        "hvns": hvns, "lvns": zones,
    }


def is_peak(s: list[float], k: int) -> bool:
    """Higher than the bin below and at least as high as the bin above (the first of a flat top counts once).
    An edge bin must be higher than its one neighbour, so a flat profile has no peak; a single bin is one."""
    n = len(s)
    if n == 1:
        return True
    if k == 0:
        return s[0] > s[1]
    if k == n - 1:
        return s[k] > s[k - 1]
    return s[k] > s[k - 1] and s[k] >= s[k + 1]


def smoothed(values: list[float], window: int) -> list[float]:
    """Centred moving average over `window` bins (odd; 1 = unchanged); at the edges, over the bins there are."""
    if window <= 1:
        return list(values)
    half = window // 2
    out = []
    for k in range(len(values)):
        part = values[max(0, k - half):k + half + 1]
        out.append(sum(part) / len(part))
    return out


def profile_from_bars(bars, start: int, end: int, bin_size: int, cursor: int | None = None, **settings) -> dict | None:
    """The profile of bars whose open time is in [start, end), never past `cursor` (the replay clock): a bar
    counts only if it has closed by then. `bars`: dict of arrays (time, low, high, tick_count) and `seconds`."""
    seconds = bars["seconds"]
    limit = end if cursor is None else min(end, cursor - seconds + 1)  # its open time + its length <= cursor
    chosen = [i for i, t in enumerate(bars["time"]) if start <= t < limit]
    if not chosen:
        return None
    return build_profile([bars["low"][i] for i in chosen], [bars["high"][i] for i in chosen],
                         [bars["tick_count"][i] for i in chosen], bin_size, **settings)


def price_bin(price: float, digits: int) -> int:
    """A bin size given in price (EURUSD 0.0001) -> the order-flow files' units (2 x points)."""
    return int(round(price * 2 * 10 ** digits))



# ---------------------------------------------------------------- days: the prior day's levels and naked POCs
def server_day(t: int) -> int:
    """The broker-server date of a UTC second, as a day number: a trading day runs from 17:00 New York."""
    from .flow import trading_day_and_slot
    import numpy as np

    day, _ = trading_day_and_slot(np.array([t]), 60)
    return int(day[0].astype("int64"))


def server_days(times) -> list[int]:
    """server_day for many times at once."""
    from .flow import trading_day_and_slot
    import numpy as np

    if len(times) == 0:
        return []
    day, _ = trading_day_and_slot(np.asarray(times, dtype=np.int64), 60)
    return day.astype("int64").tolist()


def day_levels(bars, cursor: int, bin_size: int, days_back: int = 5, **settings) -> dict:
    """The prior day's POC, VAH and VAL, and the naked POCs of the last `days_back` finished days, at `cursor`.

    Only bars that had closed by the cursor count, and only finished trading days (before the cursor's own day)
    give levels. Each level's POC is the middle of its POC bin. A naked POC runs from its day's first bar until
    the first later bar whose low and high reach it (`to` is that bar's open time); untouched, `to` is None
    (it runs on to the cursor). `bars`: dict of arrays (time, low, high, tick_count) and `seconds`."""
    seconds = bars["seconds"]
    closed = [i for i, t in enumerate(bars["time"]) if t + seconds <= cursor]
    if not closed:
        return {"day": None, "day_start": None, "prior": None, "naked": []}
    day_of = server_days([bars["time"][i] for i in closed])  # every bar's trading day, in one go
    days = {}
    for i, d in zip(closed, day_of):
        days.setdefault(d, []).append(i)
    bar_day = dict(zip(closed, day_of))
    today = server_day(cursor - 1)
    finished = sorted(d for d in days if d < today)
    levels = {}
    for d in finished[-max(days_back, 1):]:
        rows = days[d]
        p = build_profile([bars["low"][i] for i in rows], [bars["high"][i] for i in rows], [bars["tick_count"][i] for i in rows],
                          bin_size, **settings)
        if p is None:
            continue
        levels[d] = {"day": d, "from": bars["time"][rows[0]], "poc": (p["poc_low"] + p["poc_high"]) / 2, "val": p["val"], "vah": p["vah"]}
    prior = levels.get(finished[-1]) if finished else None
    naked = []
    for d in sorted(levels)[-days_back:] if days_back > 0 else []:
        level = levels[d]
        touch = next((bars["time"][i] for i in closed if bar_day[i] > d
                      and bars["low"][i] <= level["poc"] <= bars["high"][i]), None)
        naked.append({"day": d, "from": level["from"], "poc": level["poc"], "to": touch})
    start = bars["time"][days[today][0]] if today in days else None
    return {"day": today, "day_start": start, "prior": prior, "naked": naked}
