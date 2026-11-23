// Market state labels (order flow, Phase 4): where price is relative to the previous day's value area.
//
// The same definition as forex_replay/marketstate.py (read its notes), held to
// web/tests/fixtures/state_golden.json. Decision 0036. In short, on the closes of a 30-minute candle
// (a setting) built from the order-flow 1-minute bars of the current trading day, closed by the cursor:
//   ACCEPTED above/below: 2 consecutive closes outside value (a setting);
//   REJECTED above/below: price traded outside since the last close inside, then a close back inside within
//   60 minutes (a setting) of that first trade outside, with at most one outside close in between.
// Prices are in the order-flow files' units (2 x points).

import { serverDate } from "./timeframes.js";

export const STATE_TIMEFRAMES = [900, 1800, 3600];
export const STATE_SETTINGS = Object.freeze({ on: false, labels: true, timeframe: 1800, accept: 2, window: 3600 });

/** The words for each state, as the status box shows them. */
export const STATE_WORDS = {
  no_value: "No prior value area", no_bars: "No bars yet today", inside: "Inside value",
  above: "Above value", below: "Below value", accepted_above: "Accepted above", accepted_below: "Accepted below",
  rejected_above: "Rejected above", rejected_below: "Rejected below",
};

/** The Market state settings, cleaned: anything missing or odd takes the default. */
export function cleanStateSettings(raw) {
  const out = { ...STATE_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.on === "boolean") out.on = raw.on;
  if (typeof raw.labels === "boolean") out.labels = raw.labels;
  const tf = Number(raw.timeframe), accept = Number(raw.accept), window = Number(raw.window);
  if (STATE_TIMEFRAMES.includes(tf)) out.timeframe = tf;
  if (Number.isInteger(accept) && accept >= 1 && accept <= 6) out.accept = accept;
  if (Number.isInteger(window) && window >= 60 && window <= 6 * 3600 && window % 60 === 0) out.window = window;
  return out;
}

/**
 * Events of the cursor's trading day so far, and the state at the cursor.
 * bars: { length, time, high, low, close } sorted by time; seconds: a bar's length; val, vah: the previous
 * day's value area (null when there is none). Returns { events: [{ time, kind, side, price }], state, price }.
 */
export function marketState(bars, seconds, cursor, val, vah, timeframe = 1800, accept = 2, window = 3600) {
  if (val === null || vah === null || val === undefined || vah === undefined) return { events: [], state: "no_value", price: null };
  if (!STATE_TIMEFRAMES.includes(timeframe)) throw new Error(`timeframe must be one of ${STATE_TIMEFRAMES}`);
  const times = bars.time;
  const today = serverDate(cursor - 1);
  let a = 0, b = bars.length;
  const from = cursor - 86400 - seconds;
  while (a < b) { const mid = (a + b) >> 1; if (times[mid] < from) a = mid + 1; else b = mid; }
  const rows = [];
  for (let i = a; i < bars.length && times[i] + seconds <= cursor; i++) if (serverDate(times[i]) === today) rows.push(i);

  const events = [];
  const firstOut = { above: null, below: null }; // first trade outside since the last close inside value
  let outside = 0, runSide = null, run = 0, rejected = null, lastSide = null;
  const finish = (bucket, close) => {
    const end = bucket + timeframe;
    const side = close > vah ? "above" : close < val ? "below" : "inside";
    if (side === "inside") {
      for (const out of ["above", "below"]) {
        const t0 = firstOut[out];
        if (t0 !== null && outside <= 1 && end - t0 <= window) {
          events.push({ time: end, kind: "rejected", side: out, price: close });
          rejected = out;
        }
      }
      firstOut.above = firstOut.below = null;
      outside = 0; runSide = null; run = 0;
    } else {
      outside += 1;
      rejected = null;
      run = runSide === side ? run + 1 : 1;
      runSide = side;
      if (run === accept) events.push({ time: end, kind: "accepted", side, price: close });
    }
    lastSide = side;
  };

  let current = null, lastClose = null;
  for (const i of rows) {
    const bucket = times[i] - (times[i] % timeframe);
    if (bucket !== current) {
      if (current !== null) finish(current, lastClose);
      current = bucket;
    }
    if (firstOut.above === null && bars.high[i] > vah) firstOut.above = times[i];
    if (firstOut.below === null && bars.low[i] < val) firstOut.below = times[i];
    lastClose = bars.close[i];
  }
  if (current !== null && current + timeframe <= cursor) finish(current, lastClose);

  let state;
  if (rows.length === 0) state = "no_bars";
  else if (lastSide === null) state = lastClose > vah ? "above" : lastClose < val ? "below" : "inside";
  else if (lastSide === "inside") state = rejected ? `rejected_${rejected}` : "inside";
  else state = run >= accept ? `accepted_${runSide}` : runSide;
  return { events, state, price: lastClose };
}

/** A marker's words on the chart: "Acc ↑", "Rej ↓" ... */
export function eventLabel(e) {
  return `${e.kind === "accepted" ? "Acc" : "Rej"} ${e.side === "above" ? "↑" : "↓"}`;
}
