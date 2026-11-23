// Run with:  node --test web/tests/*.test.mjs
// Order flow, Phase 6: the trigger panel's rules, held to Python's answers (trigger_golden.json), and no look-ahead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import { atr } from "../js/indicators.js";
import { aggregate } from "../js/timeframes.js";
import { atrBefore, bubbleRule, candleRules, cleanTriggerSettings, currentM5, m5Candles, trigger, TRIGGER_SETTINGS } from "../js/trigger.js";

const g = JSON.parse(readFileSync(new URL("./fixtures/trigger_golden.json", import.meta.url), "utf-8"));
const minutes = { ...g.minutes, length: g.minutes.time.length };
const m5 = m5Candles(minutes);
const atrValues = atr(m5, 14);

test("the current 5-minute candle, its ATR and the four rules match Python", () => {
  for (const [n, c] of g.candles.entries()) {
    const candle = currentM5(minutes, c.cursor);
    const a = candle ? atrBefore(m5, atrValues, candle.start) : null;
    const s = { body: 0.5, range_atr: 1.2, close_zone: 0.25, min_rvol: 1.5, ...c.settings };
    const rules = candle ? candleRules(candle.open, candle.high, candle.low, candle.close, a, c.rvol, c.side, s.body, s.range_atr, s.close_zone, s.min_rvol) : null;
    assert.deepEqual({ candle, atr: a, rules }, c.expected, `case ${n} at ${c.cursor}`);
  }
});

test("the bubble rule and the overall light match Python", () => {
  for (const c of g.bubbles) assert.deepEqual(bubbleRule(c.items, c.zones, c.low, c.high, c.side, c.bubble_rvol), c.expected);
  for (const c of g.overall) assert.equal(trigger(c.rules, c.enabled), c.expected);
});

test("the chart's own 5-minute candles are the same candles", () => {
  const base = new Candles(minutes.length);
  for (const f of ["time", "open", "high", "low", "close"]) base[f].set(minutes[f]);
  const built = aggregate(base, "M5").candles;
  assert.equal(built.length, m5.length);
  for (const f of ["time", "open", "high", "low", "close"]) assert.deepEqual(Array.from(built[f].subarray(0, built.length)), m5[f], f);
});

test("no look-ahead: minutes after the cursor make no difference, and the candle is closed only at its close", () => {
  for (const c of g.candles.filter((_, n) => n % 7 === 0)) {
    const keep = minutes.time.filter((t) => t + 60 <= c.cursor).length;
    const cut = { length: keep };
    for (const f of ["time", "open", "high", "low", "close"]) cut[f] = minutes[f].slice(0, keep);
    assert.deepEqual(currentM5(cut, c.cursor), currentM5(minutes, c.cursor));
  }
  const t0 = minutes.time[0];
  assert.equal(currentM5(minutes, t0 + 299).closed, false);
  assert.equal(currentM5(minutes, t0 + 300).closed, true);
  assert.equal(currentM5(minutes, t0 + 59), null, "nothing has closed yet");
});

test("by hand: a strong bull candle passes long and fails short", () => {
  const r = candleRules(100, 200, 95, 195, 80, 2, "long");
  assert.deepEqual([r.body.pass, r.range.pass, r.close.pass, r.rvol.pass], [true, true, true, true]); // body 95 of 105; range 1.31x ATR
  const edge = candleRules(100, 196, 100, 172, 80, 1.5, "long"); // exactly on every line: "at least" passes
  assert.deepEqual([edge.body.pass, edge.range.pass, edge.close.pass, edge.rvol.pass], [true, true, true, true]);
  const s = candleRules(100, 200, 95, 195, 80, 2, "short");
  assert.equal(s.close.pass, false);
  assert.equal(trigger({ ...r, bubble: { pass: false } }, TRIGGER_SETTINGS.on), true, "the bubble rule is off by default");
  assert.equal(trigger({ ...r, bubble: { pass: false } }, { ...TRIGGER_SETTINGS.on, bubble: true }), false);
  assert.equal(trigger(r, { body: false, range: false, close: false, rvol: false, bubble: false }), false, "nothing on: never green");
  const z = [{ low: 100, high: 120 }];
  const up = { kind: "bubble", side: "up", rvol: 3.5, price: 110, delta: 9 };
  assert.equal(bubbleRule([up], z, 105, 140, "long").pass, true);
  assert.equal(bubbleRule([up, { kind: "absorption", side: null, rvol: 4, price: 115, delta: 6 }], z, 105, 140, "long").pass, false, "buyers absorbed");
  assert.equal(bubbleRule([up, { kind: "absorption", side: null, rvol: 4, price: 115, delta: -6 }], z, 105, 140, "long").pass, true, "sellers absorbed is fine for a long");
  assert.equal(bubbleRule([up], z, 121, 140, "long").zone, null, "the candle never reached the zone");
});

test("settings: defaults, nonsense refused", () => {
  assert.deepEqual(cleanTriggerSettings(null), { ...TRIGGER_SETTINGS, on: { ...TRIGGER_SETTINGS.on } });
  const s = cleanTriggerSettings({ side: "short", body: 0.6, rangeAtr: 0, closeZone: 0.9, atrPeriod: 20, on: { bubble: true, rvol: "yes" } });
  assert.deepEqual([s.side, s.body, s.rangeAtr, s.closeZone, s.atrPeriod, s.on.bubble, s.on.rvol], ["short", 0.6, 1.2, 0.25, 20, true, true]);
});
