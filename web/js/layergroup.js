// The drawing layers of every chart on screen, acting as one.
//
// With two charts side by side, each chart has its own DrawingLayer, but they share one
// DrawingStore: a drawing is a time and a price, so the same list can be painted on M15 and
// on H4. This group gives the rest of the app a single layer to talk to:
//  * a tool picked in the tool bar waits on every chart; the first chart clicked draws it,
//    and the tool then switches off everywhere;
//  * one drawing is selected at a time, whichever chart it was selected on;
//  * magnet, colour defaults, undo and the text box behave the same on every chart.

export class LayerGroup {
  /** @param {object} options { onSelect(drawing | null), onToolChange(tool | null) } as for a single layer */
  constructor({ onSelect = () => {}, onToolChange = () => {} } = {}) {
    this.layers = [];
    this.onSelect = onSelect;
    this.onToolChange = onToolChange;
    this.tool = null;
    this.magnet = false;
    this.fibDefaults = null;
    this.quiet = false; // true while the group itself is changing its layers, so their callbacks do not echo back
  }

  /** Options to hand to a new DrawingLayer so its callbacks reach the group. */
  callbacks() {
    let layer = null;
    return {
      bind: (l) => { layer = l; },
      onSelect: (d) => this.layerSelected(layer, d),
      onToolChange: (tool) => this.layerTool(layer, tool),
    };
  }

  add(layer) {
    this.layers.push(layer);
    layer.setMagnet(this.magnet);
    layer.fibDefaults = this.fibDefaults;
    if (this.layers.length > 1) layer.styleDefaults = this.layers[0].styleDefaults;
    return layer;
  }

  remove(layer) {
    this.layers = this.layers.filter((l) => l !== layer);
  }

  // ----- callbacks from the layers -------------------------------------------
  layerSelected(layer, d) {
    if (this.quiet) return;
    if (d) { // only one selection across all charts
      this.quiet = true;
      for (const other of this.layers) if (other !== layer) other.select(null);
      this.quiet = false;
    }
    this.onSelect(d || this.selected);
  }

  layerTool(layer, tool) {
    if (this.quiet) return;
    // A layer switches its tool off after drawing (or on Esc): switch it off on the others too.
    this.setTool(tool);
  }

  // ----- the single-layer interface ------------------------------------------
  setTool(tool) {
    this.quiet = true;
    for (const l of this.layers) if (l.tool !== tool) l.setTool(tool);
    this.quiet = false;
    this.tool = this.layers.length ? this.layers[0].tool : null;
    this.onToolChange(this.tool);
  }

  get selectedLayer() { return this.layers.find((l) => l.selected) || null; }
  get selected() { const l = this.selectedLayer; return l ? l.selected : null; }

  select(id) {
    this.quiet = true;
    for (const l of this.layers) l.select(id === null ? null : (l === this.layers[0] ? id : null));
    this.quiet = false;
    this.onSelect(this.selected);
  }

  deleteSelected() {
    const l = this.selectedLayer;
    return l ? l.deleteSelected() : false;
  }

  /** Esc: the first layer with something to cancel cancels it. */
  cancel() {
    if (this.layers.some((l) => l.tool)) { this.setTool(null); return true; }
    return this.layers.some((l) => l.cancel());
  }

  storeChanged() { for (const l of this.layers) l.storeChanged(); }
  redraw() { for (const l of this.layers) l.redraw(); }

  /** The levels new Fibonacci drawings start with, on every chart. */
  setFibDefaults(defaults) {
    this.fibDefaults = defaults;
    for (const l of this.layers) l.fibDefaults = defaults;
  }

  setMagnet(on) {
    this.magnet = !!on;
    for (const l of this.layers) l.setMagnet(on);
  }

  restyle(changes) {
    const l = this.selectedLayer;
    if (!l || !l.restyle(changes)) return false;
    for (const other of this.layers) other.styleDefaults = l.styleDefaults;
    this.redraw(); // the other chart shows the same drawing
    return true;
  }

  editText(target) {
    const l = this.selectedLayer || this.layers[0];
    if (l) l.editText(target);
  }
}
