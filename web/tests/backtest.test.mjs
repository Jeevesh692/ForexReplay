// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BacktestError, compareTrades, drawingsBefore, indexOfTime, newId, rebuild, snapshot, tradeRecord, validName,
} from "../js/backtest.js";
import { Candles } from "../js/data.js";
import { DrawingStore } from "../js/drawings.js";
import { ReplayClock } from "../js/replay.js";
import { TimeframeView } from "../js/timeframes.js";
import { InvalidOrder, Side, Trading } from "../js/trading.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const MANIFEST = { symbol: "EURUSD", digits: 5, pip_points: 10 };
const ENV = { pipPoints: 10, pointValue: 1 };

/** A random walk of M5 candles (seeded, so every run of the test sees the same market). */
function randomMarket(n, seed) {
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rows = [];
  let price = 110000;
  for (let i = 0; i < n; i++) {
    const o = price + Math.round((rand() - 0.5) * 6);
    const c = o + Math.round((rand() - 0.5) * 60);
    const h = Math.max(o, c) + Math.round(rand() * 25);
    const l = Math.min(o, c) - Math.round(rand() * 25);
    rows.push([utc("2026-03-02T00:00") + i * 300, o, h, l, c, 10, rand() < 0.1 ? 3 : 0]);
    price = c;
  }
  return { m5: Candles.fromBuffer(new Int32Array(rows.flat()).buffer), rand };
}

function startRun(m5, startAt) {
  const clock = new ReplayClock(m5.length);
  const trading = new Trading({ m5, clock, ...ENV, settings: { startingBalance: 10000, commissionPerLot: 4 } });
  clock.start(startAt);
  trading.startTime = m5.time[startAt - 1]; // where the run began, for save() below
  return { clock, trading };
}

function save(m5, clock, trading) {
  const meta = { id: "bt-test", name: "test", journal: "test_journal", created: "now", startTime: trading.startTime };
  const drawings = new DrawingStore();
  // Through JSON, as it goes to the server and back.
  return JSON.parse(JSON.stringify(snapshot(meta, { trading, drawings, m5, clock, manifest: MANIFEST, timeframe: "M15" })));
}

/** Try one random thing a trader might do; refusals are part of the test too. */
function randomAction(rand, trading, clock, view) {
  const pip = 10;
  const pick = rand();
  const trades = trading.broker.trades.filter((t) => t.isActive);
  const some = trades[Math.floor(rand() * trades.length)];
  try {
    if (pick < 0.2) {
      const side = rand() < 0.5 ? Side.BUY : Side.SELL;
      const dir = side === Side.BUY ? 1 : -1;
      const entry = trading.plannedEntry({ side, type: "market" }) + Math.round((rand() - 0.5) * 40 * pip);
      const type = rand() < 0.5 ? "market" : "pending";
      const base = type === "market" ? trading.plannedEntry({ side, type }) : entry;
      trading.place({
        side, type, price: type === "pending" ? entry : undefined,
        stopLoss: base - dir * Math.round((3 + rand() * 15) * pip), takeProfit: base + dir * Math.round((3 + rand() * 30) * pip),
      });
    } else if (pick < 0.3 && some) {
      const dir = some.side === Side.BUY ? 1 : -1;
      trading.modifyTrade(some.id, { stopLoss: trading.bid - dir * Math.round((2 + rand() * 10) * pip) });
    } else if (pick < 0.35 && some) {
      trading.partialClose(some.id, rand() < 0.5 ? 25 : 50);
    } else if (pick < 0.4 && some) {
      if (some.status === "OPEN") trading.closeTrade(some.id); else trading.cancelOrder(some.id);
    } else if (pick < 0.42) {
      trading.closeAll();
    } else if (pick < 0.44 && some) {
      trading.breakeven(some.id);
    } else if (pick < 0.47) {
      trading.updateSettings(rand() < 0.5 ? { riskPercent: 0.5 + Math.round(rand() * 4) / 2 } : { sizeMode: rand() < 0.5 ? "lots" : "risk" });
    } else if (pick < 0.52) {
      trading.updateSettings({ minSpreadPips: Math.round(rand() * 10) / 10 });
    } else if (pick < 0.6) {
      clock.stepBack(view); // look back: actions are refused until live again
    } else if (pick < 0.65) {
      clock.backToLive();
    } else {
      clock.advance(1 + Math.floor(rand() * 6));
    }
  } catch (err) {
    if (!(err instanceof InvalidOrder)) throw err;
  }
}

test("a rebuilt backtest matches the original run exactly, over 60 random runs", () => {
  let actions = 0, trades = 0;
  for (let run = 0; run < 60; run++) {
    const { m5, rand } = randomMarket(700, 1000 + run);
    const { clock, trading } = startRun(m5, 50 + Math.floor(rand() * 100));
    const view = new TimeframeView(m5, "M15");
    for (let step = 0; step < 250; step++) randomAction(rand, trading, clock, view);
    const saved = save(m5, clock, trading);

    const { trading: again, position, problems } = rebuild(saved, { m5, ...ENV });
    assert.deepEqual(problems, [], `run ${run}`);
    assert.equal(position, clock.furthest);
    assert.deepEqual(again.broker.trades.map((t) => tradeRecord(t, m5, again.account)), saved.trades);
    assert.deepEqual(again.actions, saved.actions);
    assert.equal(again.balance, trading.balance);
    assert.deepEqual(again.account.settings, trading.account.settings);
    actions += saved.actions.length;
    trades += saved.trades.length;
  }
  assert.ok(actions > 1000 && trades > 300, `only ${actions} actions and ${trades} trades were exercised`);
});

test("a resumed run carries on exactly as if it had never stopped", () => {
  const { m5 } = randomMarket(400, 7);
  // One run straight through...
  const a = startRun(m5, 100);
  a.trading.place({ side: Side.BUY, type: "market", stopLoss: a.trading.ask - 150, takeProfit: a.trading.ask + 400 });
  a.clock.advance(30);
  // ...and the same run saved after 10 candles, rebuilt, and continued for 20 more.
  const b = startRun(m5, 100);
  b.trading.place({ side: Side.BUY, type: "market", stopLoss: b.trading.ask - 150, takeProfit: b.trading.ask + 400 });
  b.clock.advance(10);
  const { trading: rebuilt, position } = rebuild(save(m5, b.clock, b.trading), { m5, ...ENV });
  const c = startRun(m5, position);
  c.trading.adopt(rebuilt);
  c.trading.startTime = b.trading.startTime;
  c.clock.advance(20);
  assert.deepEqual(save(m5, c.clock, c.trading).trades, save(m5, a.clock, a.trading).trades);
});

test("a settings change while looking back is recorded at the live candle, where it takes effect", () => {
  const { m5 } = randomMarket(200, 3);
  const { clock, trading } = startRun(m5, 50);
  clock.advance(12);
  clock.stepBack(new TimeframeView(m5, "M15"));
  trading.updateSettings({ minSpreadPips: 1.5 });
  assert.equal(trading.actions.at(-1).at, m5.time[clock.furthest - 1]);
});

test("a save that no longer matches the engine is reported, not passed silently", () => {
  const { m5 } = randomMarket(300, 11);
  const { clock, trading } = startRun(m5, 60);
  trading.place({ side: Side.SELL, type: "market", stopLoss: trading.bid + 120, takeProfit: trading.bid - 300 });
  clock.advance(40);
  const saved = save(m5, clock, trading);
  saved.trades[0].entryPrice += 5; // as if the fill rules had changed since the save
  saved.actions.push({ at: m5.time[clock.furthest - 1], kind: "close", id: 99 });
  const { problems } = rebuild(saved, { m5, ...ENV });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /could not be repeated: There is no trade #99/);
  assert.match(problems[1], /Trade #1 differs in entryPrice/);
});

test("a save whose candles are not in the data is refused with a reason", () => {
  const { m5 } = randomMarket(100, 5);
  const { clock, trading } = startRun(m5, 20);
  const saved = save(m5, clock, trading);
  assert.throws(() => rebuild({ ...saved, startTime: saved.startTime + 7 }, { m5, ...ENV }), BacktestError);
  assert.throws(() => rebuild({ ...saved, version: 99 }, { m5, ...ENV }), BacktestError);
  assert.throws(() => rebuild({ ...saved, actions: null }, { m5, ...ENV }), BacktestError);
});

test("only drawings made before the replay's start come along into a new run", () => {
  const line = (time) => ({ type: "hline", points: [{ time, price: 110000 }] });
  const trend = (a, b) => ({ type: "trend", points: [{ time: a, price: 1 }, { time: b, price: 2 }] });
  const kept = drawingsBefore([line(100), line(500), trend(50, 200), trend(50, 600)], 300);
  assert.deepEqual(kept, [line(100), trend(50, 200)]);
});

test("helpers: candle lookup by time, ids, names the server accepts, and trade comparison", () => {
  const { m5 } = randomMarket(50, 1);
  assert.equal(indexOfTime(m5, m5.time[37]), 37);
  assert.equal(indexOfTime(m5, m5.time[37] + 1), -1);
  assert.match(newId(new Date("2026-10-03T14:25:01Z"), () => 0.5), /^bt-20261003-142501-[a-z0-9]{4}$/);
  assert.ok(validName(newId()) && validName("impulse_candle"));
  assert.ok(!validName("../x") && !validName("") && !validName("a b"));
  assert.deepEqual(compareTrades([{ id: 1, resultR: 1 }], [{ id: 1, resultR: 1 + 1e-9 }]), []);
  assert.equal(compareTrades([{ id: 1 }], []).length, 1);
});
