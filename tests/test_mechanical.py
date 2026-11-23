"""The mechanical backtester (order flow, Phase 9): settings, the pieces by hand, and a made-up market where
Model A must take one long, move it to breakeven and be stopped there, without seeing anything ahead."""

import math

import numpy as np
import pytest

from forex_replay.flow import FIELDS
from forex_replay.loglib import Candles
from forex_replay.mechanical import config as mconfig
from forex_replay.mechanical.engine import PairRun, in_window, load_news, swing

D0 = 1762207200        # Mon 3 Nov 2025 22:00 UTC: a trading day starts (17:00 New York, winter)
D1 = D0 + 86400        # the next one; its window 18:30-21:30 IST is 13:00-16:00 UTC


def path(k: int) -> int:
    """Day 2, minute k from 22:00 UTC: quiet at 1.10000 with a dip (a 15m swing low) at 07:00, a fast rally to
    1.10300, an accepted hold, a pullback into the rally's thin middle at 13:00, a strong bull candle at 13:15,
    a run to 1.10500, then a fall back to 1.10150."""
    if 545 <= k < 550:  # the dip sits inside the 07:00 candle, so the next one opens back at 1.10000
        return 109980
    if k < 600:
        return 110000 + (k % 5) - 2
    if k < 700:
        return 110000 + 3 * (k - 600)
    if k < 900:
        return 110300 + (k % 5) - 2
    if k < 915:
        return 110300 - 11 * (k - 899)
    if k < 920:
        return [110140, 110160, 110175, 110185, 110190][k - 915]
    if k < 960:
        return 110190 + 8 * (k - 919)
    if k < 1000:
        return 110510 - 9 * (k - 959)
    return 110150


def market():
    rows = [(D0 + 60 * k, 110000 + int(40 * math.sin(k / 30)), 10) for k in range(1440)]
    rows += [(D1 + 60 * k, path(k), 30 if 915 <= k < 920 or k < 600 else 10) for k in range(1440)]  # a busy morning: a heavy base
    t = np.array([r[0] for r in rows], dtype=np.int64)
    c = np.array([r[1] for r in rows], dtype=np.int64)
    o = np.r_[c[0], c[:-1]]
    hi, lo = np.maximum(o, c) + 2, np.minimum(o, c) - 2
    base = Candles(t, o, hi, lo, c, np.zeros(len(t), dtype=np.int64))
    m1 = {name: np.zeros(len(t), dtype=np.int64) for name in FIELDS}
    ticks = np.array([r[2] for r in rows])
    m1.update(time=t, open=2 * o, high=2 * hi, low=2 * lo, close=2 * c, tick_count=ticks, up_ticks=ticks // 2,
              down_ticks=ticks - ticks // 2, baseline_x2=np.full(len(t), 20))
    m1["seconds"] = 60
    return base, m1


def config(**changes):
    c = mconfig.load(None, [f"{k}={v}" for k, v in changes.items()])
    c["limits"]["news_file"] = None
    return c


def run_market(end=D1 + 1440 * 60, **changes):
    base, m1 = market()
    r = PairRun("EURUSD", config(**changes), base, m1, contract=100000, digits=5, s15_reader=lambda months: None)
    r.run(D0, end)
    return r


def test_settings_defaults_overrides_and_refusals(tmp_path):
    c = mconfig.load(None, ["model_a.leg_atr=2.5", "management.breakeven_variant=cvd", "pairs=[EURUSD]"])
    assert (c["model_a"]["leg_atr"], c["management"]["breakeven_variant"], c["pairs"]) == (2.5, "cvd", ["EURUSD"])
    with pytest.raises(mconfig.ConfigError):
        mconfig.load(None, ["model_a.leg_atrr=2"])  # a typo is refused, not silently ignored
    with pytest.raises(mconfig.ConfigError):
        mconfig.load(None, ["management.breakeven_variant=sometimes"])
    yaml_file = tmp_path / "v.yaml"
    yaml_file.write_text("name: v\nmodel_b: {enabled: false}\n", encoding="utf-8")
    c = mconfig.load(yaml_file)
    assert c["name"] == "v" and c["model_b"]["enabled"] is False and c["model_a"]["enabled"] is True
    assert mconfig.load("configs/mechanical.yaml") == mconfig.load(None) | {"name": "baseline"}, "the shipped file is the defaults"


def test_the_window_is_india_time_and_swings_need_both_sides():
    assert in_window(D1 + 900 * 60, ["18:30", "21:30"])         # day 2 minute 900 = 13:00 UTC = 18:30 IST
    assert not in_window(D1 + 899 * 60, ["18:30", "21:30"])
    assert in_window(D1 + 1080 * 60, ["18:30", "21:30"])        # 16:00 UTC = 21:30 IST, the last close inside it
    lows = np.array([5, 4, 1, 3, 6, 2])
    assert swing(lows, 2, 2, True) and not swing(lows, 1, 2, True) and not swing(lows, 4, 2, True)


def test_model_a_takes_the_pullback_long_with_the_rules_stop():
    r = run_market()
    assert len(r.closed) == 1
    t = r.closed[0]
    assert t["answers"]["model"] == "A" and t["side"] == "BUY"
    # The pullback candles closing at 13:05, 13:10 and 13:15 UTC are turned down; the strong one closing at 13:20 is
    # the trigger: the order goes in at its last minute (minute 919) and fills at the next open, 1.10190.
    assert [((s["time"] - D1) // 60, s["reason"]) for s in r.skipped] == [(905 + 5 * k, "trigger failed: close, rvol") for k in range(3)]
    assert t["placedTime"] == D1 + 919 * 60 and t["entryPrice"] == 110190
    # Stop: 1 pip under the lower of the candle's low (1.10133) and the LVN zone's (1.10010).
    assert t["initialStop"] == 110000
    assert t["note"] == "A: leg 32.6 pips = 22.7 ATR15, LVN at 49%"
    assert t["takeProfit"] > 110190 + 50 * 190, "no naked POC above: no fixed target, the stop trails from +3R"


def test_breakeven_at_one_r_then_stopped_there_after_costs():
    t = run_market().closed[0]
    cost_points = (4 / 1 + 0.2 * 10)  # $4 a lot and 0.2 pip, at $1 a point: 6 points
    assert t["stopLoss"] == pytest.approx(t["entryPrice"] + cost_points)
    assert t["exitReason"] == "STOP_LOSS" and t["mfeR"] >= 1
    assert t["netR"] == pytest.approx(0, abs=1e-9), "a breakeven after costs is 0R after costs"


def test_nothing_after_the_cursor_changes_the_decision():
    full = run_market().closed[0]
    early = run_market(end=D1 + 921 * 60).closed  # the data ends a minute after the entry filled (closed at the end)
    assert len(early) == 1
    assert (early[0]["placedTime"], early[0]["entryPrice"], early[0]["initialStop"]) == (full["placedTime"], full["entryPrice"], full["initialStop"])


def test_limits_news_and_reduced_risk():
    r = run_market(**{"limits.max_trades_per_day": 0})
    assert not r.closed and any("limit: 0 trades today" in s["reason"] for s in r.skipped)
    base, m1 = market()
    c = config()
    news = [(D1 + 920 * 60, "USD")]  # US news at 13:20 UTC: the very moment of the trigger
    r = PairRun("EURUSD", c, base, m1, news, contract=100000, digits=5, s15_reader=lambda months: None)
    r.run(D0, D1 + 86400)
    assert not r.closed and any("news" in s["reason"] for s in r.skipped)
    r = run_market()
    r.losing_streak = 2
    assert r.c["account"]["reduced_risk_percent"] == 0.25


def test_news_file(tmp_path):
    f = tmp_path / "news.csv"
    f.write_text("date_utc,time_utc,currency,impact,title\n2025-11-05,13:30,usd,High,CPI\n2025-11-05,15:00,EUR,Low,x\n", encoding="utf-8")
    assert load_news(f) == [(1762349400, "USD")]
    assert load_news(tmp_path / "missing.csv") == []


def test_model_b_needs_a_rejection():
    r = run_market(**{"model_a.enabled": "false"})
    assert not r.closed, "the made-up day is accepted above value, never rejected: Model B stays out"


def test_compare_your_trades_with_the_rules(tmp_path):
    import csv
    import json

    from forex_replay.mechanical.compare import compare

    folder = tmp_path / "of_test" / "backtests"
    folder.mkdir(parents=True)
    trade = lambda i, placed, side, stop, target: {"id": i, "status": "CLOSED", "side": side, "placedTime": placed, "entryTime": placed + 60,
                                                   "entryPrice": 110190, "initialStop": stop, "takeProfit": target, "resultR": 1.0}
    rules = run_market().closed[0]
    session = {"id": "bt-cmp", "symbol": "EURUSD", "startTime": D1, "furthestTime": D1 + 1439 * 60, "trades": [
        trade(1, D1 + 917 * 60, "BUY", rules["initialStop"], rules["takeProfit"]),  # the rules' trade, two minutes earlier
        trade(2, D1 + 300 * 60, "SELL", 110300, 109900),                          # 03:00 UTC: outside the windows
    ]}
    (folder / "bt-cmp.json").write_text(json.dumps(session), encoding="utf-8")
    c = config()
    c["output"] = str(tmp_path / "out")
    data = market()
    result = compare("of_test", c, root=tmp_path,
                     load=lambda s: (data[0], data[1], {"contract_size": 100000, "digits": 5, "pip_points": 10, "s15_reader": lambda m: None}))
    assert result["counts"] == {"same": 1, "different": 0, "manual only": 1, "rules only": 0}
    rows = {r["kind"]: r for r in csv.DictReader(open(tmp_path / "out" / "compare_of_test" / "compare.csv", encoding="utf-8"))}
    assert rows["manual only"]["why"] == "outside both models' windows"
    session["trades"][0]["initialStop"] = 110050  # a different stop: the same trade, done differently
    (folder / "bt-cmp.json").write_text(json.dumps(session), encoding="utf-8")
    result = compare("of_test", c, root=tmp_path,
                     load=lambda s: (data[0], data[1], {"contract_size": 100000, "digits": 5, "pip_points": 10, "s15_reader": lambda m: None}))
    assert result["counts"]["different"] == 1
