// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Broker, ExitReason, InvalidOrder, OrderType, Side, Status } from "../js/broker.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/broker_golden.json", import.meta.url), "utf8"));

/** Run one recorded scenario through the JavaScript engine. */
function replay(scenario) {
  const closeOrder = [];
  const broker = new Broker({ spreadPoints: scenario.spread_points, onClose: (t) => closeOrder.push(t.id) });
  const byIndex = new Map();
  for (const action of scenario.actions) {
    if (!byIndex.has(action.index)) byIndex.set(action.index, []);
    byIndex.get(action.index).push(action);
  }
  const rejected = [];
  scenario.candles.forEach(([o, h, l, c], i) => {
    broker.processCandle(i, o, h, l);
    for (const action of byIndex.get(i) || []) {
      if (action.action === "market" || action.action === "pending") {
        try {
          if (action.action === "market") broker.marketOrder(action.side, action.stop_loss, action.take_profit, i, c);
          else broker.pendingOrder(action.side, action.price, action.stop_loss, action.take_profit, i, c);
          rejected.push(false);
        } catch (err) {
          if (!(err instanceof InvalidOrder)) throw err;
          rejected.push(true);
        }
      } else {
        const trade = broker.trades.find((t) => t.id === action.trade);
        if (action.action === "close") broker.close(trade, i, c);
        else if (action.action === "cancel") broker.cancel(trade);
        else {
          try {
            if (action.action === "partial") broker.partialClose(trade, action.fraction, i, c);
            else {
              const { stop_loss: stopLoss, take_profit: takeProfit, price } = action.change;
              broker.modify(trade, c, { stopLoss, takeProfit, price: price ?? null });
            }
            rejected.push(false);
          } catch (err) {
            if (!(err instanceof InvalidOrder)) throw err;
            rejected.push(true);
          }
        }
      }
    }
  });
  return { broker, closeOrder, rejected };
}

const record = (t) => ({
  id: t.id, side: t.side, order_type: t.orderType, status: t.status,
  planned_entry: t.plannedEntry, order_price: t.orderPrice, stop_loss: t.stopLoss, take_profit: t.takeProfit,
  placed_index: t.placedTime, entry_index: t.entryTime, entry_price: t.entryPrice,
  exit_index: t.exitTime, exit_price: t.exitPrice, exit_reason: t.exitReason,
  best_price: t.bestPrice, worst_price: t.worstPrice,
  initial_stop: t.initialStop, remaining: t.remaining,
  partials: t.partials.map((p) => ({ index: p.time, price: p.price, fraction: p.fraction })),
});

test(`matches the Python engine on ${fixture.summary.scenarios} recorded scenarios (${fixture.summary.trades} trades)`, () => {
  let compared = 0;
  for (const scenario of fixture.scenarios) {
    const { broker, closeOrder, rejected } = replay(scenario);
    const expectedRejected = scenario.actions.filter((a) => "rejected" in a).map((a) => a.rejected);
    assert.deepEqual(rejected, expectedRejected, `${scenario.name}: which orders were rejected`);
    assert.equal(broker.trades.length, scenario.trades.length, `${scenario.name}: trade count`);
    assert.deepEqual(closeOrder, scenario.close_order, `${scenario.name}: order in which trades closed`);
    scenario.trades.forEach((expected, k) => {
      const trade = broker.trades[k];
      const { result_r, mfe_r, mae_r, ...exact } = expected;
      assert.deepEqual(record(trade), exact, `${scenario.name} trade ${expected.id}`);
      for (const [name, got, want] of [["result_r", trade.resultR, result_r], ["mfe_r", trade.mfeR, mfe_r], ["mae_r", trade.maeR, mae_r]]) {
        if (want === null) assert.equal(got, null, `${scenario.name} trade ${expected.id} ${name}`);
        else assert.ok(Math.abs(got - want) < 1e-12, `${scenario.name} trade ${expected.id} ${name}: ${got} vs ${want}`);
      }
      compared++;
    });
  }
  assert.equal(compared, fixture.summary.trades);
});

test("the fixture covers every kind of order and exit", () => {
  const s = fixture.summary;
  for (const key of ["stop_loss", "take_profit", "manual", "cancelled", "rejected_orders", "limit_orders", "stop_orders", "market_orders",
    "partial_closes", "moves_accepted", "moves_rejected"]) {
    assert.ok(s[key] > 100, `${key}: ${s[key]}`);
  }
  assert.ok(s.stopped_in_profit > 25, `stopped_in_profit: ${s.stopped_in_profit}`); // rarer: a stop moved past the entry, then hit
});

test("a market order fills at the next candle's open, not at the price when placed", () => {
  const broker = new Broker();
  const trade = broker.marketOrder(Side.BUY, 109900, 110300, 0, 110000);
  assert.equal(trade.status, Status.PENDING);
  broker.processCandle(1, 110040, 110060, 110010);
  assert.equal(trade.status, Status.OPEN);
  assert.equal(trade.entryPrice, 110040);
});

test("stop loss wins when stop and target are inside the same candle", () => {
  const broker = new Broker();
  const trade = broker.marketOrder(Side.BUY, 109900, 110100, 0, 110000);
  broker.processCandle(1, 110000, 110010, 109990);
  broker.processCandle(2, 110000, 110150, 109850);
  assert.equal(trade.exitReason, ExitReason.STOP_LOSS);
  assert.equal(trade.resultR, -1);
});

test("a candle's recorded spread is used when it is wider than the minimum spread", () => {
  const broker = new Broker({ spreadPoints: 2 });
  const trade = broker.pendingOrder(Side.SELL, 110000, 110100, 109800, 0, 110050); // sell stop below the market
  assert.equal(trade.orderType, OrderType.STOP);
  broker.processCandle(1, 110020, 110030, 109990, 0);   // fills at the bid
  assert.equal(trade.status, Status.OPEN);
  broker.processCandle(2, 110050, 110070, 110040, 35);  // bid high 110070 + 35 spread = ask 110105 >= stop
  assert.equal(trade.exitReason, ExitReason.STOP_LOSS);
});

test("an exact touch counts: integer prices have no rounding near-misses", () => {
  const broker = new Broker();
  const trade = broker.pendingOrder(Side.BUY, 108500, 108400, 108700, 0, 108600); // buy limit
  broker.processCandle(1, 108560, 108590, 108500); // low touches the limit exactly
  assert.equal(trade.status, Status.OPEN);
  assert.equal(trade.entryPrice, 108500);
});

test("invalid orders are rejected and leave nothing behind", () => {
  const broker = new Broker();
  assert.throws(() => broker.pendingOrder(Side.BUY, 110000, 110100, 110200, 0, 110050), InvalidOrder);
  assert.throws(() => broker.marketOrder(Side.SELL, 109900, 109800, 0, 110000), InvalidOrder);
  assert.equal(broker.trades.length, 0);
});

test("moving the stop to breakeven does not change what 1R means", () => {
  const broker = new Broker();
  const trade = broker.marketOrder(Side.BUY, 109900, 110300, 0, 110000); // 100 points of risk
  broker.processCandle(1, 110000, 110120, 109990);
  broker.modify(trade, 110100, { stopLoss: 110000 }); // price is at 110100: stop to the entry
  assert.equal(trade.plannedRisk, 100);
  broker.processCandle(2, 110100, 110110, 109990); // comes back through the entry
  assert.equal(trade.exitReason, ExitReason.STOP_LOSS);
  assert.equal(trade.exitPrice, 110000);
  assert.equal(trade.resultR, 0);
});

test("a stop cannot be moved to the wrong side of the current price", () => {
  const broker = new Broker();
  const trade = broker.marketOrder(Side.BUY, 109900, 110300, 0, 110000);
  broker.processCandle(1, 110000, 110020, 109990);
  assert.throws(() => broker.modify(trade, 109980, { stopLoss: 110000 }), InvalidOrder); // price is below the entry
  assert.throws(() => broker.modify(trade, 110050, { takeProfit: 110040 }), InvalidOrder);
  assert.equal(trade.stopLoss, 109900);
  assert.equal(trade.takeProfit, 110300);
});

test("moving a pending order's stop changes its planned risk; moving its entry can turn a limit into a stop", () => {
  const broker = new Broker();
  const trade = broker.pendingOrder(Side.BUY, 109950, 109900, 110200, 0, 110000); // buy limit, 50 points of risk
  assert.equal(trade.orderType, OrderType.LIMIT);
  broker.modify(trade, 110000, { stopLoss: 109850 });
  assert.equal(trade.plannedRisk, 100);
  broker.modify(trade, 110000, { price: 110050 });
  assert.equal(trade.orderType, OrderType.STOP);
  assert.equal(trade.plannedRisk, 200);
});

test("a partial close banks part of the result; R is the size-weighted average", () => {
  const broker = new Broker();
  const trade = broker.marketOrder(Side.BUY, 109900, 110300, 0, 110000); // 100 points of risk, target +3R
  broker.processCandle(1, 110000, 110110, 109990);
  broker.partialClose(trade, 0.5, 1, 110100); // half off at +1R
  assert.equal(trade.remaining, 0.5);
  assert.equal(trade.status, Status.OPEN);
  broker.processCandle(2, 110100, 110310, 110090); // the rest reaches the target at +3R
  assert.equal(trade.exitReason, ExitReason.TAKE_PROFIT);
  assert.equal(trade.resultR, 2); // 0.5 x 1R + 0.5 x 3R
  assert.throws(() => broker.partialClose(trade, 0.1, 2, 110300), /only open trades/);
});

test("a partial close must leave something open", () => {
  const broker = new Broker();
  const trade = broker.marketOrder(Side.SELL, 110100, 109700, 0, 110000);
  broker.processCandle(1, 110000, 110010, 109990);
  assert.throws(() => broker.partialClose(trade, 1, 1, 110000), InvalidOrder);
  assert.throws(() => broker.partialClose(trade, 0, 1, 110000), InvalidOrder);
  assert.equal(trade.partials.length, 0);
});
