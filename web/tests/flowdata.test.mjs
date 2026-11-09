// Run with:  node --test web/tests/*.test.mjs
// Order flow, Phase 1: the browser reads exactly what Python wrote (fixtures/flow_golden, from forex_replay.flow).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { decodeFlow, FLOW_FIELDS, flowValues, joinFlow } from "../js/flowdata.js";

const bytes = readFileSync(new URL("./fixtures/flow_golden.bin", import.meta.url));
const expected = JSON.parse(readFileSync(new URL("./fixtures/flow_golden.json", import.meta.url), "utf-8"));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test("the browser decodes Python's 15-second buckets field for field", () => {
  assert.deepEqual(expected.fields, FLOW_FIELDS);
  const bars = decodeFlow(buffer);
  assert.equal(bars.length, expected.rows.length);
  expected.rows.forEach((row, i) => FLOW_FIELDS.forEach((name, k) => assert.equal(bars[name][i], row[k], `${name}[${i}]`)));
  for (let i = 0; i < bars.length; i++) {
    assert.equal(bars.time[i] % 15, 0, "each bucket starts on a 15-second boundary");
    assert.ok(bars.up_ticks[i] + bars.down_ticks[i] <= bars.tick_count[i]);
    assert.ok(bars.low[i] <= Math.min(bars.open[i], bars.close[i]) && bars.high[i] >= Math.max(bars.open[i], bars.close[i]));
  }
});

test("months join in order, and values come out in price units", () => {
  const bars = decodeFlow(buffer);
  const joined = joinFlow([bars, bars]);
  assert.equal(joined.length, 2 * bars.length);
  assert.equal(joined.close[bars.length], bars.close[0]);
  const v = flowValues(bars, 0, { price_scale: expected.price_scale });
  assert.equal(v.close, bars.close[0] / 200000);
  assert.equal(v.baseline, null, "no baseline in a sample this short");
  assert.throws(() => decodeFlow(new ArrayBuffer(12)), /whole 40-byte bars/);
});

test("the month loader asks only for the months it needs, once each", async () => {
  const { FlowMonths, monthOf } = await import("../js/flowdata.js");
  const asked = [];
  const bar = new Int32Array(10); bar[0] = 1790000000;
  const fetchFn = async (url) => { asked.push(url.split("/").pop()); return { ok: true, arrayBuffer: async () => bar.buffer.slice(0) }; };
  const manifest = { datasets: { S15: { months: [{ month: "2026-09" }, { month: "2026-10" }, { month: "2026-11" }] } } };
  let arrived = 0;
  const m = new FlowMonths("EURUSD", "S15", manifest, () => { arrived++; }, "data", fetchFn);
  assert.equal(monthOf(1790000000), "2026-09");
  const from = Date.UTC(2026, 8, 25) / 1000, to = Date.UTC(2026, 9, 3) / 1000;
  assert.deepEqual(m.monthsBetween(from, to), ["2026-09", "2026-10"]);
  assert.deepEqual(m.parts(from, to), [], "nothing yet: loading");
  m.parts(from, to);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(asked, ["2026-09.bin", "2026-10.bin"]);
  assert.equal(arrived, 2);
  const parts = m.parts(from, to);
  assert.deepEqual([parts.length, parts[0].seconds, parts[0].time[0]], [2, 15, 1790000000]);
  assert.deepEqual(m.monthsBetween(Date.UTC(2026, 11, 30) / 1000, Date.UTC(2027, 0, 2) / 1000), ["2026-12", "2027-01"], "over a new year");
});
