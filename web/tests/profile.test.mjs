// Run with:  node --test web/tests/*.test.mjs
// Volume profile (order flow, Phase 2): the browser's profile gives Python's answers on every golden case
// (fixtures/profile_golden.json, from forex_replay.profile_golden), and never reads a bar not yet closed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildProfile, priceBin, profileFromBars, smoothed } from "../js/profile.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/profile_golden.json", import.meta.url), "utf-8"));

function sameNumbers(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= 1e-9 * Math.max(1, Math.abs(expected[i])), `${label}[${i}]: ${actual[i]} vs ${expected[i]}`);
}

test("every golden profile: the same bins, POC, value area, HVNs and LVN zones as Python", () => {
  let checked = 0;
  for (const [n, c] of golden.cases.entries()) {
    const s = c.settings;
    const p = buildProfile(c.lows, c.highs, c.volumes, c.bin_size, { valueArea: s.value_area, smoothing: s.smoothing, lvn: s.lvn });
    const e = c.expected;
    if (e === null) { assert.equal(p, null, `case ${n}`); continue; }
    for (const key of ["first_bin", "bin_size", "poc", "poc_low", "poc_high", "val", "vah"]) assert.equal(p[key], e[key], `case ${n}: ${key}`);
    assert.deepEqual(p.va_bins, e.va_bins, `case ${n}: value area bins`);
    assert.deepEqual(p.hvns, e.hvns, `case ${n}: HVNs`);
    assert.deepEqual(p.lvns, e.lvns, `case ${n}: LVN zones`);
    sameNumbers(p.volumes, e.volumes, `case ${n} volumes`);
    sameNumbers(p.smoothed, e.smoothed, `case ${n} smoothed`);
    sameNumbers([p.total, p.va_volume], [e.total, e.va_volume], `case ${n} totals`);
    checked++;
  }
  assert.ok(checked >= 40, `only ${checked} profiles checked`);
  assert.ok(golden.cases.some((c) => c.expected && c.expected.lvns.length > 0), "some golden cases have LVN zones");
});

test("by hand: value area 70% from bins 5, 10, 40, 20, 15, 10, and an LVN valley between two peaks", () => {
  const bins = (v) => [v.map((_, i) => i), v.map((_, i) => i), v];
  const p = buildProfile(...bins([5, 10, 40, 20, 15, 10]), 1);
  assert.deepEqual([p.poc, p.val, p.vah, p.va_volume], [2, 2, 5, 75]);
  const q = buildProfile(...bins([10, 50, 90, 50, 8, 4, 8, 60, 100, 60, 10]), 1, { smoothing: 1 });
  assert.deepEqual(q.hvns, [2, 8]);
  assert.deepEqual(q.lvns, [{ low: 4, high: 7, bins: [4, 6] }]);
  assert.deepEqual(smoothed([3, 6, 9, 12], 3), [4.5, 6, 9, 10.5]);
  assert.deepEqual(buildProfile(...bins([20, 60, 20]), 1).va_bins, [1, 2], "a tie between the two neighbours adds the upper bin");
  assert.equal(buildProfile(...bins([10, 30, 5, 30, 10]), 1).poc, 1, "a POC tie: nearest the middle, then the lower");
});

test("no look-ahead: a bar counts only once it has closed at the replay cursor", () => {
  const bars = { length: 4, time: [0, 60, 120, 180], low: [10, 11, 50, 60], high: [10, 11, 50, 60], tick_count: [5, 5, 99, 99] };
  assert.deepEqual(profileFromBars(bars, 60, 0, 240, 1, 150).volumes, [5, 5], "the 120 bar is still forming at 150 s");
  assert.equal(profileFromBars(bars, 60, 0, 240, 1, 180).volumes.at(-1), 99, "closed at 180 s");
  assert.equal(profileFromBars(bars, 60, 0, 240, 1, 59), null);
  // Future bars never change a profile: cutting the data at the cursor gives the same answer.
  const cut = { length: 2, time: [0, 60], low: [10, 11], high: [10, 11], tick_count: [5, 5] };
  assert.deepEqual(profileFromBars(cut, 60, 0, 240, 1), profileFromBars(bars, 60, 0, 240, 1, 150));
  assert.equal(priceBin(0.0001, 5), 20);
  assert.equal(priceBin(0.5, 2), 100);
});
