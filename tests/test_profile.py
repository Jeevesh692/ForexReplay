"""Volume profile (order flow, Phase 2): small examples worked out by hand, and the golden file kept current."""

import json

import pytest

from forex_replay import profile_golden
from forex_replay.profile import build_profile, price_bin, profile_from_bars, smoothed


def one_bin_bars(volumes):
    """One bar per price 0, 1, 2, ... each covering a single bin of size 1: the histogram is exactly `volumes`."""
    prices = list(range(len(volumes)))
    return prices, prices, volumes


def test_volume_is_spread_evenly_over_the_bins_a_bar_covers():
    p = build_profile([10], [13], [8], 1)
    assert (p["first_bin"], p["volumes"]) == (10, [2.0, 2.0, 2.0, 2.0])
    p = build_profile([10, 12], [11, 12], [4, 6], 1)  # bins 10, 11 get 2 each; bin 12 gets 6
    assert p["volumes"] == [2.0, 2.0, 6.0]
    p = build_profile([105], [214], [6], 50)  # bins of 50: 100-149, 150-199, 200-249
    assert (p["first_bin"], p["volumes"], p["val"], p["vah"]) == (2, [2.0, 2.0, 2.0], 100, 250)


def test_poc_and_value_area_by_hand():
    # Bins 5, 10, 40, 20, 15, 10 (total 100). POC is 40. Value area 70: 40, +20 above (20 > 10 below) = 60,
    # +15 above (15 > 10) = 75: bins 2 to 4, so VAL is the bottom of bin 2 and VAH the top of bin 4.
    p = build_profile(*one_bin_bars([5, 10, 40, 20, 15, 10]), 1)
    assert (p["poc"], p["poc_low"], p["poc_high"]) == (2, 2, 3)
    assert (p["va_bins"], p["val"], p["vah"], p["va_volume"]) == ([2, 4], 2, 5, 75.0)


def test_a_tie_for_poc_takes_the_bin_nearest_the_middle_then_the_lower():
    assert build_profile(*one_bin_bars([10, 30, 5, 30, 10]), 1)["poc"] == 1  # 1 and 3 are equally near bin 2
    assert build_profile(*one_bin_bars([30, 5, 10, 30, 5]), 1)["poc"] == 3  # bin 3 is nearer the middle (2)


def test_a_tie_between_the_value_areas_neighbours_adds_the_upper_one_first():
    p = build_profile(*one_bin_bars([20, 60, 20]), 1, value_area=0.7)  # 60 of 100; then 20 and 20 tie
    assert p["va_bins"] == [1, 2]


def test_smoothing_is_a_centred_average_with_fewer_bins_at_the_edges():
    assert smoothed([3, 6, 9, 12], 3) == [4.5, 6.0, 9.0, 10.5]
    assert smoothed([3, 6, 9], 1) == [3, 6, 9]


def test_hvns_and_lvn_zones_by_hand():
    volumes = [10, 50, 90, 50, 8, 4, 8, 60, 100, 60, 10]
    raw = build_profile(*one_bin_bars(volumes), 1, smoothing=1)
    assert raw["hvns"] == [2, 8]
    # Below 35 (35% of 100): bin 0 (a tail), bins 4-6 (a valley between 50 and 60), bin 10 (a tail).
    assert raw["lvns"] == [{"low": 4, "high": 7, "bins": [4, 6]}]
    smooth = build_profile(*one_bin_bars(volumes), 1)  # smoothed over 3: the valley is still bins 4-6
    assert [z["bins"] for z in smooth["lvns"]] == [[4, 6]]
    assert smooth["poc"] == 8  # the POC comes from the raw volumes


def test_a_flat_profile_has_no_peak_and_no_valley():
    p = build_profile([10], [14], [50], 1)
    assert (p["hvns"], p["lvns"]) == ([], [])


def test_nothing_to_profile_gives_none_and_a_bad_bin_size_is_refused():
    assert build_profile([1], [2], [0], 1) is None
    with pytest.raises(ValueError):
        build_profile([1], [2], [3], 0)


def test_the_profile_never_reads_a_bar_that_has_not_closed_at_the_cursor():
    bars = {"seconds": 60, "time": [0, 60, 120, 180], "low": [10, 11, 50, 60], "high": [10, 11, 50, 60], "tick_count": [5, 5, 99, 99]}
    full = profile_from_bars(bars, 0, 240, 1)
    early = profile_from_bars(bars, 0, 240, 1, cursor=150)  # 150 s: the 120 bar is still forming
    assert full["volumes"][-1] == 99.0
    assert early["volumes"] == [5.0, 5.0]
    assert profile_from_bars(bars, 0, 240, 1, cursor=180)["volumes"][-1] == 99.0  # it closed at 180
    assert profile_from_bars(bars, 0, 240, 1, cursor=59) is None


def test_bin_sizes_in_price_become_file_units():
    assert price_bin(0.0001, 5) == 20  # 1 pip on EURUSD = 10 points = 20 half-points
    assert price_bin(0.50, 2) == 100  # 50 cents on gold


def test_the_golden_file_is_what_python_computes_today():
    fixture = json.loads(profile_golden.FIXTURE.read_text(encoding="utf-8"))
    assert fixture == json.loads(json.dumps(profile_golden.build()))
