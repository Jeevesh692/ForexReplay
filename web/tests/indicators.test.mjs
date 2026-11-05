// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import { adr, atr, bollinger, cleanIndicators, computeIndicators, DEFAULT_INDICATORS, ema, IndicatorEngine, latestOpeningRange, MA_LINES, rsi, sma, vwap } from "../js/indicators.js";
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
    or: { on: true, start: "09:30", minutes: 30, levels: true },
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

// ----- opening range ------------------------------------------------------------------------------------
// One-minute candles from `fromUtc` (unix seconds) for `count` minutes. Candle k's high is 1000 + k and its
// low 1000 - k, except where `shape` says otherwise, so a range's high and low are easy to work out by hand.
function minutes(fromUtc, count, shape = (k) => [1000 + k, 1000 - k]) {
  const rows = [];
  for (let k = 0; k < count; k++) {
    const [hi, lo] = shape(k);
    rows.push([fromUtc + 60 * k, (hi + lo) >> 1, hi, lo, (hi + lo) >> 1, 1, 0]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}
const utc = (text) => Date.parse(text) / 1000;
const orOn = (more = {}) => cleanIndicators({ or: { on: true, ...more } });
const orLine = (lines, id) => lines.find((l) => l.id === id).values;

test("opening range by hand: 09:30-10:00 New York in US summer (13:30 UTC) and winter (14:30 UTC)", () => {
  for (const [day, openUtc] of [["2025-08-05", "13:30"], ["2025-11-05", "14:30"]]) {
    const start = utc(`${day}T12:00:00Z`);
    const m1 = minutes(start, 240); // 12:00-15:59 UTC
    const first = (utc(`${day}T${openUtc}:00Z`) - start) / 60; // minute index of 09:30 New York
    const r = latestOpeningRange(m1, orOn().or);
    assert.deepEqual(r, { from: first, hi: 1000 + first + 29, lo: 1000 - (first + 29) }, day);
    const lines = computeIndicators(m1, orOn());
    assert.deepEqual(lines.map((l) => l.id), ["orMid", "orHigh", "orLow"]);
    const mid = orLine(lines, "orMid"), high = orLine(lines, "orHigh");
    assert.ok(Number.isNaN(mid[first - 1]), `${day}: nothing before the range`);
    for (const i of [first, first + 29, first + 30, 239]) {
      assert.equal(high[i], 1000 + first + 29, `${day}: high at ${i}`);
      assert.equal(mid[i], 1000, `${day}: mid at ${i}`); // (1000 + x + 1000 - x) / 2
    }
  }
});

test("opening range on M5 and M15 is the same range; H1 has no candle inside 09:30-10:00, so nothing is drawn", () => {
  const start = utc("2025-08-05T12:00:00Z");
  const m1 = minutes(start, 240);
  const want = latestOpeningRange(m1, orOn().or);
  for (const tf of ["M5", "M15"]) {
    const view = new TimeframeView(m1, tf);
    const r = latestOpeningRange(view.full, orOn().or);
    assert.deepEqual([r.hi, r.lo], [want.hi, want.lo], tf);
  }
  assert.equal(latestOpeningRange(new TimeframeView(m1, "H1").full, orOn().or), null);
  const h1 = computeIndicators(new TimeframeView(m1, "H1").full, orOn());
  assert.ok(h1.every((l) => l.values.every(Number.isNaN)), "H1: blank lines");
});

test("only the latest day's range is drawn: the next day's range clears the old one", () => {
  const start = utc("2025-08-05T12:00:00Z"); // Tue 5 Aug, then Wed 6 Aug
  const m1 = minutes(start, 26 * 60, (k) => (k < 24 * 60 ? [2000 + (k % 50), 1900] : [3000, 2900 - (k % 7)]));
  const lines = computeIndicators(m1, orOn());
  const day2 = (utc("2025-08-06T13:30:00Z") - start) / 60;
  const mid = orLine(lines, "orMid");
  assert.ok(Number.isNaN(mid[(utc("2025-08-05T14:00:00Z") - start) / 60]), "yesterday's range is gone");
  assert.ok(Number.isNaN(mid[day2 - 1]));
  assert.equal(orLine(lines, "orHigh")[day2], 3000);
  assert.equal(orLine(lines, "orLow")[m1.length - 1], 2894); // the lowest of 2900 - (k % 7) over 30 minutes
  // Before Wednesday's 09:30, Tuesday's range is still the latest one, and stays drawn.
  const view = new TimeframeView(m1, "M1");
  view.setPosition(day2);
  const r = latestOpeningRange(view.display, orOn().or);
  assert.equal(r.from, (utc("2025-08-05T13:30:00Z") - start) / 60);
});

test("a weekend: Monday before 09:30 still shows Friday's range", () => {
  const fri = utc("2025-08-08T13:00:00Z");
  const rows = [...minutes(fri, 120).time].map((t, k) => [t, 1000, 1100 + k, 900, 1000, 1, 0]);
  const mon = utc("2025-08-11T08:00:00Z");
  for (let k = 0; k < 60; k++) rows.push([mon + 60 * k, 1000, 1050, 950, 1000, 1, 0]);
  const m1 = Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
  const r = latestOpeningRange(m1, orOn().or);
  assert.equal(m1.time[r.from], utc("2025-08-08T13:30:00Z"));
  assert.equal(r.hi, 1100 + 59); // Friday's 09:59 candle
});

test("opening range during a replay: while it forms, the high and low so far; then fixed", () => {
  const start = utc("2025-08-05T12:00:00Z");
  const m1 = minutes(start, 240);
  const first = 90; // 13:30 UTC
  const view = new TimeframeView(m1, "M5");
  view.setPosition(first + 10); // 09:40 New York: ten minutes of the range revealed
  let r = latestOpeningRange(view.display, orOn().or);
  assert.equal(r.hi, 1000 + first + 9, "only revealed minutes count");
  view.setPosition(first + 30); // the jump to 10:00 reveals every candle that opened before it
  r = latestOpeningRange(view.display, orOn().or);
  assert.equal(r.hi, 1000 + first + 29);
  view.setPosition(first + 90);
  assert.equal(latestOpeningRange(view.display, orOn().or).hi, 1000 + first + 29, "later candles do not move it");
});

test("opening range settings: start time and minutes, nonsense refused; the step-by-step engine flags a redraw on a new day", () => {
  assert.deepEqual(cleanIndicators(null).or, { on: false, start: "09:30", minutes: 30, levels: true, breakout: true, buffers: {} });
  assert.deepEqual(cleanIndicators({ or: { on: true, start: "03:00", minutes: "60", levels: false } }).or, { on: true, start: "03:00", minutes: 60, levels: false, breakout: true, buffers: {} });
  for (const bad of [{ start: "9:30" }, { start: "24:00" }, { minutes: 0 }, { minutes: 721 }, { minutes: 2.5 }, { minutes: "" }]) {
    const s = cleanIndicators({ or: { on: true, ...bad } }).or;
    assert.deepEqual([s.start, s.minutes], ["09:30", 30], JSON.stringify(bad));
  }
  assert.deepEqual(computeIndicators(minutes(utc("2025-08-05T12:00:00Z"), 240), orOn({ levels: false })).map((l) => l.id), ["orMid"]);
  // The engine: a step inside the same day only extends the lines; a step into a new day's range redraws them.
  const start = utc("2025-08-05T12:00:00Z");
  const m1 = minutes(start, 26 * 60);
  const view = new TimeframeView(m1, "M5");
  const engine = new IndicatorEngine();
  const settings = orOn();
  view.setPosition(200);
  engine.compute(view.display, settings);
  let change = view.setPosition(201);
  assert.equal(engine.compute(view.display, settings, change.from)[0].redraw, false, "same range: no redraw");
  const day2 = (utc("2025-08-06T13:30:00Z") - start) / 60;
  view.setPosition(day2);
  engine.compute(view.display, settings, 0);
  change = view.setPosition(day2 + 1); // Wednesday's first range minute
  const lines = engine.compute(view.display, settings, change.from);
  assert.equal(lines[0].redraw, true, "a new range: redraw");
  const full = computeIndicators(view.display, settings);
  for (let k = 0; k < full.length; k++) {
    for (let i = 0; i < full[k].values.length; i++) {
      const a = lines[k].values[i], b = full[k].values[i];
      assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b, `${full[k].id}[${i}]: ${a} vs ${b}`);
    }
  }
});
