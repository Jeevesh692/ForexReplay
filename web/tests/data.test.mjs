// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Candles, FIELDS, loadSymbol } from "../js/data.js";
import { formatDate, formatDateTime, formatMonthKey } from "../js/time.js";

const bufferOf = (rows) => new Int32Array(rows.flat()).buffer;

test("decodes bars into integer price columns", () => {
  const c = Candles.fromBuffer(bufferOf([
    [1754006400, 114150, 114160, 114129, 114150, 71, 12],
    [1754006700, 114150, 114152, 114129, 114152, 66, 35],
  ]));
  assert.equal(c.length, 2);
  assert.equal(c.open[0], 114150);
  assert.equal(c.bar(1).close, 1.14152);
  assert.equal(c.spread[1], 35);
});

test("rejects a file that is not a whole number of bars", () => {
  assert.throws(() => Candles.fromBuffer(new ArrayBuffer(4 * FIELDS.length + 4)), /Corrupt/);
});

test("concat keeps order and refuses candles that go back in time", () => {
  const a = Candles.fromBuffer(bufferOf([[100, 1, 1, 1, 1, 0, 0]]));
  const b = Candles.fromBuffer(bufferOf([[400, 2, 2, 2, 2, 0, 0]]));
  assert.deepEqual([...Candles.concat([a, b]).time], [100, 400]);
  assert.throws(() => Candles.concat([b, a]), /out of order/);
});

test("formats UTC seconds in India time", () => {
  // 2025-08-01 00:00 UTC = 05:30 IST
  assert.equal(formatDateTime(1754006400), "Fri 01 Aug 2025, 05:30");
  assert.equal(formatDate(1754006400), "01 Aug 2025");
  assert.equal(formatMonthKey("2026-09"), "Sep 2026");
});

// Cross-check with the files the Python pipeline actually wrote, when they exist.
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
test("loads the real dataset written by Python", { skip: !existsSync(`${dataDir}EURUSD/manifest.json`) }, async () => {
  const fakeFetch = async (url) => {
    const bytes = readFileSync(dataDir + url.replace(/^data\//, ""));
    return {
      ok: true,
      json: async () => JSON.parse(bytes.toString("utf8")),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const { manifest, candles } = await loadSymbol("EURUSD", "data", fakeFetch);
  assert.equal(candles.length, manifest.bars);
  assert.equal(candles.time[0], manifest.first);
  assert.equal(candles.time[candles.length - 1], manifest.last);
  for (let i = 0; i < candles.length; i++) {
    assert.ok(candles.low[i] <= Math.min(candles.open[i], candles.close[i]));
    assert.ok(candles.high[i] >= Math.max(candles.open[i], candles.close[i]));
  }
});
