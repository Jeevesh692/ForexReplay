// Technical indicators, computed from the candles on the chart.
//
// The chart's candles are only those the replay clock has revealed, plus the forming one
// (TimeframeView), so an indicator can never see the future. Its last value moves while a
// candle forms, as it does on TradingView's replay, and settles when the candle closes.
//
// Prices are whole points in and out (as decimals: an average of points is not whole).
// Values that cannot be worked out yet (the first n-1 candles of a 20 SMA) are NaN.
// forex_replay/indicator_golden.py records the same calculations done in Python, and
// web/tests/indicators.test.mjs requires the same numbers.

import { bucketStart } from "./timeframes.js";

export const DEFAULT_INDICATORS = Object.freeze({
  sma: { on: false, period: 20 },
  ema: { on: false, period: 50 },
  vwap: { on: false },
  rsi: { on: false, period: 14 },
});
export const STORAGE_KEY = "forexreplay.indicators";

/** Simple moving average: the mean of the last `n` values. */
export function sma(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/**
 * Exponential moving average with weight 2 / (n + 1), started from the simple average of
 * the first `n` values (so it does not lean on whichever value happens to come first).
 */
export function ema(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative strength index (Wilder): 100 - 100 / (1 + average gain / average loss).
 * The first averages are simple averages of the first `n` changes; after that each is
 * smoothed as (previous * (n - 1) + this change) / n. No losses at all gives 100.
 */
export function rsi(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  if (values.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gain += change; else loss -= change;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let i = n + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(change, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-change, 0)) / n;
    out[i] = value();
  }
  return out;
}

/**
 * Volume-weighted average price, starting again each broker-server day (17:00 New York):
 * the sum of typical price (high + low + close) / 3 times volume, divided by the volume so far
 * that day. The volume is MT5's tick volume. With no volume yet, it is the typical price.
 */
export function vwap(candles) {
  const n = candles.length;
  const out = new Float64Array(n);
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < n; i++) {
    const d = bucketStart(candles.time[i], 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const typical = (candles.high[i] + candles.low[i] + candles.close[i]) / 3;
    pv += typical * candles.volume[i];
    vol += candles.volume[i];
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

/** Settings from storage, with anything odd replaced by the defaults. */
export function cleanIndicators(raw) {
  const out = structuredClone(DEFAULT_INDICATORS);
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(out)) {
    const r = raw[key];
    if (!r || typeof r !== "object") continue;
    out[key].on = r.on === true;
    if ("period" in out[key]) {
      const p = Number(r.period);
      if (Number.isInteger(p) && p >= 2 && p <= 500) out[key].period = p;
    }
  }
  return out;
}

/** The lines to draw for `candles` under `settings`: [{ id, label, values, pane: "price" | "rsi" }]. */
export function computeIndicators(candles, settings) {
  // Only the first `length` candles. A replay's candle list (TimeframeView.display) keeps full-size arrays
  // behind it, and the slots past `length` can still hold candles the clock has hidden: reading the whole
  // array would be look-ahead. (Found on day 13 in the browser; there is a test for it.)
  const closes = candles.close.subarray(0, candles.length);
  const lines = [];
  if (settings.sma.on) lines.push({ id: "sma", label: `SMA ${settings.sma.period}`, values: sma(closes, settings.sma.period), pane: "price" });
  if (settings.ema.on) lines.push({ id: "ema", label: `EMA ${settings.ema.period}`, values: ema(closes, settings.ema.period), pane: "price" });
  if (settings.vwap.on) lines.push({ id: "vwap", label: "VWAP (daily)", values: vwap(candles), pane: "price" });
  if (settings.rsi.on) lines.push({ id: "rsi", label: `RSI ${settings.rsi.period}`, values: rsi(closes, settings.rsi.period), pane: "rsi" });
  return lines;
}

/**
 * The same indicators, worked out only where the candles changed.
 *
 * A replay step changes the forming candle and maybe adds one; everything before it stays.
 * Working all four indicators out again over 21,000 candles took about 19 ms per step
 * (measured on day 13). This keeps each indicator's running state per candle (the EMA itself,
 * Wilder's average gain and loss, the day's volume totals), so a step only recomputes from the
 * first changed candle on. A test checks that it always equals the full calculation above.
 */
export class IndicatorEngine {
  constructor() {
    this.key = null; // settings the stored state belongs to
    this.length = 0; // candles the stored state covers
    this.capacity = 0;
  }

  grow(capacity) {
    if (capacity <= this.capacity) return;
    const keep = (old) => { const a = new Float64Array(capacity).fill(NaN); if (old) a.set(old.subarray(0, this.length)); return a; };
    for (const name of ["sma", "ema", "rsi", "gain", "loss", "vwap", "pv", "vol"]) this[name] = keep(this[name]);
    this.day = (() => { const a = new Float64Array(capacity); if (this.day) a.set(this.day.subarray(0, this.length)); return a; })();
    this.capacity = capacity;
  }

  /**
   * Lines for `candles`, as computeIndicators returns them. `from` is the first candle that may
   * have changed since the last call; null (or anything the stored state cannot vouch for) means all.
   */
  compute(candles, settings, from = null) {
    const n = candles.length;
    const key = JSON.stringify(settings);
    if (from === null || key !== this.key || from > this.length) from = 0;
    this.key = key;
    this.grow(Math.max(n, candles.close.length));
    const c = candles.close;
    const { sma: S, ema: E, rsi: R } = settings;
    if (S.on) this.smaFrom(c, S.period, from, n);
    if (E.on) this.emaFrom(c, E.period, from, n);
    if (R.on) this.rsiFrom(c, R.period, from, n);
    if (settings.vwap.on) this.vwapFrom(candles, from, n);
    this.length = n;
    const lines = [];
    if (S.on) lines.push({ id: "sma", label: `SMA ${S.period}`, values: this.sma.subarray(0, n), pane: "price" });
    if (E.on) lines.push({ id: "ema", label: `EMA ${E.period}`, values: this.ema.subarray(0, n), pane: "price" });
    if (settings.vwap.on) lines.push({ id: "vwap", label: "VWAP (daily)", values: this.vwap.subarray(0, n), pane: "price" });
    if (R.on) lines.push({ id: "rsi", label: `RSI ${R.period}`, values: this.rsi.subarray(0, n), pane: "rsi" });
    return lines;
  }

  smaFrom(c, p, from, n) {
    for (let i = from; i < n; i++) {
      if (i < p - 1) { this.sma[i] = NaN; continue; }
      let sum = 0;
      for (let k = i - p + 1; k <= i; k++) sum += c[k];
      this.sma[i] = sum / p;
    }
  }

  emaFrom(c, p, from, n) {
    const k = 2 / (p + 1);
    for (let i = from; i < n; i++) {
      if (i < p - 1) { this.ema[i] = NaN; continue; }
      if (i === p - 1) { let sum = 0; for (let j = 0; j < p; j++) sum += c[j]; this.ema[i] = sum / p; continue; }
      this.ema[i] = c[i] * k + this.ema[i - 1] * (1 - k);
    }
  }

  rsiFrom(c, p, from, n) {
    const value = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
    for (let i = from; i < n; i++) {
      if (i < p) { this.rsi[i] = this.gain[i] = this.loss[i] = NaN; continue; }
      if (i === p) {
        let g = 0, l = 0;
        for (let j = 1; j <= p; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) g += ch; else l -= ch; }
        this.gain[i] = g / p; this.loss[i] = l / p;
      } else {
        const ch = c[i] - c[i - 1];
        this.gain[i] = (this.gain[i - 1] * (p - 1) + Math.max(ch, 0)) / p;
        this.loss[i] = (this.loss[i - 1] * (p - 1) + Math.max(-ch, 0)) / p;
      }
      this.rsi[i] = value(this.gain[i], this.loss[i]);
    }
  }

  vwapFrom(candles, from, n) {
    for (let i = from; i < n; i++) {
      const d = bucketStart(candles.time[i], 86400);
      const fresh = i === 0 || d !== this.day[i - 1];
      const typical = (candles.high[i] + candles.low[i] + candles.close[i]) / 3;
      this.pv[i] = (fresh ? 0 : this.pv[i - 1]) + typical * candles.volume[i];
      this.vol[i] = (fresh ? 0 : this.vol[i - 1]) + candles.volume[i];
      this.day[i] = d;
      this.vwap[i] = this.vol[i] > 0 ? this.pv[i] / this.vol[i] : typical;
    }
  }
}
