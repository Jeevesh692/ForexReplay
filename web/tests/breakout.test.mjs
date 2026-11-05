// Run with:  node --test web/tests/*.test.mjs
// The NY ORB breakout candle (breakout.js, decision 0032): the first M5 close beyond the opening range +/- b in
// 10:00-10:55 New York, judged for displacement, on closed M5 candles only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BreakoutFinder, bufferPoints, defaultBufferPoints, describeBreakout, judgeBreakout } from "../js/breakout.js";
import { Candles, loadSymbol } from "../js/data.js";
import { cleanIndicators } from "../js/indicators.js";
import { indexAtOrBefore, TimeframeView } from "../js/timeframes.js";

const utc = (text) => Date.parse(text) / 1000;
const OR = cleanIndicators({ or: { on: true } }).or; // 09:30 for 30 minutes
const B = 10; // the buffer in points for these made-up candles

/**
 * One-minute candles from 09:00 to 11:30 New York on a day whose 09:30 New York is `open930` (UTC seconds).
 * `m5` maps "HH:MM" New York (an M5 candle's open) to [open, high, low, close]; every other M5 candle is flat at
 * 1050. The opening range is high 1100 (09:30) and low 1000 (09:55): ORW 100, so "needs" is 50.
 */
function day(open930, m5 = {}) {
  const shapes = { "09:30": [1050, 1100, 1050, 1050], "09:55": [1050, 1050, 1000, 1050], ...m5 };
  const rows = [];
  for (let k = -6; k < 24; k++) { // 09:00 to 11:25, M5 by M5
    const t = open930 + k * 300;
    const minutes = (9 * 60 + 30 + k * 5);
    const name = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const [o, h, l, c] = shapes[name] || [1050, 1050, 1050, 1050];
    // five minutes that build exactly that M5 candle: open, then the high, then the low, then the close
    rows.push([t, o, Math.max(o, c), Math.min(o, c), o, 1, 0], [t + 60, o, h, Math.min(o, c), o, 1, 0],
      [t + 120, o, Math.max(o, c), l, o, 1, 0], [t + 180, o, Math.max(o, c), Math.min(o, c), c, 1, 0],
      [t + 240, c, Math.max(o, c), Math.min(o, c), c, 1, 0]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer, 2);
}
const SUMMER = utc("2025-08-05T13:30:00Z"); // 09:30 New York in US summer time
const WINTER = utc("2025-11-05T14:30:00Z"); // and in winter
const at = (base, t) => { let i = 0; while (i < base.length && base.time[i] < t) i++; return i; }; // base candles before t
const judged = (base, position = base.length) => new BreakoutFinder(base).at(position, OR, B);

test("a close above ORH but not above ORH + b is not a breakout; the first close beyond it is, and passes both tests", () => {
  const base = day(SUMMER, {
    "10:00": [1090, 1115, 1085, 1105], // above ORH 1100 but not above 1110: not counted
    "10:05": [1080, 1160, 1075, 1150], // closes 1150 > 1110; body 70 of 85 (82%); size 85 >= 50
  });
  const b = judged(base);
  assert.equal(b.state, "breakout");
  assert.equal(b.time, SUMMER + 7 * 300); // 10:05 New York
  assert.deepEqual([b.up, b.bodyPct, b.size, b.need, b.displacement, b.failed], [true, 82, 85, 50, true, []]);
  assert.equal(describeBreakout(b, 2).text, "Displacement – enter next open");
  assert.equal(describeBreakout(b, 2).legend, "body 82% · size 0.85 / needs 0.50");
});

test("if the first close outside fails, a later candle that would pass changes nothing: no trade", () => {
  const base = day(SUMMER, {
    "10:05": [1090, 1200, 1080, 1115], // closes 1115 > 1110 first; body 25 of 120 = 21%: fails the body test
    "10:10": [1110, 1200, 1105, 1195], // a fine displacement candle, but later: never checked
  });
  const b = judged(base);
  assert.deepEqual([b.time, b.displacement, b.failed], [SUMMER + 7 * 300, false, ["body"]]);
  assert.equal(describeBreakout(b, 2).text, "Not displacement – no trade (body under 60%)");
});

test("the size test: the range must be at least half of ORW; a downward close works the same way", () => {
  const small = judged(day(SUMMER, { "10:00": [1105, 1125, 1100, 1120] })); // body 15 of 25 = 60% (passes), size 25 < 50
  assert.deepEqual([small.bodyPct, small.displacement, small.failed], [60, false, ["size"]]);
  assert.match(describeBreakout(small, 2).text, /no trade \(size under ½ ORW\)/);
  const down = judged(day(SUMMER, { "10:30": [1010, 1012, 930, 935] })); // closes 935 < ORL 1000 - 10
  assert.deepEqual([down.up, down.time, down.displacement], [false, SUMMER + 12 * 300, true]);
  const both = judged(day(SUMMER, { "10:00": [1080, 1121, 1076, 1115] })); // 35 of 45: 77%, but 45 < 50
  assert.deepEqual(both.failed, ["size"]);
  const neither = judged(day(SUMMER, { "10:00": [1105, 1130, 1100, 1111] })); // 6 of 30, 30 < 50
  assert.deepEqual(neither.failed, ["body", "size"]);
});

test("no close outside the range +/- b in the window: \"No breakout\", at 10:55 and only once it has closed", () => {
  const base = day(SUMMER, { "10:20": [1050, 1150, 1040, 1108], "11:00": [1050, 1300, 1050, 1290] }); // 11:00 is after the window
  const end = SUMMER + 30 * 60 + 60 * 60; // 11:00 New York: the 10:55 candle has closed
  const b = judged(base, at(base, end));
  assert.deepEqual([b.state, b.time], ["none", SUMMER + 17 * 300]); // the 10:55 candle
  assert.equal(describeBreakout(b, 2).text, "No breakout");
  assert.equal(judged(base, at(base, end) - 1), null, "the 10:55 candle still forming: nothing yet");
  assert.deepEqual(judged(base).state, "none", "the 11:00 candle never counts");
});

test("summer and winter: 09:30 New York is 13:30 UTC in August and 14:30 UTC in November", () => {
  for (const open930 of [SUMMER, WINTER]) {
    const b = judged(day(open930, { "10:05": [1080, 1160, 1075, 1150] }));
    assert.equal(b.time, open930 + 7 * 300, new Date(open930 * 1000).toISOString());
    assert.equal(b.displacement, true);
  }
});

test("during a replay the marker is absent while the breakout candle forms, and appears the moment it closes", () => {
  const base = day(SUMMER, { "10:05": [1080, 1160, 1075, 1150] });
  const finder = new BreakoutFinder(base);
  const opens = at(base, SUMMER + 7 * 300); // base candles before 10:05
  for (let p = opens; p < opens + 5; p++) assert.equal(finder.at(p, OR, B), null, `forming, ${p - opens} minutes in`);
  assert.equal(finder.at(opens + 5, OR, B).state, "breakout", "closed: shown");
  assert.equal(finder.at(at(base, SUMMER + 25 * 60), OR, B), null, "before the range has closed, nothing at all");
});

test("on M1 and M15 the marker goes on the candle that holds the M5 candle's close; only the latest day counts", () => {
  const base = day(SUMMER, { "10:05": [1080, 1160, 1075, 1150] });
  const b = judged(base);
  const m1 = new TimeframeView(base, "M1").full, m15 = new TimeframeView(base, "M15").full;
  assert.equal(m1.time[indexAtOrBefore(m1, b.closeTime - 1)], SUMMER + 7 * 300 + 240); // the 10:09 minute
  assert.equal(m15.time[indexAtOrBefore(m15, b.closeTime - 1)], SUMMER + 30 * 60); // the 10:00 M15 candle
  // Two days: the second day's range takes over, so the first day's breakout is no longer reported.
  const d1 = day(SUMMER, { "10:05": [1080, 1160, 1075, 1150] }), d2 = day(SUMMER + 86400, {});
  const rows = [];
  for (const c of [d1, d2]) for (let i = 0; i < c.length; i++) rows.push([c.time[i], c.open[i], c.high[i], c.low[i], c.close[i], 1, 0]);
  const both = Candles.fromBuffer(new Int32Array(rows.flat()).buffer, 2);
  assert.equal(judged(both).state, "none");
  assert.equal(judged(both).time, SUMMER + 86400 + 17 * 300);
});

test("buffer: gold $1.00 and one pip on a currency pair by default; a set value per symbol wins", () => {
  assert.equal(defaultBufferPoints("XAUUSD", 2, 10), 100);
  assert.equal(defaultBufferPoints("EURUSD", 5, 10), 10);
  assert.equal(defaultBufferPoints("USDJPY", 3, 10), 10);
  const or = cleanIndicators({ or: { buffers: { XAUUSD: "0.5", EURUSD: -1, bad: 3, GBPUSD: "" } } }).or;
  assert.deepEqual(or.buffers, { XAUUSD: 0.5 });
  assert.equal(bufferPoints(or, "XAUUSD", 2, 10), 50);
  assert.equal(bufferPoints(or, "EURUSD", 5, 10), 10);
  assert.equal(cleanIndicators(null).or.breakout, true, "on by default");
  assert.equal(cleanIndicators({ or: { breakout: false } }).or.breakout, false);
});

// ----- the real gold data (skipped when web/data has not been built) --------------------------------------------
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
test("real XAUUSD: 5 and 6 Aug 2025, the breakout candles as worked out by hand", { skip: !existsSync(`${dataDir}XAUUSD/manifest.json`) }, async () => {
  const fakeFetch = async (url) => {
    const bytes = readFileSync(dataDir + url.replace(/^data\//, ""));
    return { ok: true, json: async () => JSON.parse(bytes.toString("utf8")), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const { candles: base } = await loadSymbol("XAUUSD", "data", fakeFetch);
  const finder = new BreakoutFinder(base);
  const buffer = defaultBufferPoints("XAUUSD", 2, 10); // $1.00
  const m5 = finder.view.full;
  const m5At = (t) => indexAtOrBefore(m5, t);

  // 5 Aug: OR 3379.65 / 3369.23. 10:00 New York (19:30 IST) wicks above ORH + $1 but closes inside.
  const ten = m5At(utc("2025-08-05T14:00:00Z"));
  assert.ok(m5.high[ten] > 337965 + buffer && m5.close[ten] <= 337965 + buffer, "10:00: a wick above, a close inside");
  const aug5 = finder.at(at(base, utc("2025-08-05T16:00:00Z")), OR, buffer);
  assert.deepEqual([aug5.orHigh, aug5.orLow], [337965, 336923]);
  assert.equal(aug5.time, utc("2025-08-05T14:20:00Z")); // 10:20 New York, 19:50 IST
  assert.deepEqual([aug5.up, aug5.close, aug5.bodyPct, aug5.size, aug5.need, aug5.displacement], [true, 338217, 79, 681, 521, true]);
  assert.equal(describeBreakout(aug5, 2).legend, "body 79% · size 6.81 / needs 5.21");
  assert.equal(describeBreakout(aug5, 2).text, "Displacement – enter next open");

  // 6 Aug: OR 3373.55 / 3365.24. 10:00 New York closes 3373.59: above ORH, under ORH + $1, so not counted.
  assert.equal(m5.close[m5At(utc("2025-08-06T14:00:00Z"))], 337359);
  const aug6 = finder.at(at(base, utc("2025-08-06T16:00:00Z")), OR, buffer);
  assert.deepEqual([aug6.orHigh, aug6.orLow], [337355, 336524]);
  assert.equal(aug6.time, utc("2025-08-06T14:20:00Z"));
  assert.deepEqual([aug6.up, aug6.close, aug6.bodyPct, aug6.size, aug6.displacement, aug6.failed], [true, 337589, 85, 355, false, ["size"]]);
  assert.equal(describeBreakout(aug6, 2).legend, "body 85% · size 3.55 / needs 4.16");
  assert.equal(describeBreakout(aug6, 2).text, "Not displacement – no trade (size under ½ ORW)");
});
