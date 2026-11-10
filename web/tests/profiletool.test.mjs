// Run with:  node --test web/tests/*.test.mjs
// Order flow, Phase 3: profile drawings (fixed range and anchored), their settings, the prior day's levels and
// naked POCs (held to Python's answers), and the rule that nothing past the replay's cursor is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cleanDrawing, createDrawing, layout, logicalToX, TOOLS } from "../js/drawings.js";
import { buildProfile, dayLevels, profileFromBars } from "../js/profile.js";
import { cleanFlowSettings, cleanProfileSettings, DETAIL_PIPS, newProfileSettings, pipsToSlider, PROFILE_SETTINGS, profileLayout, profileWindow, sliderToPips } from "../js/profiletool.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/profile_golden.json", import.meta.url), "utf-8"));

test("the prior day's levels and naked POCs match Python on every golden cursor", () => {
  const bars = golden.levels[0].bars;
  const data = { length: bars.time.length, time: bars.time, low: bars.low, high: bars.high, tick_count: bars.tick_count };
  let touched = 0, untouched = 0;
  for (const [n, c] of golden.levels.entries()) {
    const s = c.settings;
    const got = dayLevels(data, bars.seconds, c.cursor, c.bin_size, c.days_back, { valueArea: s.value_area, smoothing: s.smoothing, lvn: s.lvn }, new Map());
    assert.deepEqual(got, c.expected, `case ${n} at ${c.cursor}`);
    for (const k of got.naked) k.to === null ? untouched++ : touched++;
  }
  assert.ok(touched > 0 && untouched > 0, "the cases cover touched and untouched naked POCs");
});

test("day levels never use a bar that has not closed, and a cache of finished days changes nothing", () => {
  const bars = golden.levels[0].bars;
  const data = { length: bars.time.length, time: bars.time, low: bars.low, high: bars.high, tick_count: bars.tick_count };
  const cursor = golden.levels[4].cursor; // a prior day and touched and untouched naked POCs
  const cut = data.time.findIndex((t) => t + bars.seconds > cursor);
  const only = { length: cut, time: data.time.slice(0, cut), low: data.low.slice(0, cut), high: data.high.slice(0, cut), tick_count: data.tick_count.slice(0, cut) };
  const cache = new Map();
  const a = dayLevels(data, 300, cursor, 20, 5, {}, cache);
  assert.ok(a.prior && a.naked.length === 3, "a case with something in it");
  assert.deepEqual(dayLevels(data, 300, cursor, 20, 5, {}), a, "no cache at all: the same");
  assert.deepEqual(dayLevels(only, 300, cursor, 20, 5, {}), a, "the bars after the cursor make no difference");
  assert.deepEqual(dayLevels(data, 300, cursor, 20, 5, {}, cache), a, "cached days give the same answer");
});

test("profile settings: the brief's defaults, nonsense refused, a bin per pair", () => {
  assert.deepEqual(cleanProfileSettings(null), PROFILE_SETTINGS);
  const s = cleanProfileSettings({ source: "S15", bin: "0.5", valueArea: 0.8, lvn: 0.3, smoothing: 5, width: 0.5, side: "right", extend: true, colour: "#FF0000" });
  assert.deepEqual([s.source, s.bin, s.valueArea, s.lvn, s.smoothing, s.width, s.side, s.extend, s.colour], ["S15", 0.5, 0.8, 0.3, 5, 0.5, "right", true, "#ff0000"]);
  const bad = cleanProfileSettings({ source: "H1", bin: -1, valueArea: 2, smoothing: 4, side: "up", colour: "red" });
  assert.deepEqual([bad.source, bad.bin, bad.valueArea, bad.smoothing, bad.side, bad.colour], ["M1", null, 0.7, 3, "left", "#2962ff"]);
  const flow = cleanFlowSettings({ bins: { XAUUSD: 0.25, bad: 1 }, naked: true, nakedDays: 50 });
  assert.deepEqual([flow.bins, flow.priorDay, flow.naked, flow.nakedDays], [{ XAUUSD: 0.25 }, false, true, 5]);
  // Drawn profiles start finer than the levels: 0.2 pip on EURUSD, $0.10 on gold, a fifth of the bin elsewhere.
  assert.equal(newProfileSettings(flow, "EURUSD", 0.0001).bin, 0.00002);
  assert.equal(newProfileSettings(flow, "XAUUSD", 0.5).bin, 0.1, "the levels' bin (0.25 here) is not the drawn profiles'");
  assert.equal(newProfileSettings(flow, "GBPUSD", 0.0001).bin, 0.00002);
  const mine = cleanFlowSettings({ drawBins: { EURUSD: 0.00005 }, bins: { EURUSD: 0.0001 } });
  assert.deepEqual([mine.drawBins, mine.bins], [{ EURUSD: 0.00005 }, { EURUSD: 0.0001 }]);
  assert.equal(newProfileSettings(mine, "EURUSD", 0.0001).bin, 0.00005, "your own choice for drawn profiles wins");
});

test("profile drawings are created, saved and reloaded with their settings", () => {
  assert.equal(TOOLS.vprofile.clicks, 2);
  assert.equal(TOOLS.aprofile.clicks, 1);
  const at = { time: 1762207200, price: 110000 };
  const v = createDrawing("vprofile", at, { pipPoints: 10, profile: { ...PROFILE_SETTINGS, bin: 0.0001 } });
  v.points[1] = { time: at.time + 3600, price: 110050 };
  const back = cleanDrawing(JSON.parse(JSON.stringify(v)));
  assert.deepEqual(back.points, v.points);
  assert.equal(back.profile.bin, 0.0001);
  const a = cleanDrawing(createDrawing("aprofile", at, { pipPoints: 10, profile: { ...PROFILE_SETTINGS, source: "S15" } }));
  assert.deepEqual([a.points.length, a.profile.source], [1, "S15"]);
  assert.equal(cleanDrawing({ type: "aprofile", points: [at, at] }), null, "an anchored profile has one point");
  assert.equal(cleanDrawing({ type: "vprofile", points: [at, at], profile: { valueArea: 5 } }).profile.valueArea, 0.7);
});

test("the window: a fixed range runs from its first candle through its last; an anchored one to now", () => {
  const d = { type: "vprofile", points: [{ time: 7200, price: 1 }, { time: 3600, price: 1 }] };
  assert.deepEqual(profileWindow(d, 900, 99999), { start: 3600, end: 8100 }, "points in either order; the end candle is in");
  assert.deepEqual(profileWindow({ type: "aprofile", points: [{ time: 600, price: 1 }] }, 900, 5000), { start: 600, end: 5000 });
});

test("no look-ahead: a profile stops at the cursor, and an anchored one grows as the cursor moves", () => {
  // One-minute bars from 0: prices 100 + i, 10 ticks each. At cursor 300 s only five bars have closed.
  const n = 20;
  const bars = { length: n, time: Array.from({ length: n }, (_, i) => i * 60), low: Array.from({ length: n }, (_, i) => 100 + i),
    high: Array.from({ length: n }, (_, i) => 100 + i), tick_count: Array(n).fill(10) };
  const at300 = profileFromBars(bars, 60, 0, 1200, 1, 300);
  assert.equal(at300.volumes.length, 5);
  assert.equal(profileFromBars(bars, 60, 0, 1200, 1, 600).volumes.length, 10, "later: it has grown");
  assert.deepEqual(profileFromBars(bars, 60, 0, 1200, 1, 300), buildProfile([100, 101, 102, 103, 104], [100, 101, 102, 103, 104], [10, 10, 10, 10, 10], 1));
  assert.equal(profileFromBars(bars, 60, 0, 1200, 1, 30), null, "nothing closed yet");
  assert.equal(profileFromBars(bars, 60, 600, 1200, 1).volumes.length, 10, "found by halving: the same bars as a full scan");
});

test("the drawing: a bar per bin, the POC in its own colour, POC/VAH/VAL lines, LVN zones shaded, handles on the points", () => {
  const proj = { x: (t) => t / 10, y: (p) => 1000 - p, width: 800, height: 600, formatPrice: (p) => String(p), formatTime: String, pips: (p) => p };
  const volumes = [10, 50, 90, 50, 8, 4, 8, 60, 100, 60, 10];
  const profile = buildProfile(volumes.map((_, i) => 2 * i), volumes.map((_, i) => 2 * i), volumes, 2, { smoothing: 1 });
  const d = { type: "vprofile", points: [{ time: 1000, price: 5 }, { time: 3000, price: 9 }], profile: { ...PROFILE_SETTINGS } };
  const shape = profileLayout(d, proj, { start: 1000, end: 4000, profile });
  const bins = shape.boxes.filter((b) => b.role === "bin");
  assert.equal(bins.length, volumes.length);
  assert.ok(bins.every((b) => b.x === 100), "on the left side, from the range's start");
  const widest = Math.max(...bins.map((b) => b.w));
  assert.ok(Math.abs(widest - 300 * 0.35) < 1e-9, "the biggest bin is 35% of the range wide");
  assert.equal(shape.boxes.filter((b) => b.role === "lvn").length, 1);
  assert.deepEqual(shape.lines.map((l) => l.role), ["poc", "vah", "val"]);
  assert.ok(shape.lines.every((l) => l.x1 === 100 && l.x2 === 400), "lines stop at the range's end (the cursor)");
  const extended = profileLayout({ ...d, profile: { ...d.profile, extend: true } }, proj, { start: 1000, end: 4000, profile });
  assert.ok(extended.lines.every((l) => l.x2 === 800), "extended to the right edge");
  assert.deepEqual(shape.handles.map((h) => h.key), ["p0", "p1"]);
  const right = profileLayout({ ...d, profile: { ...d.profile, side: "right" } }, proj, { start: 1000, end: 4000, profile });
  assert.ok(right.boxes.filter((b) => b.role === "bin").every((b) => Math.abs(b.x + b.w - 400) < 1e-9), "or on the right side");
  const waiting = layout(d, { ...proj, profile: () => ({ message: "Profile: loading" }) });
  assert.equal(waiting.labels[0].text, "Profile: loading");
});

test("a time part-way into a candle past the last one is drawn between the candles, not at the left edge", () => {
  // Like the chart library: whole positions have a pixel (10 px a candle), fractions answer null.
  const scale = { logicalToCoordinate: (l) => (Number.isInteger(l) ? 5 + 10 * l : null) };
  assert.equal(logicalToX(scale, 2999), 29995);
  assert.equal(logicalToX(scale, 2999.25), 29997.5);
  assert.equal(logicalToX({ logicalToCoordinate: () => null }, 3.5), null);
});


test("the Detail slider: 0.05 to 20 pips on a log scale, there and back; fine bars drawn without a gap", () => {
  for (const pips of [0.05, 0.2, 1, 2.5, 20]) assert.equal(sliderToPips(pipsToSlider(pips)), pips);
  assert.equal(sliderToPips(pipsToSlider(100)), DETAIL_PIPS[1], "clamped to the range");
  assert.ok(pipsToSlider(0.2) - pipsToSlider(0.1) > 0.29 && pipsToSlider(20) - pipsToSlider(10) > 0.29, "doubling is the same step anywhere");
  const proj = { x: (t) => t / 10, y: (p) => 1000 - p, width: 800, height: 600, formatPrice: String, formatTime: String, pips: (p) => p };
  const thin = buildProfile([0, 1, 2], [0, 1, 2], [5, 9, 5], 2); // bins 1 unit = half a pixel here: thinner than 4 px
  const d = { type: "vprofile", points: [{ time: 1000, price: 1 }, { time: 3000, price: 2 }], profile: { ...PROFILE_SETTINGS } };
  const bins = profileLayout(d, proj, { start: 1000, end: 4000, profile: thin }).boxes.filter((b) => b.role === "bin");
  assert.ok(bins.every((b, i) => i === 0 || Math.abs(bins[i - 1].y - (b.y + b.h)) < 1e-9), "each bar touches the next: no gap");
});
