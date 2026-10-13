// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowserStore } from "../js/store.js";
import { cleanStrategy, slug, strategyList } from "../js/strategies.js";

function memory() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v) };
}

test("a label becomes the same folder name as in Python", () => {
  // the same cases as tests/test_strategy_folders.py
  assert.equal(slug("Asian sweep (London)"), "asian_sweep_london");
  assert.equal(slug("  NBB / OTE  "), "nbb_ote");
  assert.equal(slug("Dollar-reversal 2"), "dollar_reversal_2");
  assert.equal(slug("!!!"), "");
  assert.equal(slug("x".repeat(80)).length, 48);
});

test("a strategy needs a safe name, a label and a known log", () => {
  assert.deepEqual(cleanStrategy("nbb", { label: " NBB OTE ", logger: "nbb" }), { label: "NBB OTE", logger: "nbb" });
  assert.deepEqual(cleanStrategy("asian", { label: "Asian sweep" }), { label: "Asian sweep", logger: "none" });
  for (const [name, data] of [["../x", { label: "x" }], ["nbb", { label: "" }], ["nbb", { label: "x".repeat(61) }],
    ["nbb", { label: "x", logger: "magic" }], ["nbb", null]]) {
    assert.ok(cleanStrategy(name, data).error, `${name} ${JSON.stringify(data)}`);
  }
});

test("the list shows each strategy's sessions, newest first, with the one to resume", () => {
  const sessions = [ // newest save first, as the stores list them
    { id: "bt-3", journal: "sweep", saved: "2026-10-13T09:00:00Z" },
    { id: "bt-2", journal: "nbb", saved: "2026-10-12T09:00:00Z" },
    { id: "bt-1", journal: "sweep", saved: "2026-10-11T09:00:00Z" },
    { id: "broken", journal: "sweep", error: "unreadable" },
  ];
  const list = strategyList(sessions, { sweep: { label: "Liquidity sweep", logger: "sweep" }, dollar: { label: "Dollar reversal" } }, { sweep: 4 });
  assert.deepEqual(list.map((s) => [s.name, s.label, s.logger, s.sessions, s.latest && s.latest.id, s.trades]), [
    ["sweep", "Liquidity sweep", "sweep", 2, "bt-3", 4],
    ["nbb", "nbb", "none", 1, "bt-2", 0],
    ["dollar", "Dollar reversal", "none", 0, null, 0], // created, not used yet
  ]);
});

test("online, strategies are kept in the browser with the sessions", async () => {
  const store = new BrowserStore(memory());
  assert.deepEqual(await store.listStrategies(), []);
  await store.putStrategy("asian_sweep", { label: "Asian sweep" });
  await assert.rejects(store.putStrategy("asian_sweep", { label: "x", logger: "magic" }), /Unknown log/);
  await store.putBacktest({ version: 1, id: "bt-1", name: "bt-1", journal: "asian_sweep", saved: "2026-10-13T10:00:00Z",
    trades: [{ id: 1, status: "CLOSED" }], actions: [], drawings: [] });
  const [only] = await store.listStrategies();
  assert.deepEqual([only.name, only.label, only.sessions, only.latest.id, only.trades], ["asian_sweep", "Asian sweep", 1, "bt-1", 1]);
});
