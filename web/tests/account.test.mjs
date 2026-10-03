// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, cleanSettings, DEFAULT_SETTINGS, formatLots, formatMoney, formatSignedMoney, pointValuePerLot, unitsForRisk } from "../js/account.js";
import { Candles } from "../js/data.js";
import { ReplayClock } from "../js/replay.js";
import { InvalidOrder, OrderType, Side, Status, Trading } from "../js/trading.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const near = (got, want, message) => assert.ok(Math.abs(got - want) < 1e-6, `${message || "value"}: ${got} vs ${want}`);

/** Flat market at 110000 with small candles, then whatever `overrides` say: { index: [o, h, l, c, spread] }. */
function market(n, overrides = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [o, h, l, c, spread = 0] = overrides[i] || [110000, 110010, 109990, 110000];
    rows.push([utc("2025-08-04T07:00") + i * 300, o, h, l, c, 10, spread]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

function setup(m5, settings = {}, startAt = 5) {
  const clock = new ReplayClock(m5.length);
  const trading = new Trading({ m5, clock, settings: { ...DEFAULT_SETTINGS, ...settings } });
  clock.start(startAt);
  return { clock, trading };
}

test("one point of EURUSD is worth $1 per lot, so a pip is $10", () => {
  assert.equal(pointValuePerLot(5), 1);
});

test("size from risk: 1% of $10,000 with a 20-pip stop is 0.50 lots", () => {
  assert.equal(unitsForRisk({ balance: 10000, riskPercent: 1, riskPoints: 200, pointValue: 1 }), 50);
});

test("size from risk is rounded down, so the money at risk is never more than asked for", () => {
  // $100 over a 13-pip stop is 0.769 lots; 0.77 would risk $100.10.
  assert.equal(unitsForRisk({ balance: 10000, riskPercent: 1, riskPoints: 130, pointValue: 1 }), 76);
  for (let points = 7; points < 3000; points += 13) {
    const units = unitsForRisk({ balance: 25000, riskPercent: 0.5, riskPoints: points, pointValue: 1 });
    assert.ok(units * points / 100 <= 125 + 1e-9, `${points} points: ${units} units`);
    assert.ok((units + 1) * points / 100 > 125, `${points} points: one step more would be too much`);
  }
});

test("a stop too wide for the risk is refused with the reason, and nothing is placed", () => {
  const { trading } = setup(market(12), { startingBalance: 100, riskPercent: 0.5 }); // $0.50 at risk
  assert.throws(() => trading.place({ side: Side.BUY, type: "market", stopLoss: 109000, takeProfit: 112000 }),
    /too little for this stop: even 0\.01 lots would risk \$10\.00/);
  assert.equal(trading.broker.trades.length, 0);
  // Wrong-side prices are reported as such, not as a sizing problem.
  assert.throws(() => trading.place({ side: Side.BUY, type: "market", stopLoss: 111000, takeProfit: 112000 }), /stop loss below the entry/);
});

test("a full stop-out costs the risk plus the commission; balance and equity agree once flat", () => {
  const m5 = market(12, { 6: [110000, 110005, 109800, 109850] });
  const { clock, trading } = setup(m5);
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 }); // 100 points: 1.00 lot
  assert.equal(trading.account.units(trade), 100);
  assert.equal(trading.balance, 10000); // nothing is charged until it fills
  clock.advance(1);
  assert.equal(trade.status, Status.OPEN);
  assert.equal(trading.balance, 9993); // $7 commission taken when it opens
  assert.equal(trading.equity, 9993);
  clock.advance(1);
  assert.equal(trade.resultR, -1);
  assert.equal(trading.money(trade), -107);
  assert.equal(trading.balance, 9893);
  assert.equal(trading.equity, 9893);
});

test("equity moves with the open trade; a sell is valued at the ask", () => {
  const m5 = market(12, { 6: [110000, 110010, 109940, 109950, 4] }); // price falls 50 points, spread 4
  const { clock, trading } = setup(m5, { sizeMode: "lots", fixedLots: 0.2, commissionPerLot: 5 });
  const trade = trading.place({ side: Side.SELL, type: "market", stopLoss: 110200, takeProfit: 109500 });
  clock.advance(2);
  assert.equal(trade.entryPrice, 110000);
  near(trading.account.unrealized(trade, trading.bid, trading.spread), 0.2 * (50 - 4)); // closes at bid + spread
  near(trading.equity, 10000 - 1 + 9.2);
  near(trading.balance, 9999);
});

test("partial close: half is banked, the rest runs; dollars and R agree", () => {
  const m5 = market(14, {
    6: [110000, 110105, 109995, 110100], // +100 points
    7: [110100, 110310, 110090, 110300], // reaches the target at 110300
  });
  const { clock, trading } = setup(m5);
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(2); // filled at 110000, now at 110100
  const part = trading.partialClose(trade.id, 50);
  assert.deepEqual(part, { fraction: 0.5, units: 50 });
  assert.equal(trading.account.openUnits(trade), 50);
  near(trading.balance, 10000 - 7 + 50); // half a lot x 100 points banked
  near(trading.equity, 10000 - 7 + 100); // the other half is still floating +$50
  clock.advance(1);
  assert.equal(trade.status, Status.CLOSED);
  assert.equal(trade.resultR, 2); // 0.5 x 1R + 0.5 x 3R
  near(trading.money(trade), 50 + 150 - 7);
  near(trading.balance, 10193);
});

test("partial close works in whole 0.01 lots and refuses when nothing would be left or closed", () => {
  const m5 = market(12);
  const { clock, trading } = setup(m5, { sizeMode: "lots", fixedLots: 0.03 });
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(1);
  assert.equal(trading.partialClose(trade.id, 50).units, 2); // half of 3 units rounds to 2
  assert.equal(trading.account.openUnits(trade), 1);
  assert.throws(() => trading.partialClose(trade.id, 50), /too small/);
  assert.throws(() => trading.partialClose(trade.id, 25), /too small/);
  assert.equal(trade.partials.length, 1);
});

test("breakeven needs the trade to be in profit, then makes the worst case a scratch", () => {
  const m5 = market(14, {
    6: [110000, 110090, 109995, 110080],
    7: [110080, 110085, 109950, 109960], // falls back through the entry
  });
  const { clock, trading } = setup(m5);
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(1);
  assert.throws(() => trading.breakeven(trade.id), /not in profit/);
  clock.advance(1);
  trading.breakeven(trade.id);
  assert.equal(trade.stopLoss, trade.entryPrice);
  assert.throws(() => trading.breakeven(trade.id), /already at breakeven/);
  clock.advance(1);
  assert.equal(trade.status, Status.CLOSED);
  assert.equal(trade.resultR, 0);
  assert.equal(trading.money(trade), -7); // only the commission
});

test("moving the stop of a pending order re-sizes it, so it still risks the chosen %", () => {
  const { trading } = setup(market(12));
  const trade = trading.place({ side: Side.BUY, type: "pending", price: 109950, stopLoss: 109900, takeProfit: 110200 });
  assert.equal(trading.account.units(trade), 200); // 50 points of risk: 2.00 lots
  trading.modifyTrade(trade.id, { stopLoss: 109850 });
  assert.equal(trading.account.units(trade), 100); // 100 points: 1.00 lot
  near(trading.account.riskMoney(trade), 100);
  trading.modifyTrade(trade.id, { price: 110050 }); // above the market now: a buy stop, 200 points of risk
  assert.equal(trade.orderType, OrderType.STOP);
  assert.equal(trading.account.units(trade), 50);
  assert.throws(() => trading.modifyTrade(trade.id, { stopLoss: 110100 }), InvalidOrder);
  assert.equal(trade.stopLoss, 109850);
  assert.equal(trading.account.units(trade), 50);
});

test("an open trade keeps its size when its stop is moved, and changes are refused while viewing history", () => {
  const m5 = market(14, { 6: [110000, 110060, 109995, 110050] });
  const { clock, trading } = setup(m5);
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(2);
  trading.modifyTrade(trade.id, { stopLoss: 109950, takeProfit: 110400 });
  assert.equal(trading.account.units(trade), 100);
  assert.equal(trade.plannedRisk, 100); // 1R is still the original 100 points
  clock.advance(-1);
  for (const action of [() => trading.modifyTrade(trade.id, { stopLoss: 109960 }), () => trading.breakeven(trade.id),
    () => trading.partialClose(trade.id, 50), () => trading.closeAll()]) {
    assert.throws(action, /viewing history/);
  }
  assert.equal(trade.stopLoss, 109950);
});

test("close all closes open trades, cancels orders, and charges no commission on orders that never filled", () => {
  const m5 = market(12);
  const { clock, trading } = setup(m5);
  trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(1);
  trading.place({ side: Side.SELL, type: "pending", price: 110100, stopLoss: 110200, takeProfit: 109800 });
  trading.closeAll();
  const s = trading.summary();
  assert.deepEqual([s.open, s.pending, s.closed], [0, 0, 1]);
  assert.equal(trading.balance, 9993);
});

test("damaged saved settings fall back to the defaults", () => {
  assert.deepEqual(cleanSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(cleanSettings({ startingBalance: "abc", riskPercent: -3, sizeMode: "all-in", commissionPerLot: 3.5 }),
    { ...DEFAULT_SETTINGS, commissionPerLot: 3.5 });
  assert.equal(cleanSettings({ fixedLots: 0.237 }).fixedLots, 0.24);
});

test("money and lots are written the same way everywhere", () => {
  assert.equal(formatMoney(10000), "$10,000.00");
  assert.equal(formatMoney(-107.5), "-$107.50");
  assert.equal(formatSignedMoney(41.2), "+$41.20");
  assert.equal(formatSignedMoney(-0.001), "$0.00");
  assert.equal(formatLots(76), "0.76");
  assert.equal(new Account(DEFAULT_SETTINGS, 1).money(76, 130), 98.8);
});
