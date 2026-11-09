"""Order-flow data (Phase 1): ticks -> M1 bars and 15-second buckets, same-slot baselines, a quality report.

    python -m forex_replay flow build EURUSD XAUUSD

Definitions (decision 0033; the browser and the Python backtester read the results, never re-derive them):
  * mid = (bid + ask) / 2. Stored as whole numbers: 2 x the price in points, so a half-point mid is exact.
  * Tick rule: mid up = +1, mid down = -1, unchanged = the previous tick's sign (0 before the first move).
    The sign carries from one day to the next: it is one stream of ticks.
  * Each bar or bucket: open, high, low, close of the mid; tick_count (ticks inside it); up_ticks and
    down_ticks (ticks signed +1 / -1); avg_spread (mean ask - bid of its ticks, in tenths of a point).
    A bar is named by its open time; only bars with at least one tick exist.
  * Trading day = the broker server's date: it starts at 17:00 New York, summer and winter, because the
    server clock is New York + 7 hours (datapipe.server_to_utc). The same clock "slot" is the bar's
    distance from that 17:00 start.
  * Baseline (no look-ahead): the median tick_count of the same slot over the PREVIOUS `BASELINE_DAYS`
    trading days that have data, never the day itself. A trading day with data but no bar in a slot counts
    as 0 ticks there. Until that many earlier days exist, the baseline is missing (-1).

Outputs, per instrument:
  web/data/<PAIR>/flow/<M1|S15>/<YYYY-MM>.bin   for the browser (int32, FIELDS below), chunked by UTC month
  web/data/<PAIR>/flow/manifest.json            fields, scales, instrument settings, months, quality summary
  data_flow/<PAIR>_<M1|S15>.parquet             for the Python backtester (prices as decimals)
  data_flow/<PAIR>_quality.md                   gaps, zero-tick minutes, spread spikes
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from .config import PROJECT_ROOT
from .datapipe import server_to_utc, utc_to_server
from .ticks import TICKS_DIR, cached_days, day_path

FLOW_DIR = PROJECT_ROOT / "data_flow"
WEB_DATA = PROJECT_ROOT / "web" / "data"
FIELDS = ["time", "open", "high", "low", "close", "tick_count", "up_ticks", "down_ticks", "spread_x10", "baseline_x2"]
DATASETS = {"M1": 60, "S15": 15}
BASELINE_DAYS = 20
GAP_MINUTES = 5  # a quiet stretch inside the trading week longer than this is listed as a gap
SPIKE_MULTIPLE = 5.0  # a minute whose average spread is this many times the day's median is a spike
FLOW_VERSION = 1

# Every number the later phases start from, per instrument, in PRICE units (Phases 2-9 read these as defaults).
INSTRUMENTS = {
    "EURUSD": {"digits": 5, "pip": 0.0001, "pip_value_per_lot": 10.0, "bin": 0.0001,
               "bubble_move": 0.00015, "absorption_move": 0.00003, "stop_buffer": 0.0001,
               "min_stop": 0.0006, "max_stop": 0.0020},
    "XAUUSD": {"digits": 2, "pip": 0.10, "pip_value_per_lot": 10.0, "bin": 0.50,
               "bubble_move": 0.50, "absorption_move": 0.10, "stop_buffer": 0.30,
               "min_stop": 2.00, "max_stop": 8.00},
}


# ---------------------------------------------------------------- one day of ticks
@dataclass
class Carry:
    """What one day hands the next: the last mid and the last tick sign (the tick rule is one stream)."""
    mid2: int | None = None
    sign: int = 0


def tick_signs(mid2: np.ndarray, carry: Carry) -> np.ndarray:
    """+1 / -1 by the move of the mid; an unchanged mid repeats the previous sign."""
    previous = np.concatenate([[carry.mid2 if carry.mid2 is not None else mid2[0]], mid2[:-1]]) if len(mid2) else mid2
    raw = np.sign(mid2 - previous).astype(np.int8)
    out = pd.Series(raw).replace(0, np.nan).ffill().fillna(carry.sign).astype(np.int8).to_numpy()
    return out


def prepare(ticks: pd.DataFrame, digits: int) -> pd.DataFrame:
    """Server-clock ticks -> UTC seconds, mid x2 in points, spread in points."""
    server = pd.to_datetime(ticks["time_msc"].to_numpy(), unit="ms")
    utc_ms = server_to_utc(pd.DatetimeIndex(server)).asi8 // 1_000_000
    scale = 10 ** digits
    return pd.DataFrame({
        "utc_ms": utc_ms,
        "mid2": np.rint((ticks["bid"].to_numpy() + ticks["ask"].to_numpy()) * scale).astype(np.int64),
        "spread": np.rint((ticks["ask"].to_numpy() - ticks["bid"].to_numpy()) * scale).astype(np.int64),
    })


def bucket(ticks: pd.DataFrame, signs: np.ndarray, seconds: int) -> pd.DataFrame:
    """Prepared ticks -> bars of `seconds`, named by their open time (UTC seconds)."""
    if len(ticks) == 0:
        return pd.DataFrame(columns=FIELDS[:-1])
    t = (ticks["utc_ms"].to_numpy() // 1000) // seconds * seconds
    frame = pd.DataFrame({"time": t, "mid2": ticks["mid2"].to_numpy(), "spread": ticks["spread"].to_numpy(),
                          "up": (signs == 1).astype(np.int64), "down": (signs == -1).astype(np.int64)})
    g = frame.groupby("time", sort=True)
    out = g.agg(open=("mid2", "first"), high=("mid2", "max"), low=("mid2", "min"), close=("mid2", "last"),
                tick_count=("mid2", "size"), up_ticks=("up", "sum"), down_ticks=("down", "sum"), spread=("spread", "mean"))
    out["spread_x10"] = np.rint(out.pop("spread") * 10).astype(np.int64)
    return out.reset_index()


def build_day(ticks: pd.DataFrame, digits: int, carry: Carry) -> tuple[dict[str, pd.DataFrame], Carry]:
    prepared = prepare(ticks, digits).sort_values("utc_ms", kind="stable").reset_index(drop=True)
    signs = tick_signs(prepared["mid2"].to_numpy(), carry)
    bars = {name: bucket(prepared, signs, seconds) for name, seconds in DATASETS.items()}
    if len(prepared):
        carry = Carry(int(prepared["mid2"].iloc[-1]), int(signs[-1]))
    return bars, carry


# ---------------------------------------------------------------- baselines
def trading_day_and_slot(times: np.ndarray, seconds: int) -> tuple[np.ndarray, np.ndarray]:
    """The broker-server date (a trading day from 17:00 New York) and the slot from that 17:00 start."""
    server = utc_to_server(pd.DatetimeIndex(pd.to_datetime(times, unit="s", utc=True)))
    day = server.normalize()
    slot = ((server - day).total_seconds() // seconds).astype(np.int64)
    return day.to_numpy().astype("datetime64[D]"), np.asarray(slot)


def add_baselines(bars: pd.DataFrame, seconds: int, days: int = BASELINE_DAYS) -> pd.DataFrame:
    """baseline_x2: twice the median tick_count of the same slot over the previous `days` trading days (-1 if fewer)."""
    bars = bars.copy()
    if len(bars) == 0:
        bars["baseline_x2"] = pd.Series(dtype="int64")
        return bars
    day, slot = trading_day_and_slot(bars["time"].to_numpy(), seconds)
    bars["day"], bars["slot"] = day, slot
    unique_days = np.unique(day)
    slots = int(86400 // seconds)
    grid = np.zeros((len(unique_days), slots), dtype=np.float64)  # a trading day with data: missing slots are 0 ticks
    row = np.searchsorted(unique_days, day)
    grid[row, slot] = bars["tick_count"].to_numpy()
    base = np.full(grid.shape, -1.0)
    for i in range(days, len(unique_days)):
        base[i] = np.median(grid[i - days:i], axis=0)  # the previous `days` rows only: never row i itself
    values = base[row, slot]
    bars["baseline_x2"] = np.where(values < 0, -1, np.rint(values * 2)).astype(np.int64)
    return bars.drop(columns=["day", "slot"])


# ---------------------------------------------------------------- quality
def quality(m1: pd.DataFrame, gap_minutes: int = GAP_MINUTES, spike_multiple: float = SPIKE_MULTIPLE) -> dict:
    """Gaps inside the trading week, zero-tick minutes in them, and spread spikes."""
    report = {"bars": int(len(m1)), "gaps": [], "zero_tick_minutes": 0, "spread_spikes": [], "weekend_closes": 0}
    if len(m1) < 2:
        return report
    t = m1["time"].to_numpy()
    step = np.diff(t)
    for i in np.flatnonzero(step > 60):
        missing = int(step[i] // 60) - 1
        if step[i] >= 36 * 3600:  # the weekend (or a long holiday close)
            report["weekend_closes"] += 1
            continue
        report["zero_tick_minutes"] += missing
        if step[i] > gap_minutes * 60:
            start = pd.Timestamp(int(t[i]) + 60, unit="s", tz="UTC")
            report["gaps"].append({"from_utc": start.isoformat(), "minutes": missing,
                                   "daily_break": bool(utc_to_server(pd.DatetimeIndex([start])).hour[0] in (23, 0))})
    day, _ = trading_day_and_slot(t, 60)
    spread = m1["spread_x10"].to_numpy() / 10
    frame = pd.DataFrame({"day": day, "spread": spread, "time": t})
    median = frame.groupby("day")["spread"].transform("median").clip(lower=1)  # at least a point, or 0 spreads spike on anything
    for i in np.flatnonzero(spread > spike_multiple * median.to_numpy()):
        report["spread_spikes"].append({"utc": pd.Timestamp(int(t[i]), unit="s", tz="UTC").isoformat(),
                                        "spread_points": round(float(spread[i]), 1), "day_median": round(float(median.iloc[i]), 1)})
    return report


def quality_markdown(symbol: str, report: dict, first: str, last: str) -> str:
    gaps = report["gaps"]
    lines = [f"# {symbol} order-flow data quality", "", f"M1 bars: {report['bars']:,}, {first} to {last} (UTC).", "",
             f"- Weekend or holiday closes: {report['weekend_closes']}",
             f"- Gaps over {GAP_MINUTES} minutes inside the week: {len(gaps)} "
             f"({sum(g['daily_break'] for g in gaps)} of them at the daily break, 17:00 New York)",
             f"- Minutes with no ticks inside the week: {report['zero_tick_minutes']:,}",
             f"- Spread spikes (a minute's average spread over {SPIKE_MULTIPLE:g}x its day's median): {len(report['spread_spikes'])}", ""]
    if gaps:
        lines += ["## Longest gaps (not the daily break)", "", "| from (UTC) | minutes |", "|---|---|"]
        for g in sorted((g for g in gaps if not g["daily_break"]), key=lambda g: -g["minutes"])[:20]:
            lines.append(f"| {g['from_utc']} | {g['minutes']} |")
        lines.append("")
    if report["spread_spikes"]:
        lines += ["## Widest spread spikes", "", "| minute (UTC) | spread (points) | day's median |", "|---|---|---|"]
        for s in sorted(report["spread_spikes"], key=lambda s: -s["spread_points"])[:20]:
            lines.append(f"| {s['utc']} | {s['spread_points']} | {s['day_median']} |")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- output
def to_rows(bars: pd.DataFrame) -> np.ndarray:
    return bars[FIELDS].to_numpy(dtype=np.int64).astype("<i4")


def write_binary(bars: pd.DataFrame, folder: Path) -> list[dict]:
    """One file per UTC month. Returns [{month, count, file}]."""
    folder.mkdir(parents=True, exist_ok=True)
    months = pd.to_datetime(bars["time"], unit="s", utc=True).dt.strftime("%Y-%m")
    out = []
    for month, part in bars.groupby(months, sort=True):
        path = folder / f"{month}.bin"
        to_rows(part).tofile(path)
        out.append({"month": month, "count": int(len(part)), "bytes": path.stat().st_size})
    return out


def to_parquet(bars: pd.DataFrame, digits: int, path: Path) -> None:
    scale = 2 * 10 ** digits
    frame = pd.DataFrame({"time_utc": pd.to_datetime(bars["time"], unit="s", utc=True)})
    for name in ("open", "high", "low", "close"):
        frame[name] = bars[name] / scale
    for name in ("tick_count", "up_ticks", "down_ticks"):
        frame[name] = bars[name].astype("int32")
    frame["avg_spread"] = bars["spread_x10"] / 10 / 10 ** digits
    frame["baseline"] = np.where(bars["baseline_x2"] < 0, np.nan, bars["baseline_x2"] / 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(path, index=False)


def build(symbol: str, ticks_root: Path = TICKS_DIR, web_root: Path = WEB_DATA, flow_root: Path = FLOW_DIR,
          baseline_days: int = BASELINE_DAYS) -> dict:
    spec = INSTRUMENTS[symbol]
    digits = spec["digits"]
    days = cached_days(symbol, ticks_root)
    if not days:
        raise FileNotFoundError(f"no cached ticks for {symbol}: run python -m forex_replay ticks download {symbol}")
    parts = {name: [] for name in DATASETS}
    carry = Carry()
    for day in days:  # one server day at a time, so a year of ticks never sits in memory at once
        ticks = pd.read_parquet(day_path(symbol, day, ticks_root))
        if len(ticks) == 0:
            continue
        bars, carry = build_day(ticks, digits, carry)
        for name in DATASETS:
            parts[name].append(bars[name])
    manifest = {"version": FLOW_VERSION, "symbol": symbol, "digits": digits, "fields": FIELDS,
                "price_scale": 2 * 10 ** digits, "spread_scale": 10 * 10 ** digits, "baseline_scale": 2,
                "baseline_days": baseline_days, "instrument": spec, "datasets": {}}
    m1 = None
    for name, seconds in DATASETS.items():
        bars = pd.concat(parts[name], ignore_index=True)
        bars = bars.groupby("time", as_index=False, sort=True).agg(  # a bar split across two day files becomes one
            open=("open", "first"), high=("high", "max"), low=("low", "min"), close=("close", "last"),
            tick_count=("tick_count", "sum"), up_ticks=("up_ticks", "sum"), down_ticks=("down_ticks", "sum"),
            spread_x10=("spread_x10", "mean")) if bars["time"].duplicated().any() else bars
        bars["spread_x10"] = np.rint(bars["spread_x10"]).astype(np.int64)
        bars = add_baselines(bars, seconds, baseline_days)
        months = write_binary(bars, web_root / symbol / "flow" / name)
        to_parquet(bars, digits, flow_root / f"{symbol}_{name}.parquet")
        manifest["datasets"][name] = {"seconds": seconds, "count": int(len(bars)), "months": months,
                                      "first": int(bars["time"].iloc[0]), "last": int(bars["time"].iloc[-1])}
        if name == "M1":
            m1 = bars
    report = quality(m1)
    first = pd.Timestamp(int(m1["time"].iloc[0]), unit="s", tz="UTC").isoformat()
    last = pd.Timestamp(int(m1["time"].iloc[-1]), unit="s", tz="UTC").isoformat()
    manifest["quality"] = {"gaps": len(report["gaps"]), "zero_tick_minutes": report["zero_tick_minutes"],
                           "spread_spikes": len(report["spread_spikes"]), "weekend_closes": report["weekend_closes"]}
    (web_root / symbol / "flow" / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    (flow_root / f"{symbol}_quality.md").write_text(quality_markdown(symbol, report, first, last), encoding="utf-8")
    (flow_root / f"{symbol}_quality.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return manifest


def biggest_file(manifest: dict) -> int:
    return max(m["bytes"] for d in manifest["datasets"].values() for m in d["months"])


# ---------------------------------------------------------------- golden sample for the browser's reader
GOLDEN = PROJECT_ROOT / "web" / "tests" / "fixtures" / "flow_golden"


def golden_ticks() -> pd.DataFrame:
    """A fixed, made-up stretch of ticks (server clock) that the browser's reader is checked against."""
    rng = np.random.default_rng(20261109)
    start = pd.Timestamp("2025-08-05 16:29:30").value // 1_000_000
    times = np.sort(start + rng.integers(0, 180_000, 300))  # 300 ticks over three minutes
    mid = 1.1 + np.cumsum(rng.integers(-1, 2, 300)) * 0.00001
    spread = rng.integers(0, 3, 300) * 0.00001
    return pd.DataFrame({"time_msc": times, "bid": np.round(mid - spread / 2, 6), "ask": np.round(mid + spread / 2, 6), "volume": 0.0})


def write_golden(path: Path = GOLDEN) -> dict:
    """python -m forex_replay.flow  rewrites the sample: <path>.bin (S15 rows) and <path>.json (the same, decoded)."""
    bars, _ = build_day(golden_ticks(), 5, Carry())
    s15 = bars["S15"].copy()
    s15["baseline_x2"] = -1
    path.parent.mkdir(parents=True, exist_ok=True)
    to_rows(s15).tofile(path.with_suffix(".bin"))
    decoded = {"fields": FIELDS, "price_scale": 2 * 10 ** 5, "rows": s15[FIELDS].astype(int).values.tolist()}
    path.with_suffix(".json").write_text(json.dumps(decoded), encoding="utf-8")
    return decoded


if __name__ == "__main__":
    sample = write_golden()
    print(f"Wrote {GOLDEN.with_suffix('.bin').relative_to(PROJECT_ROOT)}: {len(sample['rows'])} 15-second buckets")
