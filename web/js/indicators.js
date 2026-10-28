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

import { serverDate } from "./timeframes.js";

// Moving averages come in five lines of each kind, for crossover strategies (an EMA 9 against an EMA 21,
// an SMA 50 against an SMA 200): each line has its own period and colour, and is switched on by itself.
// The first line of each keeps the id it had when there was only one ("sma", "ema"); the others are
// "sma2" to "sma5" and "ema2" to "ema5". The default colours are told apart by hue and lightness on the
// dark chart; the legend and the label on the price axis always name each line, so colour is never the
// only way to tell them apart.
export const MA_LINES = 5;
const MA_DEFAULTS = {
  sma: [[10, "#00a7b8"], [20, "#2962ff"], [50, "#7cb342"], [100, "#b2b5be"], [200, "#4dd0e1"]],
  ema: [[9, "#9c4fd6"], [21, "#ff9800"], [50, "#e91e63"], [100, "#fdd835"], [200, "#a1887f"]],
};
const maDefaults = (kind) => MA_DEFAULTS[kind].map(([period, colour]) => ({ on: false, period, colour }));
export const maId = (kind, slot) => (slot === 0 ? kind : `${kind}${slot + 1}`);

export const DEFAULT_INDICATORS = Object.freeze({
  sma: maDefaults("sma"),
  ema: maDefaults("ema"),
  vwap: { on: false },
  rsi: { on: false, period: 14 },
  atr: { on: false, period: 14 },
  adr: { on: false, period: 14, levels: true },
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
    const d = serverDate(candles.time[i]);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const typical = (candles.high[i] + candles.low[i] + candles.close[i]) / 3;
    pv += typical * candles.volume[i];
    vol += candles.volume[i];
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

/**
 * Average true range (Wilder), in points. True range: the largest of high - low, |high - previous close|
 * and |low - previous close| (the first candle: high - low). The first ATR is the simple average of the
 * first `n` true ranges; after that (previous * (n - 1) + true range) / n.
 */
export function atr(candles, n) {
  const len = candles.length;
  const out = new Float64Array(len).fill(NaN);
  let prev = NaN, sum = 0;
  for (let i = 0; i < len; i++) {
    const h = candles.high[i], l = candles.low[i];
    const tr = i === 0 ? h - l : Math.max(h - l, Math.abs(h - candles.close[i - 1]), Math.abs(l - candles.close[i - 1]));
    if (i < n) { sum += tr; if (i === n - 1) out[i] = prev = sum / n; continue; }
    out[i] = prev = (prev * (n - 1) + tr) / n;
  }
  return out;
}

/**
 * Average daily range, in points: the mean high - low of the last `n` COMPLETED broker-server days
 * before the candle's own day (a day runs from 17:00 New York). Today is never in its own average,
 * and during a replay a past day is complete because the clock has passed it.
 * Also the two ADR levels for the day so far: day's low + ADR and day's high - ADR, where the day's
 * high and low are of the candles revealed so far (they move as the day develops).
 * Returns { adr, high, low }; NaN until `n` days have completed.
 */
export function adr(candles, n) {
  const len = candles.length;
  const out = { adr: new Float64Array(len).fill(NaN), high: new Float64Array(len).fill(NaN), low: new Float64Array(len).fill(NaN) };
  const ranges = [];
  let day = null, hi = -Infinity, lo = Infinity;
  for (let i = 0; i < len; i++) {
    const d = serverDate(candles.time[i]);
    if (d !== day) {
      if (day !== null) ranges.push(hi - lo);
      day = d; hi = -Infinity; lo = Infinity;
    }
    hi = Math.max(hi, candles.high[i]);
    lo = Math.min(lo, candles.low[i]);
    if (ranges.length >= n) {
      let sum = 0;
      for (let k = ranges.length - n; k < ranges.length; k++) sum += ranges[k];
      const a = sum / n;
      out.adr[i] = a; out.high[i] = lo + a; out.low[i] = hi - a;
    }
  }
  return out;
}

/** Settings from storage, with anything odd replaced by the defaults. */
export function cleanIndicators(raw) {
  const out = structuredClone(DEFAULT_INDICATORS);
  if (!raw || typeof raw !== "object") return out;
  const goodPeriod = (v) => { const p = Number(v); return Number.isInteger(p) && p >= 2 && p <= 500 ? p : null; };
  for (const kind of ["sma", "ema"]) {
    // Settings saved before v2.6 held one line ({ on, period }); it becomes the first of the five.
    const list = Array.isArray(raw[kind]) ? raw[kind] : raw[kind] && typeof raw[kind] === "object" ? [raw[kind]] : [];
    for (let slot = 0; slot < MA_LINES; slot++) {
      const r = list[slot];
      if (!r || typeof r !== "object") continue;
      out[kind][slot].on = r.on === true;
      out[kind][slot].period = goodPeriod(r.period) ?? out[kind][slot].period;
      if (typeof r.colour === "string" && /^#[0-9a-f]{6}$/i.test(r.colour)) out[kind][slot].colour = r.colour.toLowerCase();
    }
  }
  for (const key of Object.keys(out)) {
    if (key === "sma" || key === "ema") continue;
    const r = raw[key];
    if (!r || typeof r !== "object") continue;
    out[key].on = r.on === true;
    if ("levels" in out[key] && typeof r.levels === "boolean") out[key].levels = r.levels;
    if ("period" in out[key]) out[key].period = goodPeriod(r.period) ?? out[key].period;
  }
  return out;
}

/** The moving-average lines switched on, in order: SMAs first, then EMAs. */
function maLines(settings) {
  const out = [];
  for (const kind of ["sma", "ema"]) {
    settings[kind].forEach((line, slot) => {
      if (line.on) out.push({ kind, id: maId(kind, slot), label: `${kind.toUpperCase()} ${line.period}`, period: line.period, colour: line.colour });
    });
  }
  return out;
}

/**
 * The lines to draw for `candles` under `settings`: [{ id, label, values, pane, colour? }].
 * pane: "price" (over the candles), "rsi" or "atr" (a panel of its own), "legend" (a value in the legend only).
 * ATR and ADR values are in points; the chart shows them in pips.
 */
export function computeIndicators(candles, settings) {
  // Only the first `length` candles. A replay's candle list (TimeframeView.display) keeps full-size arrays
  // behind it, and the slots past `length` can still hold candles the clock has hidden: reading the whole
  // array would be look-ahead. (Found on day 13 in the browser; there is a test for it.)
  const closes = candles.close.subarray(0, candles.length);
  const lines = [];
  for (const m of maLines(settings)) {
    lines.push({ id: m.id, label: m.label, values: (m.kind === "sma" ? sma : ema)(closes, m.period), pane: "price", colour: m.colour });
  }
  if (settings.vwap.on) lines.push({ id: "vwap", label: "VWAP (daily)", values: vwap(candles), pane: "price" });
  if (settings.rsi.on) lines.push({ id: "rsi", label: `RSI ${settings.rsi.period}`, values: rsi(closes, settings.rsi.period), pane: "rsi" });
  if (settings.atr.on) lines.push({ id: "atr", label: `ATR ${settings.atr.period}`, values: atr(candles, settings.atr.period), pane: "atr" });
  if (settings.adr.on) {
    const a = adr(candles, settings.adr.period);
    lines.push({ id: "adr", label: `ADR ${settings.adr.period}`, values: a.adr, pane: "legend" });
    if (settings.adr.levels) {
      lines.push({ id: "adrHigh", label: "ADR high", values: a.high, pane: "price" });
      lines.push({ id: "adrLow", label: "ADR low", values: a.low, pane: "price" });
    }
  }
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
    this.ma = this.ma || {}; // moving-average line id -> its values
    for (const id of Object.keys(this.ma)) this.ma[id] = keep(this.ma[id]);
    for (const name of ["rsi", "gain", "loss", "vwap", "pv", "vol", "atr", "adr", "adrHigh", "adrLow", "dayHi", "dayLo"]) this[name] = keep(this[name]);
    const keepPlain = (old) => { const a = new Float64Array(capacity); if (old) a.set(old.subarray(0, this.length)); return a; };
    this.day = keepPlain(this.day);
    this.adrDay = keepPlain(this.adrDay);
    if (!this.ranges) { this.ranges = []; this.rangeStarts = []; } // completed days' ranges, and the candle that ended each day
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
    const R = settings.rsi;
    const mas = maLines(settings);
    for (const m of mas) {
      if (!this.ma[m.id]) this.ma[m.id] = new Float64Array(this.capacity).fill(NaN);
      (m.kind === "sma" ? this.smaFrom : this.emaFrom).call(this, this.ma[m.id], c, m.period, from, n);
    }
    if (R.on) this.rsiFrom(c, R.period, from, n);
    if (settings.vwap.on) this.vwapFrom(candles, from, n);
    if (settings.atr.on) this.atrFrom(candles, settings.atr.period, from, n);
    if (settings.adr.on) this.adrFrom(candles, settings.adr.period, from, n);
    this.length = n;
    const lines = [];
    for (const m of mas) lines.push({ id: m.id, label: m.label, values: this.ma[m.id].subarray(0, n), pane: "price", colour: m.colour });
    if (settings.vwap.on) lines.push({ id: "vwap", label: "VWAP (daily)", values: this.vwap.subarray(0, n), pane: "price" });
    if (R.on) lines.push({ id: "rsi", label: `RSI ${R.period}`, values: this.rsi.subarray(0, n), pane: "rsi" });
    if (settings.atr.on) lines.push({ id: "atr", label: `ATR ${settings.atr.period}`, values: this.atr.subarray(0, n), pane: "atr" });
    if (settings.adr.on) {
      lines.push({ id: "adr", label: `ADR ${settings.adr.period}`, values: this.adr.subarray(0, n), pane: "legend" });
      if (settings.adr.levels) {
        lines.push({ id: "adrHigh", label: "ADR high", values: this.adrHigh.subarray(0, n), pane: "price" });
        lines.push({ id: "adrLow", label: "ADR low", values: this.adrLow.subarray(0, n), pane: "price" });
      }
    }
    return lines;
  }

  atrFrom(candles, p, from, n) {
    for (let i = from; i < n; i++) {
      const h = candles.high[i], l = candles.low[i];
      const tr = i === 0 ? h - l : Math.max(h - l, Math.abs(h - candles.close[i - 1]), Math.abs(l - candles.close[i - 1]));
      if (i < p - 1) { this.atr[i] = NaN; continue; }
      if (i === p - 1) {
        let sum = 0;
        for (let k = 0; k < p; k++) {
          const hk = candles.high[k], lk = candles.low[k];
          sum += k === 0 ? hk - lk : Math.max(hk - lk, Math.abs(hk - candles.close[k - 1]), Math.abs(lk - candles.close[k - 1]));
        }
        this.atr[i] = sum / p;
        continue;
      }
      this.atr[i] = (this.atr[i - 1] * (p - 1) + tr) / p;
    }
  }

  adrFrom(candles, p, from, n) {
    if (from === 0) { this.ranges = []; this.rangeStarts = []; }
    while (this.rangeStarts.length && this.rangeStarts[this.rangeStarts.length - 1] >= from) { this.ranges.pop(); this.rangeStarts.pop(); }
    for (let i = from; i < n; i++) {
      const d = serverDate(candles.time[i]);
      const sameDay = i > 0 && d === this.adrDay[i - 1];
      if (!sameDay && i > 0) { this.ranges.push(this.dayHi[i - 1] - this.dayLo[i - 1]); this.rangeStarts.push(i); }
      this.adrDay[i] = d;
      this.dayHi[i] = sameDay ? Math.max(this.dayHi[i - 1], candles.high[i]) : candles.high[i];
      this.dayLo[i] = sameDay ? Math.min(this.dayLo[i - 1], candles.low[i]) : candles.low[i];
      if (this.ranges.length >= p) {
        let sum = 0;
        for (let k = this.ranges.length - p; k < this.ranges.length; k++) sum += this.ranges[k];
        const a = sum / p;
        this.adr[i] = a; this.adrHigh[i] = this.dayLo[i] + a; this.adrLow[i] = this.dayHi[i] - a;
      } else {
        this.adr[i] = this.adrHigh[i] = this.adrLow[i] = NaN;
      }
    }
  }

  smaFrom(out, c, p, from, n) {
    // A running sum: add the new close, drop the one p candles back (five lines up to SMA 200 on
    // minute charts made adding up all p closes for every candle too slow).
    for (let i = from; i < Math.min(p - 1, n); i++) out[i] = NaN;
    const start = Math.max(from, p - 1);
    if (start >= n) return;
    let sum = 0;
    for (let k = start - p + 1; k <= start; k++) sum += c[k];
    out[start] = sum / p;
    for (let i = start + 1; i < n; i++) { sum += c[i] - c[i - p]; out[i] = sum / p; }
  }

  emaFrom(out, c, p, from, n) {
    const k = 2 / (p + 1);
    for (let i = from; i < n; i++) {
      if (i < p - 1) { out[i] = NaN; continue; }
      if (i === p - 1) { let sum = 0; for (let j = 0; j < p; j++) sum += c[j]; out[i] = sum / p; continue; }
      out[i] = c[i] * k + out[i - 1] * (1 - k);
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
      const d = serverDate(candles.time[i]);
      const fresh = i === 0 || d !== this.day[i - 1];
      const typical = (candles.high[i] + candles.low[i] + candles.close[i]) / 3;
      this.pv[i] = (fresh ? 0 : this.pv[i - 1]) + typical * candles.volume[i];
      this.vol[i] = (fresh ? 0 : this.vol[i - 1]) + candles.volume[i];
      this.day[i] = d;
      this.vwap[i] = this.vol[i] > 0 ? this.pv[i] / this.vol[i] : typical;
    }
  }
}
