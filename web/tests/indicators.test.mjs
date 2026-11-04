// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import { adr, atr, bollinger, cleanIndicators, computeIndicators, DEFAULT_INDICATORS, ema, IndicatorEngine, MA_LINES, rsi, sma, vwap } from "../js/indicators.js";
import { ReplayClock } from "../js/replay.js";
import { serverDate, TimeframeView } from "../js/timeframes.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/indicators_golden.json", import.meta.url), "utf-8"));
const c = fixture.candles;
const rows = c.time.map((t, i) => [t, c.open[i], c.high[i], c.low[i], c.close[i], c.volume[i], 0]);
const candles = Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
const h = fixture.hourly;
const hourly = Candles.fromBuffer(new Int32Array(h.time.map((t, i) => [t, h.open[i], h.high[i], h.low[i], h.close[i], h.volume[i], 0]).flat()).buffer);

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

test("Bollinger Bands match the Python reference: SMA basis, bands at k population standard deviations", () => {
  for (const [n, mult] of [[20, 2], [10, 1.5]]) {
    const b = bollinger(candles.close, n, mult);
    const key = `bb${n}_${Number.isInteger(mult) ? mult.toFixed(1) : mult}`;
    same(b.basis, fixture.expected[`${key}_basis`], `${key} basis`);
    same(b.upper, fixture.expected[`${key}_upper`], `${key} upper`);
    same(b.lower, fixture.expected[`${key}_lower`], `${key} lower`);
    const s = sma(candles.close, n);
    for (let i = 0; i < s.length; i++) assert.ok(Object.is(b.basis[i], s[i]) || Math.abs(b.basis[i] - s[i]) < 1e-9, `the basis is the SMA [${i}]`);
  }
  // By hand: closes 1, 2, 3, 4, 5: mean 3, population SD sqrt(2), so 2 SD bands at 3 +/- 2.828...
  const small = bollinger(Float64Array.from([1, 2, 3, 4, 5]), 5, 2);
  assert.ok(Number.isNaN(small.upper[3]));
  assert.ok(Math.abs(small.upper[4] - (3 + 2 * Math.SQRT2)) < 1e-12 && Math.abs(small.lower[4] - (3 - 2 * Math.SQRT2)) < 1e-12);
  const flat = bollinger(Float64Array.from([7, 7, 7]), 3, 2); // no movement: the bands close onto the basis
  assert.deepEqual([flat.lower[2], flat.basis[2], flat.upper[2]], [7, 7, 7]);
});

test("Bollinger settings: period and standard deviations, nonsense refused", () => {
  assert.deepEqual(cleanIndicators(null).bb, { on: false, period: 20, mult: 2 });
  assert.deepEqual(cleanIndicators({ bb: { on: true, period: "50", mult: "2.5" } }).bb, { on: true, period: 50, mult: 2.5 });
  assert.equal(cleanIndicators({ bb: { mult: 0 } }).bb.mult, 2);
  assert.equal(cleanIndicators({ bb: { mult: 11 } }).bb.mult, 2);
  assert.equal(cleanIndicators({ bb: { mult: "" } }).bb.mult, 2);
  assert.equal(cleanIndicators({ bb: { mult: 1.23 } }).bb.mult, 1.2);
  const lines = computeIndicators(candles, cleanIndicators({ bb: { on: true, period: 20, mult: 2 } }));
  assert.deepEqual(lines.map((l) => [l.id, l.label, l.pane]), [
    ["bbUpper", "BB 20 2 upper", "price"], ["bbBasis", "BB 20 2 basis", "price"], ["bbLower", "BB 20 2 lower", "price"],
  ]);
});

test("ATR and ADR match the Python reference, ADR over two months of hourly candles", () => {
  for (const n of [7, 14]) {
    same(atr(candles, n), fixture.expected[`atr${n}`], `atr${n}`);
    same(atr(hourly, n), fixture.expected[`atr${n}_hourly`], `atr${n} hourly`);
  }
  for (const n of [5, 14]) {
    const a = adr(hourly, n);
    same(a.adr, fixture.expected[`adr${n}`], `adr${n}`);
    same(a.high, fixture.expected[`adr${n}_high`], `adr${n} high`);
    same(a.low, fixture.expected[`adr${n}_low`], `adr${n} low`);
  }
  assert.ok(fixture.expected.adr14.filter((v) => v !== null).length > 1000, "ADR must be checked on many candles");
});

test("today is never part of its own ADR", () => {
  const a = adr(hourly, 5);
  // Within one day the ADR stays the same, however wide that day becomes.
  for (let i = 1; i < hourly.length; i++) {
    const sameDay = serverDate(hourly.time[i]) === serverDate(hourly.time[i - 1]);
    if (sameDay && Number.isFinite(a.adr[i])) assert.equal(a.adr[i], a.adr[i - 1]);
  }
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

test("settings: defaults, sensible periods only; one saved SMA or EMA (before v2.6) becomes the first of five", () => {
  const s = cleanIndicators({ sma: { on: true, period: "30" }, ema: { on: "yes", period: 1 }, rsi: { period: 9999 }, vwap: null });
  const defaults = structuredClone(DEFAULT_INDICATORS);
  defaults.sma[0] = { ...defaults.sma[0], on: true, period: 30 }; // the old single line, kept
  assert.deepEqual(s, defaults); // EMA "yes" is not on, period 1 and 9999 are refused
  assert.equal(s.sma.length, MA_LINES);
  assert.equal(s.ema.length, MA_LINES);
  assert.deepEqual(s.ema.map((l) => l.period), [9, 21, 50, 100, 200]);
  assert.deepEqual(s.sma.map((l) => l.period), [30, 20, 50, 100, 200]);
  assert.equal(new Set([...s.sma, ...s.ema].map((l) => l.colour)).size, 2 * MA_LINES, "ten different default colours");
  assert.equal(cleanIndicators({ adr: { on: true, levels: false } }).adr.levels, false);
  assert.equal(cleanIndicators({ adr: { on: true, levels: "no" } }).adr.levels, true); // only a real true/false counts
  assert.deepEqual(computeIndicators(candles, cleanIndicators(null)), []);
});

test("several SMAs and EMAs at once: each line its own period and colour, the same values as one alone", () => {
  const settings = cleanIndicators({
    sma: [{ on: true, period: 50 }, null, { on: true, period: 200, colour: "#FF0000" }],
    ema: [{ on: true, period: 9 }, { on: true, period: 21, colour: "red" }, { on: false, period: 50 }, { on: true, period: 9 }],
  });
  assert.equal(settings.sma[2].colour, "#ff0000"); // a colour is a #rrggbb value...
  assert.equal(settings.ema[1].colour, DEFAULT_INDICATORS.ema[1].colour); // ...anything else keeps the default
  const lines = computeIndicators(candles, settings);
  assert.deepEqual(lines.map((l) => [l.id, l.label]), [
    ["sma", "SMA 50"], ["sma3", "SMA 200"], ["ema", "EMA 9"], ["ema2", "EMA 21"], ["ema4", "EMA 9"],
  ]);
  assert.deepEqual(lines.map((l) => l.colour), [settings.sma[0].colour, "#ff0000", settings.ema[0].colour, settings.ema[1].colour, settings.ema[3].colour]);
  const closes = candles.close.subarray(0, candles.length);
  const alike = (a, b, label) => {
    assert.equal(a.length, b.length, label);
    for (let i = 0; i < b.length; i++) assert.ok((Number.isNaN(a[i]) && Number.isNaN(b[i])) || Math.abs(a[i] - b[i]) < 1e-9, `${label}[${i}]`);
  };
  alike(lines[1].values, sma(closes, 200), "SMA 200 in line 3");
  alike(lines[3].values, ema(closes, 21), "EMA 21 in line 2");
  alike(lines[4].values, lines[2].values, "two EMA 9 lines agree");
});

test("the step-by-step engine always equals the full calculation, through a random replay", () => {
  const settings = cleanIndicators({
    sma: [{ on: true, period: 20 }, { on: true, period: 5 }, null, null, { on: true, period: 50 }],
    ema: [{ on: true, period: 9 }, { on: true, period: 21 }], vwap: { on: true }, rsi: { on: true, period: 14 },
    atr: { on: true, period: 14 }, adr: { on: true, period: 2, levels: true }, bb: { on: true, period: 20, mult: 2 },
  });
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
