"""Order flow, Phase 1: ticks -> M1 and 15-second bars, the tick rule, same-slot baselines, quality, files.

Every expected number is worked out by hand from made-up ticks."""

import json
import tempfile
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from forex_replay import flow
from forex_replay.ticks import day_path, days_to_fetch


def server_ms(text: str) -> int:
    """A broker-server clock time (New York + 7 hours), as MT5 gives it, in milliseconds."""
    return int(pd.Timestamp(text).value // 1_000_000)


def ticks(rows) -> pd.DataFrame:
    """rows: (server time text, bid, ask)."""
    return pd.DataFrame({"time_msc": [server_ms(t) for t, _, _ in rows], "bid": [b for _, b, _ in rows],
                         "ask": [a for _, _, a in rows], "volume": 0.0})


def test_tick_rule_unchanged_mid_repeats_the_previous_sign_and_carries_across_days():
    mid2 = np.array([10, 12, 12, 11, 11, 13])
    assert flow.tick_signs(mid2, flow.Carry()).tolist() == [0, 1, 1, -1, -1, 1]  # nothing before the first move
    assert flow.tick_signs(np.array([10, 10]), flow.Carry(mid2=14, sign=1)).tolist() == [-1, -1]  # 10 < 14 yesterday
    assert flow.tick_signs(np.array([14, 14]), flow.Carry(mid2=14, sign=1)).tolist() == [1, 1]  # unchanged: yesterday's sign


def test_server_clock_converts_to_utc_in_summer_and_winter():
    # 09:30 New York is 16:30 on the server clock all year; in UTC it is 13:30 in August and 14:30 in November.
    for server, utc in (("2025-08-05 16:30:00", "2025-08-05 13:30:00"), ("2025-11-05 16:30:00", "2025-11-05 14:30:00")):
        p = flow.prepare(ticks([(server, 1.1, 1.1001)]), 5)
        assert p["utc_ms"].iloc[0] == server_ms(utc)
        assert p["mid2"].iloc[0] == 220010  # (1.1 + 1.1001) x 10^5: twice the mid (1.10005 = 110005 points)
        assert p["spread"].iloc[0] == 10


def test_buckets_ohlc_counts_and_spread_by_hand():
    rows = [("2025-08-05 16:30:00.100", 1.10000, 1.10010), ("2025-08-05 16:30:05", 1.10010, 1.10020),  # up
            ("2025-08-05 16:30:09", 1.10010, 1.10020),  # unchanged: up again
            ("2025-08-05 16:30:14", 1.09990, 1.10010),  # down
            ("2025-08-05 16:30:20", 1.09980, 1.09990),  # next 15s bucket, down
            ("2025-08-05 16:31:01", 1.10000, 1.10010)]  # next minute, up
    bars, carry = flow.build_day(ticks(rows), 5, flow.Carry())
    s15, m1 = bars["S15"], bars["M1"]
    t0 = server_ms("2025-08-05 13:30:00") // 1000  # 16:30 server = 13:30 UTC
    assert s15["time"].tolist() == [t0, t0 + 15, t0 + 60]
    first = s15.iloc[0]
    assert (first.open, first.high, first.low, first.close) == (220010, 220030, 220000, 220000)
    assert (first.tick_count, first.up_ticks, first.down_ticks) == (4, 2, 1)  # the very first tick has no sign
    assert first.spread_x10 == 125  # spreads 10, 10, 10, 20 points: mean 12.5
    assert m1["time"].tolist() == [t0, t0 + 60]
    assert (m1.iloc[0].tick_count, m1.iloc[0].up_ticks, m1.iloc[0].down_ticks) == (5, 2, 2)
    assert (m1.iloc[0].open, m1.iloc[0].close) == (220010, 219970)
    assert carry == flow.Carry(mid2=220010, sign=1)


def test_trading_day_starts_at_17_00_new_york_summer_and_winter():
    # Summer: 16:59 New York = 20:59 UTC is the end of one trading day; 21:00 UTC starts the next, slot 0.
    for before, after in (("2025-08-05 20:59:00", "2025-08-05 21:00:00"), ("2025-11-05 21:59:00", "2025-11-05 22:00:00")):
        t = np.array([pd.Timestamp(before, tz="UTC").value // 10**9, pd.Timestamp(after, tz="UTC").value // 10**9])
        day, slot = flow.trading_day_and_slot(t, 60)
        assert day[1] - day[0] == np.timedelta64(1, "D")
        assert slot.tolist() == [1439, 0]


def minute_bars(days: int, counts, start="2025-08-04", slot_minute=630) -> pd.DataFrame:
    """One M1 bar per trading day at the same slot (630 minutes after 17:00 New York = 03:30 New York).
    `counts(d)` gives day d's tick count. Weekdays only, as the market trades."""
    rows, d, k = [], pd.Timestamp(start), 0
    while k < days:
        if d.weekday() < 5:
            server = d + pd.Timedelta(minutes=slot_minute)
            t = int(flow.server_to_utc(pd.DatetimeIndex([server]))[0].value // 10**9)
            rows.append({"time": t, "open": 1, "high": 1, "low": 1, "close": 1, "tick_count": counts(k), "up_ticks": 0,
                         "down_ticks": 0, "spread_x10": 0})
            k += 1
        d += pd.Timedelta(days=1)
    return pd.DataFrame(rows)


def test_baseline_is_the_median_of_the_previous_20_days_never_today():
    bars = flow.add_baselines(minute_bars(23, lambda k: k + 1), 60)
    b = bars["baseline_x2"].tolist()
    assert b[:20] == [-1] * 20  # fewer than 20 earlier days: no baseline
    assert b[20] == 21  # median of 1..20 = 10.5, stored x2
    assert b[21] == 23  # median of 2..21 = 11.5
    # Today's own count, however big, does not move today's baseline; later days cannot either.
    spiked = flow.add_baselines(minute_bars(23, lambda k: 10_000 if k == 20 else k + 1), 60)
    assert spiked["baseline_x2"].iloc[20] == 21
    assert flow.add_baselines(minute_bars(21, lambda k: k + 1), 60)["baseline_x2"].iloc[20] == 21


def test_a_trading_day_with_data_but_no_bar_in_the_slot_counts_as_zero():
    bars = minute_bars(21, lambda k: 9)
    other = bars.iloc[[3]].copy()
    other["time"] += 60  # day 3 has a bar in the next slot instead
    bars = pd.concat([bars.drop(index=3), other]).sort_values("time").reset_index(drop=True)
    out = flow.add_baselines(bars, 60)
    last = out.iloc[-1]
    assert last.baseline_x2 == 18  # 19 days of 9 and one 0 -> median 9


def test_quality_finds_gaps_zero_tick_minutes_weekends_and_spread_spikes():
    t0 = int(pd.Timestamp("2025-08-05 13:00", tz="UTC").value // 10**9)
    times = [t0, t0 + 60, t0 + 120, t0 + 60 * 10, t0 + 60 * 11]  # 7 minutes missing: one gap
    times += [t0 + 4 * 86400]  # the weekend
    spreads = [10, 10, 10, 10, 800, 60]  # 80 points against a median of 1 point, counted as 1 pip (10 points): 5 x 10 = 50
    m1 = pd.DataFrame({"time": times, "spread_x10": spreads})
    q = flow.quality(m1, pip_points=10)
    assert [g["minutes"] for g in q["gaps"]] == [7]
    assert q["zero_tick_minutes"] == 7
    assert q["weekend_closes"] == 1
    assert [s["spread_points"] for s in q["spread_spikes"]] == [80.0]  # 6 points is half a pip: not a spike


def write_day(root: Path, symbol: str, day: str, rows) -> None:
    path = day_path(symbol, date.fromisoformat(day), root)
    path.parent.mkdir(parents=True, exist_ok=True)
    ticks(rows).to_parquet(path, index=False)


def test_build_end_to_end_files_read_back_exactly():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tick_root, web, out = root / "ticks", root / "web", root / "flow"
        # Two server days, Fri 29 Aug and Mon 1 Sep 2025 (a weekend between), plus an empty Saturday file.
        write_day(tick_root, "EURUSD", "2025-08-29", [("2025-08-29 16:30:00", 1.1, 1.1001), ("2025-08-29 16:30:20", 1.1002, 1.1003)])
        write_day(tick_root, "EURUSD", "2025-08-30", [])
        write_day(tick_root, "EURUSD", "2025-09-01", [("2025-09-01 10:00:00", 1.1010, 1.1011)])
        m = flow.build("EURUSD", tick_root, web, out)
        assert m["datasets"]["M1"]["count"] == 2 and m["datasets"]["S15"]["count"] == 3
        assert [x["month"] for x in m["datasets"]["S15"]["months"]] == ["2025-08", "2025-09"]
        raw = np.fromfile(web / "EURUSD" / "flow" / "S15" / "2025-08.bin", dtype="<i4").reshape(-1, len(flow.FIELDS))
        first = dict(zip(flow.FIELDS, raw[0].tolist()))
        assert first["time"] == server_ms("2025-08-29 13:30:00") // 1000
        assert (first["open"], first["tick_count"], first["spread_x10"], first["baseline_x2"]) == (220010, 1, 100, -1)
        manifest = json.loads((web / "EURUSD" / "flow" / "manifest.json").read_text())
        assert manifest["price_scale"] == 200000 and manifest["instrument"]["bin"] == 0.0001
        back = pd.read_parquet(out / "EURUSD_S15.parquet")
        assert back["open"].iloc[0] == pytest.approx(1.100050)
        assert back["avg_spread"].iloc[0] == pytest.approx(0.0001)
        assert (out / "EURUSD_quality.md").exists()


def test_downloads_skip_cached_days_but_refresh_the_last_two():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for d in ("2025-08-01", "2025-08-02", "2025-08-03"):
            write_day(root, "EURUSD", d, [])
        todo = days_to_fetch("EURUSD", date(2025, 8, 1), date(2025, 8, 5), root)
        assert todo == [date(2025, 8, 2), date(2025, 8, 3), date(2025, 8, 4), date(2025, 8, 5)]


def test_the_browsers_golden_sample_is_up_to_date():
    """web/tests/fixtures/flow_golden.* must be what flow.py writes today (python -m forex_replay.flow rewrites it)."""
    with tempfile.TemporaryDirectory() as tmp:
        fresh = flow.write_golden(Path(tmp) / "flow_golden")
        assert json.loads(flow.GOLDEN.with_suffix(".json").read_text()) == fresh
        assert (Path(tmp) / "flow_golden.bin").read_bytes() == flow.GOLDEN.with_suffix(".bin").read_bytes()
