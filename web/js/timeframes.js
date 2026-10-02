// Builds higher-timeframe candles (M15 ... D1) from the M5 candles.
//
// Candle boundaries follow the broker's server clock, which is New York time
// + 7 hours (see docs/decisions/0002). That is what makes these candles match
// MetaTrader exactly: H4 candles start at 00:00, 04:00, ... server time and the
// daily candle runs from the New York close (17:00) to the next one.
//
// `upTo` limits how many M5 candles are used. During replay it is the replay
// position, so the last higher-timeframe candle is "forming": it contains only
// the M5 candles revealed so far and nothing from the future.

import { Candles } from "./data.js";

export const TIMEFRAMES = [
  { id: "M5", seconds: 300, label: "5 minutes" },
  { id: "M15", seconds: 900, label: "15 minutes" },
  { id: "M30", seconds: 1800, label: "30 minutes" },
  { id: "H1", seconds: 3600, label: "1 hour" },
  { id: "H4", seconds: 14400, label: "4 hours" },
  { id: "D1", seconds: 86400, label: "1 day" },
];

export function timeframe(id) {
  const tf = TIMEFRAMES.find((t) => t.id === id);
  if (!tf) throw new Error(`Unknown timeframe: ${id}`);
  return tf;
}

const DAY = 86400;

/** Unix seconds (UTC) of 00:00 on the n-th Sunday of a month. */
function nthSunday(year, monthIndex, n) {
  const first = Date.UTC(year, monthIndex, 1) / 1000;
  const weekday = new Date(first * 1000).getUTCDay(); // 0 = Sunday
  return first + (((7 - weekday) % 7) + 7 * (n - 1)) * DAY;
}

const dstCache = new Map();

/** US daylight saving: second Sunday of March 02:00 EST to first Sunday of November 02:00 EDT. */
function usDstRange(year) {
  if (!dstCache.has(year)) {
    dstCache.set(year, {
      start: nthSunday(year, 2, 2) + 7 * 3600, // 02:00 EST = 07:00 UTC
      end: nthSunday(year, 10, 1) + 6 * 3600, // 02:00 EDT = 06:00 UTC
    });
  }
  return dstCache.get(year);
}

/** Broker server clock minus UTC, in seconds: +3h during US summer time, +2h otherwise. */
export function serverOffsetSeconds(utcSeconds) {
  const year = new Date(utcSeconds * 1000).getUTCFullYear();
  const { start, end } = usDstRange(year);
  return utcSeconds >= start && utcSeconds < end ? 3 * 3600 : 2 * 3600;
}

/** Start (UTC seconds) of the timeframe candle that contains this M5 candle. */
export function bucketStart(utcSeconds, tfSeconds) {
  const offset = serverOffsetSeconds(utcSeconds);
  return Math.floor((utcSeconds + offset) / tfSeconds) * tfSeconds - offset;
}

/**
 * Aggregate M5 candles into a higher timeframe.
 * Returns { candles, firstIndex } where firstIndex[k] is the index of the first
 * M5 candle inside higher-timeframe candle k (used for forming candles in replay).
 */
export function aggregate(base, tfId, upTo = base.length) {
  const tf = timeframe(tfId);
  const n = Math.max(0, Math.min(upTo, base.length));

  // First pass: count buckets so the typed arrays can be allocated exactly.
  let count = 0;
  let previous = null;
  for (let i = 0; i < n; i++) {
    const start = bucketStart(base.time[i], tf.seconds);
    if (start !== previous) {
      count++;
      previous = start;
    }
  }

  const out = new Candles(count, base.digits);
  const firstIndex = new Int32Array(count);
  let k = -1;
  previous = null;
  for (let i = 0; i < n; i++) {
    const start = bucketStart(base.time[i], tf.seconds);
    if (start !== previous) {
      k++;
      previous = start;
      firstIndex[k] = i;
      out.time[k] = start;
      out.open[k] = base.open[i];
      out.high[k] = base.high[i];
      out.low[k] = base.low[i];
      out.volume[k] = 0;
      out.spread[k] = 0;
    }
    if (base.high[i] > out.high[k]) out.high[k] = base.high[i];
    if (base.low[i] < out.low[k]) out.low[k] = base.low[i];
    out.close[k] = base.close[i];
    out.volume[k] += base.volume[i];
    if (base.spread[i] > out.spread[k]) out.spread[k] = base.spread[i];
  }
  return { candles: out, firstIndex };
}

/** Index of the last candle whose time is <= t (binary search); -1 if none. */
export function indexAtOrBefore(candles, utcSeconds) {
  let lo = 0, hi = candles.length - 1, answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles.time[mid] <= utcSeconds) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}
