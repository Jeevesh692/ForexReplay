// The ADR plan: ADR as a unit of measurement, not a signal.
//
// ADR10 is the average high - low of the last 10 COMPLETED daily candles (a day closes at 17:00
// New York, the broker server's midnight). It is worked out once, before the day starts, and fixed
// for the whole day. Every threshold of the trading plan is a multiple of it (the minimum sweep
// penetration, the stop buffer, the smallest stop worth taking...), so one rule fits EURUSD and gold,
// quiet years and wild ones. This file holds the plan and the arithmetic; nothing here places trades.
//
// During a replay "today" is the replay's day, and only days the replay has passed are averaged.

import { serverDate } from "./timeframes.js";

export const STORAGE_KEY = "forexreplay.adrplan";

/** Jeevesh's plan (4 Oct 2026). Multipliers are of ADR; the R:R floor is a plain ratio. */
export const DEFAULT_PLAN = Object.freeze({
  period: 10,
  rrFloor: 1.5,
  rows: [
    { id: "p", label: "p · minimum sweep penetration", mult: 0.02 },
    { id: "pmax", label: "Pmax · maximum sweep penetration (beyond it: a breakout, not a sweep)", mult: 0.30 },
    { id: "b", label: "b · stop / target buffer", mult: 0.02 },
    { id: "minStop", label: "minStop · skip a trade with a smaller stop", mult: 0.08 },
    { id: "disp1", label: "Displacement size, 1m", mult: 0.04 },
    { id: "disp5", label: "Displacement size, 5m", mult: 0.08 },
    { id: "disp15", label: "Displacement size, 15m", mult: 0.15 },
    { id: "dispH1", label: "Displacement size, H1", mult: 0.25 },
    { id: "fvg5", label: "FVG minimum, 1m / 5m", mult: 0.01 },
    { id: "fvg15", label: "FVG minimum, 15m", mult: 0.02 },
  ],
});

const ID = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

/** A plan from storage made safe: period 2-100, R:R floor 0-20, up to 20 rows with a label and a multiplier 0-10. */
export function cleanPlan(raw) {
  const out = structuredClone(DEFAULT_PLAN);
  if (!raw || typeof raw !== "object") return out;
  const period = Number(raw.period);
  if (Number.isInteger(period) && period >= 2 && period <= 100) out.period = period;
  const rr = Number(raw.rrFloor);
  if (raw.rrFloor !== null && raw.rrFloor !== "" && Number.isFinite(rr) && rr >= 0 && rr <= 20) out.rrFloor = rr;
  if (Array.isArray(raw.rows)) {
    const rows = [];
    const seen = new Set();
    for (const r of raw.rows) {
      if (!r || typeof r !== "object" || !ID.test(r.id) || seen.has(r.id)) continue;
      const mult = Number(r.mult);
      if (!Number.isFinite(mult) || mult < 0 || mult > 10) continue;
      const label = String(r.label ?? "").slice(0, 80).trim() || r.id;
      rows.push({ id: r.id, label, mult });
      seen.add(r.id);
      if (rows.length === 20) break;
    }
    out.rows = rows;
  }
  return out;
}

/**
 * ADR for the day of M5 candle `endIndex`: the mean high - low of the `period` completed days before it.
 * Returns { adr (points), days: [{ date, high, low }], today (server date number) } or { adr: NaN, days } when
 * fewer days have completed. Reads candles 0..endIndex only.
 */
export function adrBefore(m5, endIndex, period) {
  const today = serverDate(m5.time[endIndex]);
  const days = [];
  let i = endIndex;
  while (i >= 0 && serverDate(m5.time[i]) === today) i--; // skip today: it is not complete
  while (i >= 0 && days.length < period) {
    const date = serverDate(m5.time[i]);
    let high = -Infinity, low = Infinity;
    while (i >= 0 && serverDate(m5.time[i]) === date) {
      high = Math.max(high, m5.high[i]);
      low = Math.min(low, m5.low[i]);
      i--;
    }
    days.push({ date, high, low });
  }
  days.reverse();
  const adr = days.length < period ? NaN : days.reduce((s, d) => s + d.high - d.low, 0) / period;
  return { adr, days, today };
}

/** Each row of the plan in points for a given ADR (points). */
export function thresholds(plan, adr) {
  return plan.rows.map((r) => ({ ...r, points: r.mult * adr }));
}

/**
 * Warnings for an order before it is placed (none means it fits the plan). Prices in points.
 * Uses the plan's minStop row (if present) and its R:R floor. The plan advises; it never blocks an order.
 */
export function checkOrder(plan, adr, { entry, stopLoss, takeProfit }, pipPoints) {
  const warnings = [];
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  const minStop = plan.rows.find((r) => r.id === "minStop");
  if (minStop && Number.isFinite(adr) && risk > 0 && risk < minStop.mult * adr) {
    warnings.push(`Stop ${(risk / pipPoints).toFixed(1)} pips is below minStop (${(minStop.mult * adr / pipPoints).toFixed(1)} pips): your plan says skip it.`);
  }
  if (risk > 0 && plan.rrFloor > 0 && reward / risk < plan.rrFloor) {
    warnings.push(`Reward/risk ${(reward / risk).toFixed(2)} is below your ${plan.rrFloor} floor (for structural targets).`);
  }
  return warnings;
}
