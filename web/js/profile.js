// Volume profile (order flow, Phase 2). The same definition as forex_replay/profile.py, step for step and in
// the same order of additions, so both give identical numbers; web/tests/fixtures/profile_golden.json holds
// them to it (python -m forex_replay.profile_golden). The definition, in short:
//   bins of `binSize` on one grid from zero; each bar's tick count spread evenly over the bins from its low to
//   its high; POC = the biggest bin (ties: nearest the middle, then lower); value area grown from the POC, the
//   larger outside neighbour first (a tie adds the upper), until it holds `valueArea` of the volume;
//   HVNs and LVNs on the volumes smoothed over `smoothing` bins; an LVN zone is a run of smoothed bins below
//   `lvn` x the smoothed POC volume with heavier bins on both sides.
// Prices are whole numbers in the order-flow files' units (2 x points); so is the bin size.

import { serverDate } from "./timeframes.js";

export const PROFILE_DEFAULTS = Object.freeze({ valueArea: 0.70, smoothing: 3, lvn: 0.35 });

export function smoothed(values, window) {
  if (window <= 1) return values.slice();
  const half = Math.floor(window / 2);
  const out = [];
  for (let k = 0; k < values.length; k++) {
    const from = Math.max(0, k - half), to = Math.min(values.length, k + half + 1);
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j];
    out.push(sum / (to - from));
  }
  return out;
}

export function isPeak(s, k) {
  const n = s.length;
  if (n === 1) return true;
  if (k === 0) return s[0] > s[1];
  if (k === n - 1) return s[k] > s[k - 1];
  return s[k] > s[k - 1] && s[k] >= s[k + 1];
}

/** lows, highs: whole-number prices; volumes: each bar's tick count. Null when there is no volume. */
export function buildProfile(lows, highs, volumes, binSize, { valueArea = 0.70, smoothing = 3, lvn = 0.35 } = {}) {
  if (!(binSize > 0)) throw new Error("bin size must be positive");
  const bars = [];
  for (let i = 0; i < lows.length; i++) if (volumes[i] > 0) bars.push([lows[i], highs[i], volumes[i]]);
  if (bars.length === 0) return null;
  let first = Infinity, last = -Infinity;
  for (const [lo, hi] of bars) { first = Math.min(first, Math.floor(lo / binSize)); last = Math.max(last, Math.floor(hi / binSize)); }
  const raw = new Array(last - first + 1).fill(0);
  for (const [lo, hi, v] of bars) {
    const a = Math.floor(lo / binSize) - first, b = Math.floor(hi / binSize) - first;
    const share = v / (b - a + 1);
    for (let k = a; k <= b; k++) raw[k] += share;
  }
  const n = raw.length;

  let top = -Infinity;
  for (const v of raw) top = Math.max(top, v);
  const middle = (n - 1) / 2;
  let poc = -1;
  for (let k = 0; k < n; k++) {
    if (raw[k] !== top) continue;
    if (poc < 0 || Math.abs(k - middle) < Math.abs(poc - middle)) poc = k; // equal distance: the lower stays
  }

  let total = 0;
  for (const v of raw) total += v;
  let lo = poc, hi = poc, inside = raw[poc];
  while (inside < valueArea * total - 1e-12 && (lo > 0 || hi < n - 1)) {
    const below = lo > 0 ? raw[lo - 1] : -1, above = hi < n - 1 ? raw[hi + 1] : -1;
    if (above >= below) { hi += 1; inside += above; } else { lo -= 1; inside += below; }
  }

  const smooth = smoothed(raw, smoothing);
  const hvns = [];
  for (let k = 0; k < n; k++) if (isPeak(smooth, k)) hvns.push(k);
  let peak = -Infinity;
  for (const v of smooth) peak = Math.max(peak, v);
  const level = lvn * peak;
  const lvns = [];
  for (let k = 0; k < n;) {
    if (smooth[k] < level) {
      const start = k;
      while (k < n && smooth[k] < level) k++;
      if (start > 0 && k < n) lvns.push({ low: (first + start) * binSize, high: (first + k) * binSize, bins: [start, k - 1] });
    } else k++;
  }

  const edge = (k) => (first + k) * binSize;
  return {
    first_bin: first, bin_size: binSize, volumes: raw, smoothed: smooth, total,
    poc, poc_low: edge(poc), poc_high: edge(poc + 1),
    va_bins: [lo, hi], val: edge(lo), vah: edge(hi + 1), va_volume: inside,
    hvns, lvns,
  };
}

/**
 * The profile of bars opening in [start, end) that had CLOSED by `cursor` (the replay clock, UTC seconds):
 * never a bar still forming, never a later one. `bars`: { length, time, low, high, tick_count } and `seconds`.
 */
export function profileFromBars(bars, seconds, start, end, binSize, cursor = Infinity, settings = {}) {
  const limit = Math.min(end, cursor - seconds + 1);
  const lows = [], highs = [], volumes = [];
  // Bars are in time order: find the first one at or after `start` by halving, then read only the window.
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars.time[mid] < start) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < bars.length && bars.time[i] < limit; i++) {
    lows.push(bars.low[i]); highs.push(bars.high[i]); volumes.push(bars.tick_count[i]);
  }
  return lows.length ? buildProfile(lows, highs, volumes, binSize, settings) : null;
}

/** A bin size in price (EURUSD 0.0001, gold 0.50) -> the order-flow files' units (2 x points). */
export function priceBin(price, digits) {
  return Math.round(price * 2 * 10 ** digits);
}

/**
 * The prior day's POC, VAH and VAL, and the naked POCs of the last `daysBack` finished trading days, at
 * `cursor` (UTC seconds), as forex_replay/profile.day_levels: only bars closed by the cursor, only finished
 * days (a trading day runs from 17:00 New York). A POC is the middle of its POC bin. A naked POC runs from its
 * day's first bar until the first later bar whose low and high reach it (`to`), or on to the cursor (`to` null).
 * `cache` (a Map) may keep finished days' profiles between calls: they cannot change.
 */
export function dayLevels(bars, seconds, cursor, binSize, daysBack = 5, settings = {}, cache = null) {
  const days = new Map();
  let last = -1;
  for (let i = 0; i < bars.length && bars.time[i] + seconds <= cursor; i++) {
    const d = serverDate(bars.time[i]);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(i);
    last = i;
  }
  if (last < 0) return { day: null, day_start: null, prior: null, naked: [] };
  const today = serverDate(cursor - 1);
  const finished = [...days.keys()].filter((d) => d < today).sort((a, b) => a - b);
  const levels = new Map();
  for (const d of finished.slice(-Math.max(daysBack, 1))) {
    const key = `${d}|${binSize}|${settings.valueArea}|${settings.smoothing}|${settings.lvn}`;
    let level = cache ? cache.get(key) : undefined;
    if (level === undefined) {
      const rows = days.get(d);
      const p = buildProfile(rows.map((i) => bars.low[i]), rows.map((i) => bars.high[i]), rows.map((i) => bars.tick_count[i]), binSize, settings);
      level = p && { day: d, from: bars.time[rows[0]], poc: (p.poc_low + p.poc_high) / 2, val: p.val, vah: p.vah };
      if (cache) cache.set(key, level);
    }
    if (level) levels.set(d, level);
  }
  const prior = finished.length ? levels.get(finished.at(-1)) || null : null;
  const naked = [];
  if (daysBack > 0) {
    for (const d of [...levels.keys()].sort((a, b) => a - b).slice(-daysBack)) {
      const level = levels.get(d);
      let to = null;
      for (let i = 0; i <= last; i++) {
        if (serverDate(bars.time[i]) > d && bars.low[i] <= level.poc && level.poc <= bars.high[i]) { to = bars.time[i]; break; }
      }
      naked.push({ day: d, from: level.from, poc: level.poc, to });
    }
  }
  return { day: today, day_start: days.has(today) ? bars.time[days.get(today)[0]] : null, prior, naked };
}
