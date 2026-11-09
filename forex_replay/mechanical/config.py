"""The backtester's settings: defaults here, a YAML file on top (configs/mechanical.yaml), and --set on top of that."""

from __future__ import annotations

import copy
from pathlib import Path

DEFAULTS: dict = {
    "name": "baseline",
    "pairs": ["EURUSD", "XAUUSD"],
    "from": None,
    "to": None,
    "output": "mechanical_output",
    "account": {"balance": 10000, "risk_percent": 0.5, "reduced_risk_percent": 0.25, "losses_before_reduced": 2,
                "commission_per_lot": 4.0, "commission_per_side": False, "slippage_pips": 0.2, "min_spread_pips": 0.0},
    "pair_settings": {"EURUSD": {"stop_buffer": 0.0001, "min_stop": 0.0006, "max_stop": 0.0020},
                      "XAUUSD": {"stop_buffer": 0.30, "min_stop": 2.00, "max_stop": 8.00}},
    "profile": {"value_area": 0.70, "smoothing": 3, "lvn": 0.35},
    "bins": {"EURUSD": 0.0001, "XAUUSD": 0.50},
    "market_state": {"timeframe_minutes": 30, "accept_closes": 2, "reject_window_minutes": 60},
    "trigger": {"body": 0.5, "range_atr": 1.2, "atr_period": 14, "close_zone": 0.25, "min_rvol": 1.5,
                "use_bubble_rule": False, "bubble_rvol": 3.0},
    "bubbles": {"min_rvol": 3.0, "medium": 5.0, "large": 8.0, "bubble_move": {"EURUSD": 0.00015, "XAUUSD": 0.50},
                "absorption_move": {"EURUSD": 0.00003, "XAUUSD": 0.10}},
    "model_a": {"enabled": True, "window": ["18:30", "21:30"], "swing_bars": 2, "swing_lookback_15m": 40, "leg_atr": 3.0,
                "retrace_min": 0.30, "retrace_max": 0.70, "min_target_r": 2.0, "naked_poc_days": 5, "naked_poc_max_r": 4.0,
                "fallback_target_r": 3.0, "trail_after_r": 3.0},
    "model_b": {"enabled": True, "window": ["18:30", "21:30"], "balanced_poc_middle": 0.50, "min_target_r": 1.5,
                "double_failure_only": False, "hold_quarter": False},
    "management": {"breakeven_r": 1.0, "breakeven_variant": "none", "time_stop_minutes": 45, "time_stop_r": 0.5},
    "limits": {"max_trades_per_session": 2, "max_trades_per_day": 3, "stop_day_after_losses": 2, "stop_day_after_r": 2.0,
               "stop_week_at_percent": -3.0, "news_file": "configs/news.csv", "news_minutes": 15},
}
BE_VARIANTS = ("none", "second_displacement", "cvd")


class ConfigError(ValueError):
    pass


def merge(base: dict, extra: dict, where: str = "") -> dict:
    """`extra` on top of `base`; an unknown key is refused (a typo must not silently do nothing)."""
    out = copy.deepcopy(base)
    for key, value in (extra or {}).items():
        if key not in base and where not in ("pair_settings", "bins", "bubbles.bubble_move", "bubbles.absorption_move"):
            raise ConfigError(f"Unknown setting {where + '.' if where else ''}{key}")
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            out[key] = merge(base[key], value, f"{where}.{key}".strip("."))
        else:
            out[key] = value
    return out


def parse_value(text: str):
    """A --set value: true/false, null, a number, or text."""
    import yaml

    return yaml.safe_load(text)


def load(path: str | Path | None = None, overrides: list[str] | None = None) -> dict:
    """The settings for a run: the defaults, the YAML file, then each "a.b=value" override."""
    import yaml

    config = copy.deepcopy(DEFAULTS)
    if path:
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        config = merge(config, raw)
    for item in overrides or []:
        if "=" not in item:
            raise ConfigError(f"--set needs key=value, not {item!r}")
        key, value = item.split("=", 1)
        parts = key.strip().split(".")
        patch: dict = {}
        node = patch
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = parse_value(value)
        config = merge(config, patch)
    check(config)
    return config


def check(config: dict) -> None:
    """Refuse settings that cannot work, in plain words."""
    if config["management"]["breakeven_variant"] not in BE_VARIANTS:
        raise ConfigError(f"management.breakeven_variant must be one of {', '.join(BE_VARIANTS)}")
    if config["market_state"]["timeframe_minutes"] not in (15, 30, 60):
        raise ConfigError("market_state.timeframe_minutes must be 15, 30 or 60")
    for model in ("model_a", "model_b"):
        start, end = config[model]["window"]
        for t in (start, end):
            h, m = (int(x) for x in str(t).split(":"))
            if not (0 <= h < 24 and 0 <= m < 60):
                raise ConfigError(f"{model}.window: {t!r} is not a time of day")
    for pair in config["pairs"]:
        if pair not in config["pair_settings"] or pair not in config["bins"]:
            raise ConfigError(f"{pair}: add it under pair_settings and bins")
    a = config["account"]
    if not (0 < a["risk_percent"] <= 10 and 0 < a["reduced_risk_percent"] <= 10):
        raise ConfigError("account risk percents must be above 0 and at most 10")
