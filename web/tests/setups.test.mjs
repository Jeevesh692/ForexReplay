// Run with:  node --test web/tests/*.test.mjs
// The setup finder (decision 0030): the RSI + Bollinger reversal setup on closed 4-hour candles, its stop, target
// and skip rules, and that it never uses a candle the replay clock has not closed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Candles, loadSymbol } from "../js/data.js";
import { ReplayClock } from "../js/replay.js";
import { cleanSetupRules, DEFAULT_SETUP_RULES, describeSetup, findSetups, SetupFinder, setupJumpLimit } from "../js/setups.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const PIP = 10; // points per pip on a 5-digit pair
const RULES = cleanSetupRules({ on: true });

/**
 * 4-hour candles [open, high, low, close]: 30 quiet candles around 1.10000, a six-candle rally, then one red
 * candle (index 36) that closes back down: a SELL setup. `flip` mirrors every price (a BUY setup).
 */
function design(flip = false) {
  const rows = [];
  let p = 110000;
  for (let i = 0; i < 30; i++) { const o = p, c = p + (i % 2 ? 15 : -15); rows.push([o, Math.max(o, c) + 10, Math.min(o, c) - 10, c]); p = c; }
  for (let i = 0; i < 6; i++) { const o = p, c = p + 60; rows.push([o, c + 10, o - 5, c]); p = c; }
  rows.push([p, p + 10, p - 35, p - 30]); // the reversal candle
  rows.push([p - 30, p - 20, p - 60, p - 50]); // and one after it
  if (!flip) return rows;
  return rows.map(([o, h, l, c]) => [220000 - o, 220000 - l, 220000 - h, 220000 - c]);
}

const START = utc("2026-01-05T22:00"); // 00:00 on the broker's server clock (UTC+2 in winter): an H4 boundary

function h4Candles(rows) {
  const c = new Candles(rows.length);
  rows.forEach(([o, h, l, cl], i) => { c.time[i] = START + i * 14400; c.open[i] = o; c.high[i] = h; c.low[i] = l; c.close[i] = cl; c.volume[i] = 1; });
  return c;
}

/** The same candles as 1-hour candles, four to each 4-hour candle, so the replay can step through them. */
function hourly(rows) {
  const out = [];
  rows.forEach(([o, h, l, c], i) => {
    const t = START + i * 14400;
    out.push([t, o, h, l, o, 1, 0], [t + 3600, o, o, o, o, 1, 0], [t + 7200, o, o, o, o, 1, 0],
      [t + 10800, o, Math.max(o, c), Math.min(o, c), c, 1, 0]);
  });
  return Candles.fromBuffer(new Int32Array(out.flat()).buffer);
}

test("a SELL setup on the first red candle after RSI 70 and an upper-band touch", () => {
  const c = h4Candles(design());
  const list = findSetups(c, c.length, RULES, PIP);
  const s = list.find((x) => x.index === 36);
  assert.ok(s, "the reversal candle is a setup");
  assert.equal(s.side, "SELL");
  assert.equal(s.entry, c.close[36]);
  const high = Math.max(c.high[34], c.high[35], c.high[36]);
  assert.equal(s.stopLoss, high + 2 * PIP); // 2 pips above the highest high of the last 3 candles
  assert.equal(s.risk, s.stopLoss - s.entry);
  assert.equal(s.takeProfit, s.entry - s.risk); // 1R
  assert.equal(s.closeTime, c.time[36] + 14400);
  assert.ok(s.rsi >= 70);
  assert.equal(s.skip, null);
  assert.ok(!list.some((x) => x.index < 36 && !x.skip), "nothing to take during the quiet part or the rally");
  assert.match(describeSetup(s), /^SELL setup · stop \d+\.\d pips \(\d\.\d\d ATR\)$/);
});

test("the mirror image is a BUY setup with the stop below the lowest low", () => {
  const c = h4Candles(design(true));
  const s = findSetups(c, c.length, RULES, PIP).find((x) => x.index === 36);
  assert.equal(s.side, "BUY");
  assert.equal(s.stopLoss, Math.min(c.low[34], c.low[35], c.low[36]) - 2 * PIP);
  assert.equal(s.takeProfit, s.entry + s.risk);
});

test("a stop wider than the ATR limit, or smaller than the pip limit, is marked skipped", () => {
  const c = h4Candles(design());
  const tight = findSetups(c, c.length, cleanSetupRules({ ...RULES, maxStopAtr: 0.5 }), PIP).find((x) => x.index === 36);
  assert.equal(tight.skip, "wide");
  assert.match(describeSetup(tight), /skipped: .*wider than the limit/);
  const big = findSetups(c, c.length, cleanSetupRules({ ...RULES, minStopPips: 50 }), PIP).find((x) => x.index === 36);
  assert.equal(big.skip, "small");
  const twoR = findSetups(c, c.length, cleanSetupRules({ ...RULES, targetR: 2 }), PIP).find((x) => x.index === 36);
  assert.equal(twoR.takeProfit, twoR.entry - 2 * twoR.risk);
});

test("no look-ahead: the setups on the first k candles never depend on the candles after them", () => {
  const rows = design();
  const c = h4Candles(rows);
  const all = findSetups(c, c.length, RULES, PIP);
  for (let k = 0; k <= c.length; k++) {
    const changed = h4Candles(rows.map((r, i) => (i >= k ? [r[0], r[1] + 999, r[2] - 999, r[3] + 500] : r)));
    assert.deepEqual(findSetups(changed, k, RULES, PIP), all.filter((s) => s.index < k), `first ${k} candles`);
  }
});

test("SetupFinder: a setup appears only once its 4-hour candle has closed, on the replay's own candles", () => {
  const rows = design();
  const base = hourly(rows);
  const finder = new SetupFinder(base, null, PIP, RULES);
  const seen = [];
  for (let position = 1; position <= base.length; position++) {
    assert.equal(finder.closedCount(position), Math.floor(position / 4), `closed 4-hour candles at ${position}`);
    const s = finder.newAt(position);
    if (s) seen.push([position, s.index]);
  }
  const expected = findSetups(h4Candles(rows), rows.length, RULES, PIP).filter((x) => !x.skip).map((x) => [(x.index + 1) * 4, x.index]);
  assert.deepEqual(seen, expected); // each at the close of its own 4-hour candle
  assert.deepEqual(seen[0], [37 * 4, 36]); // the first: the clock reaches the close of candle 36, 37 four-hour candles shown
  for (let position = 36 * 4 + 1; position < 37 * 4; position++) assert.equal(finder.latestAt(position), null, "not while it forms");
  assert.equal(finder.latestAt(37 * 4 + 1).index, 36); // still the newest closed candle's setup
  assert.equal(finder.newAt(37 * 4 + 1), null); // but not "new" any more
  // The next red candle is a setup too under the same rules (RSI was still at 70 a candle ago): the rules are kept
  // exactly as they were backtested; with a trade already open you would pass on it.
  assert.equal(seen[1][1], 37);
});

test("a jump to the next setup reveals candle by candle and stops at the setup candle's close", () => {
  const base = hourly(design());
  const finder = new SetupFinder(base, null, PIP, RULES);
  const clock = new ReplayClock(base.length, { setInterval: () => 1, clearInterval: () => {} });
  clock.start(10);
  const revealed = [];
  clock.onReveal((from, to) => revealed.push([from, to]));
  const limit = setupJumpLimit(base, clock.position);
  assert.equal(limit, base.length); // less than 60 days of candles: the limit is the end
  const done = clock.jumpTo(limit, () => !!finder.newAt(clock.position));
  assert.equal(done.early, true);
  assert.equal(clock.position, 37 * 4);
  assert.equal(revealed.length, 37 * 4 - 10); // one candle at a time
  assert.equal(setupJumpLimit(base, 10, 1), 10 + 24 - 1); // a 1-day limit: the first candle a day after the last shown
});

test("settings: bad values fall back to the defaults", () => {
  assert.deepEqual(cleanSetupRules(null), { ...DEFAULT_SETUP_RULES });
  const r = cleanSetupRules({ on: true, rsiHigh: "75", rsiLow: 25, maxStopAtr: "abc", lookback: 0, targetR: 1.27, bbMult: "2.25" });
  assert.equal(r.on, true);
  assert.equal(r.rsiHigh, 75);
  assert.equal(r.rsiLow, 25);
  assert.equal(r.maxStopAtr, DEFAULT_SETUP_RULES.maxStopAtr);
  assert.equal(r.lookback, DEFAULT_SETUP_RULES.lookback);
  assert.equal(r.targetR, 1.25); // steps of 0.05
  assert.equal(r.bbMult, 2.3); // steps of 0.1
  const crossed = cleanSetupRules({ rsiHigh: 50, rsiLow: 50 });
  assert.equal(crossed.rsiHigh, 70);
  assert.equal(crossed.rsiLow, 30);
});

// On the real data: walking the clock to each 4-hour close finds exactly the setups the whole history holds.
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
test("real data: the setups found as the clock moves equal those on the whole history", { skip: !existsSync(`${dataDir}EURUSD/manifest.json`) }, async () => {
  const fakeFetch = async (url) => {
    const bytes = readFileSync(dataDir + url.replace(/^data\//, ""));
    return { ok: true, json: async () => JSON.parse(bytes.toString("utf8")), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const { candles: m1, history, manifest } = await loadSymbol("EURUSD", "data", fakeFetch);
  const finder = new SetupFinder(m1, history.H4, manifest.pip_points, RULES);
  const v = finder.view;
  const whole = findSetups(v.full, v.full.length, RULES, manifest.pip_points).filter((s) => !s.skip && !v.isHistory(s.index));
  const walked = [];
  for (let k = v.historyLength; k < v.full.length; k++) {
    const end = v.endOf(k);
    const s = finder.newAt(end);
    if (s) walked.push(s);
    if (end > 1) assert.equal(finder.newAt(end - 1), null);
  }
  assert.deepEqual(walked, whole);
  assert.ok(whole.length > 20, `setups found: ${whole.length}`);
  for (const s of whole) {
    assert.ok(s.stopAtr <= RULES.maxStopAtr + 1e-9 && s.stopPips >= RULES.minStopPips - 1e-9);
    assert.equal(Math.abs(s.takeProfit - s.entry), s.risk);
  }
});
