// Run with:  node --test web/tests/*.test.mjs
// Order flow, Phase 4: the market state labels, held to Python's answers (state_golden.json), and no look-ahead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cleanStateSettings, eventLabel, marketState, STATE_SETTINGS, STATE_WORDS } from "../js/marketstate.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/state_golden.json", import.meta.url), "utf-8"));
const g = golden.bars;
const bars = { length: g.time.length, time: g.time, high: g.high, low: g.low, close: g.close };

test("every golden case: the same events and state as Python", () => {
  const seen = new Set();
  for (const [n, c] of golden.cases.entries()) {
    const got = marketState(bars, g.seconds, c.cursor, c.val, c.vah, c.timeframe, c.accept, c.window);
    assert.deepEqual(got, c.expected, `case ${n} at ${c.cursor}`);
    seen.add(got.state);
    for (const e of got.events) seen.add(`${e.kind} ${e.side}`);
  }
  for (const s of ["accepted above", "accepted below", "rejected above", "rejected below", "inside", "no_value"]) {
    assert.ok(seen.has(s), `the cases include ${s}`);
  }
});

test("bars after the cursor make no difference", () => {
  for (const c of golden.cases.filter((_, n) => n % 9 === 0)) {
    const cut = g.time.findIndex((t) => t + g.seconds > c.cursor);
    const n = cut < 0 ? g.time.length : cut;
    const only = { length: n, time: g.time.slice(0, n), high: g.high.slice(0, n), low: g.low.slice(0, n), close: g.close.slice(0, n) };
    assert.deepEqual(marketState(only, g.seconds, c.cursor, c.val, c.vah, c.timeframe, c.accept, c.window), c.expected);
  }
});

test("a full-size array longer than its length is read only up to its length", () => {
  const c = golden.cases.find((x) => x.expected.events.length > 0);
  const n = g.time.findIndex((t) => t + g.seconds > c.cursor);
  const padded = { length: n, time: g.time, high: g.high.map(() => 1e9), low: g.low.map(() => -1e9), close: g.close };
  for (let i = 0; i < n; i++) { padded.high[i] = g.high[i]; padded.low[i] = g.low[i]; }
  assert.deepEqual(marketState(padded, g.seconds, c.cursor, c.val, c.vah, c.timeframe, c.accept, c.window), c.expected);
});

test("settings: the brief's defaults, nonsense refused; the words and the chart labels", () => {
  assert.deepEqual(cleanStateSettings(null), STATE_SETTINGS);
  assert.deepEqual(cleanStateSettings({ on: true, labels: false, timeframe: 900, accept: 3, window: 2700 }),
    { on: true, labels: false, timeframe: 900, accept: 3, window: 2700 });
  const bad = cleanStateSettings({ timeframe: 1200, accept: 0, window: 30 });
  assert.deepEqual([bad.timeframe, bad.accept, bad.window], [1800, 2, 3600]);
  assert.equal(STATE_WORDS.accepted_above, "Accepted above");
  assert.equal(eventLabel({ kind: "rejected", side: "below" }), "Rej ↓");
  assert.throws(() => marketState(bars, 60, g.time[100], 1, 2, 1200));
});
