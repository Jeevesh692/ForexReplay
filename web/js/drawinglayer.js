// Drawings on the chart: painting them, and creating, selecting, moving and deleting them with the mouse.
//
// What a drawing is and where its lines go is decided in drawings.js (pure, tested without a
// browser). This file is the thin part that needs a real chart: it converts between pixels and
// time/price, paints with the chart library's "primitive" hook, and listens to the mouse.
//
// Mouse rules, the same as TradingView:
//  * Pick a tool, click once (horizontal line, long, short) or twice (trendline, rectangle,
//    Fibonacci). Press-drag-release also works for the two-click tools. The tool then switches off.
//  * Click a drawing to select it. Drag a handle to reshape it, drag its body to move it.
//  * Delete removes the selected drawing. Esc cancels whatever is in progress.

import { createDrawing, hit, layout, logicalToTime, moveAll, moveHandle, timeToLogical, TOOLS } from "./drawings.js";
import { timeframe as timeframeInfo } from "./timeframes.js";

const BLUE = "#2962ff";
const STYLE = {
  line: { stroke: BLUE, width: 1.5 },
  guide: { stroke: "rgba(120, 123, 134, 0.8)", width: 1, dash: [4, 4] },
  level: { stroke: "rgba(120, 123, 134, 0.9)", width: 1 },
  ote: { stroke: "#f5a623", width: 1, fill: "rgba(245, 166, 35, 0.10)" },
  fill: { fill: "rgba(41, 98, 255, 0.12)" },
  profit: { fill: "rgba(38, 166, 154, 0.22)", text: "#26a69a" },
  loss: { fill: "rgba(239, 83, 80, 0.22)", text: "#ef5350" },
  entry: { stroke: "#d1d4dc", width: 1, text: "#d1d4dc" },
  measure: { text: "#b2b5be" },
};
const FONT = '11px -apple-system, "Segoe UI", Roboto, sans-serif';

export class DrawingLayer {
  /**
   * @param {ChartView} view
   * @param {object} options { store: DrawingStore, pipPoints, note(drawing) -> text for position tools,
   *   onSelect(drawing | null), onToolChange(tool | null) }
   */
  constructor(view, { store, pipPoints, note, onSelect, onToolChange }) {
    this.view = view;
    this.store = store;
    this.pipPoints = pipPoints;
    this.note = note || (() => "");
    this.onSelect = onSelect || (() => {});
    this.onToolChange = onToolChange || (() => {});
    this.tool = null; // the drawing tool waiting for clicks, or null
    this.draft = null; // a drawing being created (after its first click)
    this.selectedId = null;
    this.drag = null; // { id, hit, start, original, current, moved } while a drawing is being moved
    this.paneWidth = 0;

    const draw = (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize));
    const paneView = { zOrder: () => "top", renderer: () => ({ draw }) };
    this.primitive = {
      attached: ({ requestUpdate }) => { this.requestUpdate = requestUpdate; },
      detached: () => { this.requestUpdate = null; },
      updateAllViews: () => {},
      paneViews: () => [paneView],
    };
    view.series.attachPrimitive(this.primitive);

    const el = view.container;
    el.addEventListener("mousedown", (event) => this.handleDown(event), true); // capture: before the chart pans
    el.addEventListener("mousemove", (event) => this.handleHover(event));
    this.dragMove = (event) => this.handleDragMove(event);
    this.release = (event) => this.handleUp(event);
  }

  redraw() {
    if (this.requestUpdate) this.requestUpdate();
  }

  // ----- pixels <-> time and price ----------------------------------------------
  get tfSeconds() { return timeframeInfo(this.view.timeframe).seconds; }

  projection() {
    const v = this.view;
    const scale = v.chart.timeScale();
    const unit = 10 ** v.digits;
    return {
      x: (time) => scale.logicalToCoordinate(timeToLogical(v.candles, this.tfSeconds, time)) ?? 0,
      y: (price) => v.series.priceToCoordinate(price / unit) ?? 0,
      width: this.paneWidth,
      formatPrice: (points) => (points / unit).toFixed(v.digits),
      pips: (points) => points / this.pipPoints,
      note: this.note,
    };
  }

  /** Where the mouse is: { x, y, logical, time, price }. `anywhere` also accepts positions outside the price pane. */
  pointAt(event, anywhere = false) {
    const v = this.view;
    if (!v.candles) return null;
    let point = v.panePoint(event);
    if (!point) {
      if (!anywhere) return null;
      const box = v.container.getBoundingClientRect();
      point = { x: event.clientX - box.left, y: event.clientY - box.top };
    }
    const logical = v.chart.timeScale().coordinateToLogical(point.x);
    const price = v.series.coordinateToPrice(point.y);
    if (logical === null || price === null) return null;
    return {
      ...point, logical,
      time: logicalToTime(v.candles, this.tfSeconds, logical),
      price: Math.round(price * 10 ** v.digits),
    };
  }

  // ----- tools and selection --------------------------------------------------------
  setTool(tool) {
    this.tool = tool && TOOLS[tool] ? tool : null;
    this.draft = null;
    this.view.toolActive = !!this.tool; // trade lines are not draggable while a tool is waiting for clicks
    if (this.tool) this.select(null);
    this.view.container.classList.toggle("tool-active", !!this.tool);
    this.onToolChange(this.tool);
    this.redraw();
  }

  select(id) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.onSelect(id === null ? null : this.store.get(id));
    this.redraw();
  }

  get selected() { return this.selectedId === null ? null : this.store.get(this.selectedId); }

  deleteSelected() {
    if (this.selectedId === null) return false;
    const id = this.selectedId;
    this.select(null);
    this.store.remove(id);
    return true;
  }

  /** Esc: drop the drawing in progress, then the tool, then the selection. Returns true if there was anything to cancel. */
  cancel() {
    if (this.drag) { this.finishDrag(true); return true; }
    if (this.tool) { this.setTool(null); return true; }
    if (this.selectedId !== null) { this.select(null); return true; }
    return false;
  }

  /** The store changed from outside (cleared, loaded): drop a selection that no longer exists. */
  storeChanged() {
    if (this.selectedId !== null && !this.store.get(this.selectedId)) this.select(null);
    this.redraw();
  }

  /** The drawing under (x, y), topmost first; the selected one also offers its handles. */
  find(x, y) {
    const proj = this.projection();
    const selected = this.selected;
    if (selected) {
      const found = hit(layout(selected, proj), x, y, { withHandles: true });
      if (found && found.part === "handle") return { id: selected.id, hit: found };
    }
    for (let i = this.store.items.length - 1; i >= 0; i--) {
      const d = this.store.items[i];
      const found = hit(layout(d, proj), x, y);
      if (found) return { id: d.id, hit: found };
    }
    return null;
  }

  // ----- mouse ------------------------------------------------------------------------
  handleDown(event) {
    if (event.button !== 0 || this.view.drag) return; // a trade line is being dragged
    const at = this.pointAt(event);
    if (!at) return;

    if (this.tool) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.draft) {
        const v = this.view;
        this.draft = createDrawing(this.tool, at, {
          pipPoints: this.pipPoints,
          barsAhead: (time, bars) => logicalToTime(v.candles, this.tfSeconds, timeToLogical(v.candles, this.tfSeconds, time) + bars),
        });
        if (TOOLS[this.tool].clicks === 1) { this.commit(); return; }
        this.pressed = { x: event.clientX, y: event.clientY }; // press-drag-release also finishes a two-click drawing
        window.addEventListener("mouseup", this.release, true);
      } else {
        this.draft = moveHandle(this.draft, "p1", at);
        this.commit();
      }
      this.redraw();
      return;
    }

    const found = this.find(at.x, at.y);
    if (!found) {
      this.select(null); // a click on empty chart deselects, and the chart pans as usual
      return;
    }
    event.preventDefault();
    event.stopPropagation(); // the chart must not pan while a drawing is being moved
    this.select(found.id);
    const original = this.store.get(found.id);
    this.drag = { id: found.id, hit: found.hit, start: at, original, current: original, moved: false };
    this.view.chart.applyOptions({ handleScroll: false, handleScale: false });
    this.view.container.classList.add("draw-drag");
    window.addEventListener("mousemove", this.dragMove, true);
    window.addEventListener("mouseup", this.release, true);
  }

  handleHover(event) {
    if (this.drag) return;
    const at = this.pointAt(event);
    if (this.draft) {
      if (at) {
        this.draft = moveHandle(this.draft, "p1", at);
        this.redraw();
      }
      return;
    }
    const over = !this.tool && at && !this.view.drag ? this.find(at.x, at.y) : null;
    this.view.container.classList.toggle("draw-hover", !!over);
  }

  handleDragMove(event) {
    const drag = this.drag;
    const at = this.pointAt(event, true);
    if (!drag || !at) return;
    if (!drag.moved && Math.hypot(at.x - drag.start.x, at.y - drag.start.y) < 3) return; // a click, not a drag (yet)
    drag.moved = true;
    if (drag.hit.part === "handle") {
      drag.current = moveHandle(drag.original, drag.hit.key, at);
    } else {
      const v = this.view;
      const bars = Math.round(at.logical - drag.start.logical);
      const shift = (time) => logicalToTime(v.candles, this.tfSeconds, timeToLogical(v.candles, this.tfSeconds, time) + bars);
      drag.current = moveAll(drag.original, shift, at.price - drag.start.price);
    }
    this.onSelect({ ...drag.current, id: drag.id }); // keep the toolbar's numbers live
    this.redraw();
  }

  handleUp(event) {
    window.removeEventListener("mouseup", this.release, true);
    if (this.drag) { this.finishDrag(false); return; }
    // Press-drag-release with a two-click tool: finish the drawing where the mouse was let go.
    if (this.draft && this.pressed && Math.hypot(event.clientX - this.pressed.x, event.clientY - this.pressed.y) > 5) {
      const at = this.pointAt(event, true);
      if (at) {
        this.draft = moveHandle(this.draft, "p1", at);
        this.commit();
      }
    }
    this.pressed = null;
  }

  finishDrag(cancelled) {
    const drag = this.drag;
    this.drag = null;
    window.removeEventListener("mousemove", this.dragMove, true);
    window.removeEventListener("mouseup", this.release, true);
    this.view.chart.applyOptions({ handleScroll: true, handleScale: true });
    this.view.container.classList.remove("draw-drag");
    if (drag.moved && !cancelled) this.store.update(drag.id, drag.current);
    this.onSelect(this.selected);
    this.redraw();
  }

  /** Keep the finished drawing, select it, and switch the tool off. */
  commit() {
    const draft = this.draft;
    this.draft = null;
    this.pressed = null;
    const [a, b] = draft.points;
    const empty = TOOLS[draft.type].clicks === 2 && a.time === b.time && a.price === b.price;
    const added = empty ? null : this.store.add(draft);
    this.setTool(null);
    if (added) this.select(added.id);
  }

  // ----- painting ------------------------------------------------------------------------
  paint(ctx, size) {
    this.paneWidth = size.width;
    if (!this.view.candles || this.view.candles.length === 0) return;
    const proj = this.projection();
    const shown = this.store.items.map((d) => (this.drag && this.drag.id === d.id ? { ...this.drag.current, id: d.id } : d));
    if (this.draft) shown.push({ ...this.draft, id: "draft" });

    ctx.save();
    ctx.font = FONT;
    ctx.textBaseline = "alphabetic";
    for (const d of shown) {
      const active = d.id === this.selectedId || d.id === "draft";
      const shape = layout(d, proj);
      for (const b of shape.boxes) {
        ctx.fillStyle = STYLE[b.role].fill;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      for (const l of shape.lines) {
        const style = STYLE[l.role];
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.width + (active && l.role === "line" ? 0.5 : 0);
        ctx.setLineDash(style.dash || []);
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      let lastLevelY = null;
      for (const t of shape.labels) {
        if (t.role === "measure" && !active) continue; // sizes are shown only for the drawing you are working on
        if (t.role === "level") { // on a small Fibonacci the level names would print over each other
          if (lastLevelY !== null && Math.abs(t.y - lastLevelY) < 12) continue;
          lastLevelY = t.y;
        }
        const style = STYLE[t.role];
        ctx.fillStyle = style.text || style.stroke;
        ctx.textAlign = t.align;
        ctx.fillText(t.text, t.x, t.y);
      }
      if (d.id === this.selectedId) {
        for (const h of shape.handles) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = "#131722";
          ctx.fill();
          ctx.strokeStyle = BLUE;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}
