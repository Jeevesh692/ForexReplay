// The trading chart: a thin wrapper around TradingView Lightweight Charts.
//
// The library draws times as UTC. We want India time on the axis, so every
// timestamp handed to it is shifted by +5:30 (toChartTime) and shifted back
// when the library gives one to us (fromChartTime). Nothing else in the app
// ever sees shifted times.

import { rgb, sessionsBetween } from "./sessions.js";
import { formatDate, formatDateTime, IST_OFFSET_SECONDS } from "./time.js";
import { indexAtOrBefore, timeframe as timeframeInfo } from "./timeframes.js";

const COLOURS = {
  background: "#131722",
  text: "#b2b5be",
  grid: "#1f2330",
  border: "#2a2e39",
  up: "#26a69a",
  down: "#ef5350",
  upVolume: "rgba(38, 166, 154, 0.35)",
  downVolume: "rgba(239, 83, 80, 0.35)",
  crosshair: "#758696",
};

const DEFAULT_VISIBLE_BARS = 160;
const GRAB_PIXELS = 5; // how close the mouse must be to a line to drag it
const RIGHT_GAP_BARS = 8;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis labels. chartTime is already shifted to India time, so UTC getters read India time. */
function tickLabel(chartTime, tickType) {
  const d = new Date(chartTime * 1000);
  if (tickType === 0) return String(d.getUTCFullYear()); // year
  if (tickType === 1) return MONTHS[d.getUTCMonth()]; // month
  if (tickType === 2) return String(d.getUTCDate()); // day of month
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export const toChartTime = (utcSeconds) => utcSeconds + IST_OFFSET_SECONDS;
export const fromChartTime = (chartSeconds) => chartSeconds - IST_OFFSET_SECONDS;

/**
 * Background bands for the Asia, London and New York sessions, drawn with the
 * library's "primitive" hook (custom drawing behind the candles).
 */
class SessionBands {
  constructor(view) {
    this.view = view;
    this.enabled = true;
    const draw = (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize));
    this.views = [{ zOrder: () => "bottom", renderer: () => ({ draw }) }];
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.requestUpdate) this.requestUpdate();
  }

  paint(ctx, size) {
    const candles = this.view.candles;
    const tf = this.view.timeframe;
    if (!this.enabled || !candles || candles.length === 0 || timeframeInfo(tf).seconds > 3600) return;

    const scale = this.view.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const first = Math.max(0, Math.floor(range.from));
    const last = Math.min(candles.length - 1, Math.ceil(range.to));
    if (first > last) return;
    const half = scale.options().barSpacing / 2;

    for (const { session, start, end } of sessionsBetween(candles.time[first], candles.time[last])) {
      const i0 = Math.max(first, indexAtOrBefore(candles, start - 1) + 1); // first candle at or after the open
      const i1 = Math.min(last, indexAtOrBefore(candles, end - 1));         // last candle before the close
      if (i0 > i1) continue; // weekend or holiday
      const x0 = scale.logicalToCoordinate(i0) - half;
      const x1 = scale.logicalToCoordinate(i1) + half;
      ctx.fillStyle = `rgba(${rgb(session.colour)}, 0.07)`; // the colour key is in the status bar
      ctx.fillRect(x0, 0, x1 - x0, size.height);
    }
  }
}

export class ChartView {
  /**
   * @param {HTMLElement} container  element the chart fills
   * @param {object} options  { lib, symbol, digits, onHover(barInfo | null), onClick(index, points),
   *   onLineDrag(id, points) while a trade line is being dragged, onLineDrop(id, points | null) when it is let go
   *   (null = cancelled), onCrosshairTime(utc | null) when the mouse moves over this chart (for the other chart) }
   */
  constructor(container, { lib, symbol, digits, onHover, onClick, onLineDrag, onLineDrop, onCrosshairTime }) {
    this.container = container;
    this.onLineDrag = onLineDrag || (() => {});
    this.onLineDrop = onLineDrop || (() => {});
    this.lib = lib;
    this.symbol = symbol;
    this.digits = digits;
    this.onHover = onHover || (() => {});
    this.onClick = onClick || (() => {});
    this.onCrosshairTime = onCrosshairTime || (() => {});
    this.mouseInside = false; // only the chart under the mouse tells the other where its crosshair is
    this.candles = null; // Candles of the timeframe on screen
    this.timeframe = null;

    const minMove = 1 / 10 ** digits;
    this.chart = lib.createChart(container, {
      autoSize: true,
      layout: {
        background: { color: COLOURS.background },
        textColor: COLOURS.text,
        fontSize: 12,
        attributionLogo: true, // required credit for TradingView Lightweight Charts
      },
      grid: { vertLines: { color: COLOURS.grid }, horzLines: { color: COLOURS.grid } },
      crosshair: {
        mode: lib.CrosshairMode.Normal, // free crosshair like TradingView, not snapped to the close
        vertLine: { color: COLOURS.crosshair, labelBackgroundColor: "#363a45" },
        horzLine: { color: COLOURS.crosshair, labelBackgroundColor: "#363a45" },
      },
      rightPriceScale: { borderColor: COLOURS.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: {
        borderColor: COLOURS.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_GAP_BARS,
        barSpacing: 8,
        minBarSpacing: 0.5,
        tickMarkFormatter: (chartTime, tickType) => tickLabel(chartTime, tickType),
      },
      localization: {
        locale: "en-IN", // fixed, so number formatting never depends on the computer's language setting
        // Crosshair label at the bottom: full India-time date for the hovered candle.
        timeFormatter: (chartTime) => this.formatTime(fromChartTime(chartTime)),
      },
    });

    this.series = this.chart.addSeries(lib.CandlestickSeries, {
      upColor: COLOURS.up,
      downColor: COLOURS.down,
      wickUpColor: COLOURS.up,
      wickDownColor: COLOURS.down,
      borderVisible: false,
      priceFormat: { type: "price", precision: digits, minMove },
    });

    this.volume = this.chart.addSeries(lib.HistogramSeries, {
      priceScaleId: "volume", // its own invisible scale so it never squashes the candles
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    // Keep the lines of active trades on screen: the price scale stretches to include them, unless a line
    // is so far away (more than 1.5x the height of the candles on screen) that the candles would be squashed.
    this.series.applyOptions({
      autoscaleInfoProvider: (original) => {
        const info = original();
        if (!info || !info.priceRange || !this.lineSpecs || this.lineSpecs.length === 0) return info;
        let { minValue, maxValue } = info.priceRange;
        const reach = (maxValue - minValue) * 1.5;
        const low = minValue - reach, high = maxValue + reach;
        for (const spec of this.lineSpecs) {
          const price = spec.price / 10 ** this.digits;
          if (price < low || price > high) continue;
          minValue = Math.min(minValue, price);
          maxValue = Math.max(maxValue, price);
        }
        return { ...info, priceRange: { minValue, maxValue } };
      },
    });

    this.sessions = new SessionBands(this);
    this.series.attachPrimitive(this.sessions);

    this.chart.subscribeCrosshairMove((param) => this.handleCrosshair(param));
    this.chart.subscribeClick((param) => {
      if (this.justDragged) return; // the click that ends a drag is not a click on the chart
      if (!this.candles || !param.point) return;
      const index = param.time === undefined ? null : indexAtOrBefore(this.candles, fromChartTime(param.time));
      const price = this.series.coordinateToPrice(param.point.y); // price under the mouse
      this.onClick(index, price === null ? null : Math.round(price * 10 ** this.digits));
    });

    this.priceLines = [];
    this.lineSpecs = [];
    this.drag = null; // { spec, line, startY, points, moved } while a line is being dragged
    this.deferredLines = null;
    this.justDragged = false;
    this.toolActive = false; // set by the drawing layer
    this.markers = lib.createSeriesMarkers(this.series, []);

    // Dragging trade lines. The library has no draggable lines, so the mouse is watched here.
    // Listening in the capture phase lets a drag start before the library begins to pan the chart.
    container.addEventListener("mousedown", (event) => this.startDrag(event), true);
    container.addEventListener("mousemove", (event) => {
      if (!this.drag) container.classList.toggle("line-hover", !!this.lineAt(event));
    });
    container.addEventListener("mouseleave", () => {
      if (!this.drag) container.classList.remove("line-hover");
      this.mouseInside = false;
      this.onCrosshairTime(null);
    });
    container.addEventListener("mouseenter", () => { this.mouseInside = true; });
    this.moveDrag = (event) => this.continueDrag(event);
    this.endDrag = (event) => this.finishDrag(event);
  }

  // ----- dragging trade lines ------------------------------------------------
  /** Mouse position inside the price pane, or null when it is over an axis. */
  panePoint(event) {
    const box = this.container.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const paneWidth = box.width - this.chart.priceScale("right").width();
    const paneHeight = box.height - this.chart.timeScale().height();
    return x >= 0 && x <= paneWidth && y >= 0 && y <= paneHeight ? { x, y } : null;
  }

  /** The draggable line under the mouse (the nearest within a few pixels), or null. */
  lineAt(event) {
    const point = this.panePoint(event);
    if (!point) return null;
    let best = null;
    this.lineSpecs.forEach((spec, i) => {
      if (!spec.draggable) return;
      const y = this.series.priceToCoordinate(spec.price / 10 ** this.digits);
      if (y === null) return;
      const distance = Math.abs(y - point.y);
      if (distance <= GRAB_PIXELS && (!best || distance < best.distance)) best = { spec, line: this.priceLines[i], distance };
    });
    return best;
  }

  startDrag(event) {
    if (event.button !== 0 || this.drag || this.toolActive) return; // a drawing tool is waiting for its clicks
    const hit = this.lineAt(event);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation(); // the chart must not start panning
    this.drag = { spec: hit.spec, line: hit.line, startY: event.clientY, points: hit.spec.price, moved: false };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    window.addEventListener("mousemove", this.moveDrag, true);
    window.addEventListener("mouseup", this.endDrag, true);
  }

  continueDrag(event) {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 3) return; // a click, not a drag (yet)
    drag.moved = true;
    const y = event.clientY - this.container.getBoundingClientRect().top;
    const price = this.series.coordinateToPrice(y);
    if (price === null) return;
    drag.points = Math.round(price * 10 ** this.digits);
    drag.line.applyOptions({ price: drag.points / 10 ** this.digits });
    this.onLineDrag(drag.spec.id, drag.points);
  }

  finishDrag(event, cancelled = false) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    window.removeEventListener("mousemove", this.moveDrag, true);
    window.removeEventListener("mouseup", this.endDrag, true);
    this.chart.applyOptions({ handleScroll: true, handleScale: true });
    this.container.classList.remove("line-hover");
    if (drag.moved) {
      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 0);
    }
    const lines = this.deferredLines || this.lineSpecs; // put every line back where the trades say it is
    this.deferredLines = null;
    this.setTradeLines(lines);
    this.onLineDrop(drag.spec.id, drag.moved && !cancelled ? drag.points : null);
  }

  /** Abandon a drag in progress (Esc). Returns true if there was one. */
  cancelDrag() {
    if (!this.drag) return false;
    this.finishDrag(null, true);
    return true;
  }

  /**
   * Horizontal lines for active trades.
   * lines = [{ id, price (points), colour, dashed, title, draggable }]
   */
  setTradeLines(lines) {
    if (this.drag) { // do not pull the line out from under the mouse; redraw when the drag ends
      this.deferredLines = lines;
      return;
    }
    this.lineSpecs = lines;
    for (const line of this.priceLines) this.series.removePriceLine(line);
    this.priceLines = lines.map((line) => this.series.createPriceLine({
      price: line.price / 10 ** this.digits,
      color: line.colour,
      lineWidth: 1,
      lineStyle: line.dashed ? this.lib.LineStyle.Dashed : this.lib.LineStyle.Solid,
      axisLabelVisible: true,
      title: line.title,
    }));
  }

  /**
   * Entry and exit markers. markers = [{ time (UTC s of a candle on screen), above, colour, shape, text }]
   */
  setTradeMarkers(markers) {
    this.markers.setMarkers(markers
      .slice()
      .sort((a, b) => a.time - b.time)
      .map((m) => ({
        time: toChartTime(m.time),
        position: m.above ? "aboveBar" : "belowBar",
        color: m.colour,
        shape: m.shape,
        text: m.text,
      })));
  }

  candlePoint(i) {
    const c = this.candles;
    return {
      time: toChartTime(c.time[i]),
      open: c.price(c.open[i]), high: c.price(c.high[i]), low: c.price(c.low[i]), close: c.price(c.close[i]),
    };
  }

  volumePoint(i) {
    const c = this.candles;
    return {
      time: toChartTime(c.time[i]),
      value: c.volume[i],
      color: c.close[i] >= c.open[i] ? COLOURS.upVolume : COLOURS.downVolume,
    };
  }

  /**
   * Fast path for replay: candles `from`..`to` changed or were added at the end.
   * The library can update its last candle or append newer ones, which is all replay needs going forward.
   */
  updateBars(from, to) {
    for (let i = Math.max(0, from); i <= to; i++) {
      this.series.update(this.candlePoint(i));
      this.volume.update(this.volumePoint(i));
    }
    this.onHover(this.barInfo(this.candles.length - 1));
  }

  /** Is the newest candle on screen? (Then the chart follows the replay.) */
  latestVisible() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    return !!range && !!this.candles && range.to >= this.candles.length - 1;
  }

  formatTime(utcSeconds) {
    return this.timeframe === "D1" ? formatDate(utcSeconds) : formatDateTime(utcSeconds);
  }

  /** Everything the legend needs for candle i of the current timeframe. */
  barInfo(i) {
    const c = this.candles;
    if (!c || i < 0 || i >= c.length) return null;
    const previousClose = i > 0 ? c.close[i - 1] : c.open[i];
    return {
      index: i,
      time: c.time[i],
      timeText: this.formatTime(c.time[i]),
      open: c.price(c.open[i]),
      high: c.price(c.high[i]),
      low: c.price(c.low[i]),
      close: c.price(c.close[i]),
      volume: c.volume[i],
      change: c.price(c.close[i] - previousClose),
      changePercent: ((c.close[i] - previousClose) / previousClose) * 100,
      rising: c.close[i] >= c.open[i],
    };
  }

  handleCrosshair(param) {
    if (!this.candles || param.time === undefined) {
      this.onHover(this.barInfo(this.candles ? this.candles.length - 1 : -1)); // fall back to the latest candle
      if (this.mouseInside) this.onCrosshairTime(null);
      return;
    }
    this.onHover(this.barInfo(indexAtOrBefore(this.candles, fromChartTime(param.time))));
    if (this.mouseInside) this.onCrosshairTime(fromChartTime(param.time));
  }

  /**
   * Put the crosshair on the candle containing `utcSeconds` (the other chart is hovering that moment).
   * On a higher timeframe that is the candle the moment falls in; past the last candle, the last one.
   */
  showCrosshairAt(utcSeconds) {
    if (!this.candles || this.candles.length === 0 || this.mouseInside) return;
    const i = indexAtOrBefore(this.candles, utcSeconds);
    if (i < 0) { this.hideCrosshair(); return; }
    this.chart.setCrosshairPosition(this.candles.price(this.candles.close[i]), toChartTime(this.candles.time[i]), this.series);
    this.onHover(this.barInfo(i)); // the library sends no hover event for a crosshair placed by code
  }

  hideCrosshair() {
    if (this.mouseInside || !this.candles) return;
    this.chart.clearCrosshairPosition();
    this.onHover(this.barInfo(this.candles.length - 1)); // back to the newest candle, as when the mouse leaves
  }

  /** UTC time of the candle at the right edge of the screen (used to keep your place). */
  rightEdgeTime() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (!range || !this.candles || this.candles.length === 0) return null;
    const i = Math.max(0, Math.min(this.candles.length - 1, Math.floor(range.to) - RIGHT_GAP_BARS));
    return this.candles.time[i];
  }

  visibleBarCount() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    return range ? Math.max(20, Math.round(range.to - range.from)) : DEFAULT_VISIBLE_BARS;
  }

  /**
   * Show candles of a timeframe. keepTime (UTC seconds) puts that moment at the
   * right edge, so switching timeframe keeps you at the same place in history.
   */
  setCandles(timeframeId, candles, { keepTime = null, bars = null, preserveView = false } = {}) {
    this.timeframe = timeframeId;
    this.candles = candles;

    const n = candles.length;
    const candleData = new Array(n);
    const volumeData = new Array(n);
    for (let i = 0; i < n; i++) {
      candleData[i] = this.candlePoint(i);
      volumeData[i] = this.volumePoint(i);
    }
    const range = preserveView ? this.chart.timeScale().getVisibleLogicalRange() : null;
    this.series.setData(candleData);
    this.volume.setData(volumeData);

    if (range) {
      this.chart.timeScale().setVisibleLogicalRange(range); // same candles stay under the same pixels
    } else {
      const last = keepTime === null ? n - 1 : Math.max(0, indexAtOrBefore(candles, keepTime));
      this.showEndingAt(last, bars || DEFAULT_VISIBLE_BARS);
    }
    this.onHover(this.barInfo(n - 1));
  }

  setSessionsVisible(visible) {
    this.sessions.setEnabled(visible);
  }

  /** Redraw the session bands after the session settings changed. */
  refreshSessions() {
    this.sessions.setEnabled(this.sessions.enabled);
  }

  /** Put candle index `last` at the right edge with `bars` candles on screen. */
  showEndingAt(last, bars) {
    this.chart.timeScale().setVisibleLogicalRange({ from: last - bars + RIGHT_GAP_BARS, to: last + RIGHT_GAP_BARS });
  }

  /** Centre the chart on a moment in time (UTC seconds). */
  goTo(utcSeconds) {
    if (!this.candles) return null;
    const i = Math.max(0, indexAtOrBefore(this.candles, utcSeconds));
    const bars = this.visibleBarCount();
    const half = Math.floor(bars / 2);
    this.chart.timeScale().setVisibleLogicalRange({ from: i - half, to: i + half });
    return this.candles.time[i];
  }

  goToLatest() {
    if (this.candles) this.showEndingAt(this.candles.length - 1, this.visibleBarCount());
  }
}
