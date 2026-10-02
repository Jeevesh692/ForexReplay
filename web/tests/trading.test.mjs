// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import { ReplayClock } from "../js/replay.js";
import { TimeframeView } from "../js/timeframes.js";
import { InvalidOrder, Side, Status, Trading } from "../js/trading.js";

const utc = (text) => Date.parse(text + "Z") / 1000;

/** Flat market at 110000 with small candles, then whatever `overrides` say: { index: [o, h, l, c, spread] }. */
function market(n, overrides = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [o, h, l, c, spread = 0] = overrides[i] || [110000, 110010, 109990, 110000];
    rows.push([utc("2025-08-04T07:00") + i * 300, o, h, l, c, 10, spread]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

function setup(m5, startAt = 5) {
  const clock = new ReplayClock(m5.length);
  let changes = 0;
  const trading = new Trading({ m5, clock, onChange: () => { changes++; } });
  clock.start(startAt);
  return { clock, trading, changes: () => changes };
}

test("a market order placed now fills at the open of the next revealed candle", () => {
  const m5 = market(20, { 5: [110020, 110030, 110015, 110025] });
  const { clock, trading } = setup(m5);
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110200 });
  assert.equal(trade.status, Status.PENDING);
  clock.advance(1);
  assert.equal(trade.status, Status.OPEN);
  assert.equal(trade.entryPrice, 110020);
  assert.equal(trade.entryTime, 5); // index of the M5 candle it filled on
});

test("stepping a whole H1 candle still resolves the stop on the M5 candle that hit it", () => {
  const m5 = market(40, { 9: [110000, 110005, 109880, 109900] }); // the stop is hit on M5 candle 9
  const { clock, trading } = setup(m5);
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.stepForward(new TimeframeView(m5, "H1")); // jumps to the end of the hour: several M5 candles at once
  assert.equal(trade.status, Status.CLOSED);
  assert.equal(trade.exitTime, 9);
  assert.equal(trade.resultR, -1);
});

test("looking back and coming forward again never processes a candle twice", () => {
  const m5 = market(30);
  const { clock, trading } = setup(m5);
  const seen = [];
  const original = trading.broker.processCandle.bind(trading.broker);
  trading.broker.processCandle = (i, ...rest) => { seen.push(i); return original(i, ...rest); };
  const view = new TimeframeView(m5, "M15");
  clock.advance(4);
  clock.stepBack(view);
  clock.stepBack(view);
  clock.advance(2);     // still inside what was already revealed
  clock.backToLive();
  clock.advance(3);
  assert.deepEqual(seen, [5, 6, 7, 8, 9, 10, 11]);
});

test("orders are refused when not replaying, when viewing history, and at the end of the data", () => {
  const m5 = market(12);
  const clock = new ReplayClock(m5.length);
  const trading = new Trading({ m5, clock });
  const order = { side: Side.SELL, type: "market", stopLoss: 110100, takeProfit: 109800 };
  assert.throws(() => trading.place(order), /Start a replay/);
  clock.start(6);
  clock.advance(2);
  clock.stepBack(new TimeframeView(m5, "M5"));
  assert.throws(() => trading.place(order), /viewing history/);
  clock.backToLive();
  assert.equal(trading.place(order).status, Status.PENDING);
  clock.advance(100);
  assert.throws(() => trading.place(order), /end of the data/);
});

test("bad prices are refused with a clear message", () => {
  const { trading } = setup(market(12));
  assert.throws(() => trading.place({ side: Side.BUY, type: "pending", price: NaN, stopLoss: 109900, takeProfit: 110200 }), /Entry price/);
  assert.throws(() => trading.place({ side: Side.BUY, type: "market", stopLoss: 110100, takeProfit: 110200 }), InvalidOrder);
  assert.equal(trading.broker.trades.length, 0);
});

test("the wider of the minimum spread and the candle's recorded spread applies", () => {
  const m5 = market(12, { 4: [110000, 110010, 109990, 110000, 12], 5: [110000, 110010, 109990, 110000, 30] });
  const { clock, trading } = setup(m5);
  trading.setMinSpread(20);
  assert.equal(trading.spread, 20);      // candle 4 recorded 12, minimum 20
  const trade = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(1);
  assert.equal(trade.entryPrice, 110030); // candle 5: open 110000 + spread 30
});

test("flatten closes open trades at the current price and cancels pending orders", () => {
  const m5 = market(12);
  const { clock, trading } = setup(m5);
  const open = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(1);
  const pending = trading.place({ side: Side.BUY, type: "pending", price: 109950, stopLoss: 109900, takeProfit: 110300 });
  trading.flatten();
  assert.equal(open.status, Status.CLOSED);
  assert.equal(pending.status, Status.CANCELLED);
  assert.deepEqual(trading.summary(), { open: 0, pending: 0, closed: 1, wins: 0, losses: 0, totalR: 0 });
});
