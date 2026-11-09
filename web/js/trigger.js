// The trigger panel (order flow, Phase 6): is the current 5-minute candle a trigger, long or short?
//
// The same rules as forex_replay/trigger.py (read its notes), held to web/tests/fixtures/trigger_golden.json.
// Decision 0038. In short: body >= 50% of the range; range >= 1.2 x ATR(14) of the candles before; close in
// the top (long) or bottom (short) 25%; RVOL >= 1.5; and, switched off by default, a same-direction bubble of
// 3x or more inside an LVN zone the candle trades into, with no opposite absorption there. On when every rule
// switched on passes.

export const RULES = ["body", "range", "close", "rvol", "bubble"];
export const RULE_NAMES = { // short, for the panel; RULE_HELP says it in full (the row's tooltip)
  body: "Body ≥ {body}%", range: "Range ≥ {range}× ATR", close: "Close {end} {zone}%", rvol: "RVOL ≥ {rvol}x", bubble: "Bubble ≥ {bubbleRvol}x in LVN",
};
export const RULE_HELP = {
  body: "The candle's body (open to close) is at least this share of its range (high to low).",
  range: "The candle's range is at least this many times ATR({atr}) of the 5-minute candles before it.",
  close: "The close is in the top (long) or bottom (short) part of the range, this share of it.",
  rvol: "The candle's ticks against the same five minutes over the last 20 days.",
  bubble: "The candle trades into an LVN zone of a profile you drew, and inside that zone there is a same-direction bubble of at least this RVOL and no absorption against you (for a long: buyers absorbed, up ticks beating down ticks).",
};
export const TRIGGER_SETTINGS = Object.freeze({
  side: "long", body: 0.5, rangeAtr: 1.2, atrPeriod: 14, closeZone: 0.25, minRvol: 1.5, bubbleRvol: 3.0,
  on: { body: true, range: true, close: true, rvol: true, bubble: false },
});
export const STORAGE_KEY = "forexreplay.trigger";

const lowerBound = (a, n, x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

/** The panel's settings, cleaned: anything missing or odd takes the default. */
export function cleanTriggerSettings(raw) {
  const out = { ...TRIGGER_SETTINGS, on: { ...TRIGGER_SETTINGS.on } };
  if (!raw || typeof raw !== "object") return out;
  if (raw.side === "long" || raw.side === "short") out.side = raw.side;
  const num = (v, low, high) => { const n = Number(v); return Number.isFinite(n) && n >= low && n <= high ? Math.round(n * 100) / 100 : null; };
  out.body = num(raw.body, 0.05, 1) ?? out.body;
  out.rangeAtr = num(raw.rangeAtr, 0.1, 10) ?? out.rangeAtr;
  out.closeZone = num(raw.closeZone, 0.05, 0.5) ?? out.closeZone;
  out.minRvol = num(raw.minRvol, 0, 50) ?? out.minRvol;
  out.bubbleRvol = num(raw.bubbleRvol, 1, 50) ?? out.bubbleRvol;
  const period = Number(raw.atrPeriod);
  if (Number.isInteger(period) && period >= 2 && period <= 200) out.atrPeriod = period;
  if (raw.on && typeof raw.on === "object") for (const r of RULES) if (typeof raw.on[r] === "boolean") out.on[r] = raw.on[r];
  return out;
}

/** The 5-minute candle of the last revealed 1-minute candle: { start, open, high, low, close, minutes, closed }, or null. */
export function currentM5(minutes, cursor) {
  const t = minutes.time;
  const last = lowerBound(t, minutes.length, cursor - 60 + 1) - 1; // the last minute with time + 60 <= cursor
  if (last < 0) return null;
  const start = t[last] - (t[last] % 300);
  const first = lowerBound(t, minutes.length, start);
  let high = -Infinity, low = Infinity;
  for (let i = first; i <= last; i++) { high = Math.max(high, minutes.high[i]); low = Math.min(low, minutes.low[i]); }
  return { start, open: minutes.open[first], high, low, close: minutes.close[last], minutes: last - first + 1, closed: start + 300 <= cursor };
}

/** Every 5-minute candle built from the minutes (the UTC five-minute grid). */
export function m5Candles(minutes) {
  const out = { time: [], open: [], high: [], low: [], close: [] };
  for (let i = 0; i < minutes.length; i++) {
    const start = minutes.time[i] - (minutes.time[i] % 300);
    const k = out.time.length - 1;
    if (k >= 0 && out.time[k] === start) {
      out.high[k] = Math.max(out.high[k], minutes.high[i]);
      out.low[k] = Math.min(out.low[k], minutes.low[i]);
      out.close[k] = minutes.close[i];
    } else {
      out.time.push(start); out.open.push(minutes.open[i]); out.high.push(minutes.high[i]); out.low.push(minutes.low[i]); out.close.push(minutes.close[i]);
    }
  }
  out.length = out.time.length;
  return out;
}

/** ATR at the last 5-minute candle opening before `start`, from ATR values worked out on every candle (indicators.atr). */
export function atrBefore(m5, atrValues, start) {
  const k = lowerBound(m5.time, m5.length, start) - 1;
  return k >= 0 && Number.isFinite(atrValues[k]) ? atrValues[k] : null;
}

/** The four candle rules: { name: { pass, value, need } }. side: "long" or "short". */
export function candleRules(open, high, low, close, atr, rvol, side, body = 0.5, rangeAtr = 1.2, closeZone = 0.25, minRvol = 1.5) {
  const rng = high - low;
  const long = side === "long";
  return {
    body: { pass: rng > 0 && Math.abs(close - open) >= body * rng, value: rng > 0 ? Math.abs(close - open) / rng : null, need: body },
    range: { pass: atr !== null && atr > 0 && rng >= rangeAtr * atr, value: atr ? rng / atr : null, need: rangeAtr },
    close: { pass: rng > 0 && (long ? close >= high - closeZone * rng : close <= low + closeZone * rng), value: rng > 0 ? (close - low) / rng : null, need: closeZone },
    rvol: { pass: rvol !== null && rvol >= minRvol, value: rvol, need: minRvol },
  };
}

/** The bubble rule: { pass, zone, same, opposite } for the candle's bubbles and absorption and the LVN zones. */
export function bubbleRule(items, zones, candleLow, candleHigh, side, bubbleRvol = 3.0) {
  const want = side === "long" ? "up" : "down";
  let best = null;
  const sorted = [...zones].sort((a, b) => a.low - b.low || a.high - b.high);
  for (const z of sorted) {
    if (z.low > candleHigh || z.high < candleLow) continue; // the candle did not trade into this zone
    const inside = items.filter((it) => z.low <= it.price && it.price <= z.high);
    const same = inside.filter((it) => it.kind === "bubble" && it.side === want && it.rvol >= bubbleRvol).length;
    const opposite = inside.filter((it) => it.kind === "absorption" && (side === "long" ? it.delta > 0 : it.delta < 0)).length;
    const found = { pass: same > 0 && opposite === 0, zone: { low: z.low, high: z.high }, same, opposite };
    if (found.pass) return found;
    best = best || found;
  }
  return best || { pass: false, zone: null, same: 0, opposite: 0 };
}

/** On when every rule switched on passes (and at least one is on). */
export function trigger(rules, enabled) {
  const on = RULES.filter((name) => enabled[name] && rules[name]);
  return on.length > 0 && on.every((name) => rules[name].pass);
}
