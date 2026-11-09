// Volume-profile drawing tools (order flow, Phase 3).
//
//   * Fixed range profile ("vprofile"): two clicks, a start candle and an end candle, on any timeframe.
//   * Anchored profile ("aprofile"): one click; it grows candle by candle to the replay's cursor.
//   * Prior-day profile and naked POCs: drawn by ProfileLevels, not by you (switched on in Order flow settings).
//
// A profile is always built from the order-flow M1 bars or 15-second buckets inside its time window
// (web/js/profile.js, the same definition as Python's), never from the candles on screen, and only from bars
// that had closed by the replay cursor: a profile's right edge is clamped to the cursor. Prices: the
// order-flow files hold 2 x points, the chart holds points, so values are halved for drawing.

import { logicalToX, timeToLogical } from "./drawings.js";
import { timeframe as timeframeInfo } from "./timeframes.js";

export const PROFILE_TOOLS = ["vprofile", "aprofile"];
export const STORAGE_KEY = "forexreplay.profiles";
export const SOURCES = ["M1", "S15"];
export const SIDES = ["left", "right"];
export const POC_COLOUR = "#fdd835";

/** Every profile setting, with the brief's defaults. `bin` is a price (EURUSD 0.0001, gold 0.50) set per pair. */
export const PROFILE_SETTINGS = Object.freeze({
  source: "M1", bin: null, valueArea: 0.70, lvn: 0.35, smoothing: 3,
  extend: false, side: "left", width: 0.35, colour: "#2962ff", pocColour: POC_COLOUR,
});

const hex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const inRange = (v, low, high) => Number.isFinite(v) && v >= low && v <= high;

/** One profile's settings, cleaned: anything missing or odd takes the default. */
export function cleanProfileSettings(raw, fallback = PROFILE_SETTINGS) {
  const out = { ...PROFILE_SETTINGS, ...fallback };
  if (!raw || typeof raw !== "object") return out;
  if (SOURCES.includes(raw.source)) out.source = raw.source;
  const bin = Number(raw.bin);
  if (raw.bin !== null && raw.bin !== "" && inRange(bin, 1e-9, 100000)) out.bin = bin;
  const va = Number(raw.valueArea), lvn = Number(raw.lvn), smoothing = Number(raw.smoothing), width = Number(raw.width);
  if (inRange(va, 0.1, 0.99)) out.valueArea = Math.round(va * 100) / 100;
  if (inRange(lvn, 0.01, 0.95)) out.lvn = Math.round(lvn * 100) / 100;
  if (Number.isInteger(smoothing) && smoothing >= 1 && smoothing <= 9 && smoothing % 2 === 1) out.smoothing = smoothing;
  if (inRange(width, 0.05, 1)) out.width = Math.round(width * 100) / 100;
  if (typeof raw.extend === "boolean") out.extend = raw.extend;
  if (SIDES.includes(raw.side)) out.side = raw.side;
  if (hex(raw.colour)) out.colour = raw.colour.toLowerCase();
  if (hex(raw.pocColour)) out.pocColour = raw.pocColour.toLowerCase();
  return out;
}

/** The Order flow settings: defaults for new profiles, a bin per pair, and the automatic levels. */
export function cleanFlowSettings(raw) {
  const out = { defaults: { ...PROFILE_SETTINGS }, bins: {}, priorDay: false, naked: false, nakedDays: 5 };
  if (!raw || typeof raw !== "object") return out;
  out.defaults = cleanProfileSettings(raw.defaults);
  out.defaults.bin = null; // the bin is per pair, below
  if (raw.bins && typeof raw.bins === "object") {
    for (const [symbol, value] of Object.entries(raw.bins)) {
      const v = Number(value);
      if (/^[A-Z]{6}$/.test(symbol) && value !== null && value !== "" && inRange(v, 1e-9, 100000)) out.bins[symbol] = v;
    }
  }
  if (typeof raw.priorDay === "boolean") out.priorDay = raw.priorDay;
  if (typeof raw.naked === "boolean") out.naked = raw.naked;
  const n = Number(raw.nakedDays);
  if (Number.isInteger(n) && n >= 1 && n <= 30) out.nakedDays = n;
  return out;
}

/** A new profile drawing's settings: the defaults, with this pair's bin (or the instrument's own default). */
export function newProfileSettings(flowSettings, symbol, instrumentBin) {
  return cleanProfileSettings({ ...flowSettings.defaults, bin: flowSettings.bins[symbol] ?? instrumentBin });
}

const rgba = (colour, alpha) => `rgba(${parseInt(colour.slice(1, 3), 16)}, ${parseInt(colour.slice(3, 5), 16)}, ${parseInt(colour.slice(5, 7), 16)}, ${alpha})`;
const LVN_FILL = "rgba(239, 83, 80, 0.13)";

/**
 * Pixels for a profile drawing. `computed` = { start, end, profile } from the profiler (start and end in UTC
 * seconds, the end already clamped to the cursor; profile in order-flow units), or { message } while there is
 * nothing to draw. proj as in drawings.layout. Items carry their own colour (painted as given).
 */
export function profileLayout(d, proj, computed) {
  const out = { lines: [], boxes: [], labels: [], handles: [] };
  const s = d.profile;
  const p0 = d.points[0];
  if (d.type === "vprofile") out.handles.push({ key: "p0", x: proj.x(p0.time), y: proj.y(p0.price) }, { key: "p1", x: proj.x(d.points[1].time), y: proj.y(d.points[1].price) });
  else out.handles.push({ key: "p0", x: proj.x(p0.time), y: proj.y(p0.price) });
  if (!computed || !computed.profile) {
    const x = proj.x(p0.time), y = proj.y(p0.price);
    out.boxes.push({ x: x - 4, y: y - 14, w: 160, h: 20, role: "textbox", colour: "rgba(0,0,0,0)" });
    out.labels.push({ x: x + 6, y: y + 2, text: (computed && computed.message) || "Profile: no order-flow bars here", align: "left", role: "measure", colour: "#b2b5be" });
    return out;
  }
  const { profile: pr, start, end } = computed;
  const half = (v) => v / 2; // order-flow units (2 x points) -> chart points
  const x0 = proj.x(start), x1 = Math.max(proj.x(end), x0 + 2);
  const yOf = (units) => proj.y(half(units));
  const top = (pr.first_bin + pr.volumes.length) * pr.bin_size, bottom = pr.first_bin * pr.bin_size;
  // A faint frame over the whole range: it is what you click to select the profile.
  out.boxes.push({ x: x0, y: yOf(top), w: x1 - x0, h: yOf(bottom) - yOf(top), role: "frame", colour: rgba(s.colour, 0.04) });
  for (const z of pr.lvns) out.boxes.push({ x: x0, y: yOf(z.high), w: x1 - x0, h: Math.max(1, yOf(z.low) - yOf(z.high)), role: "lvn", colour: LVN_FILL });
  const most = Math.max(...pr.volumes);
  const span = (x1 - x0) * s.width;
  pr.volumes.forEach((v, k) => {
    if (v <= 0) return;
    const yTop = yOf((pr.first_bin + k + 1) * pr.bin_size), yBottom = yOf((pr.first_bin + k) * pr.bin_size);
    const length = Math.max(1, (span * v) / most);
    const inside = k >= pr.va_bins[0] && k <= pr.va_bins[1];
    out.boxes.push({
      x: s.side === "left" ? x0 : x1 - length, y: yTop + 0.5, w: length, h: Math.max(1, yBottom - yTop - 1),
      role: "bin", colour: k === pr.poc ? rgba(s.pocColour, 0.75) : rgba(s.colour, inside ? 0.5 : 0.22),
    });
  });
  const right = s.extend ? Math.max(proj.width, x1) : x1;
  const level = (units, name, colour, dash, width) => {
    const y = yOf(units);
    out.lines.push({ x1: x0, y1: y, x2: right, y2: y, role: name, colour, dash, width });
    out.labels.push({ x: right - 4, y: y - 3, text: `${name.toUpperCase()} ${proj.formatPrice(half(units))}`, align: "right", role: name, colour });
  };
  level((pr.poc_low + pr.poc_high) / 2, "poc", s.pocColour, [], 1.5);
  level(pr.vah, "vah", s.colour, [4, 3], 1);
  level(pr.val, "val", s.colour, [4, 3], 1);
  return out;
}

/** The profile's time window: [start, end) in UTC seconds, before clamping to the cursor. */
export function profileWindow(d, tfSeconds, lastTime) {
  if (d.type === "vprofile") {
    const [a, b] = [d.points[0].time, d.points[1].time];
    return { start: Math.min(a, b), end: Math.max(a, b) + tfSeconds }; // the end candle is inside the range
  }
  return { start: d.points[0].time, end: lastTime }; // anchored: up to now
}

/**
 * The prior day's POC, VAH and VAL across the current trading day, and naked POCs running right until price
 * touches them, painted as a primitive under the drawings. `provide()` returns { levels, cursor, digits } or
 * null; levels come from profile.dayLevels (order-flow units).
 */
export class ProfileLevels {
  constructor(view, provide) {
    this.view = view;
    this.provide = provide;
    const draw = (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize));
    this.views = [{ zOrder: () => "normal", renderer: () => ({ draw }) }];
    view.series.attachPrimitive(this);
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }
  redraw() { if (this.requestUpdate) this.requestUpdate(); }

  paint(ctx, size) {
    const v = this.view;
    const info = this.provide();
    if (!info || !v.candles || v.candles.length === 0) return;
    const { levels, cursor } = info;
    const tf = timeframeInfo(v.timeframe).seconds;
    const x = (time) => logicalToX(v.chart.timeScale(), timeToLogical(v.candles, tf, time));
    const unit = 10 ** v.digits;
    const y = (units) => v.series.priceToCoordinate(units / 2 / unit);
    const now = Math.min(cursor, v.candles.time[v.candles.length - 1] + tf);
    const line = (from, to, units, colour, dash, label) => {
      const xa = x(from), xb = x(to), yy = y(units);
      if (xa === null || xb === null || yy === null || xb < 0 || xa > size.width) return;
      ctx.strokeStyle = colour;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(Math.max(xa, 0), yy);
      ctx.lineTo(Math.min(xb, size.width), yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colour;
      ctx.fillText(`${label} ${(units / 2 / unit).toFixed(v.digits)}`, Math.min(xb, size.width) - 4, yy - 3);
    };
    ctx.save();
    ctx.font = '10px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "right";
    ctx.lineWidth = 1;
    if (levels.prior && levels.day_start !== null) {
      const p = levels.prior;
      line(levels.day_start, now, p.poc, POC_COLOUR, [], "pPOC");
      line(levels.day_start, now, p.vah, "#90a4ae", [5, 4], "pVAH");
      line(levels.day_start, now, p.val, "#90a4ae", [5, 4], "pVAL");
    }
    for (const n of levels.naked) line(n.from, n.to === null ? now : n.to, n.poc, "rgba(255, 152, 0, 0.9)", [2, 3], n.to === null ? "nPOC" : "nPOC hit");
    ctx.restore();
  }
}

