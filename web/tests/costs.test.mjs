// Run with:  node --test web/tests/*.test.mjs
// Order flow, Phase 7: the position tool's size, costs and R after costs, held to Python's answers (costs_golden.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cleanCostSettings, COST_SETTINGS, minTargetR, positionPlan, stopLimits, warningText } from "../js/costs.js";

const g = JSON.parse(readFileSync(new URL("./fixtures/costs_golden.json", import.meta.url), "utf-8"));

test("every golden plan matches Python", () => {
  for (const [n, c] of g.cases.entries()) {
    const i = c.inputs;
    const got = positionPlan(i.side, i.entry, i.stop, i.target, {
      balance: i.balance, riskPercent: i.risk_percent, pointValue: i.point_value, pipPoints: i.pip_points, spreadPoints: i.spread_points,
      commissionPerLot: i.commission_per_lot, perSide: i.per_side, slippagePips: i.slippage_pips, minStopPips: i.min_stop_pips,
      maxStopPips: i.max_stop_pips, minTargetR: i.min_target_r,
    });
    assert.deepEqual(got, c.expected, `case ${n}`);
  }
});

test("by hand: EURUSD, 10 pips of stop, 1 pip of spread, 0.2 pip of slippage, $4 a lot", () => {
  // $10,000 at 0.5% = $50; 100 points of stop at $1 a point a lot = $100 a lot, so 0.50 lots.
  const p = positionPlan("long", 110000, 109900, 110250, { balance: 10000, riskPercent: 0.5, pointValue: 1, pipPoints: 10, spreadPoints: 10 });
  assert.equal(p.units, 50);
  assert.equal(p.stop_pips, 10);
  assert.equal(p.rr, 2.5);
  // Cost a lot: (10 + 2) points x $1 + $4 = $16, against $100 a lot at the stop: 0.16R.
  assert.ok(Math.abs(p.cost_r - 0.16) < 1e-12);
  assert.ok(Math.abs(p.target_r - 2.34) < 1e-12 && Math.abs(p.stop_r + 1.16) < 1e-12);
  assert.ok(Math.abs(p.cost_money - 8) < 1e-9, "0.50 lots x $16");
  const perSide = positionPlan("long", 110000, 109900, 110250, { balance: 10000, riskPercent: 0.5, pointValue: 1, pipPoints: 10, spreadPoints: 10, perSide: true });
  assert.ok(Math.abs(perSide.cost_r - 0.2) < 1e-12, "$8 a lot when charged per side");
  assert.ok(positionPlan("short", 110000, 109900, 110250, { balance: 1, riskPercent: 1, pointValue: 1, pipPoints: 10, spreadPoints: 0 }).error);
});

test("warnings: stop limits per pair and the model's target after costs", () => {
  const s = cleanCostSettings(null);
  const [min, max] = stopLimits(s, "EURUSD");
  assert.deepEqual([min, max], [6, 20]);
  assert.deepEqual(stopLimits(s, "XAUUSD"), [20, 80], "gold: 2.00 to 8.00 is 20 to 80 pips of 0.10");
  assert.deepEqual(stopLimits(s, "GBPUSD"), [null, null]);
  assert.deepEqual(stopLimits(cleanCostSettings({ minStop: { GBPUSD: 8 } }), "GBPUSD"), [8, null]);
  // 5-pip stop, target 2.1R before costs: under the minimum stop, and under 2R once costs are taken off.
  const p = positionPlan("long", 110000, 109950, 110105, { balance: 10000, riskPercent: 0.5, pointValue: 1, pipPoints: 10, spreadPoints: 5,
    minStopPips: min, maxStopPips: max, minTargetR: minTargetR(s) });
  assert.deepEqual(p.warnings, ["stop_below_min", "target_below_min"]);
  assert.deepEqual(warningText(p, { minStopPips: 6, maxStopPips: 20, minTargetR: 2, model: "A" }), ["stop under 6 pips", "target under 2R after costs (Model A)"]);
  assert.equal(minTargetR({ ...s, model: "B" }), 1.5);
  assert.equal(minTargetR({ ...s, model: "none" }), null);
});

test("settings: defaults, nonsense refused", () => {
  assert.deepEqual(cleanCostSettings(null), { ...COST_SETTINGS, minStop: {}, maxStop: {} });
  const s = cleanCostSettings({ slippagePips: -1, model: "C", targetA: 3, maxStop: { XAUUSD: "90", bad: 3 } });
  assert.deepEqual([s.slippagePips, s.model, s.targetA, s.maxStop], [0.2, "A", 3, { XAUUSD: 90 }]);
});

test("the position drawing shows the costs on its labels, and warnings on a line of their own", async () => {
  const { layout } = await import("../js/drawings.js");
  const d = { type: "long", points: [{ time: 1000, price: 110000 }, { time: 2000, price: 110000 }], stop: 109950, target: 110105 };
  const proj = { x: (t) => t / 10, y: (p) => 120000 - p, width: 800, height: 600, formatPrice: String, pips: (p) => p / 10 };
  const plain = layout(d, { ...proj, note: () => "0.50 lots" });
  assert.ok(plain.labels.some((l) => l.text === "Long 110000 · 0.50 lots"), "a plain note still goes on the entry line");
  const shown = layout(d, { ...proj, note: () => ({ entry: "costs 0.16R", target: "2.04R after costs", stop: "−1.16R after costs", warn: "⚠ stop under 6 pips" }) });
  const text = shown.labels.map((l) => l.text);
  assert.ok(text.includes("Target 110105 · 10.5 pips · 2.10R · 2.04R after costs"));
  assert.ok(text.includes("Stop 109950 · 5.0 pips · −1.16R after costs"));
  const stop = shown.labels.find((l) => l.text.startsWith("Stop")), warn = shown.labels.find((l) => l.text.startsWith("⚠"));
  assert.equal(warn.y, stop.y + 13, "one line beyond the stop's label, so the two never overlap");
});

test("dollars per point per lot: Python's costs.point_value is the account's pointValueFor", async () => {
  const { pointValueFor } = await import("../js/account.js");
  for (const c of g.point_values) {
    const pv = pointValueFor(c.symbol, c.digits, c.contract);
    assert.equal(typeof pv === "function" ? pv(c.price) : pv, c.expected, `${c.symbol} at ${c.price}`);
  }
  assert.ok(g.point_values.some((c) => c.symbol === "USDJPY"), "a pair whose point value moves with the price");
});
