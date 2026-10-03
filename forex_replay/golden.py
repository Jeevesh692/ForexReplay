"""Reference scenarios for the JavaScript trading engine.

The browser app has its own port of broker.py (web/js/broker.js). To prove the
port behaves identically, this module runs many random scenarios through the
tested Python engine and records every order and every resulting trade. A
JavaScript test replays the same scenarios and must get exactly the same fills,
exits and R results.

Prices here are whole numbers of points (1.08500 -> 108500), the same units the
browser uses, so both engines do exact integer-valued arithmetic.

    python -m forex_replay.golden      # rewrites web/tests/fixtures/broker_golden.json
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from .broker import Broker, InvalidOrder, OrderType, Side, Status
from .config import PROJECT_ROOT, Instrument

FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "broker_golden.json"
POINTS = Instrument(symbol="EURUSD", pip_size=10.0, digits=0)  # prices in points: 1 pip = 10 points
SEED = 20261003
SCENARIOS = 120
CANDLES = 60


def make_candles(rng: random.Random) -> list[list[int]]:
    """A random walk of [open, high, low, close] candles in points, with occasional gaps."""
    candles = []
    price = 110_000 + rng.randint(-2_000, 2_000)
    for _ in range(CANDLES):
        gap = rng.choice([0, 0, 0, 0, 0, rng.randint(-40, 40)])  # sometimes the open jumps
        o = price + gap
        c = o + rng.randint(-35, 35)
        h = max(o, c) + rng.randint(0, 25)
        l = min(o, c) - rng.randint(0, 25)
        candles.append([o, h, l, c])
        price = c
    return candles


def random_order(rng: random.Random, bid: int) -> dict:
    side = rng.choice(["BUY", "SELL"])
    direction = 1 if side == "BUY" else -1
    kind = rng.choice(["market", "pending", "pending"])
    risk = rng.randint(8, 60)
    reward = rng.randint(8, 120)
    entry = bid if kind == "market" else bid + rng.randint(-45, 45)
    order = {
        "action": kind, "side": side,
        "stop_loss": entry - direction * risk,
        "take_profit": entry + direction * reward,
    }
    if kind == "pending":
        order["price"] = entry
    if rng.random() < 0.08:  # sometimes an invalid order: stop on the wrong side
        order["stop_loss"], order["take_profit"] = order["take_profit"], order["stop_loss"]
    return order


def random_change(rng: random.Random, trade, bid: int) -> dict:
    """A random move of stop loss, take profit or entry price. Often valid, sometimes not."""
    direction = 1 if trade.side is Side.BUY else -1
    change: dict = {}
    roll = rng.random()
    entry = int(trade.entry_price if trade.entry_price is not None else trade.planned_entry)
    if roll < 0.15:  # stop to breakeven
        change["stop_loss"] = entry
    elif roll < 0.40 and trade.status is Status.OPEN and (bid - entry) * direction > 6:
        change["stop_loss"] = entry + direction * rng.randint(1, (bid - entry) * direction - 1)  # lock in some profit
    elif roll < 0.60:  # move the stop somewhere near the price
        change["stop_loss"] = bid - direction * rng.randint(-10, 70)
    elif roll < 0.85:
        change["take_profit"] = bid + direction * rng.randint(-10, 120)
    else:  # both, or the entry of a pending order
        change["stop_loss"] = bid - direction * rng.randint(5, 70)
        change["take_profit"] = bid + direction * rng.randint(5, 120)
    if trade.status is Status.PENDING and rng.random() < 0.4:
        change["price"] = bid + rng.randint(-45, 45)
    return change


def apply_change(broker: Broker, trade, change: dict, bid: float) -> bool:
    """Apply a recorded change. Returns True if the engine rejected it."""
    try:
        broker.modify(trade, bid, **{key: float(value) for key, value in change.items()})
        return False
    except InvalidOrder:
        return True


def trade_record(trade) -> dict:
    def whole(value):
        return None if value is None else int(round(value))

    return {
        "id": trade.id,
        "side": trade.side.value,
        "order_type": trade.order_type.value,
        "status": trade.status.value,
        "planned_entry": whole(trade.planned_entry),
        "order_price": whole(trade.order_price),
        "stop_loss": whole(trade.stop_loss),
        "take_profit": whole(trade.take_profit),
        "placed_index": trade.placed_time,
        "entry_index": trade.entry_time,
        "entry_price": whole(trade.entry_price),
        "exit_index": trade.exit_time,
        "exit_price": whole(trade.exit_price),
        "exit_reason": None if trade.exit_reason is None else trade.exit_reason.value,
        "best_price": whole(trade.best_price),
        "worst_price": whole(trade.worst_price),
        "initial_stop": whole(trade.initial_stop),
        "remaining": trade.remaining,
        "partials": [{"index": p["time"], "price": whole(p["price"]), "fraction": p["fraction"]}
                     for p in trade.partials],
        "result_r": trade.result_r,
        "mfe_r": trade.mfe_r,
        "mae_r": trade.mae_r,
    }


def run_scenario(rng: random.Random, number: int) -> dict:
    candles = make_candles(rng)
    spread = rng.choice([0, 0, 3, 8, 15])
    broker = Broker(POINTS)
    broker.spread = float(spread)  # set in points directly, no float conversion from pips
    close_order: list[int] = []
    broker.on_close = lambda trade: close_order.append(trade.id)

    actions = []
    for i, (o, h, l, c) in enumerate(candles):
        broker.process_candle(i, float(o), float(h), float(l))
        if i == CANDLES - 1:
            break
        bid = float(c)
        for _ in range(rng.choice([0, 0, 0, 1, 1, 2])):
            roll = rng.random()
            if roll < 0.50:
                order = random_order(rng, c)
                try:
                    if order["action"] == "market":
                        broker.market_order(Side(order["side"]), float(order["stop_loss"]),
                                            float(order["take_profit"]), i, bid)
                    else:
                        broker.pending_order(Side(order["side"]), float(order["price"]),
                                             float(order["stop_loss"]), float(order["take_profit"]), i, bid)
                    order["rejected"] = False
                except InvalidOrder:
                    order["rejected"] = True
                actions.append({"index": i, **order})
            elif roll < 0.60 and broker.open_trades:
                trade = rng.choice(broker.open_trades)
                broker.close(trade, i, bid)
                actions.append({"index": i, "action": "close", "trade": trade.id})
            elif roll < 0.72 and broker.open_trades:
                trade = rng.choice(broker.open_trades)
                fraction = trade.remaining * rng.choice([0.25, 0.5, 0.3, 1.0])  # 1.0 = everything: must be refused
                try:
                    broker.partial_close(trade, fraction, i, bid)
                    rejected = False
                except InvalidOrder:
                    rejected = True
                actions.append({"index": i, "action": "partial", "trade": trade.id, "fraction": fraction,
                                "rejected": rejected})
            elif roll < 0.92 and (broker.open_trades or broker.pending_orders):
                trade = rng.choice(broker.open_trades + broker.pending_orders)
                change = random_change(rng, trade, c)
                rejected = apply_change(broker, trade, change, bid)
                actions.append({"index": i, "action": "modify", "trade": trade.id, "change": change,
                                "rejected": rejected})
            elif broker.pending_orders:
                trade = rng.choice(broker.pending_orders)
                broker.cancel(trade)
                actions.append({"index": i, "action": "cancel", "trade": trade.id})

    return {
        "name": f"scenario-{number}",
        "spread_points": spread,
        "candles": candles,
        "actions": actions,
        "trades": [trade_record(t) for t in broker.trades],
        "close_order": close_order,
    }


def build_fixture() -> dict:
    rng = random.Random(SEED)
    scenarios = [run_scenario(rng, n) for n in range(SCENARIOS)]
    trades = [t for s in scenarios for t in s["trades"]]
    summary = {
        "scenarios": len(scenarios),
        "trades": len(trades),
        "closed": sum(t["status"] == Status.CLOSED.value for t in trades),
        "stop_loss": sum(t["exit_reason"] == "STOP_LOSS" for t in trades),
        "take_profit": sum(t["exit_reason"] == "TAKE_PROFIT" for t in trades),
        "manual": sum(t["exit_reason"] == "MANUAL" for t in trades),
        "cancelled": sum(t["status"] == Status.CANCELLED.value for t in trades),
        "rejected_orders": sum(a.get("rejected", False) for s in scenarios for a in s["actions"]),
        "limit_orders": sum(t["order_type"] == OrderType.LIMIT.value for t in trades),
        "stop_orders": sum(t["order_type"] == OrderType.STOP.value for t in trades),
        "market_orders": sum(t["order_type"] == OrderType.MARKET.value for t in trades),
        "partial_closes": sum(len(t["partials"]) for t in trades),
        "moves_accepted": sum(a["action"] == "modify" and not a["rejected"] for s in scenarios for a in s["actions"]),
        "moves_rejected": sum(a["action"] == "modify" and a["rejected"] for s in scenarios for a in s["actions"]),
        "stopped_in_profit": sum(t["exit_reason"] == "STOP_LOSS" and t["result_r"] > 0 for t in trades),
    }
    return {"generator": "forex_replay/golden.py", "seed": SEED, "units": "points", "summary": summary,
            "scenarios": scenarios}


def write_fixture(path: Path = FIXTURE) -> dict:
    fixture = build_fixture()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, separators=(",", ":")), encoding="utf-8")
    return fixture["summary"]


if __name__ == "__main__":
    print(write_fixture())


def replay_recorded(scenario: dict) -> list[dict]:
    """Run the Python engine over a scenario stored in the fixture (no randomness involved).
    Used by the test that checks the fixture still matches the Python engine."""
    broker = Broker(POINTS)
    broker.spread = float(scenario["spread_points"])
    by_index: dict[int, list[dict]] = {}
    for action in scenario["actions"]:
        by_index.setdefault(action["index"], []).append(action)

    for i, (o, h, l, c) in enumerate(scenario["candles"]):
        broker.process_candle(i, float(o), float(h), float(l))
        for action in by_index.get(i, []):
            kind = action["action"]
            if kind in ("market", "pending"):
                try:
                    if kind == "market":
                        broker.market_order(Side(action["side"]), float(action["stop_loss"]),
                                            float(action["take_profit"]), i, float(c))
                    else:
                        broker.pending_order(Side(action["side"]), float(action["price"]),
                                             float(action["stop_loss"]), float(action["take_profit"]), i, float(c))
                except InvalidOrder:
                    pass
            else:
                trade = next(t for t in broker.trades if t.id == action["trade"])
                if kind == "close":
                    broker.close(trade, i, float(c))
                elif kind == "partial":
                    try:
                        broker.partial_close(trade, action["fraction"], i, float(c))
                    except InvalidOrder:
                        pass
                elif kind == "modify":
                    apply_change(broker, trade, action["change"], float(c))
                else:
                    broker.cancel(trade)
    return [trade_record(t) for t in broker.trades]
