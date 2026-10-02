// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Candles, loadSymbol } from "../js/data.js";
import { aggregate, bucketStart, indexAtOrBefore, serverOffsetSeconds } from "../js/timeframes.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const candlesOf = (rows) => Candles.fromBuffer(new Int32Array(rows.flat()).buffer);

test("server clock is UTC+3 in US summer time and UTC+2 otherwise", () => {
  assert.equal(serverOffsetSeconds(utc("2025-08-04T07:00")), 3 * 3600);
  assert.equal(serverOffsetSeconds(utc("2025-12-01T07:00")), 2 * 3600);
  // 2026: US summer time starts Sunday 8 March 07:00 UTC, ends Sunday 1 November 06:00 UTC
  assert.equal(serverOffsetSeconds(utc("2026-03-08T06:59")), 2 * 3600);
  assert.equal(serverOffsetSeconds(utc("2026-03-08T07:00")), 3 * 3600);
  assert.equal(serverOffsetSeconds(utc("2026-11-01T05:59")), 3 * 3600);
  assert.equal(serverOffsetSeconds(utc("2026-11-01T06:00")), 2 * 3600);
});

test("H4 and D1 candles start on the server clock, not on UTC", () => {
  // Summer: server midnight = 21:00 UTC. A candle at 22:10 UTC belongs to the H4 candle starting 21:00 UTC.
  assert.equal(bucketStart(utc("2025-08-04T22:10"), 14400), utc("2025-08-04T21:00"));
  // Winter: server midnight = 22:00 UTC.
  assert.equal(bucketStart(utc("2025-12-01T22:10"), 14400), utc("2025-12-01T22:00"));
  assert.equal(bucketStart(utc("2025-12-02T10:00"), 86400), utc("2025-12-01T22:00"));
  // Up to H1 the server clock and UTC agree.
  assert.equal(bucketStart(utc("2025-08-04T22:10"), 900), utc("2025-08-04T22:00"));
});

test("aggregates open, high, low, close and volume", () => {
  const t = utc("2025-08-04T07:00");
  const m5 = candlesOf([
    [t, 100, 110, 95, 105, 10, 1],
    [t + 300, 105, 120, 104, 118, 20, 3],
    [t + 600, 118, 119, 90, 92, 30, 2],
    [t + 900, 92, 93, 91, 93, 5, 0], // next M15 candle
  ]);
  const { candles, firstIndex } = aggregate(m5, "M15");
  assert.equal(candles.length, 2);
  assert.deepEqual(
    [candles.time[0], candles.open[0], candles.high[0], candles.low[0], candles.close[0], candles.volume[0], candles.spread[0]],
    [t, 100, 120, 90, 92, 60, 3]);
  assert.deepEqual([...firstIndex], [0, 3]);
});

test("upTo gives a forming candle that knows nothing about the future", () => {
  const t = utc("2025-08-04T07:00");
  const m5 = candlesOf([
    [t, 100, 110, 95, 105, 10, 0],
    [t + 300, 105, 120, 104, 118, 20, 0],
    [t + 600, 118, 119, 90, 92, 30, 0],
  ]);
  const { candles } = aggregate(m5, "M15", 2); // only the first two M5 candles are revealed
  assert.equal(candles.length, 1);
  assert.deepEqual([candles.high[0], candles.low[0], candles.close[0]], [120, 95, 118]);
});

test("indexAtOrBefore finds the candle containing a time", () => {
  const c = candlesOf([[100, 1, 1, 1, 1, 0, 0], [400, 1, 1, 1, 1, 0, 0], [700, 1, 1, 1, 1, 0, 0]]);
  assert.equal(indexAtOrBefore(c, 99), -1);
  assert.equal(indexAtOrBefore(c, 400), 1);
  assert.equal(indexAtOrBefore(c, 650), 1);
  assert.equal(indexAtOrBefore(c, 9999), 2);
});

// Cross-check against candles computed independently by pandas (forex_replay/datapipe.py).
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const haveReference = existsSync(`${dataDir}EURUSD/reference.json`);
test("H4 and D1 candles match the pandas reference for the whole dataset", { skip: !haveReference }, async () => {
  const fakeFetch = async (url) => {
    const bytes = readFileSync(dataDir + url.replace(/^data\//, ""));
    return {
      ok: true,
      json: async () => JSON.parse(bytes.toString("utf8")),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const { candles: m5 } = await loadSymbol("EURUSD", "data", fakeFetch);
  const reference = JSON.parse(readFileSync(`${dataDir}EURUSD/reference.json`, "utf8"));
  for (const tf of ["H4", "D1"]) {
    const { candles } = aggregate(m5, tf);
    assert.equal(candles.length, reference[tf].length, `${tf} candle count`);
    reference[tf].forEach(([time, open, high, low, close, volume], k) => {
      assert.deepEqual(
        [candles.time[k], candles.open[k], candles.high[k], candles.low[k], candles.close[k], candles.volume[k]],
        [time, open, high, low, close, volume], `${tf} candle ${k}`);
    });
  }
});
