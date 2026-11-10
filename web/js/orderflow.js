// Synthetic order flow (order flow, Phase 5): RVOL, bubbles, absorption, delta, CVD and divergence.
//
// The same definitions as forex_replay/orderflow.py (read its notes), held to
// web/tests/fixtures/orderflow_golden.json. Decision 0037. Prices and moves are in the order-flow files' units
// (2 x points); baselines are stored x 2 (-1: not 20 days yet). Only minutes and 15-second buckets that had
// closed by the replay's cursor are used.

import { indexAtOrBefore, timeframe as timeframeInfo } from "./timeframes.js";
import { logicalToX } from "./drawings.js";

export const RESETS = ["session", "day", "anchor"];
export const FLOW_LAYER = Object.freeze({
  show: true, rvol: false, bubbles: false, absorption: false, cvd: false, deltaBars: false, reset: "session", anchor: null,
  divergence: false, lookback: 20, minRvol: 3.0, medium: 5.0, large: 8.0, fallback: true, bubbleMove: {}, absorptionMove: {},
});
// `show` is the master switch (Alt + O): off, every automatic order-flow item is hidden (the prior day's levels,
// naked POCs, market state, RVOL, CVD, bubbles); each feature also has its own switch, off until chosen.
export const STORAGE_KEY = "forexreplay.flowlayer";
export const MIN_RVOL_FLOOR = 0.5; // bubbles can be asked for from half the usual activity upwards

const upperBound = (a, n, x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };
const lowerBound = (a, n, x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

/** The order-flow layer's settings, cleaned: anything missing or odd takes the default. Moves are prices, per pair. */
export function cleanFlowLayer(raw) {
  const out = { ...FLOW_LAYER, bubbleMove: {}, absorptionMove: {} };
  if (!raw || typeof raw !== "object") return out;
  for (const k of ["show", "rvol", "bubbles", "absorption", "cvd", "deltaBars", "divergence", "fallback"]) if (typeof raw[k] === "boolean") out[k] = raw[k];
  if (RESETS.includes(raw.reset)) out.reset = raw.reset;
  if (Number.isInteger(raw.anchor) && raw.anchor > 0) out.anchor = raw.anchor;
  const lookback = Number(raw.lookback);
  if (Number.isInteger(lookback) && lookback >= 2 && lookback <= 500) out.lookback = lookback;
  const r = Number(raw.minRvol), m = Number(raw.medium), l = Number(raw.large);
  if (Number.isFinite(r) && r >= MIN_RVOL_FLOOR && r <= 50) out.minRvol = Math.round(r * 100) / 100; // any multiple, to 2 decimals
  if (Number.isFinite(m) && m >= out.minRvol && m <= 100) out.medium = Math.round(m * 100) / 100;
  if (Number.isFinite(l) && l >= out.medium && l <= 200) out.large = Math.round(l * 100) / 100;
  if (out.medium < out.minRvol) out.medium = out.minRvol;
  if (out.large < out.medium) out.large = out.medium;
  for (const key of ["bubbleMove", "absorptionMove"]) {
    if (!raw[key] || typeof raw[key] !== "object") continue;
    for (const [symbol, value] of Object.entries(raw[key])) {
      const v = Number(value);
      if (/^[A-Z]{6}$/.test(symbol) && value !== null && value !== "" && Number.isFinite(v) && v >= 0 && v <= 100000) out[key][symbol] = v;
    }
  }
  return out;
}

/** Relative tick volume, or null without a usable baseline. */
export function rvol(ticks, baselineX2) {
  if (baselineX2 === null || baselineX2 === undefined || baselineX2 <= 0) return null;
  return (2 * ticks) / baselineX2;
}

/** A bubble, an absorption, or null, for one 15-second bucket. */
export function classifyBucket(open, close, ticks, baselineX2, bubbleMove, absorptionMove, minRvol = 3.0, medium = 5.0, large = 8.0) {
  const r = rvol(ticks, baselineX2);
  if (r === null || r < minRvol) return null;
  const move = close - open;
  const size = r >= large ? 3 : r >= medium ? 2 : 1;
  if (Math.abs(move) >= bubbleMove) return { kind: "bubble", side: move > 0 ? "up" : "down", size, rvol: r };
  if (Math.abs(move) <= absorptionMove) return { kind: "absorption", side: null, size, rvol: r };
  return null;
}

/** Every bubble and absorption among the buckets in [start, end) that had closed by the cursor, with its bucket's delta. */
export function bubbles(buckets, start, end, cursor, bubbleMove, absorptionMove, minRvol = 3.0, medium = 5.0, large = 8.0) {
  const out = [];
  const t = buckets.time, s = buckets.seconds;
  for (let i = lowerBound(t, buckets.length, start); i < buckets.length; i++) {
    if (t[i] >= end || t[i] + s > cursor) break;
    const c = classifyBucket(buckets.open[i], buckets.close[i], buckets.tick_count[i], buckets.baseline_x2[i], bubbleMove, absorptionMove, minRvol, medium, large);
    if (c) out.push({ time: t[i], price: buckets.close[i], ...c, delta: buckets.up_ticks[i] - buckets.down_ticks[i] });
  }
  return out;
}

/** Delta estimated from a candle alone: tick volume x (close - open) / (high - low). */
export function fallbackDelta(volume, open, high, low, close) {
  return high === low ? 0 : (volume * (close - open)) / (high - low);
}

/**
 * Per chart candle: ticks, baseline sum, rvol, delta and cvd (null where the candle has no minute).
 * starts: the candles' open times (the first `n` are used). bars: the order-flow 1-minute bars { length, time,
 * tick_count, up_ticks, down_ticks, baseline_x2 }. fallback: 1-minute candles { length, time, open, high, low,
 * close, volume } used before `flowFirst`. `from` (optional): start reading minutes at this time (see FlowSeries).
 */
export function candleFlow(starts, n, seconds, cursor, bars, resets, fallback = null, flowFirst = null, from = -Infinity) {
  const ticks = new Array(n).fill(null), base = new Array(n).fill(null), delta = new Array(n).fill(null), cvd = new Array(n).fill(null);
  const complete = new Array(n).fill(true);
  let running = 0, period = null;
  const add = (t, d, k, b) => {
    const p = upperBound(resets, resets.length, t);
    if (p !== period) { running = 0; period = p; }
    running += d;
    const c = upperBound(starts, n, t) - 1;
    if (c < 0) return;
    const end = c + 1 < n ? Math.min(starts[c] + seconds, starts[c + 1]) : starts[c] + seconds;
    if (t >= end) return;
    delta[c] = (delta[c] ?? 0) + d;
    cvd[c] = running;
    if (k !== null) {
      ticks[c] = (ticks[c] ?? 0) + k;
      if (b < 0) complete[c] = false;
      else base[c] = (base[c] ?? 0) + b;
    }
  };
  if (fallback && flowFirst !== null) {
    for (let i = lowerBound(fallback.time, fallback.length, from); i < fallback.length; i++) {
      const t = fallback.time[i];
      if (t >= flowFirst || t + 60 > cursor) break;
      add(t, fallbackDelta(fallback.volume[i], fallback.open[i], fallback.high[i], fallback.low[i], fallback.close[i]), null, null);
    }
  }
  for (let i = lowerBound(bars.time, bars.length, from); i < bars.length; i++) {
    const t = bars.time[i];
    if (t + 60 > cursor) break;
    add(t, bars.up_ticks[i] - bars.down_ticks[i], bars.tick_count[i], bars.baseline_x2[i]);
  }
  const rv = ticks.map((k, c) => (k !== null && complete[c] && base[c] ? rvol(k, base[c]) : null));
  return { ticks, base, rvol: rv, delta, cvd };
}

/** Candles making a new high (low) of their reset period while CVD makes no new high (low) over `lookback`. */
export function divergences(starts, highs, lows, cvd, resets, lookback = 20) {
  const out = [];
  let first = 0;
  for (let i = 0; i < starts.length; i++) {
    if (i === 0 || upperBound(resets, resets.length, starts[i]) !== upperBound(resets, resets.length, starts[i - 1])) { first = i; continue; }
    if (cvd[i] === null) continue;
    const window = cvd.slice(Math.max(first, i - lookback), i).filter((v) => v !== null);
    if (window.length === 0) continue;
    if (highs[i] > Math.max(...highs.slice(first, i)) && cvd[i] <= Math.max(...window)) out.push({ index: i, side: "bearish" });
    else if (lows[i] < Math.min(...lows.slice(first, i)) && cvd[i] >= Math.min(...window)) out.push({ index: i, side: "bullish" });
  }
  return out;
}

/** Trading-day starts (17:00 New York) between two times: the hours where the broker-server date changes. */
export function dayResets(first, last, serverDate) {
  const out = [];
  let previous = null;
  for (let h = first - (first % 3600); h < last + 3600; h += 3600) {
    const d = serverDate(h);
    if (previous !== null && d !== previous) out.push(h);
    previous = d;
  }
  return out;
}

/**
 * RVOL, delta and CVD for one chart timeframe, kept up to date as the replay moves. A candle that had closed
 * keeps its values; each call works out again only the candles from the first one still open (at this or the
 * previous cursor), reading minutes from the last reset before it, so a step costs a day of minutes at most.
 */
export class FlowSeries {
  constructor() { this.key = null; this.n = 0; this.cursor = -Infinity; this.values = null; }

  /** full: the timeframe's candles; resets: sorted UTC times; returns { rvol, delta, cvd, changedFrom }. */
  compute(full, seconds, cursor, bars, resets, fallback, flowFirst, key) {
    const n = full.length, starts = full.time;
    const end = (i) => (i + 1 < n ? Math.min(starts[i] + seconds, starts[i + 1]) : starts[i] + seconds);
    let k;
    if (key !== this.key || !this.values || n < this.n - 1 || (n > 0 && this.firstTime !== starts[0])) {
      this.values = { ticks: [], base: [], rvol: [], delta: [], cvd: [] };
      k = 0;
    } else {
      k = Math.max(0, Math.min(this.n - 1, n));
      const limit = Math.min(cursor, this.cursor);
      let a = 0, b = k; // the first candle not closed under both cursors
      while (a < b) { const m = (a + b) >> 1; if (end(m) <= limit) a = m + 1; else b = m; }
      k = a;
    }
    const v = this.values;
    for (const name of Object.keys(v)) v[name].length = n;
    if (k < n) {
      const r = upperBound(resets, resets.length, starts[k]);
      const from = r > 0 ? resets[r - 1] : -Infinity;
      const part = candleFlow(starts.subarray ? starts.subarray(k, n) : starts.slice(k, n), n - k, seconds, cursor, bars, resets, fallback, flowFirst, from);
      for (const name of Object.keys(v)) for (let i = k; i < n; i++) v[name][i] = part[name][i - k];
    }
    Object.assign(this, { key, n, cursor, firstTime: n ? starts[0] : null });
    return { ...v, changedFrom: k };
  }
}

/** Bubbles and absorption painted over the candles, at each bucket's time inside its candle and its close price. */
export class BubbleLayer {
  constructor(view, provide, onPaint = null) {
    this.view = view;
    this.provide = provide; // (fromUtc, toUtc) -> { items, digits } | null
    this.onPaint = onPaint; // ({ bubbles, absorption }) on screen, after each paint (the Bubbles panel's count)
    const draw = (target) => target.useMediaCoordinateSpace(({ context }) => this.paint(context));
    this.views = [{ zOrder: () => "normal", renderer: () => ({ draw }) }];
    view.series.attachPrimitive(this);
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }
  redraw() { if (this.requestUpdate) this.requestUpdate(); }

  paint(ctx) {
    const v = this.view;
    const c = v.candles;
    if (!c || c.length === 0) return;
    const scale = v.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const tf = timeframeInfo(v.timeframe).seconds;
    const a = Math.max(0, Math.floor(range.from)), b = Math.min(c.length - 1, Math.ceil(range.to));
    if (b < a) return;
    const info = this.provide(c.time[a], c.time[b] + tf);
    if (this.onPaint) {
      const items = info ? info.items : [];
      this.onPaint({ bubbles: items.filter((it) => it.kind === "bubble").length, absorption: items.filter((it) => it.kind === "absorption").length });
    }
    if (!info) return;
    const unit = 10 ** info.digits;
    ctx.save();
    for (const it of info.items) {
      const i = indexAtOrBefore(c, it.time);
      if (i < 0) continue;
      const logical = i - 0.5 + Math.min(1, (it.time + 7.5 - c.time[i]) / tf); // spread across its candle, like a footprint
      const x = logicalToX(scale, logical);
      const y = v.series.priceToCoordinate(it.price / 2 / unit);
      if (x === null || y === null) continue;
      const radius = [0, 3.5, 6, 9][it.size];
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      if (it.kind === "absorption") {
        ctx.strokeStyle = "rgba(178, 181, 190, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = it.side === "up" ? "rgba(38, 166, 154, 0.55)" : "rgba(239, 83, 80, 0.55)";
        ctx.strokeStyle = it.side === "up" ? "#26a69a" : "#ef5350";
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

