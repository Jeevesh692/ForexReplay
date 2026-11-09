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
