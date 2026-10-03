// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import { cleanIndicators, computeIndicators, ema, IndicatorEngine, rsi, sma, vwap } from "../js/indicators.js";
import { ReplayClock } from "../js/replay.js";
import { TimeframeView } from "../js/timeframes.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/indicators_golden.json", import.meta.url), "utf-8"));
const c = fixture.candles;
const rows = c.time.map((t, i) => [t, c.open[i], c.high[i], c.low[i], c.close[i], c.volume[i], 0]);
const candles = Candles.fromBuffer(new Int32Array(rows.flat()).buffer);

function same(actual, expected, label) {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === null) assert.ok(Number.isNaN(actual[i]), `${label}[${i}] should be empty`);
    else assert.ok(Math.abs(actual[i] - expected[i]) < 1e-7, `${label}[${i}]: ${actual[i]} vs ${expected[i]}`);
  }
}

test("SMA, EMA, RSI and daily VWAP match the Python reference on 900 candles over 5 days", () => {
  const closes = candles.close;
  for (const n of [5, 20]) same(sma(closes, n), fixture.expected[`sma${n}`], `sma${n}`);
  for (const n of [9, 50]) same(ema(closes, n), fixture.expected[`ema${n}`], `ema${n}`);
  for (const n of [7, 14]) same(rsi(closes, n), fixture.expected[`rsi${n}`], `rsi${n}`);
  same(vwap(candles), fixture.expected.vwap, "vwap");
  same(rsi(fixture.rising, 14), fixture.expected.rsi14_rising, "rsi with no losses");
});

test("VWAP starts again at the broker's midnight", () => {
  const v = vwap(candles);
  // The first candle of the second server day: VWAP is that candle's own typical price again.
  const i = candles.time.findIndex((t, k) => k > 0 && (t + 2 * 3600) % 86400 === 0); // 22:00 UTC = 00:00 server in early March
  assert.ok(i > 0);
  const typical = (candles.high[i] + candles.low[i] + candles.close[i]) / 3;
  if (candles.volume[i] > 0) assert.ok(Math.abs(v[i] - typical) < 1e-9);
});

test("indicators on a replay see only revealed candles: hiding the future changes nothing before it", () => {
  const settings = cleanIndicators({ sma: { on: true, period: 20 }, ema: { on: true, period: 50 }, vwap: { on: true }, rsi: { on: true, period: 14 } });
  const full = computeIndicators(new TimeframeView(candles, "M15").full, settings);
  const view = new TimeframeView(candles, "M15");
  view.setPosition(candles.length); // everything shown first, as before a replay starts...
  view.setPosition(400); // ...then the replay starts with 400 M5 candles revealed
  const partial = computeIndicators(view.display, settings);
  for (const line of partial) assert.equal(line.values.length, view.display.length, `${line.id} must stop at the last revealed candle`);
  for (let k = 0; k < full.length; k++) {
    const last = view.display.length - 1; // the forming candle may differ; everything before it may not
    for (let i = 0; i < last; i++) {
      const a = partial[k].values[i], b = full[k].values[i];
      assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9, `${full[k].id}[${i}]`);
    }
  }
  assert.deepEqual(partial.map((l) => [l.id, l.pane]), [["sma", "price"], ["ema", "price"], ["vwap", "price"], ["rsi", "rsi"]]);
});

test("settings: defaults, sensible periods only", () => {
  const s = cleanIndicators({ sma: { on: true, period: "30" }, ema: { on: "yes", period: 1 }, rsi: { period: 9999 }, vwap: null });
  assert.deepEqual(s, { sma: { on: true, period: 30 }, ema: { on: false, period: 50 }, vwap: { on: false }, rsi: { on: false, period: 14 } });
  assert.deepEqual(computeIndicators(candles, cleanIndicators(null)), []);
});

test("the step-by-step engine always equals the full calculation, through a random replay", () => {
  const settings = cleanIndicators({ sma: { on: true, period: 20 }, ema: { on: true, period: 9 }, vwap: { on: true }, rsi: { on: true, period: 14 } });
  let seed = 11; const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const tf of ["M5", "M15", "H1"]) {
    const view = new TimeframeView(candles, tf);
    const clock = new ReplayClock(candles.length);
    const engine = new IndicatorEngine();
    clock.start(30);
    view.setPosition(clock.position);
    let lines = engine.compute(view.display, settings);
    let checked = 0;
    for (let step = 0; step < 400; step++) {
      const r = rand();
      if (r < 0.75) clock.advance(1 + Math.floor(rand() * 3));
      else if (r < 0.9) clock.stepBack(view);
      else clock.backToLive();
      const change = view.setPosition(clock.position);
      if (change.reset) lines = engine.compute(view.display, settings);           // a jump: everything again
      else if (change.to >= change.from) lines = engine.compute(view.display, settings, change.from);
      const full = computeIndicators(view.display, settings);
      for (let k = 0; k < full.length; k++) {
        assert.equal(lines[k].values.length, full[k].values.length);
        for (let i = 0; i < full[k].values.length; i++) {
          const a = lines[k].values[i], b = full[k].values[i];
          assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-7, `${tf} step ${step} ${full[k].id}[${i}]: ${a} vs ${b}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 10000, `${tf}: only ${checked} values checked`);
  }
});
