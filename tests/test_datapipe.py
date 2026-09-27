import json
import tempfile
from pathlib import Path

import pandas as pd
import pytest

from forex_replay.datapipe import (EURUSD, build, from_bytes, merge_exports, read_mt5_csv,
                                   server_to_utc)

EXPORT_HEADER = "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n"


def write_export(folder: Path, name: str, rows: list[str]) -> Path:
    path = folder / name
    path.write_text(EXPORT_HEADER + "".join(r + "\n" for r in rows), encoding="utf-8")
    return path


def bar(date, time, o, h, l, c, vol=10, spread=0):
    return f"{date}\t{time}\t{o}\t{h}\t{l}\t{c}\t{vol}\t0\t{spread}"


def test_reads_both_mt5_formats():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        a = write_export(tmp, "EURUSD_M5_new.csv", [bar("2025.08.04", "00:05:00", 1.1, 1.2, 1.0, 1.15, 5, 3)])
        b = tmp / "EURUSD_M5.csv"
        b.write_text("time,open,high,low,close,tick_volume,spread,real_volume\n"
                     "2025-08-04 00:05:00,1.1,1.2,1.0,1.15,5,0,0\n")
        new, old = read_mt5_csv(a), read_mt5_csv(b)
    assert list(new.columns[:6]) == ["open", "high", "low", "close", "volume", "spread"]
    assert new.index[0] == old.index[0] == pd.Timestamp("2025-08-04 00:05")
    assert new["spread"].iloc[0] == 3


def test_server_time_is_new_york_plus_seven_hours_through_daylight_saving():
    server = pd.DatetimeIndex(["2025-11-03 00:05", "2026-03-09 00:05", "2026-03-16 00:05", "2026-07-06 00:05"])
    utc = server_to_utc(server)
    # Winter (EST, UTC-5): week opens Sunday 17:05 New York = 22:05 UTC
    assert utc[0] == pd.Timestamp("2025-11-02 22:05", tz="UTC")
    # US summer time started 8 Mar 2026 while Europe had not changed yet: still exact
    assert utc[1] == pd.Timestamp("2026-03-08 21:05", tz="UTC")
    assert utc[2] == pd.Timestamp("2026-03-15 21:05", tz="UTC")
    assert utc[3] == pd.Timestamp("2026-07-05 21:05", tz="UTC")


def test_later_export_wins_on_overlap():
    idx = pd.DatetimeIndex(["2025-08-04 00:05", "2025-08-04 00:10"])
    first = pd.DataFrame({"close": [1.0, 1.0], "source": "a"}, index=idx)
    second = pd.DataFrame({"close": [2.0], "source": "b"}, index=idx[1:])
    merged, replaced = merge_exports([first, second])
    assert replaced == 1
    assert merged["close"].tolist() == [1.0, 2.0]


def test_build_writes_exact_integer_prices_and_reports_gaps():
    rows = [
        bar("2025.08.04", "10:00:00", 1.08500, 1.08520, 1.08490, 1.08510),
        bar("2025.08.04", "10:05:00", 1.08510, 1.08530, 1.08500, 1.08525),
        bar("2025.08.04", "10:20:00", 1.08525, 1.08540, 1.08515, 1.08535),  # 2 candles missing
    ]
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = write_export(tmp, "EURUSD_M5_test.csv", rows)
        manifest, report = build(start="2025-08-01", files=[src], out_root=tmp / "web")
        blob = (tmp / "web" / manifest["months"][0]["file"]).read_bytes()
        stored = json.loads((tmp / "web" / "EURUSD" / "manifest.json").read_text())
    data = from_bytes(blob)
    assert data.shape == (3, 7)
    assert data[0, 1] == 108500  # open in points, exact
    # server 10:00 = New York 03:00 (EDT) = 07:00 UTC
    assert data[0, 0] == int(pd.Timestamp("2025-08-04 07:00", tz="UTC").timestamp())
    assert report["missing_bars_in_short_gaps"] == 2
    assert stored["bars"] == 3 and stored["digits"] == EURUSD.digits


def test_build_rejects_impossible_candles():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = write_export(tmp, "EURUSD_M5_bad.csv", [bar("2025.08.04", "10:00:00", 1.1, 1.05, 1.0, 1.1)])
        with pytest.raises(ValueError):
            build(start="2025-08-01", files=[src], out_root=tmp / "web")
