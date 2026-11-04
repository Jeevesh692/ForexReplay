// Run with:  node --test web/tests/*.test.mjs
// Jump to setup time: the next target in its own city's clock, never backwards, weekends skipped, and
// every candle on the way played through, so an open trade's stop is hit where it would have been.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import { cleanJump, jumpClock, nextJump, validateJump } from "../js/jump.js";
import { ReplayClock } from "../js/replay.js";
import { Side, Trading } from "../js/trading.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const ENV = { pipPoints: 10, pointValue: 1 };

/** 1-minute candles while the market is open (Sunday 22:00 to Friday 22:00 UTC), from `from` for `weeks` weeks. */
function minutes(from, weeks, price = () => 110000) {
  const rows = [];
  const start = utc(from);
  for (let t = start; t < start + weeks * 7 * 86400; t += 60) {
    const d = new Date(t * 1000);
    const day = d.getUTCDay();
    const open = (day >= 1 && day <= 4) || (day === 5 && d.getUTCHours() < 22) || (day === 0 && d.getUTCHours() >= 22);
    if (!open) continue;
    const p = price(t);
    rows.push([t, p, p + 2, p - 2, p, 1, 0]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

const indexOf = (c, t) => { for (let i = 0; i < c.length; i++) if (c.time[i] >= t) return i; return c.length; };
const TOKYO_CLOSE = { kind: "session", session: "asia", edge: "end", offset: 0 };
const NY_KZ = { kind: "session", session: "ny-kz", edge: "start", offset: 0 };
const LONDON_OPEN = { kind: "session", session: "london", edge: "start", offset: 0 };

test("lands at the Tokyo close with every candle before it revealed, and never goes back", () => {
  const c = minutes("2026-01-05T00:00", 1); // a Monday
  const from = indexOf(c, utc("2026-01-05T03:00")) + 1;
  const a = nextJump(TOKYO_CLOSE, c, c.length, from, 60);
  assert.equal(a.target, utc("2026-01-05T09:00")); // 18:00 Tokyo = 09:00 UTC all year: Japan has no daylight saving
  assert.equal(c.time[a.position - 1], utc("2026-01-05T08:59")); // the last candle shown closes at 18:00
  const b = nextJump(TOKYO_CLOSE, c, c.length, a.position, 60); // already there: the next one is tomorrow
  assert.equal(b.target, utc("2026-01-06T09:00"));
  assert.ok(b.position > a.position);
});

test("a target already passed today goes to the next day", () => {
  const c = minutes("2026-01-05T00:00", 1);
  const late = indexOf(c, utc("2026-01-05T15:00")) + 1;
  assert.equal(nextJump(TOKYO_CLOSE, c, c.length, late, 60).target, utc("2026-01-06T09:00"));
});

test("a jump from Friday skips the weekend", () => {
  const c = minutes("2026-01-05T00:00", 2);
  const friday = indexOf(c, utc("2026-01-09T12:00")) + 1; // after Friday's Tokyo close
  assert.equal(nextJump(TOKYO_CLOSE, c, c.length, friday, 60).target, utc("2026-01-12T09:00")); // Monday
  const ny = nextJump(NY_KZ, c, c.length, indexOf(c, utc("2026-01-09T13:00")) + 1, 60);
  assert.equal(ny.target, utc("2026-01-12T12:00")); // Monday 07:00 New York (winter, UTC-5)
});

test("New York's killzone stays at 07:00 New York through both clock changes; London's open follows UK time", () => {
  // US clocks moved on 8 Mar 2026 and back on 1 Nov; UK clocks on 29 Mar and 25 Oct.
  const march = minutes("2026-03-02T00:00", 5);
  const at = (t) => indexOf(march, utc(t)) + 1;
  assert.equal(nextJump(NY_KZ, march, march.length, at("2026-03-05T13:00"), 60).target, utc("2026-03-06T12:00")); // EST: UTC-5
  assert.equal(nextJump(NY_KZ, march, march.length, at("2026-03-06T13:00"), 60).target, utc("2026-03-09T11:00")); // EDT: UTC-4
  assert.equal(nextJump(LONDON_OPEN, march, march.length, at("2026-03-26T09:00"), 60).target, utc("2026-03-27T08:00")); // GMT
  assert.equal(nextJump(LONDON_OPEN, march, march.length, at("2026-03-27T09:00"), 60).target, utc("2026-03-30T07:00")); // BST
  const november = minutes("2026-10-26T00:00", 2);
  const atN = (t) => indexOf(november, utc(t)) + 1;
  assert.equal(nextJump(NY_KZ, november, november.length, atN("2026-10-29T12:00"), 60).target, utc("2026-10-30T11:00")); // still EDT
  assert.equal(nextJump(NY_KZ, november, november.length, atN("2026-10-30T12:00"), 60).target, utc("2026-11-02T12:00")); // EST again
});

test("an offset lands that many minutes early or late, and a clock time uses its own zone", () => {
  const c = minutes("2026-01-05T00:00", 1);
  const from = indexOf(c, utc("2026-01-05T03:00")) + 1;
  assert.equal(nextJump({ ...TOKYO_CLOSE, offset: -15 }, c, c.length, from, 60).target, utc("2026-01-05T08:45"));
  assert.equal(nextJump({ kind: "clock", zone: "Asia/Kolkata", time: "12:30", offset: 0 }, c, c.length, from, 60).target, utc("2026-01-05T07:00"));
});

test("a target in a short gap lands on the first candle after it; the end of the data gives null", () => {
  const c = minutes("2026-01-05T00:00", 1);
  const keep = [];
  for (let i = 0; i < c.length; i++) {
    if (c.time[i] < utc("2026-01-05T08:50") || c.time[i] >= utc("2026-01-05T09:30")) keep.push(c.time[i], 110000, 110002, 109998, 110000, 1, 0);
  }
  const holes = Candles.fromBuffer(new Int32Array(keep).buffer);
  const j = nextJump(TOKYO_CLOSE, holes, holes.length, 10, 60);
  assert.equal(holes.time[j.position - 1], utc("2026-01-05T09:30")); // the first candle after the gap is shown
  assert.equal(nextJump(TOKYO_CLOSE, c, c.length, c.length - 1, 60), null);
});

test("settings: a damaged jump reads as none; bad ones are refused with a reason", () => {
  assert.equal(cleanJump({ kind: "session", session: "asia", edge: "sideways" }), null);
  assert.equal(cleanJump("tokyo"), null);
  assert.deepEqual(cleanJump({ kind: "session", session: "ny-kz", edge: "start" }), NY_KZ);
  assert.ok(validateJump({ kind: "clock", zone: "UTC", time: "24:00" }).error);
  assert.ok(validateJump({ kind: "session", session: "asia", edge: "end", offset: 721 }).error);
  assert.deepEqual(validateJump(null), { jump: null });
});

function run(c, startAt) {
  const clock = new ReplayClock(c.length);
  const trading = new Trading({ m5: c, clock, ...ENV, settings: { startingBalance: 10000, commissionPerLot: 4 } });
  clock.start(startAt);
  trading.reset();
  return { clock, trading };
}

test("an open trade whose stop is hit mid-jump stops the jump on that candle, with the same result as playing through", () => {
  // The price falls 1 point a minute from 06:00 UTC: a buy with a 100-point stop is stopped near 07:38, before 09:00.
  const start = utc("2026-01-05T06:00");
  const falling = (t) => (t < start ? 110000 : 110000 - Math.floor((t - start) / 60));
  const c = minutes("2026-01-05T00:00", 1, falling);
  const startAt = indexOf(c, utc("2026-01-05T05:58")) + 1;
  const order = (trading) => trading.place({ side: Side.BUY, type: "market", stopLoss: 110000 - 100, takeProfit: 110000 + 400 });
  const jumped = run(c, startAt);
  order(jumped.trading);
  const target = nextJump(TOKYO_CLOSE, c, c.length, startAt, 60).position; // 09:00 UTC, well after the stop
  // The first jump stops where the market order fills; the next one where the stop is hit.
  const filled = jumpClock(jumped.clock, jumped.trading, target);
  assert.equal(filled.early, true);
  assert.equal(jumped.trading.broker.trades[0].status, "OPEN");
  const stopped = jumpClock(jumped.clock, jumped.trading, target);
  assert.equal(stopped.early, true);
  const trade = jumped.trading.broker.trades[0];
  assert.equal(trade.status, "CLOSED");
  assert.ok(jumped.clock.position < target);
  assert.equal(jumped.clock.position - 1, trade.exitTime, "the jump ends on the candle that hit the stop (exitTime is a candle index)");
  // Playing the same minutes one at a time gives exactly the same trade.
  const played = run(c, startAt);
  order(played.trading);
  while (played.trading.broker.trades[0].status !== "CLOSED") played.clock.advance(1);
  const p = played.trading.broker.trades[0];
  assert.deepEqual([p.exitTime, p.exitPrice, p.pnl, p.exitReason], [trade.exitTime, trade.exitPrice, trade.pnl, trade.exitReason]);
  assert.equal(trade.exitReason, "STOP_LOSS");
});

test("with nothing open a jump goes all the way; looking back at history it does nothing", () => {
  const c = minutes("2026-01-05T00:00", 1);
  const { clock, trading } = run(c, 100);
  const target = nextJump(TOKYO_CLOSE, c, c.length, 100, 60).position;
  assert.deepEqual(jumpClock(clock, trading, target), { moved: true, early: false, at: target });
  clock.moveTo(clock.position - 5, "back"); // looking back: not live
  assert.equal(jumpClock(clock, trading, target + 500).moved, false);
});
