// The trading chart: a thin wrapper around TradingView Lightweight Charts.
//
// The library draws times as UTC. We want India time on the axis, so every
// timestamp handed to it is shifted by +5:30 (toChartTime) and shifted back
// when the library gives one to us (fromChartTime). Nothing else in the app
// ever sees shifted times.

import { sessionsBetween } from "./sessions.js";
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
      ctx.fillStyle = `rgba(${session.colour}, 0.07)`; // the colour key is in the status bar
      ctx.fillRect(x0, 0, x1 - x0, size.height);
    }
  }
}

export class ChartView {
  /**
   * @param {HTMLElement} container  element the chart fills
   * @param {object} options  { lib, symbol, digits, onHover(barInfo | null) }
   */
  constructor(container, { lib, symbol, digits, onHover, onClick }) {
    this.lib = lib;
    this.symbol = symbol;
    this.digits = digits;
    this.onHover = onHover || (() => {});
    this.onClick = onClick || (() => {});
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

    this.sessions = new SessionBands(this);
    this.series.attachPrimitive(this.sessions);

    this.chart.subscribeCrosshairMove((param) => this.handleCrosshair(param));
    this.chart.subscribeClick((param) => {
      if (!this.candles || param.time === undefined) return;
      this.onClick(indexAtOrBefore(this.candles, fromChartTime(param.time)));
    });
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
      return;
    }
    this.onHover(this.barInfo(indexAtOrBefore(this.candles, fromChartTime(param.time))));
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
