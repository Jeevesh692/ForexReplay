// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Candles, FIELDS, loadSymbol } from "../js/data.js";
import { ReplayClock } from "../js/replay.js";
import { aggregate, TimeframeView } from "../js/timeframes.js";

const utc = (text) => Date.parse(text + "Z") / 1000;

/** n synthetic M5 candles starting at a server-hour boundary, each with distinct prices. */
function synthetic(n, start = utc("2025-08-04T07:00")) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const base = 110000 + ((i * 37) % 200) - 100;
    rows.push([start + i * 300, base, base + 30 + (i % 7), base - 25 - (i % 5), base + ((i % 3) - 1) * 10, 10 + i, i % 4]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

function assertSameCandles(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message}: candle count`);
  for (const f of FIELDS) {
    assert.deepEqual([...actual[f].subarray(0, actual.length)], [...expected[f].subarray(0, expected.length)], `${message}: ${f}`);
  }
}

test("a forming H1 candle contains only the M5 candles revealed so far", () => {
  const m5 = synthetic(36); // three hours
  const view = new TimeframeView(m5, "H1");
  view.setPosition(16); // 1 hour 20 minutes in
  assert.equal(view.display.length, 2);
  assert.equal(view.isForming(), true);
  let high = -Infinity, low = Infinity;
  for (let i = 12; i < 16; i++) { high = Math.max(high, m5.high[i]); low = Math.min(low, m5.low[i]); }
  assert.deepEqual(
    [view.display.open[1], view.display.high[1], view.display.low[1], view.display.close[1]],
    [m5.open[12], high, low, m5.close[15]]);
});

test("moving forward reports only the candles that changed; moving back asks for a redraw", () => {
  const view = new TimeframeView(synthetic(36), "M15");
  assert.deepEqual(view.setPosition(4), { reset: true });      // back from the end
  assert.deepEqual(view.setPosition(5), { reset: false, from: 1, to: 1 });
  assert.deepEqual(view.setPosition(11), { reset: false, from: 1, to: 3 });
  assert.deepEqual(view.setPosition(9), { reset: true });
});

test("whatever path the replay takes, the view equals a fresh aggregate of the revealed candles", () => {
  const m5 = synthetic(700);
  for (const tf of ["M5", "M15", "M30", "H1", "H4", "D1"]) {
    const view = new TimeframeView(m5, tf);
    let seed = 12345;
    const random = (max) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max; };
    let position = 1 + random(700);
    for (let step = 0; step < 300; step++) {
      // mostly small steps forward, sometimes a jump anywhere (back or forward)
      position = random(10) < 8 ? Math.min(700, position + 1 + random(4)) : 1 + random(700);
      view.setPosition(position);
      assertSameCandles(view.display, aggregate(m5, tf, position).candles, `${tf} at ${position}`);
    }
  }
});

test("step forward finishes the forming candle, then moves one whole candle at a time", () => {
  const m5 = synthetic(36);
  const view = new TimeframeView(m5, "M15");
  const clock = new ReplayClock(m5.length);
  clock.start(4); // one M5 candle into the second M15 candle
  assert.equal(clock.stepForward(view), true);
  assert.equal(clock.position, 6);
  clock.stepForward(view);
  assert.equal(clock.position, 9);
});

test("step back hides candles but remembers how far you had got", () => {
  const m5 = synthetic(36);
  const view = new TimeframeView(m5, "M15");
  const clock = new ReplayClock(m5.length);
  clock.start(9);
  clock.stepBack(view);
  assert.equal(clock.position, 6);
  assert.equal(clock.furthest, 9);
  assert.equal(clock.live, false);
  clock.backToLive();
  assert.equal(clock.live, true);
});

test("play reveals candles on a timer, pauses at the end of the data, and exit shows everything", () => {
  const timers = { fn: null, setInterval(fn) { this.fn = fn; return 1; }, clearInterval() { this.fn = null; } };
  const clock = new ReplayClock(10, timers);
  const reasons = [];
  clock.onChange((_, reason) => reasons.push(reason));
  clock.start(7);
  clock.setSpeed(2);
  clock.play();
  timers.fn(); timers.fn(); timers.fn();
  assert.equal(clock.position, 10);
  assert.equal(clock.playing, false);
  assert.equal(timers.fn, null);
  clock.stop();
  assert.equal(clock.active, false);
  assert.deepEqual(reasons, ["start", "speed", "play", "advance", "advance", "advance", "pause", "stop"]);
});

test("nothing happens when replay is not active", () => {
  const clock = new ReplayClock(10);
  assert.equal(clock.advance(), false);
  clock.play();
  assert.equal(clock.playing, false);
});

// The same no-future-data property on the real dataset.
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
test("real data: replay views never differ from a fresh aggregate", { skip: !existsSync(`${dataDir}EURUSD/manifest.json`) }, async () => {
  const fakeFetch = async (url) => {
    const bytes = readFileSync(dataDir + url.replace(/^data\//, ""));
    return {
      ok: true,
      json: async () => JSON.parse(bytes.toString("utf8")),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const { candles: m5 } = await loadSymbol("EURUSD", "data", fakeFetch);
  for (const tf of ["M15", "H1", "H4", "D1"]) {
    const view = new TimeframeView(m5, tf);
    for (const position of [1, 2, 288, 5000, 5001, 5013, 40000, 39990, m5.length - 1, m5.length]) {
      view.setPosition(position);
      assertSameCandles(view.display, aggregate(m5, tf, position).candles, `${tf} at ${position}`);
    }
  }
});
