// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { rebuild, snapshot } from "../js/backtest.js";
import { Candles } from "../js/data.js";
import { DrawingStore } from "../js/drawings.js";
import { ReplayClock } from "../js/replay.js";
import { cleanEntry, cleanTag, MAX_NOTE, MAX_TAGS, SUGGESTED_TAGS, TradeNotes } from "../js/tradenotes.js";
import { Side, Trading } from "../js/trading.js";

test("tags are tidied: trimmed, single spaces, plain characters, short", () => {
  assert.equal(cleanTag("  A+   setup "), "A+ setup");
  assert.equal(cleanTag("<b>FOMO</b>"), "bFOMO/b"); // angle brackets go; "/" is allowed (e.g. "BOS/MSS")
  assert.equal(cleanTag("x".repeat(40)).length, 24);
  assert.equal(cleanTag("   "), null);
  assert.equal(cleanTag(42), null);
});

test("a damaged entry keeps what is usable", () => {
  const e = cleanEntry({
    note: "n".repeat(MAX_NOTE + 50), tags: ["London", "London", "", ...Array.from({ length: 20 }, (_, i) => `t${i}`)],
    screenshots: ["bt-1-t1-exit.png", "../../etc/passwd", "x.svg", 7],
  });
  assert.equal(e.note.length, MAX_NOTE);
  assert.equal(e.tags.length, MAX_TAGS);
  assert.equal(e.tags.filter((t) => t === "London").length, 1);
  assert.deepEqual(e.screenshots, ["bt-1-t1-exit.png"]);
  assert.deepEqual(cleanEntry(null), { note: "", tags: [], screenshots: [] });
});

test("notes, tags and screenshots are kept per trade, and an emptied entry disappears", () => {
  const changed = [];
  const notes = new TradeNotes({ onChange: (id) => changed.push(id) });
  notes.setNote(3, "Swept Asia high, entered on the retest");
  notes.toggleTag(3, "A+ setup");
  notes.toggleTag(3, "London");
  notes.toggleTag(5, "FOMO");
  notes.addScreenshot(3, "bt-1-t3-entry.png");
  assert.deepEqual(notes.get(3), { note: "Swept Asia high, entered on the retest", tags: ["A+ setup", "London"], screenshots: ["bt-1-t3-entry.png"] });
  assert.equal(notes.toggleTag(3, "   "), false);
  notes.toggleTag(5, "FOMO"); // off again: nothing left for #5
  assert.equal(notes.has(5), false);
  assert.deepEqual(Object.keys(notes.toJSON()), ["3"]);
  assert.deepEqual(changed, [3, 3, 3, 5, 3, 5]);
  const copy = notes.get(3);
  copy.tags.push("changed outside");
  assert.equal(notes.get(3).tags.length, 2); // get() hands out a copy
});

test("tag choices put the run's own tags first, most used first, then the suggestions", () => {
  const notes = new TradeNotes();
  notes.toggleTag(1, "London"); notes.toggleTag(2, "London"); notes.toggleTag(2, "FOMO"); notes.toggleTag(3, "Asia");
  const choices = notes.tagChoices();
  assert.deepEqual(choices.slice(0, 3), ["London", "Asia", "FOMO"]);
  assert.equal(choices.filter((t) => t === "FOMO").length, 1);
  assert.equal(choices.length, 3 + SUGGESTED_TAGS.length - 1);
});

test("notes are saved with the backtest and on each trade for the journal, and do not disturb the rebuild", () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push([Date.parse("2026-03-02T08:00Z") / 1000 + i * 300, 110000, 110030, 109970, 110000, 10, 0]);
  const m5 = Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
  const clock = new ReplayClock(m5.length);
  const trading = new Trading({ m5, clock, pipPoints: 10, pointValue: 1 });
  clock.start(10);
  trading.reset();
  const t = trading.place({ side: Side.BUY, type: "market", stopLoss: 109900, takeProfit: 110300 });
  clock.advance(5);
  const notes = new TradeNotes();
  notes.setNote(t.id, "Test note");
  notes.toggleTag(t.id, "followed plan");
  const meta = { id: "bt-x", name: "x", journal: "j", created: "now", startTime: m5.time[9] };
  const saved = JSON.parse(JSON.stringify(snapshot(meta, {
    trading, drawings: new DrawingStore(), notes, m5, clock, manifest: { symbol: "EURUSD", digits: 5, pip_points: 10 }, timeframe: "M5",
  })));
  assert.deepEqual(saved.notes, { 1: { note: "Test note", tags: ["followed plan"], screenshots: [] } });
  assert.equal(saved.trades[0].note, "Test note");
  assert.deepEqual(saved.trades[0].tags, ["followed plan"]);
  assert.deepEqual(rebuild(saved, { m5, pipPoints: 10, pointValue: 1 }).problems, []);
  const loaded = new TradeNotes();
  loaded.load({ ...saved.notes, "-2": { note: "bad id" }, abc: { note: "bad id" }, 9: { note: "" } });
  assert.deepEqual(loaded.toJSON(), saved.notes);
});
