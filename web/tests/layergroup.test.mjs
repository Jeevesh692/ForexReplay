// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import { LayerGroup } from "../js/layergroup.js";
import { ReplayClock } from "../js/replay.js";
import { TimeframeView } from "../js/timeframes.js";

/** A stand-in for DrawingLayer with just what the group uses; it calls back like the real one. */
class FakeLayer {
  constructor(name, callbacks) {
    this.name = name;
    this.cb = callbacks;
    this.tool = null;
    this.selectedId = null;
    this.magnet = false;
    this.styleDefaults = {};
    this.redraws = 0;
    callbacks.bind(this);
  }
  setTool(tool) { this.tool = tool; this.cb.onToolChange(tool); }
  select(id) { if (id === this.selectedId) return; this.selectedId = id; this.cb.onSelect(id === null ? null : { id }); }
  get selected() { return this.selectedId === null ? null : { id: this.selectedId }; }
  deleteSelected() { if (this.selectedId === null) return false; this.select(null); return true; }
  cancel() { if (this.selectedId !== null) { this.select(null); return true; } return false; }
  setMagnet(on) { this.magnet = on; }
  restyle(changes) { if (!this.selected) return false; this.styleDefaults = { trend: changes }; return true; }
  redraw() { this.redraws++; }
  storeChanged() { this.redraws++; }
  /** What the real layer does after a drawing is finished: its tool switches off. */
  finishDrawing(id) { this.setTool(null); this.select(id); }
}

function setup() {
  const seen = { tools: [], selected: [] };
  const group = new LayerGroup({ onToolChange: (t) => seen.tools.push(t), onSelect: (d) => seen.selected.push(d && d.id) });
  const a = group.add(new FakeLayer("main", group.callbacks()));
  const b = group.add(new FakeLayer("side", group.callbacks()));
  return { group, a, b, seen };
}

test("a tool waits on both charts; drawing on one switches it off on both", () => {
  const { group, a, b, seen } = setup();
  group.setTool("trend");
  assert.deepEqual([a.tool, b.tool, group.tool], ["trend", "trend", "trend"]);
  b.finishDrawing(7); // drawn on the side chart
  assert.deepEqual([a.tool, b.tool, group.tool], [null, null, null]);
  assert.equal(group.selected.id, 7);
  assert.equal(group.selectedLayer, b);
  assert.equal(seen.tools.at(-1), null);
});

test("only one drawing is selected across both charts", () => {
  const { group, a, b } = setup();
  a.select(3);
  b.select(5);
  assert.deepEqual([a.selectedId, b.selectedId], [null, 5]);
  assert.ok(group.deleteSelected());
  assert.equal(group.selected, null);
  assert.equal(group.deleteSelected(), false);
});

test("Esc drops a waiting tool first, then a selection; magnet and colours apply to every chart", () => {
  const { group, a, b } = setup();
  b.select(2);
  group.setTool("hline");
  assert.ok(group.cancel());
  assert.deepEqual([a.tool, b.tool], [null, null]);
  b.select(2);
  assert.ok(group.cancel());
  assert.equal(group.selected, null);
  assert.equal(group.cancel(), false);
  group.setMagnet(true);
  assert.deepEqual([a.magnet, b.magnet], [true, true]);
  b.select(4);
  group.restyle({ color: "#ef5350" });
  assert.deepEqual(a.styleDefaults, { trend: { color: "#ef5350" } }); // the other chart's next trendline is red too
  assert.ok(a.redraws > 0); // and it repaints the drawing it shares
});

test("a chart taken away from the group takes no part any more", () => {
  const { group, a, b } = setup();
  group.remove(b);
  group.setTool("rect");
  assert.deepEqual([a.tool, b.tool], ["rect", null]);
  const c = group.add(new FakeLayer("again", group.callbacks()));
  assert.equal(c.magnet, group.magnet);
});

test("two views of the same timeframe on one clock both hear every candle", () => {
  // Why the side chart has its own TimeframeView: a shared one would report "nothing changed" to the second chart.
  const rows = [];
  for (let i = 0; i < 48; i++) rows.push([Date.parse("2026-03-02T08:00Z") / 1000 + i * 300, 110000, 110010, 109990, 110000 + i, 10, 0]);
  const m5 = Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
  const clock = new ReplayClock(m5.length);
  const main = new TimeframeView(m5, "M15"), side = new TimeframeView(m5, "M15"), hour = new TimeframeView(m5, "H1");
  clock.start(10);
  for (const v of [main, side, hour]) v.setPosition(clock.position);
  clock.advance(1);
  const changes = [main, side, hour].map((v) => v.setPosition(clock.position));
  assert.ok(changes.every((c) => c.reset || c.to >= c.from));
  assert.equal(side.display.close[side.display.length - 1], m5.close[clock.position - 1]); // forming candle shows the newest close
  assert.equal(hour.display.close[hour.display.length - 1], m5.close[clock.position - 1]); // and nothing later
});
