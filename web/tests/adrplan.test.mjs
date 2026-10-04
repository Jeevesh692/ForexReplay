// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { adrBefore, checkOrder, cleanPlan, DEFAULT_PLAN, thresholds } from "../js/adrplan.js";
import { Candles } from "../js/data.js";
import { serverDate, TimeframeView } from "../js/timeframes.js";

/** M5 candles over 15 trading days (Mon-Fri, from Sunday 21:00 UTC in summer), each day with its own range. */
function market() {
  const rows = [];
  const start = Date.parse("2026-06-07T21:00Z") / 1000; // Sunday 17:00 New York = Monday 00:00 server
  let day = 0;
  for (let d = 0; day < 15; d++) {
    const t0 = start + d * 86400;
    const weekday = new Date((t0 + 3 * 3600) * 1000).getUTCDay(); // server weekday
    if (weekday === 0 || weekday === 6) continue;
    const range = 400 + day * 20; // day k ranges 400 + 20k points
    for (let i = 0; i < 288; i++) {
      const high = 110000 + (i === 100 ? range / 2 : 10), low = 110000 - (i === 200 ? range / 2 : 10);
      rows.push([t0 + i * 300, 110000, high, low, 110000, 10, 0]);
    }
    day++;
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

test("ADR is the mean range of the completed days before today, from the same days as the D1 candles", () => {
  const m5 = market();
  const end = m5.length - 50; // somewhere in the last day
  const { adr, days, today } = adrBefore(m5, end, 10);
  assert.equal(days.length, 10);
  assert.ok(days.every((d) => d.date < today)); // today is never in it
  const ranges = days.map((d) => d.high - d.low);
  assert.deepEqual(ranges, Array.from({ length: 10 }, (_, k) => 400 + (k + 4) * 20)); // days 4..13
  assert.equal(adr, ranges.reduce((a, b) => a + b, 0) / 10);
  // The same as averaging the last 10 completed D1 candles the chart builds.
  const d1 = new TimeframeView(m5, "D1");
  d1.setPosition(end + 1);
  const shown = d1.display;
  const completed = [];
  for (let i = 0; i < shown.length; i++) if (serverDate(shown.time[i]) < today) completed.push(shown.high[i] - shown.low[i]);
  assert.equal(adr, completed.slice(-10).reduce((a, b) => a + b, 0) / 10);
  // It does not change during the day.
  assert.equal(adrBefore(m5, end - 100, 10).adr, adr);
  // Too few completed days: no number.
  assert.ok(Number.isNaN(adrBefore(m5, 300, 10).adr));
});

test("the worked example: ADR10 of 70 pips", () => {
  const rows = Object.fromEntries(thresholds(DEFAULT_PLAN, 700).map((r) => [r.id, r.points / 10]));
  assert.ok(Math.abs(rows.p - 1.4) < 1e-9);
  assert.ok(Math.abs(rows.pmax - 21) < 1e-9);
  assert.ok(Math.abs(rows.b - 1.4) < 1e-9);
  assert.ok(Math.abs(rows.minStop - 5.6) < 1e-9);
  assert.ok(Math.abs(rows.disp5 - 5.6) < 1e-9);
});

test("order warnings: a stop under minStop, and reward/risk under the floor", () => {
  const order = (stopPips, targetPips) => ({ entry: 110000, stopLoss: 110000 - stopPips * 10, takeProfit: 110000 + targetPips * 10 });
  assert.deepEqual(checkOrder(DEFAULT_PLAN, 700, order(10, 20), 10), []);
  const small = checkOrder(DEFAULT_PLAN, 700, order(4, 20), 10);
  assert.equal(small.length, 1);
  assert.match(small[0], /Stop 4\.0 pips is below minStop \(5\.6 pips\)/);
  assert.match(checkOrder(DEFAULT_PLAN, 700, order(10, 12), 10)[0], /Reward\/risk 1\.20 is below your 1\.5 floor/);
  assert.equal(checkOrder(DEFAULT_PLAN, NaN, order(4, 20), 10).length, 0); // no ADR yet: no minStop warning
});

test("a plan from storage is made safe", () => {
  const plan = cleanPlan({ period: "20", rrFloor: 2, rows: [
    { id: "p", label: "custom", mult: "0.03" }, { id: "p", label: "duplicate", mult: 1 }, { id: "bad id", mult: 1 },
    { id: "huge", mult: 99 }, { id: "x", label: "<b>new</b>", mult: 0.5 },
  ] });
  assert.equal(plan.period, 20);
  assert.equal(plan.rrFloor, 2);
  assert.deepEqual(plan.rows.map((r) => [r.id, r.mult]), [["p", 0.03], ["x", 0.5]]);
  assert.deepEqual(cleanPlan(null), structuredClone(DEFAULT_PLAN));
  assert.equal(cleanPlan({ period: 1 }).period, 10);
});
