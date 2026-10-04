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

/**
 * The broker-server date of a moment, as a day number (days since 1970 on the server clock).
 * Use this to ask "same trading day?". bucketStart(t, 86400) gives a day's start in UTC, which
 * works out differently on either side of a US clock change; on that Sunday (market closed in
 * real data) the same date could get two different starts. Found when testing ADR (after v2.0.2).
 */
export function serverDate(utcSeconds) {
  return Math.floor((utcSeconds + serverOffsetSeconds(utcSeconds)) / 86400);
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
  const bucketOf = new Int32Array(n); // bucketOf[i] = which higher-timeframe candle M5 candle i belongs to
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
    bucketOf[i] = k;
    if (base.high[i] > out.high[k]) out.high[k] = base.high[i];
    if (base.low[i] < out.low[k]) out.low[k] = base.low[i];
    out.close[k] = base.close[i];
    out.volume[k] += base.volume[i];
    if (base.spread[i] > out.spread[k]) out.spread[k] = base.spread[i];
  }
  return { candles: out, firstIndex, bucketOf };
}

/**
 * One timeframe as seen during replay.
 *
 * `full` holds every candle of the timeframe (built once). `display` is what the
 * chart is allowed to show: the candles that are complete at the replay position
 * plus one forming candle built only from the M5 candles revealed so far.
 * `display.length` shrinks and grows with the replay position, so nothing after
 * the replay position can ever reach the chart.
 */
export class TimeframeView {
  constructor(base, tfId) {
    this.base = base;
    this.id = tfId;
    const { candles, firstIndex, bucketOf } = aggregate(base, tfId);
    this.full = candles;
    this.firstIndex = firstIndex;
    this.bucketOf = bucketOf;
    this.display = new Candles(candles.length, base.digits);
    this.position = -1; // forces a full copy on first use
    this.setPosition(base.length);
  }

  /** Number of timeframe candles visible when `position` M5 candles are revealed. */
  countAt(position) {
    return position <= 0 ? 0 : this.bucketOf[position - 1] + 1;
  }

  /** Index one past the last M5 candle of timeframe candle k. */
  endOf(k) {
    return k + 1 < this.full.length ? this.firstIndex[k + 1] : this.base.length;
  }

  copyFull(from, to) {
    for (const f of ["time", "open", "high", "low", "close", "volume", "spread"]) {
      this.display[f].set(this.full[f].subarray(from, to), from);
    }
  }

  /** Rebuild candle k from the M5 candles revealed so far. */
  buildForming(k, position) {
    const b = this.base, d = this.display;
    const start = this.firstIndex[k];
    d.time[k] = this.full.time[k];
    d.open[k] = b.open[start];
    d.high[k] = b.high[start];
    d.low[k] = b.low[start];
    d.volume[k] = 0;
    d.spread[k] = 0;
    for (let i = start; i < position; i++) {
      if (b.high[i] > d.high[k]) d.high[k] = b.high[i];
      if (b.low[i] < d.low[k]) d.low[k] = b.low[i];
      d.close[k] = b.close[i];
      d.volume[k] += b.volume[i];
      if (b.spread[i] > d.spread[k]) d.spread[k] = b.spread[i];
    }
  }

  /**
   * Move to a replay position (number of M5 candles revealed).
   * Returns { reset: true } when the chart must redraw everything, or
   * { reset: false, from, to } with the range of candles that changed (moving forward).
   */
  setPosition(position) {
    const p = Math.max(0, Math.min(position, this.base.length));
    const before = this.position;
    const count = this.countAt(p);
    const oldCount = before < 0 ? 0 : this.countAt(before);
    this.position = p;
    this.display.length = count;

    if (before < 0 || p < before) {
      this.copyFull(0, this.full.length); // jumping or moving back: start from clean candles
      if (count > 0) this.buildForming(count - 1, p);
      return { reset: true };
    }
    if (count === 0 || p === before) return { reset: false, from: count, to: count - 1 };

    // Moving forward: candles passed along the way are now complete; the last one is forming.
    const from = Math.max(0, oldCount - 1);
    this.copyFull(from, count - 1);
    this.buildForming(count - 1, p);
    return { reset: false, from, to: count - 1 };
  }

  /** True when the last displayed candle still lacks some of its M5 candles. */
  isForming() {
    const k = this.display.length - 1;
    return k >= 0 && this.position < this.endOf(k);
  }
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
