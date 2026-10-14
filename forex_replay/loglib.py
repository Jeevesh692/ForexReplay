"""Shared tools for the strategy loggers (nbb.py, and sweep.py later).

A logger measures a strategy's rules for each saved trade and writes them to a CSV that an
Excel workbook reads. Everything here works on the same M5 candles the browser replays
(web/data, built by datapipe.py): UTC open times, prices and spreads in whole points.

No look-ahead is structural: a logger first cuts the candles at the moment it is allowed to
see (`Candles.until`), and every bigger timeframe is built from that cut. A bucket is used only
when it has closed by then (`Bars.closed_by`).
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from .config import PROJECT_ROOT

NEW_YORK = ZoneInfo("America/New_York")
SERVER_HOURS_AHEAD_OF_NY = 7  # broker server clock = New York + 7 h (datapipe.py)
DAY = 86400
WEB_DATA = PROJECT_ROOT / "web" / "data"
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# ----------------------------------------------------------------- time
def ny(utc: int) -> datetime:
    return datetime.fromtimestamp(utc, timezone.utc).astimezone(NEW_YORK)


def ny_date(utc: int) -> date:
    return ny(utc).date()


def ny_time(day: date, hour: int, minute: int = 0) -> int:
    """UTC seconds of a New York wall-clock time on a date."""
    return int(datetime.combine(day, time(hour, minute), NEW_YORK).timestamp())


def ny_text(utc: int | None) -> str:
    return "" if utc is None else ny(utc).strftime("%Y-%m-%d %H:%M")


def ny_minutes(utc: int) -> int:
    t = ny(utc)
    return t.hour * 60 + t.minute


def server_seconds(utc: int) -> int:
    """UTC seconds -> broker server clock seconds (New York + 7 h)."""
    return utc + int(ny(utc).utcoffset().total_seconds()) + SERVER_HOURS_AHEAD_OF_NY * 3600


def server_seconds_array(utc: np.ndarray) -> np.ndarray:
    """The same for many times. The New York offset only changes twice a year, so look it up per distinct hour."""
    hours = utc // 3600
    unique, inverse = np.unique(hours, return_inverse=True)
    offsets = np.array([_hour_offset(int(h)) for h in unique], dtype=np.int64)
    return utc + offsets[inverse]


@lru_cache(maxsize=None)
def _hour_offset(hour: int) -> int:
    return server_seconds(hour * 3600) - hour * 3600


def server_day(utc: int) -> int:
    """Broker-server day number (days since 1970-01-01 on the server clock); a day closes at 17:00 New York."""
    return server_seconds(utc) // DAY


def week_of_server_day(day: int) -> int:
    """Monday-start week number of a server day (1970-01-01 was a Thursday)."""
    return (day + 3) // 7


# ----------------------------------------------------------------- candles
@dataclass(frozen=True)
class Candles:
    """M5 candles: open time (UTC seconds), open, high, low, close and spread in points."""
    time: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    spread: np.ndarray

    def __len__(self) -> int:
        return len(self.time)

    def until(self, last_open: int) -> "Candles":
        """Only the candles that opened at or before `last_open`: what the replay had shown by then."""
        n = int(np.searchsorted(self.time, last_open, side="right"))
        return Candles(*(a[:n] for a in (self.time, self.open, self.high, self.low, self.close, self.spread)))

    def index_at(self, t: int) -> int:
        """Index of the candle that opened exactly at `t`, or -1."""
        i = int(np.searchsorted(self.time, t))
        return i if i < len(self.time) and self.time[i] == t else -1

    def between(self, start: int, end: int) -> slice:
        """Indexes of candles opening in [start, end)."""
        return slice(int(np.searchsorted(self.time, start)), int(np.searchsorted(self.time, end)))

    @staticmethod
    def from_rows(rows) -> "Candles":
        a = np.asarray(rows, dtype=np.int64).reshape(-1, 6) if len(rows) else np.zeros((0, 6), dtype=np.int64)
        return Candles(*(np.ascontiguousarray(a[:, k]) for k in range(6)))


@lru_cache(maxsize=2)
def _load(manifest_path: str, stamp: float) -> Candles:
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    root = Path(manifest_path).parent.parent
    parts = [np.frombuffer((root / m["file"]).read_bytes(), dtype="<i4").reshape(-1, 7) for m in manifest["months"]]
    a = np.concatenate(parts).astype(np.int64)
    return Candles(a[:, 0].copy(), a[:, 1].copy(), a[:, 2].copy(), a[:, 3].copy(), a[:, 4].copy(), a[:, 6].copy())


def load_base(symbol: str = "EURUSD", data_root: Path = WEB_DATA) -> Candles:
    """The app's base candles (M1 since v2.3), read once and kept in memory until the data files are rebuilt."""
    manifest = data_root / symbol / "manifest.json"
    if not manifest.exists():
        raise FileNotFoundError("The market data has not been built yet; start the app once (python -m forex_replay app).")
    return _load(str(manifest), manifest.stat().st_mtime)


# ----------------------------------------------------------------- buys as mirrored sells
def mirror(m5: Candles) -> Candles:
    """Every price negated, highs and lows swapped: a sell rule measured on this is the buy rule."""
    return Candles(m5.time, -m5.open, -m5.low, -m5.high, -m5.close, m5.spread)


def view(m5: Candles, side: str) -> Candles:
    return m5 if side == "SELL" else mirror(m5)


def back(value, side: str):
    """A price on the side's view -> the real price."""
    if value is None:
        return None
    return value if side == "SELL" else -value


# ----------------------------------------------------------------- M5 from the base candles
M5_SECONDS = 300


def bar_of(data: dict) -> int:
    """A session's base candle in seconds: 60 since v2.3; sessions saved before that replayed M5 (300)."""
    return int(data.get("barSeconds") or M5_SECONDS)


def closed_cut(t: int, bar: int) -> int:
    """The open time of the last M5 candle that had closed once the base candle opened at `t` had closed.
    With M5 base candles this is `t` itself; with M1, an order at 08:37 sees the 08:30 candle (closed 08:35),
    never the 08:35 one still forming. Pass it to Candles.until on M5 candles."""
    return ((t + bar) // M5_SECONDS) * M5_SECONDS - M5_SECONDS


_five_cache: dict = {}


def five_minute(base: Candles) -> Candles:
    """M5 candles from M1 ones, in the broker's own way (the bucket's first open, highest high, lowest low,
    last close; checked identical to the broker's M5 for GBPUSD on 14 Oct 2026). Spread: the bucket's last."""
    key = (id(base.time), len(base))
    if key in _five_cache:
        return _five_cache[key]
    if len(base) == 0:
        return base
    keys = base.time // M5_SECONDS
    starts = np.flatnonzero(np.r_[True, keys[1:] != keys[:-1]])
    lasts = np.r_[starts[1:] - 1, len(keys) - 1]
    out = Candles(keys[starts] * M5_SECONDS, base.open[starts], np.maximum.reduceat(base.high, starts),
                  np.minimum.reduceat(base.low, starts), base.close[lasts], base.spread[lasts])
    _five_cache.clear()  # one dataset at a time is enough
    _five_cache[key] = out
    return out


def logger_candles(data: dict, base: Candles) -> Candles:
    """The M5 candles a logger measures on, for this session's base candles."""
    return base if bar_of(data) == M5_SECONDS else five_minute(base)


# ----------------------------------------------------------------- bigger timeframes
@dataclass(frozen=True)
class Bars:
    """Candles of a bigger timeframe, built from M5. `key` numbers the buckets; a bucket closes at `end` (UTC)."""
    key: np.ndarray
    start: np.ndarray   # UTC open time of the bucket (its first M5 candle's open)
    end: np.ndarray     # UTC time the bucket closes
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    first: np.ndarray   # index of its first M5 candle
    last: np.ndarray    # index of its last M5 candle

    def __len__(self) -> int:
        return len(self.key)

    def closed_by(self, t: int) -> int:
        """How many buckets (from the start) had closed by time `t`."""
        return int(np.searchsorted(self.end, t, side="right"))

    def index_of_time(self, t: int) -> int:
        """Index of the bucket containing the M5 candle that opened at `t` (buckets are in time order)."""
        i = int(np.searchsorted(self.start, t, side="right")) - 1
        return i if i >= 0 and self.first[i] <= self.last[i] else -1


def _group(m5: Candles, keys: np.ndarray, ends: np.ndarray) -> Bars:
    n = len(keys)
    if n == 0:
        z = np.zeros(0, dtype=np.int64)
        return Bars(z, z, z, z, z, z, z, z, z)
    starts = np.flatnonzero(np.r_[True, keys[1:] != keys[:-1]])
    lasts = np.r_[starts[1:] - 1, n - 1]
    return Bars(
        key=keys[starts], start=m5.time[starts], end=ends[starts],
        open=m5.open[starts], high=np.maximum.reduceat(m5.high, starts), low=np.minimum.reduceat(m5.low, starts),
        close=m5.close[lasts], first=starts, last=lasts,
    )


def minutes_bars(m5: Candles, minutes: int) -> Bars:
    """15m, 30m... buckets of floor(utc / (minutes * 60))."""
    size = minutes * 60
    keys = m5.time // size
    return _group(m5, keys, (keys + 1) * size)


def server_bars(m5: Candles, hours: int) -> Bars:
    """H4 or D1 (hours=24) buckets on the broker server clock, as reference_candles in datapipe.py builds them."""
    size = hours * 3600
    server = server_seconds_array(m5.time)
    keys = server // size
    # A bucket closes when the server clock reaches the next bucket: that moment in UTC.
    ends = m5.time + ((keys + 1) * size - server)
    return _group(m5, keys, ends)


def week_bars(days: Bars) -> dict:
    """Monday-start weeks from daily bars (server clock). Returns arrays: key, high, low, last_day_index."""
    if len(days) == 0:
        z = np.zeros(0, dtype=np.int64)
        return {"key": z, "high": z, "low": z, "open": z, "close": z, "first": z, "last": z}
    wk = (days.key + 3) // 7
    starts = np.flatnonzero(np.r_[True, wk[1:] != wk[:-1]])
    lasts = np.r_[starts[1:] - 1, len(wk) - 1]
    return {"key": wk[starts], "high": np.maximum.reduceat(days.high, starts), "low": np.minimum.reduceat(days.low, starts),
            "open": days.open[starts], "close": days.close[lasts], "first": starts, "last": lasts}


# ----------------------------------------------------------------- measures
def wilder_atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int = 14) -> np.ndarray:
    """Wilder ATR, exactly as atr() in web/js/indicators.js (NaN until n candles)."""
    out = np.full(len(high), np.nan)
    prev, total = np.nan, 0.0
    for i in range(len(high)):
        h, lo = float(high[i]), float(low[i])
        tr = h - lo if i == 0 else max(h - lo, abs(h - close[i - 1]), abs(lo - close[i - 1]))
        if i < n:
            total += tr
            if i == n - 1:
                out[i] = prev = total / n
            continue
        out[i] = prev = (prev * (n - 1) + tr) / n
    return out


def is_swing_high(high, k: int) -> bool:
    """Strictly above the 2 candles before and the 2 after (needs k-2 .. k+2 to exist)."""
    return k >= 2 and k + 2 < len(high) and all(high[k] > high[j] for j in (k - 2, k - 1, k + 1, k + 2))


def is_swing_low(low, k: int) -> bool:
    return k >= 2 and k + 2 < len(low) and all(low[k] < low[j] for j in (k - 2, k - 1, k + 1, k + 2))


# ----------------------------------------------------------------- formatting
def fmt_price(points, digits: int = 5) -> str:
    return "" if points is None else f"{points / 10 ** digits:.{digits}f}"


def fmt_num(value, places: int) -> str:
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return ""
    text = f"{value:.{places}f}"
    return "0" + text[2:] if text.startswith("-0") and float(text) == 0 else text  # no "-0.0"


def fmt_bool(value) -> str:
    return "" if value is None else ("TRUE" if value else "FALSE")


# ----------------------------------------------------------------- the trade itself
def settings_at(data: dict, t: int) -> dict:
    """The session's account settings in force at time t (its start settings, then any changes made before t)."""
    settings = dict(data.get("settings") or {})
    for a in data.get("actions") or []:
        if a.get("kind") == "settings" and a.get("at", 0) <= t and isinstance(a.get("settings"), dict):
            settings.update(a["settings"])
    return settings


def spread_at(data: dict, m5: Candles, index: int, t: int) -> int:
    """The spread the engine used on a candle: its recorded spread or the minimum-spread setting, whichever is larger."""
    minimum = round(float(settings_at(data, t).get("minSpreadPips", 0) or 0) * data["pipPoints"])
    return max(minimum, int(m5.spread[index]))


def trade_fields(trade: dict, data: dict, m5: Candles) -> dict:
    """The columns every strategy log starts with: the trade as it was traded."""
    digits, pip = data["digits"], data["pipPoints"]
    entry_t = trade["entryTime"]
    day = ny_date(entry_t)
    price = lambda p: fmt_price(None if p is None else int(round(p)), digits)
    initial = trade.get("initialStop", trade.get("stopLoss"))
    row = {
        "run_id": data["id"], "trade_id": trade["id"], "date_ny": day.isoformat(), "weekday": WEEKDAYS[day.weekday()],
        "side": trade["side"], "order_type": trade.get("orderType", ""),
        "placed_time_ny": ny_text(trade.get("placedTime")), "entry_time_ny": ny_text(entry_t),
        "exit_time_ny": ny_text(trade.get("exitTime")), "entry_price": price(trade.get("entryPrice")),
        "stop_loss": price(initial), "take_profit": price(trade.get("takeProfit")),
        "exit_price": price(trade.get("exitPrice")), "exit_reason": trade.get("exitReason") or "",
        "lots": fmt_num(trade.get("lots"), 2), "actual_r": fmt_num(trade.get("resultR"), 2),
        "pnl_usd": fmt_num(trade.get("money"), 2), "commission_usd": fmt_num(trade.get("commission"), 2),
        "tags": "; ".join(trade.get("tags") or []), "note": trade.get("note") or "", "risk_pips": "", "spread_pips": "",
    }
    if trade.get("entryPrice") is not None and initial is not None:
        row["risk_pips"] = fmt_num(abs(trade["entryPrice"] - initial) / pip, 1)
    i = m5.index_at(entry_t)
    if i >= 0:
        row["spread_pips"] = fmt_num(spread_at(data, m5, i, entry_t) / pip, 1)
    return row


def previous_rows(path: Path, run: str, key: str) -> dict:
    """This session's rows already in a log file, by `key` (to reuse finished ones)."""
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8") as f:
        return {r[key]: r for r in csv.DictReader(f) if r.get("run_id") == run}


# ----------------------------------------------------------------- files
def write_keyed_csv(path: Path, columns: list[str], run_id: str, rows: list[dict], sort_key) -> None:
    """Replace every row of `run_id` in the CSV with `rows`, keep other runs' rows, sort, and write atomically."""
    kept = []
    if path.exists():
        with path.open(newline="", encoding="utf-8") as f:
            kept = [r for r in csv.DictReader(f) if r.get("run_id") != run_id]
    every = sorted(kept + [{c: str(r.get(c, "")) for c in columns} for r in rows], key=sort_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for r in every:
            writer.writerow({c: r.get(c, "") for c in columns})
    replace_file(tmp, path)


def replace_file(tmp: Path, path: Path, tries: int = 15, wait: float = 0.2) -> None:
    """Move the finished file into place. Windows refuses while another program has the target open: OneDrive
    uploading it (a moment) or Excel showing it (until closed). Retry for a few seconds, then say which it is."""
    import time as _time
    for attempt in range(tries):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == tries - 1:
                tmp.unlink(missing_ok=True)
                raise PermissionError(f"{path.name} is open in another program (Excel?) or still syncing; "
                                      f"close it and the next save writes it") from None
            _time.sleep(wait)


def weekdays_between(first: date, last: date):
    """New York dates from first to last, Monday to Friday."""
    d = first
    while d <= last:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)
