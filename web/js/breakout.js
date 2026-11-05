// The NY Opening Range Breakout's breakout candle (decision 0032), an option of the Opening range indicator.
//
// The rules, exactly as Jeevesh set them:
//   * The opening range (OR) is the high (ORH) and low (ORL) of the M5 candles opening 09:30-09:55 New York
//     (latestOpeningRange); ORW = ORH - ORL. b is a buffer in price per symbol (gold $1.00, forex 1 pip).
//   * The breakout window is the M5 candles OPENING 10:00-10:55 New York: the hour after the range.
//   * The FIRST of them to CLOSE above ORH + b or below ORL - b is the breakout candle. Later candles that
//     day are never checked. None by the end of the window: no breakout that day.
//   * It is a displacement candle only if its body |close - open| is at least 60% of its range (high - low)
//     AND its range is at least half of ORW. Then the trade is "enter next open"; otherwise no trade.
//
// No look-ahead: everything is judged on M5 candles built from the base minutes, and only those that had
// fully closed when the replay clock reached `position` (the forming one never counts), whatever timeframe
// is on screen. Prices are whole points; both tests compare whole numbers, so no rounding can flip them.

import { latestOpeningRange, OR_ZONE } from "./indicators.js";
import { zoneOffsetSeconds, zonedTimeToUtc } from "./sessions.js";
import { TimeframeView } from "./timeframes.js";

export const WINDOW_MINUTES = 60; // the breakout window: 10:00-10:55 New York after a 09:30-10:00 range
export const BREAKOUT_TIMEFRAMES = ["M1", "M5", "M15"]; // the marker is not shown on H1 and above
const M5 = 300;

/** The default buffer in points: $1.00 on gold, one pip on a currency pair. */
export function defaultBufferPoints(symbol, digits, pipPoints) {
  return symbol === "XAUUSD" ? Math.round(10 ** digits) : pipPoints;
}

/** The buffer in points for a symbol: the one set in the Indicators row, or the default. */
export function bufferPoints(or, symbol, digits, pipPoints) {
  const price = or.buffers && or.buffers[symbol];
  return price !== undefined ? Math.round(price * 10 ** digits) : defaultBufferPoints(symbol, digits, pipPoints);
}

/** When the opening range that contains candle time `t` starts (UTC seconds), on its New York day. */
function rangeStart(t, or) {
  const local = new Date((t + zoneOffsetSeconds(OR_ZONE, t)) * 1000);
  return zonedTimeToUtc(OR_ZONE, local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(),
    Number(or.start.slice(0, 2)), Number(or.start.slice(3, 5)));
}

/**
 * Judge the latest day on closed M5 candles: `m5` holds them in its first `count` entries.
 * Returns null (no range yet, or the window still open with nothing decided), or one of
 *   { state: "breakout", time, closeTime, up, close, bodyPct, size, need, body, displacement, failed: [...] }
 *   { state: "none", time, closeTime }  the window closed with no breakout; time is its last candle
 * Every price and size is in points.
 */
export function judgeBreakout(m5, count, or, buffer) {
  const closed = { length: count, time: m5.time, high: m5.high, low: m5.low };
  const range = latestOpeningRange(closed, or);
  if (!range) return null;
  const start = rangeStart(m5.time[range.from], or);
  const windowStart = start + or.minutes * 60;
  const windowEnd = windowStart + WINDOW_MINUTES * 60;
  const lastClose = m5.time[count - 1] + M5; // the moment the newest closed M5 candle closed
  if (lastClose < windowStart) return null; // the range itself is still forming
  const width = range.hi - range.lo;
  let lastInWindow = -1;
  for (let i = range.from; i < count; i++) {
    const t = m5.time[i];
    if (t < windowStart) continue;
    if (t >= windowEnd) break;
    lastInWindow = i;
    const c = m5.close[i];
    const up = c > range.hi + buffer;
    if (!up && !(c < range.lo - buffer)) continue;
    // The first close outside: the breakout candle. Judge it; nothing later counts.
    const body = Math.abs(c - m5.open[i]);
    const size = m5.high[i] - m5.low[i];
    const bodyOk = size > 0 && 5 * body >= 3 * size; // body >= 60% of the range
    const sizeOk = 2 * size >= width; // range >= half of ORW
    const failed = [];
    if (!bodyOk) failed.push("body");
    if (!sizeOk) failed.push("size");
    return {
      state: "breakout", time: t, closeTime: t + M5, up, close: c, body, size, need: width / 2,
      bodyPct: size > 0 ? Math.round((100 * body) / size) : 0, displacement: bodyOk && sizeOk, failed,
      orHigh: range.hi, orLow: range.lo,
    };
  }
  if (lastClose < windowEnd) return null; // the window is still open
  if (lastInWindow < 0) return null; // no candles in the window at all (a gap): nothing to mark
  return { state: "none", time: m5.time[lastInWindow], closeTime: m5.time[lastInWindow] + M5, orHigh: range.hi, orLow: range.lo };
}

/** The words on the marker and in the legend. `digits` turns points into prices. */
export function describeBreakout(b, digits) {
  const price = (points) => (points / 10 ** digits).toFixed(digits);
  if (b.state === "none") return { text: "No breakout", legend: "" };
  const facts = `body ${b.bodyPct}% · size ${price(b.size)} / needs ${price(b.need)}`;
  if (b.displacement) return { text: "Displacement – enter next open", legend: facts };
  const why = b.failed.map((f) => (f === "body" ? "body under 60%" : "size under ½ ORW")).join(", ");
  return { text: `Not displacement – no trade (${why})`, legend: facts };
}

/** The breakout candle for the replay: M5 built once from the base minutes, judged at each position. */
export class BreakoutFinder {
  constructor(base) {
    this.view = new TimeframeView(base, "M5");
    this.cache = { key: null, value: null };
  }

  /** How many M5 candles had fully closed once `position` base candles were revealed. */
  closedCount(position) {
    const v = this.view;
    if (position <= 0) return 0;
    const k = v.bucketOf[Math.min(position, v.base.length) - 1];
    return position >= v.endOf(k) ? k + 1 : k;
  }

  at(position, or, buffer) {
    const count = this.closedCount(position);
    const key = `${count}|${or.start}|${or.minutes}|${buffer}`;
    if (this.cache.key !== key) this.cache = { key, value: count ? judgeBreakout(this.view.full, count, or, buffer) : null };
    return this.cache.value;
  }
}
