// The position tool's sums (order flow, Phase 7): size, costs and R after costs.
//
// The same definition as forex_replay/costs.py (read its notes), held to web/tests/fixtures/costs_golden.json.
// Decision 0039. Prices are whole points; money is dollars. Results in R are always after costs.

import { LOT_UNITS, unitsForRisk } from "./account.js";

export const STORAGE_KEY = "forexreplay.costs";
/** Stops in pips that the brief allows, per pair (EURUSD 6-20 pips; gold 2.00-8.00, a pip being 0.10). */
export const STOP_LIMITS = Object.freeze({ EURUSD: [6, 20], XAUUSD: [20, 80] });
export const COST_SETTINGS = Object.freeze({ slippagePips: 0.2, model: "A", targetA: 2.0, targetB: 1.5, minStop: {}, maxStop: {} });
export const WARNINGS = {
  too_small: "risk too small for 0.01 lots", stop_below_min: "stop under {min} pips", stop_above_max: "stop over {max} pips",
  target_below_min: "target under {target}R after costs (Model {model})",
};

/** The tool's settings, cleaned: anything missing or odd takes the default. Stop limits are pips, per pair. */
export function cleanCostSettings(raw) {
  const out = { ...COST_SETTINGS, minStop: {}, maxStop: {} };
  if (!raw || typeof raw !== "object") return out;
  const num = (v, low, high) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) && n >= low && n <= high ? n : null; };
  out.slippagePips = num(raw.slippagePips, 0, 100) ?? out.slippagePips;
  if (["A", "B", "none"].includes(raw.model)) out.model = raw.model;
  out.targetA = num(raw.targetA, 0, 50) ?? out.targetA;
  out.targetB = num(raw.targetB, 0, 50) ?? out.targetB;
  for (const key of ["minStop", "maxStop"]) {
    if (!raw[key] || typeof raw[key] !== "object") continue;
    for (const [symbol, value] of Object.entries(raw[key])) {
      const v = num(value, 0, 100000);
      if (/^[A-Z]{6}$/.test(symbol) && v !== null) out[key][symbol] = v;
    }
  }
  return out;
}

/** A pair's stop limits in pips: the setting, else the brief's for that pair, else none. */
export function stopLimits(settings, symbol) {
  const brief = STOP_LIMITS[symbol] || [null, null];
  return [settings.minStop[symbol] ?? brief[0], settings.maxStop[symbol] ?? brief[1]];
}

/** The model's minimum target in R after costs, or null for none. */
export const minTargetR = (settings) => (settings.model === "A" ? settings.targetA : settings.model === "B" ? settings.targetB : null);

/** Everything the position tool shows, or { error } when the stop and target are on the wrong sides. */
export function positionPlan(side, entry, stop, target, { balance, riskPercent, pointValue, pipPoints, spreadPoints,
  commissionPerLot = 4.0, perSide = false, slippagePips = 0.2, minStopPips = null, maxStopPips = null, minTargetR: minR = null }) {
  const direction = side === "long" ? 1 : -1;
  if (!(direction * (entry - stop) > 0 && direction * (target - entry) > 0)) {
    return { error: "The stop must be below the entry and the target above it (the other way round for a short)." };
  }
  const riskPoints = Math.abs(entry - stop), rewardPoints = Math.abs(target - entry);
  const stopPips = riskPoints / pipPoints;
  const rr = rewardPoints / riskPoints;
  const commission = commissionPerLot * (perSide ? 2 : 1); // per lot, round trip
  const slippagePoints = slippagePips * pipPoints;
  const costPerLot = (spreadPoints + slippagePoints) * pointValue + commission;
  const costR = costPerLot / (riskPoints * pointValue);
  const units = unitsForRisk({ balance, riskPercent, riskPoints, pointValue });
  const lots = units / LOT_UNITS;
  const warnings = [];
  if (units < 1) warnings.push("too_small");
  if (minStopPips !== null && stopPips < minStopPips) warnings.push("stop_below_min");
  if (maxStopPips !== null && stopPips > maxStopPips) warnings.push("stop_above_max");
  if (minR !== null && rr - costR < minR) warnings.push("target_below_min");
  return {
    stop_pips: stopPips, target_pips: rewardPoints / pipPoints, rr, units,
    risk_money: lots * riskPoints * pointValue, spread_money: lots * spreadPoints * pointValue,
    slippage_money: lots * slippagePoints * pointValue, commission_money: lots * commission,
    cost_money: lots * costPerLot, cost_r: costR, target_r: rr - costR, stop_r: -1 - costR, warnings,
  };
}

/** The words for a plan's warnings. */
export function warningText(plan, { minStopPips, maxStopPips, minTargetR: minR, model }) {
  return plan.warnings.map((w) => WARNINGS[w].replace("{min}", minStopPips).replace("{max}", maxStopPips)
    .replace("{target}", minR).replace("{model}", model));
}
