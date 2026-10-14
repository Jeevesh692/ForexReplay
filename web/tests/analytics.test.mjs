// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  applyFilters, balanceCurve, breakdown, computeStats, dailyPnl, equityCurve, filterChoices, gaveBack, histogram, longestStreak,
  maxDrawdown, money, monthWeeks, num, parseRows, propCheck,
} from "../js/analytics.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/stats_golden.json", import.meta.url), "utf-8"));
const close = (a, b, label) => {
  if (b === "inf") return assert.equal(a, Infinity, label);
  if (b === "nan") return assert.ok(Number.isNaN(a), `${label}: expected NaN, got ${a}`);
  assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);
};

test(`every statistic matches stats.py on ${fixture.journals.length} recorded journals`, () => {
  let compared = 0;
  fixture.journals.forEach((j, n) => {
    const trades = parseRows(j.rows);
    const stats = computeStats(trades);
    if (j.stats === null) { assert.equal(stats, null, `journal ${n}`); return; }
    for (const [key, value] of Object.entries(j.stats)) { close(stats[key], value, `journal ${n} ${key}`); compared++; }
    for (const by of fixture.groups) {
      const table = breakdown(trades, { exit_reason: "exitReason" }[by] || by); // journal column -> trade field
      assert.equal(table.length, Object.keys(j.breakdowns[by]).length, `journal ${n} ${by}`);
      for (const row of table) {
        for (const key of ["trades", "win_rate", "total_r", "expectancy_r"]) {
          close(row[key], j.breakdowns[by][row.group][key], `journal ${n} ${by}=${row.group} ${key}`);
          compared++;
        }
      }
    }
    const prop = propCheck(stats, fixture.risk_pct);
    for (const key of ["return_pct", "max_drawdown_pct", "worst_day_pct"]) close(prop[key], j.prop[key], `journal ${n} ${key}`);
  });
  assert.ok(compared > 2000, `only ${compared} numbers compared`);
});

test("an empty cell is no value, never zero", () => {
  assert.ok(Number.isNaN(num("")));
  assert.ok(Number.isNaN(num(undefined)));
  assert.equal(num("0"), 0);
  const trades = parseRows([{ result_r: "1", mfe_r: "" }, { result_r: "", mfe_r: "2" }]);
  assert.equal(trades.length, 1);
  assert.ok(Number.isNaN(computeStats(trades).avg_mfe_r));
});

const t = (r, extra = {}) => ({ r, run: "a", side: "BUY", session: "London", tags: [], mfe: NaN, money: NaN, commission: NaN, exitDay: "2026-03-02", ...extra });

test("drawdown, streaks and the equity curve", () => {
  const trades = [1, 1, -1, -1, -1, 2].map((r) => t(r));
  assert.deepEqual(equityCurve(trades), [1, 2, 1, 0, -1, 1]);
  assert.equal(maxDrawdown(trades), 3);
  assert.equal(maxDrawdown([-1, -1, 3].map((r) => t(r))), 2); // from the starting 0
  assert.equal(longestStreak([-1, 0, -1, 1, -1].map((r) => t(r)), "loss"), 2); // a breakeven does not break a run
});

test("tags: a trade with two tags counts in both groups", () => {
  const trades = [t(2, { tags: ["A+ setup", "London"] }), t(-1, { tags: ["London"] }), t(1)];
  const table = breakdown(trades, (x) => (x.tags.length ? x.tags : ["(no tag)"]));
  assert.deepEqual(table.map((row) => [row.group, row.trades, row.total_r]), [["London", 2, 1], ["A+ setup", 1, 2], ["(no tag)", 1, 1]]);
});

test("histogram buckets, give-backs, money and filters", () => {
  const trades = [t(-1, { mfe: 1.2, money: -100, commission: 4 }), t(-1, { mfe: 0.3 }), t(-0.4), t(0.6, { session: "Asia" }), t(2.1, { side: "SELL", tags: ["FOMO"] })];
  assert.deepEqual(histogram(trades).map((b) => [b.from, b.count]), [[-1, 2], [-0.5, 1], [0, 0], [0.5, 1], [1, 0], [1.5, 0], [2, 1]]);
  assert.deepEqual(gaveBack(trades), { losers: 3, known: 2, reached: 1 });
  assert.deepEqual(money(trades), { trades: 1, net: -100, commission: 4 });
  assert.equal(applyFilters(trades, { side: "SELL" }).length, 1);
  assert.equal(applyFilters(trades, { tag: "FOMO", session: "London" }).length, 1);
  assert.equal(applyFilters(trades, { session: "Asia", side: "SELL" }).length, 0);
  assert.deepEqual(filterChoices(trades).session, ["London", "Asia"]);
});

test("balance curve: in the order trades closed, from the starting balance, skipping trades without $", () => {
  const at = (exit, money, r = 1) => t(r, { money, exitDay: exit.slice(0, 10), row: { exit_time: exit } });
  const trades = [at("2026-03-03 10:00:00", 50), at("2026-03-02 09:00:00", -20), at("2026-03-02 11:00:00", NaN), at("2026-03-04 08:00:00", 30)];
  assert.deepEqual(balanceCurve(trades, 1000).map((p) => p.balance), [980, 1030, 1060]);
  assert.deepEqual(balanceCurve(trades).map((p) => p.balance), [-20, 30, 60]);
  assert.deepEqual(balanceCurve([]), []);
});

test("P&L calendar: days summed, $ counted only where recorded, weeks Sunday first with week totals", () => {
  const trades = [t(1, { money: 100, exitDay: "2026-09-01" }), t(-1, { money: -40, exitDay: "2026-09-01" }), t(2, { exitDay: "2026-09-03" }),
    t(1, { money: 25, exitDay: "2026-10-02" })];
  const days = dailyPnl(trades);
  assert.deepEqual(days.get("2026-09-01"), { money: 60, r: 0, trades: 2, withMoney: 2 });
  assert.deepEqual(days.get("2026-09-03"), { money: 0, r: 2, trades: 1, withMoney: 0 });
  const weeks = monthWeeks(2026, 9, days); // 1 Sep 2026 is a Tuesday
  assert.equal(weeks.length, 5);
  assert.equal(weeks[0].days[0].date, "2026-08-30");
  assert.equal(weeks[0].days[0].inMonth, false);
  assert.deepEqual(weeks[0].total, { money: 60, r: 2, trades: 3, withMoney: 2 });
  assert.equal(weeks[4].days[6].date, "2026-10-03");
  assert.deepEqual(weeks[4].total, { money: 25, r: 1, trades: 1, withMoney: 1 }); // the week runs into October
  assert.equal(monthWeeks(2026, 2, new Map()).length, 4); // February 2026 starts on a Sunday and fills four rows exactly
});
