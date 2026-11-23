"""The position tool's sums (order flow, Phase 7): size, costs and R after costs.

One definition, written twice: here and in web/js/costs.js, held to web/tests/fixtures/costs_golden.json
(python -m forex_replay.costs_golden). Decision 0039. Prices are whole points; money is dollars.

  * Stop in pips = |entry - stop| / points per pip. R:R = |target - entry| / |entry - stop|.
  * Lots: the largest whole number of 0.01 lots whose loss at the stop is no more than risk % of the balance
    (the account's own rule, account.unitsForRisk).
  * Cost of a round trip = spread (the data's, at that time) + slippage (0.2 pip by default) + commission
    ($4 a lot round turn, or $4 a side when "per side" is on, so $8).
  * Cost in R = that cost / the loss at the stop, both for one lot: it does not depend on how the lots round.
  * After costs: a win at the target is R:R - cost in R; a loss at the stop is -1 - cost in R. Results in R
    are always given after costs.
  * Warnings: stop under the pair's minimum (EURUSD 6 pips, gold 2.00) or over its maximum (20 pips / 8.00);
    target under the model's minimum after costs (Model A 2R, Model B 1.5R); a size under 0.01 lots.
"""

from __future__ import annotations

import math

LOT_UNITS = 100  # sizes are whole numbers of 0.01 lots
DEFAULTS = {"slippage_pips": 0.2, "commission_per_lot": 4.0, "per_side": False, "target_a": 2.0, "target_b": 1.5}


def point_value(symbol: str, digits: int, contract_size: int, price_points: int | None = None) -> float:
    """Dollars per point per lot (account.js pointValueFor): fixed on a pair quoted in dollars (EURUSD $1 a point,
    gold $1 with 100 ounces and 2 digits); on a dollar-first pair (USDJPY) it depends on the price, in points."""
    if symbol[3:] == "USD":
        return contract_size / 10 ** digits
    if symbol[:3] == "USD":
        if not price_points or price_points <= 0:
            raise ValueError(f"{symbol}: the money needs the price it happens at")
        return contract_size / price_points
    raise ValueError(f"{symbol}: money for a pair without the dollar needs another rate; not supported.")


def units_for_risk(balance: float, risk_percent: float, risk_points: int, point_value: float) -> int:
    """Largest size in 0.01 lots whose loss at the stop is no more than the risk (account.js unitsForRisk)."""
    if not (balance > 0) or not (risk_percent > 0) or not (risk_points > 0):
        return 0
    risk_money = balance * risk_percent / 100
    per_unit = risk_points * point_value / LOT_UNITS
    return math.floor(risk_money / per_unit + 1e-9)


def position_plan(side: str, entry: int, stop: int, target: int, *, balance: float, risk_percent: float, point_value: float,
                  pip_points: int, spread_points: int, commission_per_lot: float = 4.0, per_side: bool = False,
                  slippage_pips: float = 0.2, min_stop_pips=None, max_stop_pips=None, min_target_r=None) -> dict:
    """Everything the position tool shows, or {"error": ...} when the stop and target are on the wrong sides."""
    direction = 1 if side == "long" else -1
    if not (direction * (entry - stop) > 0 and direction * (target - entry) > 0):
        return {"error": "The stop must be below the entry and the target above it (the other way round for a short)."}
    risk_points, reward_points = abs(entry - stop), abs(target - entry)
    stop_pips = risk_points / pip_points
    rr = reward_points / risk_points
    commission = commission_per_lot * (2 if per_side else 1)  # per lot, round trip
    slippage_points = slippage_pips * pip_points
    cost_per_lot = (spread_points + slippage_points) * point_value + commission
    cost_r = cost_per_lot / (risk_points * point_value)
    units = units_for_risk(balance, risk_percent, risk_points, point_value)
    lots = units / LOT_UNITS
    warnings = []
    if units < 1:
        warnings.append("too_small")
    if min_stop_pips is not None and stop_pips < min_stop_pips:
        warnings.append("stop_below_min")
    if max_stop_pips is not None and stop_pips > max_stop_pips:
        warnings.append("stop_above_max")
    if min_target_r is not None and rr - cost_r < min_target_r:
        warnings.append("target_below_min")
    return {
        "stop_pips": stop_pips, "target_pips": reward_points / pip_points, "rr": rr, "units": units,
        "risk_money": lots * risk_points * point_value, "spread_money": lots * spread_points * point_value,
        "slippage_money": lots * slippage_points * point_value, "commission_money": lots * commission,
        "cost_money": lots * cost_per_lot, "cost_r": cost_r, "target_r": rr - cost_r, "stop_r": -1 - cost_r, "warnings": warnings,
    }
