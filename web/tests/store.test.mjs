// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRows } from "../js/analytics.js";
import { BROWSER_KEY, BrowserStore, journalRow, openStore, ServerStore } from "../js/store.js";

/** localStorage stand-in. */
function memory(limit = Infinity) {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { if (v.length > limit) { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; } data.set(k, v); },
    raw: data,
  };
}

const UTC_0905 = Date.parse("2026-03-05T09:05:00Z") / 1000; // server time 11:05 (UTC+2 in early March)
const trade = (id, extra = {}) => ({
  id, status: "CLOSED", side: "BUY", orderType: "MARKET", placedTime: UTC_0905 - 300, entryTime: UTC_0905, exitTime: UTC_0905 + 3300,
  entryPrice: 108500, exitPrice: 108700, stopLoss: 108400, takeProfit: 108700, plannedRisk: 100, pnl: 200, resultR: 2,
  plannedRewardR: 2, mfeR: 2, maeR: 0.3, exitReason: "TAKE_PROFIT", lots: 1.5, money: 296, commission: 6,
  note: "a note", tags: ["A+ setup", "London"], screenshots: [], ...extra,
});
const backtest = (id, trades, extra = {}) => ({
  version: 1, id, name: id, journal: "j1", symbol: "EURUSD", digits: 5, pipPoints: 10, created: `2026-10-04T10:0${id.slice(-1)}:00Z`,
  saved: `2026-10-04T11:0${id.slice(-1)}:00Z`, startTime: 1, furthestTime: 2, result: { closed: trades.length }, trades, actions: [], drawings: [], ...extra,
});

test("the online store keeps backtests in the browser: save, list, open, delete", async () => {
  const storage = memory();
  const store = new BrowserStore(storage);
  assert.equal(store.screenshots, false);
  const first = await store.putBacktest(backtest("bt-1", [trade(1), { ...trade(2), status: "OPEN" }]));
  assert.equal(first.journalAdded, 1);
  assert.equal((await store.putBacktest(backtest("bt-1", [trade(1), trade(2)]))).journalAdded, 1); // the second trade closed since
  await store.putBacktest(backtest("bt-2", [trade(1)], { journal: "j2" }));
  const list = await store.listBacktests();
  assert.deepEqual(list.map((b) => b.id), ["bt-2", "bt-1"]); // newest save first
  assert.ok(!("actions" in list[0])); // a summary, like the server's
  assert.equal((await store.getBacktest("j1", "bt-1")).trades.length, 2);
  assert.deepEqual(await store.listJournals(), [{ name: "j1", trades: 2 }, { name: "j2", trades: 1 }]);
  await store.deleteBacktest("j2", "bt-2");
  assert.deepEqual((await store.listBacktests()).map((b) => b.id), ["bt-1"]);
  await assert.rejects(store.getBacktest("j2", "bt-2"), /No saved backtest/);
  storage.setItem(BROWSER_KEY, "{damaged"); // a damaged store reads as empty instead of breaking the app
  assert.deepEqual(await store.listBacktests(), []);
});

test("a full browser store says so in plain words", async () => {
  const store = new BrowserStore(memory(50));
  await assert.rejects(store.putBacktest(backtest("bt-1", [trade(1)])), /storage is full/);
});

test("online journal rows are the rows the server writes, and analytics reads them the same way", () => {
  const row = journalRow(trade(7), backtest("bt-1", []));
  assert.equal(row.entry_time, "2026-03-05 11:05:00"); // the broker server clock, as in trades.csv
  assert.equal(row.session, "London");
  assert.equal(row.weekday, "Thursday");
  assert.equal(Number(row.entry_price), 1.085);
  assert.equal(Number(row.risk_pips), 10);
  assert.equal(Number(row.pnl_pips), 20);
  assert.equal(Number(row.duration_min), 55);
  assert.equal(row.tags, "A+ setup; London");
  const [parsed] = parseRows([row]);
  assert.deepEqual([parsed.r, parsed.session, parsed.money, parsed.commission, parsed.tags], [2, "London", 296, 6, ["A+ setup", "London"]]);
});

test("the app finds out where it runs from site.json", async () => {
  const answer = (ok, body) => async () => ({ ok, json: async () => body });
  assert.equal((await openStore(answer(true, { static: true }))).kind, "browser");
  assert.equal((await openStore(answer(false, {}))).kind, "server");
  assert.equal((await openStore(async () => { throw new Error("offline"); })).kind, "server");
  assert.ok(new ServerStore().screenshots);
});
