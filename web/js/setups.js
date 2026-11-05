// The setup finder: the RSI + Bollinger reversal setup of the "technical analysis based" strategy, found on
// closed 4-hour candles (decision 0030).
//
// A SELL setup on candle k (a BUY is the mirror image):
//   * RSI reached the sell level (70) on candle k or the candle before it,
//   * price reached the upper Bollinger band within the last `lookback` candles (the band of the candle
//     before k, so the candle cannot move its own band out of the way),
//   * candle k closed red (below its open): the first reversal candle.
// Entry: the close of candle k (a market order fills at the next candle's open).
// Stop:  `bufferPips` beyond the highest high of the last `lookback` candles.
// Skip:  the stop is wider than `maxStopAtr` x ATR (a late, stretched entry) or narrower than `minStopPips`.
// Target: `targetR` x the risk. Exits are up to the trader.
//
// The same rules were backtested in Python on Jan 2024 - Oct 2026 (chat with Claude, 4-5 Nov 2026) and sent as a
// TradingView script. That backtest used pandas' RSI, seeded differently, so a reading right at 70 can
// fall on either side here: a setup or two can differ.
//
// No look-ahead: everything is worked out from the first `count` candles, and `count` only ever covers
// candles that had closed at the replay clock (SetupFinder.closedCount).

import { atr, bollinger, rsi } from "./indicators.js";
import { TimeframeView } from "./timeframes.js";

export const SETUP_TIMEFRAME = "H4";
export const STORAGE_KEY = "forexreplay.setups";

export const DEFAULT_SETUP_RULES = Object.freeze({
  on: false,
  pause: true, // playing stops at each setup, and a jump to a session or a setup time stops there too
  rsiPeriod: 14,
  rsiHigh: 70,
  rsiLow: 30,
  bbPeriod: 20,
  bbMult: 2,
  lookback: 3,
  bufferPips: 2,
  atrPeriod: 14,
  maxStopAtr: 1.8,
  minStopPips: 5,
  targetR: 1,
});

/** [key, smallest, largest, step]: what each number may be. Anything else falls back to the default. */
const LIMITS = [
  ["rsiPeriod", 2, 100, 1], ["rsiHigh", 50, 99, 0.5], ["rsiLow", 1, 50, 0.5],
  ["bbPeriod", 2, 200, 1], ["bbMult", 0.1, 10, 0.1], ["lookback", 1, 20, 1], ["bufferPips", 0, 100, 0.1],
  ["atrPeriod", 2, 100, 1], ["maxStopAtr", 0.1, 20, 0.1], ["minStopPips", 0, 500, 0.1], ["targetR", 0.1, 20, 0.05],
];

/** Settings from storage or the form, with anything odd replaced by the default. */
export function cleanSetupRules(raw) {
  const out = { ...DEFAULT_SETUP_RULES };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.on === "boolean") out.on = raw.on;
  if (typeof raw.pause === "boolean") out.pause = raw.pause;
  for (const [key, lo, hi, step] of LIMITS) {
    if (raw[key] === null || raw[key] === "" || raw[key] === undefined) continue;
    const v = Math.round(Number(raw[key]) / step) * step;
    if (Number.isFinite(v) && v >= lo - 1e-9 && v <= hi + 1e-9) out[key] = Number(v.toFixed(4));
  }
  if (out.rsiLow >= out.rsiHigh) { out.rsiLow = DEFAULT_SETUP_RULES.rsiLow; out.rsiHigh = DEFAULT_SETUP_RULES.rsiHigh; }
  return out;
}

/**
 * The indicator values the rules need, for the first `count` candles only.
 * Returns { rsi, upper, lower, atr } (Float64Arrays of length `count`).
 */
function indicatorsFor(candles, count, rules) {
  const closes = candles.close.subarray(0, count);
  const cut = { high: candles.high.subarray(0, count), low: candles.low.subarray(0, count), close: closes, length: count };
  const bands = bollinger(closes, rules.bbPeriod, rules.bbMult);
  return { rsi: rsi(closes, rules.rsiPeriod), upper: bands.upper, lower: bands.lower, atr: atr(cut, rules.atrPeriod) };
}

/**
 * The setup on candle k, or null. `ind` holds the indicators for candles 0..k at least.
 * A setup: { index, time, closeTime, side, entry, stopLoss, takeProfit, risk, stopPips, stopAtr, rsi, skip }
 * Prices in points. `skip` is null for a setup to take, or "wide" / "small" with the stop that broke the rule.
 */
export function setupAt(candles, k, ind, rules, pipPoints, barSeconds = 14400) {
  const look = rules.lookback;
  if (k < 1 || k - look + 1 < 0) return null;
  const r0 = ind.rsi[k - 1], r1 = ind.rsi[k], up = ind.upper[k - 1], lo = ind.lower[k - 1], a = ind.atr[k];
  if (![r0, r1, up, lo, a].every(Number.isFinite) || a <= 0) return null;
  const open = candles.open[k], close = candles.close[k];
  let high = -Infinity, low = Infinity;
  for (let i = k - look + 1; i <= k; i++) {
    if (candles.high[i] > high) high = candles.high[i];
    if (candles.low[i] < low) low = candles.low[i];
  }
  const buffer = Math.round(rules.bufferPips * pipPoints);
  let side = null, stopLoss = null;
  if (Math.max(r0, r1) >= rules.rsiHigh && close < open && high >= up) { side = "SELL"; stopLoss = high + buffer; }
  else if (Math.min(r0, r1) <= rules.rsiLow && close > open && low <= lo) { side = "BUY"; stopLoss = low - buffer; }
  if (!side) return null;
  const risk = Math.abs(close - stopLoss);
  const dir = side === "BUY" ? 1 : -1;
  const stopAtr = risk / a;
  const skip = stopAtr > rules.maxStopAtr + 1e-9 ? "wide" : risk < rules.minStopPips * pipPoints - 1e-9 ? "small" : null;
  return {
    index: k, time: candles.time[k], closeTime: candles.time[k] + barSeconds, side,
    entry: close, stopLoss, takeProfit: close + dir * Math.round(rules.targetR * risk), risk,
    stopPips: risk / pipPoints, stopAtr, rsi: side === "SELL" ? Math.max(r0, r1) : Math.min(r0, r1), skip,
  };
}

/** Every setup (taken or skipped) on the first `count` candles, oldest first. */
export function findSetups(candles, count, rules, pipPoints, barSeconds = 14400) {
  const n = Math.max(0, Math.min(count, candles.length));
  const ind = indicatorsFor(candles, n, rules);
  const out = [];
  for (let k = 1; k < n; k++) {
    const s = setupAt(candles, k, ind, rules, pipPoints, barSeconds);
    if (s) out.push(s);
  }
  return out;
}

/** "SELL · stop 25.6 pips (1.2 ATR)" and the like, for hints and markers. */
export function describeSetup(s) {
  const stop = `stop ${s.stopPips.toFixed(1)} pips (${s.stopAtr.toFixed(2)} ATR)`;
  if (s.skip === "wide") return `${s.side} setup skipped: ${stop}, wider than the limit`;
  if (s.skip === "small") return `${s.side} setup skipped: ${stop}, smaller than the limit`;
  return `${s.side} setup · ${stop}`;
}

/**
 * Setups on the replay's 4-hour candles, as the clock reveals them.
 *
 * It keeps its own H4 TimeframeView of the base candles (with the older H4 history, decision 0024), used only
 * to know where each 4-hour candle starts and ends in the base candles. Only candles that had CLOSED at a
 * position are ever read: closedCount(position) of them.
 */
export class SetupFinder {
  constructor(base, history, pipPoints, rules = DEFAULT_SETUP_RULES) {
    this.view = new TimeframeView(base, SETUP_TIMEFRAME, history || null);
    this.pipPoints = pipPoints;
    this.barSeconds = 14400;
    this.setRules(rules);
  }

  setRules(rules) {
    this.rules = cleanSetupRules(rules);
    this.cache = { count: -1, list: [] };
  }

  /** How many 4-hour candles had closed once `position` base candles were revealed. */
  closedCount(position) {
    const v = this.view;
    if (position <= 0) return v.historyLength;
    const k = v.bucketOf[Math.min(position, v.base.length) - 1];
    return position >= v.endOf(k) ? k + 1 : k;
  }

  /** True when the base candle that brought the clock to `position` was the last of a 4-hour candle. */
  closesAt(position) {
    if (position <= 0) return false;
    const v = this.view;
    const k = v.bucketOf[Math.min(position, v.base.length) - 1];
    return position === v.endOf(k);
  }

  /** Every setup on the 4-hour candles closed at `position`, oldest first (cached until another candle closes). */
  setupsAt(position) {
    const count = this.closedCount(position);
    if (this.cache.count !== count) this.cache = { count, list: findSetups(this.view.full, count, this.rules, this.pipPoints, this.barSeconds) };
    return this.cache.list;
  }

  /** The setup on the newest closed 4-hour candle at `position`, or null. */
  latestAt(position) {
    const count = this.closedCount(position);
    const list = this.setupsAt(position);
    const last = list[list.length - 1];
    return last && last.index === count - 1 ? last : null;
  }

  /** A setup to take (not skipped) whose candle closed exactly as the clock reached `position`, or null. */
  newAt(position) {
    if (!this.closesAt(position)) return null;
    const s = this.latestAt(position);
    return s && !s.skip ? s : null;
  }
}

/**
 * Where a "next setup" jump may go at most: the first base candle at least `days` after the last revealed one
 * (or the end of the data). The jump itself reveals candle by candle and stops at the first setup on the way
 * (SetupFinder.newAt), so where it stops is never worked out from candles the clock has not reached.
 */
export function setupJumpLimit(base, position, days = 60) {
  const until = base.time[position - 1] + days * 86400;
  let lo = position, hi = base.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (base.time[mid] < until) lo = mid + 1; else hi = mid;
  }
  return lo;
}
