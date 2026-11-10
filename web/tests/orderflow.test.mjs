// Run with:  node --test web/tests/*.test.mjs
// Order flow, Phase 5: RVOL, bubbles, absorption, delta, CVD and divergence, held to Python's answers
// (orderflow_golden.json); the step-by-step series against a full recompute; no look-ahead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { bubbles, candleFlow, classifyBucket, cleanFlowLayer, dayResets, divergences, fallbackDelta, FLOW_LAYER, FlowSeries, rvol } from "../js/orderflow.js";
import { serverDate } from "../js/timeframes.js";

const g = JSON.parse(readFileSync(new URL("./fixtures/orderflow_golden.json", import.meta.url), "utf-8"));
const withLength = (o) => ({ ...o, length: o.time.length });
const bars = withLength(g.bars), fallback = withLength(g.fallback), buckets = withLength(g.buckets);
const startsFor = (seconds) => {
  const all = [];
  for (let t = g.start; t < g.end; t += seconds) all.push(t);
  return all.filter((_, k) => k % 17 !== 5);
};

test("candle RVOL, delta and CVD match Python for every timeframe, cursor and reset", () => {
  let fallbackSeen = false, rvolSeen = false;
  for (const [n, c] of g.flow.entries()) {
    const starts = startsFor(c.seconds);
    const got = candleFlow(starts, starts.length, c.seconds, c.cursor, bars, g.resets[c.reset], fallback, g.flow_first);
    assert.deepEqual(got, c.expected, `case ${n}: ${c.seconds}s ${c.reset} at ${c.cursor}`);
    fallbackSeen ||= got.delta.some((d, i) => d !== null && got.ticks[i] === null);
    rvolSeen ||= got.rvol.some((r) => r !== null);
  }
  assert.ok(fallbackSeen && rvolSeen, "the cases cover candles from the fallback and candles with RVOL");
});

test("divergences match Python", () => {
  let total = 0;
  for (const c of g.divergences) {
    const flow = g.flow.find((f) => f.seconds === c.seconds && f.cursor === c.cursor && f.reset === c.reset).expected;
    const n = c.highs.length;
    const got = divergences(startsFor(c.seconds).slice(0, n), c.highs, c.lows, flow.cvd.slice(0, n), g.resets[c.reset], c.lookback);
    assert.deepEqual(got, c.expected);
    total += got.length;
  }
  assert.ok(total > 0);
});

test("bubbles and absorption match Python, in every size", () => {
  const kinds = new Set();
  for (const c of g.bubbles) {
    const s = { min_rvol: 3, medium: 5, large: 8, ...c.settings };
    const got = bubbles(buckets, c.start, c.end, c.cursor, c.bubble_move, c.absorption_move, s.min_rvol, s.medium, s.large);
    assert.deepEqual(got, c.expected);
    for (const b of got) kinds.add(`${b.kind} ${b.side} ${b.size}`);
  }
  assert.equal(kinds.size, 9, "bubbles up and down and absorption, each small, medium and large");
});

test("the step-by-step series gives what a full recompute gives, cursor after cursor, back and forth", () => {
  for (const seconds of [300, 3600]) {
    for (const mode of ["session", "anchor"]) {
      const starts = startsFor(seconds);
      const series = new FlowSeries();
      const cursors = [];
      for (let t = g.flow_first - 3000; t <= g.end; t += 4877) cursors.push(t);
      cursors.push(g.flow_first + 9000, g.flow_first + 600); // and back
      for (const cursor of cursors) {
        const n = starts.filter((s) => s < cursor).length; // the candles a replay would have shown
        const full = { length: n, time: Int32Array.from(starts) };
        const got = series.compute(full, seconds, cursor, bars, g.resets[mode], fallback, g.flow_first, `${seconds}${mode}`);
        const want = candleFlow(starts, n, seconds, cursor, bars, g.resets[mode], fallback, g.flow_first);
        for (const name of ["rvol", "delta", "cvd"]) assert.deepEqual(got[name], want[name], `${name} ${seconds}s ${mode} at ${cursor}`);
      }
    }
  }
});

test("minutes and buckets after the cursor make no difference", () => {
  const cursor = g.flow_first + 7 * 3600 + 420;
  const cut = (o, keep) => { const out = { ...o }; for (const k of Object.keys(o)) if (Array.isArray(o[k])) out[k] = o[k].slice(0, keep); out.length = keep; return out; };
  const onlyBars = cut(bars, bars.time.filter((t) => t + 60 <= cursor).length);
  const starts = startsFor(900);
  assert.deepEqual(candleFlow(starts, starts.length, 900, cursor, onlyBars, g.resets.day, fallback, g.flow_first),
    candleFlow(starts, starts.length, 900, cursor, bars, g.resets.day, fallback, g.flow_first));
  const onlyBuckets = cut(buckets, buckets.time.filter((t) => t + 15 <= cursor).length);
  assert.deepEqual(bubbles(onlyBuckets, g.flow_first, cursor + 3600, cursor, 30, 6), bubbles(buckets, g.flow_first, cursor + 3600, cursor, 30, 6));
});

test("the small rules by hand", () => {
  assert.equal(rvol(30, 20), 3); // 30 ticks against a median of 10
  assert.equal(rvol(30, -1), null);
  assert.equal(rvol(30, 0), null);
  assert.deepEqual(classifyBucket(100, 130, 30, 20, 30, 6), { kind: "bubble", side: "up", size: 1, rvol: 3 });
  assert.equal(classifyBucket(100, 129, 30, 20, 30, 6), null, "a move between the two thresholds is neither");
  assert.deepEqual(classifyBucket(100, 94, 80, 20, 30, 6), { kind: "absorption", side: null, size: 3, rvol: 8 });
  assert.equal(classifyBucket(100, 200, 29, 20, 30, 6), null, "RVOL 2.9: nothing");
  assert.equal(fallbackDelta(100, 10, 20, 0, 15), 25);
  assert.equal(fallbackDelta(100, 10, 10, 10, 10), 0);
  // 3 Nov 2025 (winter): the day starts at 22:00 UTC; 9 Nov 2025 is also winter.
  assert.deepEqual(dayResets(1762207200 - 7200, 1762207200 + 3600, serverDate), [1762207200]);
});

test("settings: the brief's defaults; nonsense refused; sizes kept in order", () => {
  assert.deepEqual(cleanFlowLayer(null), { ...FLOW_LAYER, bubbleMove: {}, absorptionMove: {} });
  const s = cleanFlowLayer({ show: false, reset: "anchor", anchor: 1762207200, minRvol: 2.5, medium: 2, large: 9, lookback: 1, bubbleMove: { XAUUSD: "0.4", bad: 1 } });
  assert.deepEqual([s.show, s.reset, s.anchor, s.minRvol, s.medium, s.large, s.lookback, s.bubbleMove], [false, "anchor", 1762207200, 2.5, 5, 9, 20, { XAUUSD: 0.4 }]);
  assert.equal(cleanFlowLayer({ reset: "week" }).reset, "session");
});

test("the bubble multiple can be any value from 0.5x, to two decimals; sizes stay in order", () => {
  assert.equal(cleanFlowLayer({ minRvol: 2.35 }).minRvol, 2.35);
  assert.equal(cleanFlowLayer({ minRvol: 0.5 }).minRvol, 0.5);
  assert.equal(cleanFlowLayer({ minRvol: 0.4 }).minRvol, FLOW_LAYER.minRvol, "under 0.5x: refused, the default kept");
  assert.equal(cleanFlowLayer({ minRvol: 1.234 }).minRvol, 1.23);
  const s = cleanFlowLayer({ minRvol: 6.5, medium: 5, large: 8 });
  assert.deepEqual([s.minRvol, s.medium, s.large], [6.5, 6.5, 8], "medium never below where bubbles start");
  // A bucket at 2.4x: a bubble from 2.35x, nothing from the default 3x.
  assert.equal(classifyBucket(100, 140, 24, 20, 30, 6, 2.35, 5, 8).kind, "bubble");
  assert.equal(classifyBucket(100, 140, 24, 20, 30, 6), null);
});
