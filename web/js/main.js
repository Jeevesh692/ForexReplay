// App start-up: load data, build the chart, wire the top bar and the replay.

import { formatLots, formatMoney, formatSignedMoney, loadSettings, pointValueFor } from "./account.js";
import { drawingsBefore, rebuild } from "./backtest.js";
import { loadRules as loadChallengeRules } from "./challenge.js";
import { AdrPanel } from "./adrpanel.js";
import { AnalyticsView } from "./analyticsview.js";
import { Backtests } from "./backtestpanel.js";
import { JournalPanel } from "./journalpanel.js";
import { capture as captureChart } from "./screenshots.js";
import { openStore } from "./store.js";
import { TradeNotes } from "./tradenotes.js";
import { ChartView } from "./chart.js";
import { DrawingLayer } from "./drawinglayer.js";
import { jumpClock, jumpLabel, nextJump, SESSION_OPENS } from "./jump.js";
import { BREAKOUT_TIMEFRAMES, BreakoutFinder, bufferPoints, describeBreakout } from "./breakout.js";
import { cleanSetupRules, describeSetup, SetupFinder, setupJumpLimit, STORAGE_KEY as KEY_SETUPS } from "./setups.js";
import { atr as atrOf, cleanIndicators, STORAGE_KEY as KEY_INDICATORS } from "./indicators.js";
import { LayerGroup } from "./layergroup.js";
import {
  cleanFibLevels, DrawingStore, FIB_LEVELS, fibLevelsOf, LINE_STYLES, loadSaved as loadSavedDrawings, moveHandle, PALETTE,
  positionStats, save as saveDrawings, TOOLS,
} from "./drawings.js";
import { OTHER_KEYS, SHORTCUTS, shortcutFor } from "./shortcuts.js";
import { loadJSON, loadSymbol } from "./data.js";
import { renderDataView } from "./dataview.js";
import { OrderType } from "./broker.js";
import { ReplayClock, SPEEDS } from "./replay.js";
import { loadSavedSessions, renderSessionKey, setupSessionSettings } from "./sessionsettings.js";
import { formatDate, formatDateTime, IST_OFFSET_SECONDS } from "./time.js";
import { hourlyBase, indexAtOrBefore, serverDate, timeframe as timeframeOf, TIMEFRAMES, TimeframeView } from "./timeframes.js";
import { InvalidOrder, Side, Status, Trading } from "./trading.js";
import { TradingPanel } from "./tradingpanel.js";
import { FlowMonths, loadFlow } from "./flowdata.js";
import { dayLevels, priceBin, profileFromBars } from "./profile.js";
import { cleanFlowSettings, cleanProfileSettings, newProfileSettings, ProfileLevels, profileWindow, STORAGE_KEY as KEY_FLOW } from "./profiletool.js";
import { cleanStateSettings, eventLabel, marketState, STATE_WORDS } from "./marketstate.js";
import { bubbles as findBubbles, BubbleLayer, candleFlow, cleanFlowLayer, dayResets, divergences, FlowSeries, STORAGE_KEY as KEY_FLOW_LAYER } from "./orderflow.js";
import { getSessions, sessionsBetween } from "./sessions.js";
import { cleanCostSettings, minTargetR, positionPlan, STORAGE_KEY as KEY_COSTS, stopLimits, warningText } from "./costs.js";
import { atrBefore, bubbleRule, candleRules, cleanTriggerSettings, currentM5, RULE_HELP, RULE_NAMES, RULES, STORAGE_KEY as KEY_TRIGGER, trigger as triggerOn } from "./trigger.js";

const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString("en-IN");
const KEY_TIMEFRAME = "forexreplay.timeframe";
const KEY_STATE = "forexreplay.marketstate";
const KEY_SYMBOL = "forexreplay.symbol";
const KEY_BASE = "forexreplay.base"; // "M1" (the default) or "H1" for swing replays over the older history
const KEY_SESSIONS = "forexreplay.sessions";
const KEY_MAGNET = "forexreplay.magnet";
const KEY_LAYOUT = "forexreplay.layout";
const KEY_SIDE_TF = "forexreplay.sidetimeframe";
const KEY_DRAW_STYLES = "forexreplay.drawstyles";
const KEY_FIB_DEFAULTS = "forexreplay.fibdefaults";

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
}
function recall(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function showError(message) {
  const box = $("error");
  box.hidden = false;
  box.textContent = message;
}

/** Legend in the chart's top-left corner, like TradingView's O H L C line. */
function renderLegend(el, symbol, timeframeId, digits, info, forming, extra = "", flowText = "") {
  if (!info) {
    el.textContent = `${symbol} · ${timeframeId}`;
    return;
  }
  const tone = info.rising ? "up" : "down";
  const p = (v) => v.toFixed(digits);
  const sign = info.change >= 0 ? "+" : "";
  el.innerHTML =
    `<span class="legend-title">${symbol} · ${timeframeId}</span>` +
    `<span class="legend-time">${info.timeText}${forming ? " · forming" : ""}</span>` +
    `<span class="${tone}">O <b>${p(info.open)}</b> H <b>${p(info.high)}</b> ` +
    `L <b>${p(info.low)}</b> C <b>${p(info.close)}</b> ` +
    `${sign}${p(info.change)} (${sign}${info.changePercent.toFixed(2)}%)</span>` +
    `<span class="legend-volume">Vol ${number(info.volume)}</span>` +
    (info.indicators || []).map((ind) => `<span class="legend-ind"><i style="background:${ind.colour}"></i>${ind.label} <b>${ind.text}</b></span>`).join("") +
    (extra ? `<span class="legend-ind">Breakout <b>${extra}</b></span>` : "") +
    (flowText ? `<span class="legend-ind">${flowText}</span>` : "");
}

/** "2026-03-05T13:30" typed in India time -> UTC seconds. */
function parseIndiaInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 1000 - IST_OFFSET_SECONDS;
}

/** UTC seconds -> value for a datetime-local input, in India time. */
function toIndiaInput(utcSeconds) {
  return new Date((utcSeconds + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 16);
}

async function boot() {
  const store = await openStore(); // files on disk with the local server, or this browser on the website
  const health = await store.health();
  if (store.kind === "browser") $("status-version").textContent = "online · backtests are saved in this browser";
  else if (health) $("status-version").textContent = `app v${health.version}`;

  const lib = window.LightweightCharts;
  $("status-lib").innerHTML = lib
    ? `<span class="ok">Chart library v${lib.version()} ready</span>`
    : '<span class="bad">Chart library missing</span>';

  // Which pair: ?symbol= in the address (set when switching), else the last one used, else the first built.
  const symbols = await loadJSON("data/symbols.json").catch(() => [{ symbol: "EURUSD" }]); // older data: EURUSD only
  const params = new URLSearchParams(location.search);
  const known = (s) => symbols.some((x) => x.symbol === s);
  const symbol = [params.get("symbol"), recall(KEY_SYMBOL, null), symbols[0].symbol].find((s) => s && known(s)) || "EURUSD";
  try { localStorage.setItem(KEY_SYMBOL, symbol); } catch { /* private mode: not kept */ }
  const symbolBox = $("symbol");
  symbolBox.innerHTML = symbols.map((s) => `<option${s.symbol === symbol ? " selected" : ""}>${s.symbol}</option>`).join("");

  let loaded, quality;
  try {
    [loaded, quality] = await Promise.all([loadSymbol(symbol), loadJSON(`data/${symbol}/quality.json`)]);
  } catch (err) {
    console.error(err);
    showError(`Could not load the market data.\n${err.message}\n\n` +
      "Fix: close this tab, then run  python -m forex_replay app --rebuild");
    return;
  }
  // The candles the replay steps through: minutes, or hours for swing replays that reach back over the older
  // H1 history (decision 0025). Everything below works on `m5` as the base, whatever its size.
  const canSwing = !!loaded.history.H1;
  const baseMode = [params.get("base"), recall(KEY_BASE, "M1")].find((b) => b === "M1" || (b === "H1" && canSwing)) || "M1";
  try { localStorage.setItem(KEY_BASE, baseMode); } catch { /* private mode: not kept */ }
  const m5 = baseMode === "H1" ? hourlyBase(loaded.candles, loaded.history.H1) : loaded.candles;
  const manifest = baseMode === "H1"
    ? { ...loaded.manifest, timeframe: "H1", bar_seconds: 3600, bars: m5.length, first: m5.time[0], last: m5.time[m5.length - 1] }
    : loaded.manifest;
  const history = baseMode === "H1" ? {} : loaded.history; // the hours already reach as far back as the H4 and D1 history
  const baseBox = $("base");
  baseBox.innerHTML = `<option value="M1"${baseMode === "M1" ? " selected" : ""}>1-minute candles · from ${formatDate(loaded.manifest.first)}</option>` +
    (canSwing ? `<option value="H1"${baseMode === "H1" ? " selected" : ""}>1-hour candles (swing) · from ${formatDate(loaded.history.H1.time[0])}</option>` : "");

  $("status-data").textContent =
    `${manifest.symbol} · ${number(manifest.bars)} ${manifest.timeframe} candles · ` +
    `${formatDateTime(manifest.first)} → ${formatDateTime(manifest.last)} IST`;

  const redrawData = renderDataView($("data-view"), { manifest, quality, candles: m5 });

  if (!lib) {
    showError("TradingView Lightweight Charts is not downloaded yet.\n" +
      "Restart the app with an internet connection, or attach the file in the chat.");
    return;
  }

  // ------------------------------------------------------------ timeframes
  // One TimeframeView per timeframe, built on first use. Each shows only what
  // the replay clock has revealed.
  const clock = new ReplayClock(m5.length);
  const views = new Map();
  const viewFor = (tf) => {
    if (!views.has(tf)) views.set(tf, new TimeframeView(m5, tf, history[tf] || null));
    return views.get(tf);
  };

  // Only timeframes at least as long as the replay's candles: in 1-hour mode, H1, H4 and D1.
  const usable = TIMEFRAMES.filter((t) => t.seconds >= manifest.bar_seconds);
  let current = recall(KEY_TIMEFRAME, "M15");
  if (!usable.some((t) => t.id === current)) current = usable.some((t) => t.id === "M15") ? "M15" : usable[0].id;
  let view = viewFor(current);
  let picking = false; // waiting for a click on the candle to start the replay from
  let anchorPicking = false; // waiting for a click on the candle the CVD should start from
  // The order-flow layer's settings (orderflow.js): read here, before the charts are made, as their legends use them.
  let flowLayer = cleanFlowLayer((() => { try { return JSON.parse(recall(KEY_FLOW_LAYER, "null")); } catch { return null; } })());
  let costSettings = cleanCostSettings((() => { try { return JSON.parse(recall(KEY_COSTS, "null")); } catch { return null; } })());
  let triggerSettings = cleanTriggerSettings((() => { try { return JSON.parse(recall(KEY_TRIGGER, "null")); } catch { return null; } })());
  let atrMemo = { period: null, values: null }; // the trigger panel's ATR on every 5-minute candle
  let panel = null; // trading panel (created below, once the chart exists)
  loadSavedSessions();

  const hint = $("hint");
  const setHint = (text) => {
    hint.hidden = !text;
    hint.textContent = text || "";
  };

  // Each chart on screen is a "pane": its chart, its timeframe and its view of the one replay clock.
  // The main pane is the one the timeframe buttons, the replay steps and the backtest's timeframe follow.
  // The side pane (two charts side by side) has its own timeframe and its own TimeframeView, even when
  // both show the same timeframe, so each chart is told about every candle the clock reveals.
  let layoutTwo = recall(KEY_LAYOUT, "one") === "two";
  const mainPane = { id: "main", legend: $("legend"), get tf() { return current; }, get view() { return view; }, chart: null, layer: null };
  const sideTf = recall(KEY_SIDE_TF, "H4");
  const sidePane = { id: "side", legend: $("legend-side"), tf: usable.some((t) => t.id === sideTf) ? sideTf : "H4", view: null, chart: null, layer: null };
  const panes = () => (layoutTwo && sidePane.chart ? [mainPane, sidePane] : [mainPane]);

  const chartOptions = (pane) => ({
    lib,
    symbol: manifest.symbol,
    digits: manifest.digits,
    pipPoints: manifest.pip_points,
    onHover: (info) => renderLegend(pane.legend, manifest.symbol, pane.tf, manifest.digits, info,
      info && info.index === pane.view.display.length - 1 && pane.view.isForming(), breakoutLegend(pane, info), flowLegend(pane, info)),
    onCrosshairTime: (time) => { // the other chart puts its crosshair on the same moment
      const other = pane === mainPane ? sidePane : mainPane;
      if (!layoutTwo || !other.chart) return;
      if (time === null) other.chart.hideCrosshair(); else other.chart.showCrosshairAt(time);
    },
    onClick: (index, price) => {
      if (anchorPicking) {
        if (index === null || index < 0) return;
        setAnchorPicking(false);
        flowLayer = cleanFlowLayer({ ...flowLayer, reset: "anchor", anchor: pane.view.full.time[index] });
        remember(KEY_FLOW_LAYER, JSON.stringify(flowLayer));
        refreshFlowLayer();
        setHint(`CVD now runs from ${formatDateTime(flowLayer.anchor)} IST.`);
        setTimeout(() => setHint(null), 2500);
        return;
      }
      if (picking) {
        if (index === null) return;
        if (pane.view.isHistory(index)) { // older history has no 1-minute candles to replay
          setHint(`A replay can start from ${formatDateTime(m5.time[0])} IST, where the 1-minute candles begin. ` +
            "Click a later candle, or press Esc to cancel.");
          return;
        }
        setPicking(false);
        clock.start(pane.view.endOf(index)); // the clicked candle is the last one shown, on whichever chart
      } else if (panel && price !== null) {
        panel.receivePrice(price); // filling in a price field from the chart
      }
    },
    onLineDrag: (id, price) => setHint(describeMove(id, price)),
    onLineDrop: (id, price) => {
      setHint(null);
      if (price === null) return;
      const [kind, tradeId] = id.split(":");
      try {
        trading.modifyTrade(Number(tradeId), { [LINE_FIELD[kind]]: price });
        panel.say(`${LINE_NAME[kind]} of #${tradeId} moved to ${(price / 10 ** manifest.digits).toFixed(manifest.digits)}.`, "ok");
      } catch (err) {
        if (!(err instanceof InvalidOrder)) throw err;
        panel.say(err.message, "bad"); // the line has already snapped back
      }
    },
  });
  let indicators = cleanIndicators((() => { try { return JSON.parse(recall(KEY_INDICATORS, "null")); } catch { return null; } })());
  const chart = new ChartView($("chart"), chartOptions(mainPane));
  chart.setIndicators(indicators);
  mainPane.chart = chart;

  // ------------------------------------------------------------ trading
  const UP = "#26a69a", DOWN = "#ef5350", PENDING = "#ffb74d", ENTRY = "#d1d4dc";
  const trading = new Trading({
    m5, clock, pipPoints: manifest.pip_points, pointValue: pointValueFor(manifest.symbol, manifest.digits, manifest.contract_size),
    settings: loadSettings(), challenge: loadChallengeRules(), onChange: () => refreshTrading(),
  });
  const formatR = (r) => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;

  // The setup finder (setups.js, decision 0030): RSI + Bollinger reversal setups on closed 4-hour candles.
  // Its own H4 view of the replay's candles is built the first time it is switched on.
  let setupRules = cleanSetupRules((() => { try { return JSON.parse(recall(KEY_SETUPS, "null")); } catch { return null; } })());
  let finder = null;
  // The NY ORB breakout candle (decision 0032): judged on closed M5 candles built from the minutes.
  let breakoutFinder = null;
  function breakoutNow(view) {
    const or = indicators.or;
    if (!or.on || !or.breakout || manifest.bar_seconds > 300 || !BREAKOUT_TIMEFRAMES.includes(view.id)) return null;
    breakoutFinder = breakoutFinder || new BreakoutFinder(m5);
    return breakoutFinder.at(clock.position, or, bufferPoints(or, manifest.symbol, manifest.digits, manifest.pip_points));
  }
  /** The legend's words on the breakout candle: body %, size, and half of ORW. */
  function breakoutLegend(pane, info) {
    if (!info || !pane.view) return "";
    const b = breakoutNow(pane.view);
    if (!b || b.state !== "breakout") return "";
    const i = indexAtOrBefore(pane.view.full, b.closeTime - 1);
    if (i < 0 || pane.view.full.time[i] !== info.time) return "";
    return describeBreakout(b, manifest.digits).legend;
  }
  const setupFinder = () => finder || (finder = new SetupFinder(m5, history.H4 || null, manifest.pip_points, setupRules));
  const pauseAtSetups = () => setupRules.on && setupRules.pause;
  const setupState = { dismissed: null, taken: new Set() }; // closeTime of a dismissed card; closeTimes of setups taken
  const LINE_FIELD = { sl: "stopLoss", tp: "takeProfit", entry: "price" };
  const LINE_NAME = { sl: "Stop loss", tp: "Take profit", entry: "Entry" };

  /** Shown while a line is being dragged: where it is now, and what that means in pips, R and dollars. */
  function describeMove(id, price) {
    const [kind, tradeId] = id.split(":");
    const t = trading.broker.trades.find((trade) => trade.id === Number(tradeId));
    if (!t) return null;
    const text = `${LINE_NAME[kind]} #${t.id} → ${(price / 10 ** manifest.digits).toFixed(manifest.digits)}`;
    if (kind === "entry") return `${text} · let go to move the order, Esc to cancel`;
    const entry = t.entryPrice ?? t.plannedEntry;
    const points = (price - entry) * (t.side === Side.BUY ? 1 : -1);
    const money = t.status === Status.OPEN
      ? ` · ${formatSignedMoney(trading.account.money(trading.account.openUnits(t), points, price))} on what is open` : "";
    return `${text} · ${(points / manifest.pip_points).toFixed(1)} pips from entry (${formatR(points / t.plannedRisk)})${money}`;
  }

  /** Lines for active trades on every chart, and entry/exit markers on each chart's own candles. */
  function drawTrades() {
    const lines = [];
    const draggable = !trading.blockedReason; // lines can be moved only when orders can be placed
    for (const t of trading.broker.trades) {
      if (t.status === Status.CANCELLED) continue;
      if (t.isActive) {
        const pending = t.status === Status.PENDING;
        if (!(pending && t.orderType === OrderType.MARKET)) {
          lines.push({
            id: `entry:${t.id}`, draggable: draggable && pending,
            price: pending ? t.orderPrice : t.entryPrice, colour: pending ? PENDING : ENTRY, dashed: pending,
            title: `#${t.id} ${t.side}${pending ? ` ${t.orderType}` : ""} ${formatLots(trading.account.openUnits(t))}`,
          });
        }
        lines.push({ id: `sl:${t.id}`, draggable, price: t.stopLoss, colour: DOWN, dashed: true, title: `SL #${t.id}` });
        lines.push({ id: `tp:${t.id}`, draggable, price: t.takeProfit, colour: UP, dashed: true, title: `TP #${t.id}` });
      }
    }
    // Only when something changed: re-creating the lines and markers on every candle was measurable work.
    const linesKey = JSON.stringify(lines);
    for (const p of panes()) {
      const markers = markersFor(p.view);
      const markersKey = JSON.stringify(markers);
      if (p.chart !== p.drawnOn || linesKey !== p.linesKey) p.chart.setTradeLines(lines);
      if (p.chart !== p.drawnOn || markersKey !== p.markersKey) p.chart.setTradeMarkers(markers);
      Object.assign(p, { drawnOn: p.chart, linesKey, markersKey });
    }
  }

  /**
   * Markers for OPEN trades only: the entry arrow (#id) and a dot for each part closed so far, on the candles
   * of `view`'s timeframe. A closed trade leaves nothing on the chart: zoomed out or on low timeframes its
   * arrows and labels covered the candles (Jeevesh, 5 Nov 2026). Closed trades are in the panel and the journal.
   */
  function markersFor(view) {
    const markers = [];
    const shown = view.display.length;
    for (const t of trading.broker.trades) {
      if (t.status !== Status.OPEN) continue;
      const buy = t.side === Side.BUY;
      if (t.entryTime !== null && view.bucketOf[t.entryTime] < shown) {
        markers.push({
          time: view.full.time[view.bucketOf[t.entryTime]], above: !buy, colour: buy ? UP : DOWN,
          shape: buy ? "arrowUp" : "arrowDown", text: `#${t.id}`,
        });
      }
      for (const part of t.partials) { // a small dot where part of the trade was closed
        if (view.bucketOf[part.time] >= shown) continue;
        const gain = (part.price - t.entryPrice) * (buy ? 1 : -1);
        markers.push({
          time: view.full.time[view.bucketOf[part.time]], above: buy, colour: gain >= 0 ? UP : DOWN,
          shape: "circle", text: `#${t.id} part`,
        });
      }
    }
    const b = breakoutNow(view);
    if (b) { // the NY ORB breakout candle, on whichever candle of this chart holds its close (breakout.js)
      const i = indexAtOrBefore(view.full, b.closeTime - 1);
      if (i >= 0 && i < shown) {
        const words = describeBreakout(b, manifest.digits).text;
        markers.push(b.state === "none"
          ? { time: view.full.time[i], above: false, colour: "#787b86", shape: "circle", text: words }
          : { time: view.full.time[i], above: !b.up, colour: b.displacement ? UP : "#787b86", shape: b.up ? "arrowUp" : "arrowDown", text: words });
      }
    }
    const st = stateSettings.on && stateSettings.labels && flowLayer.show ? stateInfo() : null;
    if (st) { // market state labels, on whichever candle of this chart holds the close that made them
      for (const e of st.events) {
        const i = indexAtOrBefore(view.full, e.time - 1);
        if (i < 0 || i >= shown) continue;
        const bearish = (e.kind === "accepted") === (e.side === "below");
        markers.push({ time: view.full.time[i], above: e.side === "above", colour: bearish ? DOWN : UP, shape: "square", text: eventLabel(e) });
      }
    }
    for (const d of flowDivergences(view)) { // CVD divergence: a new high or low of the period that CVD did not confirm
      const bearish = d.side === "bearish";
      markers.push({ time: view.full.time[d.index], above: bearish, colour: bearish ? DOWN : UP, shape: "circle", text: "div" });
    }
    if (setupRules.on) { // setups on the 4-hour candles closed so far, on whichever candle of this chart holds their close
      let previous = null;
      for (const s of setupFinder().setupsAt(clock.position)) {
        // Setups on back-to-back candles: only the first is labelled, or the words sit on top of each other.
        const labelled = !(previous && previous.index === s.index - 1 && previous.side === s.side && !!previous.skip === !!s.skip);
        previous = s;
        const i = indexAtOrBefore(view.full, s.closeTime - 1);
        if (i < 0 || i >= shown) continue;
        const sell = s.side === "SELL";
        markers.push(s.skip
          ? { time: view.full.time[i], above: sell, colour: "#787b86", shape: "circle", text: labelled ? "skip" : "" }
          : { time: view.full.time[i], above: sell, colour: sell ? DOWN : UP, shape: sell ? "arrowDown" : "arrowUp", text: labelled ? s.side : "" });
      }
    }
    return markers;
  }

  let adrPanel = null; // the ADR plan card (created with the panel, below)
  let challengeOutcome = null; // to notice the moment a challenge passes or fails
  let refreshQueued = false;
  /**
   * Redraw the panel, lines and markers once the current step is over. A replay tick used to
   * redraw twice (once for the engine, once for the clock); now everything that happens in one
   * tick is drawn once, right after it (a microtask: before the browser paints).
   */
  function refreshTrading() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; refreshNow(); });
  }

  function refreshNow() {
    const c = clock.active ? trading.challenge : null;
    if (panel && c && c.outcome !== "RUNNING" && challengeOutcome === "RUNNING") {
      clock.pause(); // stop the replay where the challenge ended
      panel.say(`Challenge ${c.outcome === "PASSED" ? "passed" : "failed"}: ${c.reason}.`, c.outcome === "PASSED" ? "ok" : "bad");
    }
    challengeOutcome = c ? c.outcome : null;
    if (adrPanel) adrPanel.render();
    if (panel) panel.render();
    renderSetupCard();
    renderTrigger();
    drawTrades();
    if (clock.active && backtests) backtests.changed(); // saved shortly after (see backtestpanel.js)
    autoScreenshots();
  }

  // ------------------------------------------------------------ journal: notes, tags, screenshots
  let journalBox = null; // the journal box (created with the panel, below)
  const notes = new TradeNotes({
    onChange: () => {
      if (panel) panel.render();
      if (journalBox) journalBox.refresh();
      if (clock.active && backtests) backtests.changed();
    },
  });
  const shotsTaken = new Set(); // "3:entry", "3:exit": automatic screenshots already taken in this run
  let shotQueue = Promise.resolve(); // uploads go one after another; leaving a replay waits for them

  /** Picture of the chart for trade `id`, saved to the backtest's journal folder and listed on the trade. */
  function takeScreenshot(id, kind) {
    const bt = backtests && backtests.current;
    const t = trading.broker.trades.find((trade) => trade.id === id);
    if (!bt || !t || !store.screenshots) return;
    const now = m5.time[clock.position - 1] + manifest.bar_seconds;
    const tfs = panes().map((p) => p.tf).join(" + ");
    const caption = `${manifest.symbol} ${tfs} · #${id} ${t.side} · ${kind} · ${formatDateTime(now)} IST · ${bt.name}`;
    const name = `${bt.id}-t${id}-${kind}${kind === "added" ? `-${Date.now().toString(36)}` : ""}.png`;
    let picture;
    try {
      picture = captureChart(panes().map((p) => p.chart.chart), caption); // taken now; only the upload waits
    } catch (err) {
      panel.say(`Screenshot not taken: ${err.message}`, "bad");
      return;
    }
    shotQueue = shotQueue
      .then(async () => {
        await store.putScreenshot(bt.journal, name, await picture);
        if (backtests.current && backtests.current.id === bt.id) notes.addScreenshot(id, name);
      })
      .catch((err) => panel.say(`Screenshot not saved: ${err.message}`, "bad"));
  }

  /**
   * At entry (when the order is placed) and at exit, unless switched off in the journal box.
   * The engine hears about a new candle before the chart draws it, so the pictures are taken a
   * moment later (a microtask: after the chart update, before the next replay tick), or the exit
   * picture would miss the candle that hit the stop.
   */
  let pendingShots = [];
  function autoScreenshots() {
    if (!clock.active || resuming || !journalBox || !journalBox.autoScreenshots || !backtests || !backtests.current) return;
    for (const t of trading.broker.trades) {
      if (t.status === Status.CANCELLED) continue;
      if (!shotsTaken.has(`${t.id}:entry`)) { shotsTaken.add(`${t.id}:entry`); pendingShots.push([t.id, "entry"]); }
      if (t.status === Status.CLOSED && !shotsTaken.has(`${t.id}:exit`)) { shotsTaken.add(`${t.id}:exit`); pendingShots.push([t.id, "exit"]); }
    }
    if (pendingShots.length) {
      queueMicrotask(() => {
        const shots = pendingShots;
        pendingShots = [];
        for (const [id, kind] of shots) takeScreenshot(id, kind);
      });
    }
  }

  /** Trades that already exist when a run is opened get no automatic pictures (they had their moment). */
  function markShotsTaken(trades) {
    shotsTaken.clear();
    for (const t of trades) {
      shotsTaken.add(`${t.id}:entry`);
      if (t.status === Status.CLOSED || t.status === Status.CANCELLED) shotsTaken.add(`${t.id}:exit`);
    }
  }

  // ------------------------------------------------------------ backtests
  // Each replay is a backtest, saved as you go. Outside a replay the chart keeps its
  // own drawings in the browser; a replay has its own, saved with the backtest.
  let backtests = null; // created below, once the panel exists
  let resuming = false; // a saved backtest is being opened: the clock's "start" must not wipe it
  const useChartDrawings = () => {
    drawings.load(loadSavedDrawings(manifest.symbol));
    layer.select(null);
    layer.storeChanged();
  };

  // ------------------------------------------------------------ drawings
  const drawings = new DrawingStore({
    onChange: () => {
      if (clock.active) backtests.drawingsChanged(); // a replay's drawings belong to its backtest
      else saveDrawings(manifest.symbol, drawings);
      layer.storeChanged();
      renderUndo();
    },
  });
  const undoButton = $("undo"), redoButton = $("redo");
  const renderUndo = () => {
    undoButton.disabled = !drawings.canUndo;
    redoButton.disabled = !drawings.canRedo;
  };
  const toolButtons = [...$("tools").querySelectorAll("[data-tool]")];
  const drawBar = {
    box: $("draw-bar"), text: $("draw-bar-text"), ticket: $("draw-to-ticket"), remove: $("draw-delete"),
    colours: $("draw-colours"), styles: $("draw-styles"), editText: $("draw-edit-text"),
    levels: $("draw-levels"), stop: $("draw-stop"), target: $("draw-target"), fibLevels: $("draw-fib-levels"),
  };
  drawBar.colours.innerHTML = PALETTE.map((c) => `<button data-colour="${c}" style="background:${c}" title="Colour"></button>`).join("");
  let styleDefaults = {};
  try { styleDefaults = JSON.parse(recall(KEY_DRAW_STYLES, "{}")) || {}; } catch { /* damaged: start plain */ }
  // Only known colours and styles are kept from storage.
  styleDefaults = Object.fromEntries(Object.entries(styleDefaults).filter(([tool]) => TOOLS[tool] && TOOLS[tool].styled)
    .map(([tool, s]) => [tool, {
      ...(PALETTE.includes(s && s.color) ? { color: s.color } : {}), ...(LINE_STYLES.includes(s && s.style) ? { style: s.style } : {}),
    }]));
  const clearButton = $("drawings-clear");
  let clearArmed = false;
  const disarmClear = () => {
    if (!clearArmed) return;
    clearArmed = false;
    clearButton.classList.remove("armed");
    setHint(null);
  };
  const priceText = (points) => (points / 10 ** manifest.digits).toFixed(manifest.digits);

  /**
   * The words a long/short drawing adds to its three labels (Phase 7, costs.js): lots and risk from the account,
   * the round trip's cost in R and dollars, R after costs at the target and the stop, and any warnings.
   * The spread is the 1-minute candle's own at the entry time (never past the cursor), at least the minimum.
   */
  function positionNote(d) {
    const entry = d.points[0].price;
    const sized = trading.account.size(positionStats(d).risk, trading.balance, entry);
    if (sized.error) return "";
    const last = clock.active ? clock.position - 1 : m5.length - 1;
    const i = Math.min(last, Math.max(0, indexAtOrBefore(m5, d.points[0].time)));
    const spreadPoints = Math.max(trading.minSpreadPoints, m5.spread[i]);
    const cs = costSettings;
    const [minStop, maxStop] = stopLimits(cs, manifest.symbol);
    const s = trading.account.settings;
    const plan = positionPlan(d.type, entry, d.stop, d.target, {
      balance: trading.balance, riskPercent: s.riskPercent, pointValue: trading.account.pv(entry), pipPoints: manifest.pip_points,
      spreadPoints, commissionPerLot: s.commissionPerLot, perSide: s.commissionPerSide, slippagePips: cs.slippagePips,
      minStopPips: minStop, maxStopPips: maxStop, minTargetR: minTargetR(cs),
    });
    const base = `${formatLots(sized.units)} lots · risk ${formatMoney(sized.riskMoney)}`;
    if (plan.error) return base;
    const r = (v) => `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(2)}R`;
    const warnings = warningText({ ...plan, warnings: plan.warnings.filter((w) => w !== "too_small") },
      { minStopPips: minStop, maxStopPips: maxStop, minTargetR: minTargetR(cs), model: cs.model });
    return {
      entry: `${base} · costs ${plan.cost_r.toFixed(2)}R (${formatMoney(plan.cost_r * sized.riskMoney)})`,
      warn: warnings.length ? `⚠ ${warnings.join(" · ")}` : "",
      target: `${r(plan.target_r)} after costs`,
      stop: `${r(plan.stop_r)} after costs`,
    };
  }

  // One drawing layer per chart, all on the same drawings, acting as one (see layergroup.js).
  // ------------------------------------------------------------ order flow: volume profiles (Phase 3)
  // The order-flow bars (forex_replay/flow.py) load the first time a profile needs them. A profile is built
  // from them inside its own time window, never from the candles on screen, and only from bars that had
  // closed at the replay's cursor (profile.js); its right edge stops at the cursor (profiletool.js).
  let flowSettings = cleanFlowSettings((() => { try { return JSON.parse(recall(KEY_FLOW, "null")); } catch { return null; } })());
  let stateSettings = cleanStateSettings((() => { try { return JSON.parse(recall(KEY_STATE, "null")); } catch { return null; } })());
  const flowData = {}; // "M1" / "S15" -> { bars, seconds, manifest } | null (not built for this pair) | undefined (not loaded)
  const flowLoading = {};
  const levelLayers = [];
  const profileCache = new Map();
  const levelsCache = new Map();
  // The instrument's own default bin, in price, before its order-flow manifest has loaded (forex_replay/flow.INSTRUMENTS).
  const instrumentBin = () => (flowData.M1 && flowData.M1.manifest.instrument.bin) || { EURUSD: 0.0001, XAUUSD: 0.5 }[manifest.symbol]
    || manifest.pip_points / 10 ** manifest.digits;
  const redrawProfiles = () => {
    layer.redraw(); for (const l of levelLayers) l.redraw(); renderStateBox(); for (const b of bubbleLayers) b.redraw(); renderTrigger();
  };
  function ensureFlow(dataset) {
    if (flowData[dataset] !== undefined || flowLoading[dataset]) return;
    flowLoading[dataset] = loadFlow(manifest.symbol, dataset).then((r) => {
      flowData[dataset] = r ? { bars: r.bars, manifest: r.manifest, seconds: r.manifest.datasets[dataset].seconds } : null;
    }).catch(() => { flowData[dataset] = null; }).finally(() => { flowLoading[dataset] = null; redrawProfiles(); if (dataset === "M1") refreshFlowLayer(); else drawTrades(); });
  }
  /** The replay's cursor: the close of the last revealed base candle; outside a replay, the close of the last
   *  candle there is (the order-flow files can run on past the candles, as gold's do). */
  const flowCursor = () => m5.time[(clock.active ? clock.position : m5.length) - 1] + manifest.bar_seconds;
  function profiler(d, tfSeconds) {
    const s = d.profile;
    const f = flowData[s.source];
    if (f === undefined) { ensureFlow(s.source); return { message: "Profile: loading the order-flow bars…" }; }
    if (!f) return { message: `Profile: no order-flow data for ${manifest.symbol} (python -m forex_replay flow build ${manifest.symbol})` };
    const lastTime = f.bars.time[f.bars.length - 1] + f.seconds;
    const w = profileWindow(d, tfSeconds, lastTime);
    const cursor = flowCursor();
    const end = Math.min(w.end, cursor, lastTime); // never past the cursor
    if (end <= w.start) return { message: "Profile: starts after the replay's cursor" };
    const bin = Math.max(1, priceBin(s.bin || instrumentBin(), manifest.digits));
    const key = JSON.stringify([s, w.start, w.end, cursor, bin]);
    if (!profileCache.has(key)) {
      if (profileCache.size > 300) profileCache.clear();
      profileCache.set(key, profileFromBars(f.bars, f.seconds, w.start, w.end, bin, cursor, { valueArea: s.valueArea, smoothing: s.smoothing, lvn: s.lvn }));
    }
    const profile = profileCache.get(key);
    return profile ? { start: w.start, end, profile } : { message: "Profile: no order-flow bars in this range" };
  }
  /** The prior day's levels and naked POCs (for ProfileLevels and the market state), worked out once per cursor position. */
  let levelsMemo = { key: null, value: null };
  function levelsInfo() {
    if (!flowSettings.priorDay && !flowSettings.naked && !stateSettings.on) return null;
    const f = flowData.M1;
    if (f === undefined) { ensureFlow("M1"); return null; }
    if (!f) return null;
    const lastTime = f.bars.time[f.bars.length - 1] + f.seconds;
    const cursor = Math.min(flowCursor(), lastTime);
    const s = flowSettings.defaults;
    const bin = Math.max(1, priceBin(flowSettings.bins[manifest.symbol] || instrumentBin(), manifest.digits));
    const key = JSON.stringify([cursor, s, bin, flowSettings.naked, flowSettings.nakedDays]);
    if (levelsMemo.key !== key) {
      // Only the last few weeks matter: start at a trading-day boundary that many days back, so the first day is whole.
      const from = cursor - (flowSettings.nakedDays + 10) * 86400;
      let a = 0, b = f.bars.length;
      while (a < b) { const mid = (a + b) >> 1; if (f.bars.time[mid] < from) a = mid + 1; else b = mid; }
      const firstDay = a < f.bars.length ? serverDate(f.bars.time[a]) : 0;
      while (a < f.bars.length && serverDate(f.bars.time[a]) === firstDay && a > 0) a++;
      const part = { length: f.bars.length - a };
      for (const name of ["time", "low", "high", "tick_count"]) part[name] = f.bars[name].subarray(a);
      const levels = dayLevels(part, f.seconds, cursor, bin, flowSettings.naked ? flowSettings.nakedDays : 0,
        { valueArea: s.valueArea, smoothing: s.smoothing, lvn: s.lvn }, levelsCache);
      levelsMemo = { key, value: { levels, cursor } };
    }
    return levelsMemo.value;
  }
  /** What ProfileLevels paints: the prior day's lines and the naked POCs, each only when switched on. */
  function shownLevels() {
    if (!flowLayer.show || (!flowSettings.priorDay && !flowSettings.naked)) return null;
    const info = levelsInfo();
    if (!info) return null;
    const l = info.levels;
    return { cursor: info.cursor, levels: { ...l, prior: flowSettings.priorDay ? l.prior : null, naked: flowSettings.naked ? l.naked : [] } };
  }

  // ------------------------------------------------------------ order flow: market state (Phase 4)
  // Accepted or rejected relative to the previous day's value area, on 30-minute closes of the order-flow
  // 1-minute bars of the current trading day, closed by the cursor (marketstate.js, decision 0036).
  let stateMemo = { key: null, value: null };
  function stateInfo() {
    if (!stateSettings.on) return null;
    const info = levelsInfo();
    if (!info) return null;
    const f = flowData.M1;
    const p = info.levels.prior;
    const key = JSON.stringify([info.cursor, p && p.val, p && p.vah, stateSettings]);
    if (stateMemo.key !== key) {
      const st = stateSettings;
      const result = marketState(f.bars, f.seconds, info.cursor, p ? p.val : null, p ? p.vah : null, st.timeframe, st.accept, st.window);
      stateMemo = { key, value: { ...result, prior: p } };
    }
    return stateMemo.value;
  }
  const STATE_TONE = { accepted_above: "up", rejected_below: "up", accepted_below: "down", rejected_above: "down" };
  function renderStateBox() {
    const box = $("state-box");
    box.hidden = !stateSettings.on || !flowLayer.show;
    if (box.hidden) return;
    const info = stateInfo();
    if (!info) {
      box.className = "state-box";
      box.textContent = flowData.M1 === null ? "Market state: no order-flow data for this pair" : "Market state: loading…";
      return;
    }
    const price = (units) => (units / 2 / 10 ** manifest.digits).toFixed(manifest.digits);
    const last = info.events.at(-1);
    box.className = `state-box ${STATE_TONE[info.state] || ""}`;
    box.innerHTML = `<b>${STATE_WORDS[info.state]}</b>`
      + (info.prior ? `<span class="muted"> · VAH ${price(info.prior.vah)} · VAL ${price(info.prior.val)}</span>` : "")
      + (last ? `<span class="muted"> · ${eventLabel(last)} ${formatDateTime(last.time).slice(-5)}</span>` : "");
    box.title = `On ${stateSettings.timeframe / 60}-minute closes of the current trading day. Accepted: ${stateSettings.accept} closes in a row `
      + `outside the previous day's value area. Rejected: traded outside, then a close back inside within ${stateSettings.window / 60} minutes.`;
  }

  // ------------------------------------------------------------ order flow: synthetic order flow (Phase 5)
  // RVOL and CVD panels, bubbles and absorption from the 15-second buckets, CVD divergence (orderflow.js,
  // decision 0037). Everything stops at the replay's cursor. The master switch (Alt + O) hides all of it.
  const flowSeries = new Map(); // timeframe id -> FlowSeries
  const bubbleLayers = [];
  let s15 = null; // the 15-second buckets, a month at a time
  const instrumentMove = (key) => (flowData.M1 && flowData.M1.manifest.instrument[key]) || { bubble_move: { EURUSD: 0.00015, XAUUSD: 0.5 },
    absorption_move: { EURUSD: 0.00003, XAUUSD: 0.1 } }[key][manifest.symbol] || 0;
  const bubbleMove = () => flowLayer.bubbleMove[manifest.symbol] ?? instrumentMove("bubble_move");
  const absorptionMove = () => flowLayer.absorptionMove[manifest.symbol] ?? instrumentMove("absorption_move");
  const wantsFlowSeries = () => flowLayer.show && (flowLayer.rvol || flowLayer.cvd || flowLayer.deltaBars || flowLayer.divergence);
  let resetsMemo = { key: null, value: [] };
  /** CVD reset times from `first` to a day past the cursor: trading days, session opens, or the anchor. */
  function flowResets(first, cursor) {
    if (flowLayer.reset === "anchor") return flowLayer.anchor ? [flowLayer.anchor] : [];
    const last = Math.min(cursor, m5.time[m5.length - 1] + 60);
    const key = JSON.stringify([flowLayer.reset, first, Math.floor(last / 86400), getSessions()]);
    if (resetsMemo.key !== key) {
      const to = (Math.floor(last / 86400) + 2) * 86400;
      const value = flowLayer.reset === "day" ? dayResets(first, to, serverDate)
        : [...new Set(sessionsBetween(first, to).map((w) => w.start))].sort((a, b) => a - b);
      resetsMemo = { key, value };
    }
    return resetsMemo.value;
  }
  /** RVOL, delta and CVD for every candle of a timeframe so far (FlowSeries), or null before the bars load. */
  function flowValuesFor(full, tfId) {
    if (!wantsFlowSeries() || full.length === 0) return null;
    const f = flowData.M1;
    if (f === undefined) { ensureFlow("M1"); return null; }
    if (!f) return null;
    const cursor = flowCursor();
    let fs = flowSeries.get(tfId);
    if (!fs) flowSeries.set(tfId, (fs = new FlowSeries()));
    const resets = flowResets(full.time[0], cursor);
    const key = JSON.stringify([tfId, flowLayer.reset, flowLayer.anchor, flowLayer.fallback, getSessions()]);
    return fs.compute(full, timeframeOf(tfId).seconds, cursor, f.bars, resets, flowLayer.fallback ? m5 : null, f.bars.time[0], key);
  }
  /** CVD to show: with an anchor, nothing before the anchor's candle (the sum there runs from the data's start). */
  function shownCvd(v, full, tfId) {
    if (flowLayer.reset !== "anchor" || !flowLayer.anchor) return v.cvd;
    const tf = timeframeOf(tfId).seconds;
    let before = 0, hi = full.length; // the first candle that ends after the anchor
    while (before < hi) { const m = (before + hi) >> 1; if (full.time[m] + tf <= flowLayer.anchor) before = m + 1; else hi = m; }
    return before > 0 ? v.cvd.map((x, i) => (i < before ? null : x)) : v.cvd;
  }
  /** The chart's RVOL, CVD and delta lines (chart.setFlowLines). */
  function flowLinesFor(full, tfId, from) {
    const v = flowValuesFor(full, tfId);
    if (!v) return [];
    const redraw = from !== null && v.changedFrom < from; // earlier candles changed: send them all again
    const lines = [];
    const signed = (x) => `${x > 0 ? "+" : ""}${Math.round(x).toLocaleString("en-IN")}`;
    if (flowLayer.rvol) {
      lines.push({ id: "rvol", label: "RVOL", pane: "rvol", style: "histogram", values: v.rvol, precision: 2, redraw,
        colourOf: (x) => (x >= flowLayer.minRvol ? "#ffb300" : x >= 1.5 ? "#26a69a" : "#5d606b"), format: (x) => `${x.toFixed(2)}x` });
    }
    if (flowLayer.cvd) lines.push({ id: "cvd", label: "CVD", pane: "cvd", values: shownCvd(v, full, tfId), precision: 0, redraw, format: signed });
    if (flowLayer.deltaBars) {
      lines.push({ id: "delta", label: "Δ", pane: "cvd", style: "histogram", overlay: true, values: v.delta, precision: 0, redraw,
        colourOf: (x) => (x >= 0 ? "rgba(38, 166, 154, 0.7)" : "rgba(239, 83, 80, 0.7)"), format: signed });
    }
    return lines;
  }
  let divergenceMemo = { key: null, value: [] };
  /** CVD divergences on the closed candles of a chart (markers). */
  function flowDivergences(view) {
    if (!flowLayer.show || !flowLayer.divergence) return [];
    const shown = view.display.length;
    const closed = view.isForming() ? shown - 1 : shown;
    if (closed < 2) return [];
    const v = flowValuesFor(view.display, view.id);
    if (!v) return [];
    const key = JSON.stringify([view.id, closed, flowLayer.lookback, flowLayer.reset, flowLayer.anchor, v.cvd[closed - 1]]);
    if (divergenceMemo.key !== key) {
      const starts = Array.from(view.full.time.subarray(0, closed));
      const resets = flowResets(starts[0], flowCursor());
      divergenceMemo = { key, value: divergences(starts, Array.from(view.full.high.subarray(0, closed)), Array.from(view.full.low.subarray(0, closed)),
        shownCvd(v, view.display, view.id).slice(0, closed), resets, flowLayer.lookback) };
    }
    return divergenceMemo.value;
  }
  let bubbleMemo = { key: null, value: null };
  /** Bubbles and absorption between two times, from the buckets closed at the cursor. */
  function bubbleItems(from, to, memo = true) {
    if (!flowLayer.show || (!flowLayer.bubbles && !flowLayer.absorption)) return null;
    const f = flowData.M1;
    if (f === undefined) { ensureFlow("M1"); return null; }
    if (!f) return null;
    if (!s15) s15 = new FlowMonths(manifest.symbol, "S15", f.manifest, () => { bubbleMemo.key = null; redrawFlowLayer(); });
    const cursor = flowCursor();
    const end = Math.min(to, cursor);
    const parts = s15.parts(from, end);
    const key = JSON.stringify([from, end, cursor, flowLayer, s15.loaded.size]);
    if (memo && bubbleMemo.key === key) return bubbleMemo.value;
    const move = (price) => priceBin(price, manifest.digits);
    const items = [];
    for (const part of parts) {
      for (const b of findBubbles(part, from, end, cursor, move(bubbleMove()), move(absorptionMove()), flowLayer.minRvol, flowLayer.medium, flowLayer.large)) {
        if (b.kind === "bubble" ? flowLayer.bubbles : flowLayer.absorption) items.push(b);
      }
    }
    const value = { items, digits: manifest.digits };
    if (memo) bubbleMemo = { key, value };
    return value;
  }
  /** The legend's order-flow words for the candle under the mouse: its bubbles and absorption. */
  function flowLegend(pane, info) {
    if (!info || !flowLayer.show || (!flowLayer.bubbles && !flowLayer.absorption)) return "";
    const got = bubbleItems(info.time, info.time + timeframeOf(pane.tf).seconds, false);
    if (!got || got.items.length === 0) return "";
    const up = got.items.filter((b) => b.side === "up"), down = got.items.filter((b) => b.side === "down");
    const held = got.items.filter((b) => b.kind === "absorption");
    const most = (list) => Math.max(...list.map((b) => b.rvol)).toFixed(1);
    const words = [];
    if (up.length) words.push(`<b class="up">${up.length} ↑</b> (to ${most(up)}x)`);
    if (down.length) words.push(`<b class="down">${down.length} ↓</b> (to ${most(down)}x)`);
    if (held.length) words.push(`<b>${held.length} absorption</b> (to ${most(held)}x): high activity, no progress`);
    return `Bubbles ${words.join(" · ")}`;
  }
  function redrawFlowLayer() { for (const b of bubbleLayers) b.redraw(); }
  /** After a settings change or new data: the panels, markers and bubbles again. */
  function refreshFlowLayer() {
    for (const p of panes()) if (p.chart) p.chart.setFlowLines((full, tfId, from) => flowLinesFor(full, tfId, from));
    renderStateBox();
    for (const l of levelLayers) l.redraw();
    redrawFlowLayer();
    drawTrades();
    $("flow-open").classList.toggle("active", flowSettings.priorDay || flowSettings.naked || stateSettings.on
      || flowLayer.rvol || flowLayer.cvd || flowLayer.deltaBars || flowLayer.bubbles || flowLayer.absorption || flowLayer.divergence);
    $("flow-open").classList.toggle("hidden-layer", !flowLayer.show);
  }
  function setAnchorPicking(on) {
    if (on) layer.setTool(null);
    anchorPicking = on;
    setHint(on ? "Click the candle the CVD should start from. Press Esc to cancel." : null);
    $("chart-view").classList.toggle("picking", on);
  }

  // ------------------------------------------------------------ order flow: trigger panel (Phase 6)
  // Is the current 5-minute candle a trigger? Body, range against ATR, close position, RVOL and (switched on)
  // the bubble rule in an LVN zone of the profiles drawn (trigger.js, decision 0038). Judged on the minutes the
  // replay has revealed; at a 5-minute close, on the candle that has just closed.
  function triggerState() {
    const cursor = flowCursor();
    const candle = currentM5(m5, cursor);
    if (!candle) return null;
    const ts = triggerSettings;
    const m5View = viewFor("M5");
    if (atrMemo.period !== ts.atrPeriod) atrMemo = { period: ts.atrPeriod, values: atrOf(m5View.full, ts.atrPeriod) };
    const atr = atrBefore(m5View.full, atrMemo.values, candle.start); // the candles before this one only
    const f = flowData.M1;
    if (f === undefined) ensureFlow("M1");
    const rvol = f ? candleFlow([candle.start], 1, 300, cursor, f.bars, [], null, null, candle.start).rvol[0] : null;
    const rules = candleRules(candle.open, candle.high, candle.low, candle.close, atr, rvol, ts.side, ts.body, ts.rangeAtr, ts.closeZone, ts.minRvol);
    if (ts.on.bubble) {
      const zones = [];
      for (const d of drawings.items) {
        if (!d.profile) continue;
        const got = profiler(d, timeframeOf(current).seconds);
        if (got && got.profile) for (const z of got.profile.lvns) zones.push({ low: z.low, high: z.high });
      }
      let items = [];
      if (f) {
        if (!s15) s15 = new FlowMonths(manifest.symbol, "S15", f.manifest, () => { bubbleMemo.key = null; redrawFlowLayer(); renderTrigger(); });
        const move = (price) => priceBin(price, manifest.digits);
        for (const part of s15.parts(candle.start, candle.start + 300)) {
          items = items.concat(findBubbles(part, candle.start, candle.start + 300, cursor, move(bubbleMove()), move(absorptionMove()),
            flowLayer.minRvol, flowLayer.medium, flowLayer.large));
        }
      }
      rules.bubble = { ...bubbleRule(items, zones, 2 * candle.low, 2 * candle.high, ts.side, ts.bubbleRvol), zones: zones.length };
    }
    return { candle, atr, rvol, rules, on: triggerOn(rules, ts.on), hasFlow: !!f };
  }
  function renderTrigger() {
    const panelEl = $("trigger-panel");
    panelEl.hidden = manifest.bar_seconds !== 60; // a 5-minute candle needs the 1-minute candles
    if (panelEl.hidden) return;
    const ts = triggerSettings;
    for (const b of document.querySelectorAll(".trigger-sides button")) b.classList.toggle("active", b.dataset.side === ts.side);
    const st = triggerState();
    const light = $("trigger-light");
    if (!st) { light.className = "trigger-light"; $("trigger-summary").textContent = ""; $("trigger-rows").innerHTML = ""; return; }
    light.className = `trigger-light ${st.on ? "pass" : "fail"}`;
    $("trigger-summary").textContent = st.on ? `${ts.side === "long" ? "Long" : "Short"} trigger` : `no ${ts.side} trigger`;
    const c = st.candle;
    $("trigger-candle").textContent = `${formatDateTime(c.start).slice(-5)} IST · ${c.closed ? "closed" : `forming, ${c.minutes} of 5 min`}`;
    const pips = (points) => (points / manifest.pip_points).toFixed(1);
    const words = {
      body: () => (st.rules.body.value === null ? "no range" : `${Math.round(st.rules.body.value * 100)}%`),
      range: () => (st.atr === null ? "ATR not ready" : `${pips(c.high - c.low)} p, ${st.rules.range.value.toFixed(2)}×`),
      close: () => (st.rules.close.value === null ? "no range" : `at ${Math.round(st.rules.close.value * 100)}%`),
      rvol: () => (st.rvol === null ? (st.hasFlow ? "no baseline" : "no order-flow data") : `${st.rvol.toFixed(2)}x`),
      bubble: () => {
        const b = st.rules.bubble;
        if (!b) return "";
        if (!b.zone) return b.zones ? "not in an LVN" : "no LVN: draw a profile";
        return `${b.same} with, ${b.opposite} against`;
      },
    };
    const names = {
      body: RULE_NAMES.body.replace("{body}", Math.round(ts.body * 100)),
      range: RULE_NAMES.range.replace("{range}", ts.rangeAtr),
      close: RULE_NAMES.close.replace("{zone}", Math.round(ts.closeZone * 100)).replace("{end}", ts.side === "long" ? "in top" : "in bottom"),
      rvol: RULE_NAMES.rvol.replace("{rvol}", ts.minRvol),
      bubble: RULE_NAMES.bubble.replace("{bubbleRvol}", ts.bubbleRvol),
    };
    $("trigger-rows").innerHTML = RULES.map((r) => {
      const on = ts.on[r];
      const rule = st.rules[r];
      const lightClass = !on ? "off" : rule && rule.pass ? "pass" : "fail";
      return `<tr class="${on ? "" : "disabled"}" title="${RULE_HELP[r].replace("{atr}", ts.atrPeriod)}"><td><input type="checkbox" data-rule="${r}" ${on ? "checked" : ""} aria-label="Use this rule"></td>`
        + `<td><span class="trigger-light ${lightClass}"></span></td><td>${names[r]}</td><td class="value">${on || rule ? words[r]() : ""}</td></tr>`;
    }).join("");
  }
  function saveTrigger(change) {
    triggerSettings = cleanTriggerSettings({ ...triggerSettings, ...change });
    remember(KEY_TRIGGER, JSON.stringify(triggerSettings));
    renderTrigger();
  }
  for (const b of document.querySelectorAll(".trigger-sides button")) b.addEventListener("click", () => saveTrigger({ side: b.dataset.side }));

  // ------------------------------------------------------------ order flow: position tool costs (Phase 7)
  const NO_MAX_STOP = 100000; // pips: a blank maximum is stored as this, which no stop reaches
  function renderCostSettings() {
    const cs = costSettings;
    $("cost-slippage").value = cs.slippagePips;
    $("cost-model").value = cs.model;
    $("cost-target-a").value = cs.targetA;
    $("cost-target-b").value = cs.targetB;
    const [minStop, maxStop] = stopLimits(cs, manifest.symbol);
    $("cost-min-stop").value = minStop ?? "";
    $("cost-max-stop").value = maxStop === null || maxStop >= NO_MAX_STOP ? "" : maxStop;
    $("cost-stop-label").textContent = `${manifest.symbol} stop, pips (min / max)`;
  }
  function saveCosts() {
    const value = (id) => ($(id).value === "" ? null : Number($(id).value));
    const stopValue = (id) => ($(id).value === "" ? (id === "cost-max-stop" ? NO_MAX_STOP : 0) : Number($(id).value)); // blank: no limit
    costSettings = cleanCostSettings({
      ...costSettings, slippagePips: value("cost-slippage"), model: $("cost-model").value, targetA: value("cost-target-a"), targetB: value("cost-target-b"),
      minStop: { ...costSettings.minStop, [manifest.symbol]: stopValue("cost-min-stop") },
      maxStop: { ...costSettings.maxStop, [manifest.symbol]: stopValue("cost-max-stop") },
    });
    remember(KEY_COSTS, JSON.stringify(costSettings));
    renderCostSettings();
    layer.redraw();
  }
  for (const id of ["cost-slippage", "cost-model", "cost-target-a", "cost-target-b", "cost-min-stop", "cost-max-stop"]) $(id).addEventListener("change", saveCosts);
  renderCostSettings();
  $("trigger-rows").addEventListener("change", (event) => {
    const r = event.target.dataset.rule;
    if (r) saveTrigger({ on: { ...triggerSettings.on, [r]: event.target.checked } });
  });
  const TRIGGER_FIELDS = { "trig-body": ["body", 100], "trig-range": ["rangeAtr", 1], "trig-atr": ["atrPeriod", 1], "trig-close": ["closeZone", 100], "trig-rvol": ["minRvol", 1], "trig-bubble": ["bubbleRvol", 1] };
  for (const [id, [key, scale]] of Object.entries(TRIGGER_FIELDS)) {
    $(id).value = Math.round(triggerSettings[key] * scale * 100) / 100;
    $(id).addEventListener("change", () => {
      saveTrigger({ [key]: Number($(id).value) / scale });
      $(id).value = Math.round(triggerSettings[key] * scale * 100) / 100; // shows what was kept, if the number was refused
    });
  }

  const addLayer = (paneChart) => {
    const cb = layer.callbacks();
    bubbleLayers.push(new BubbleLayer(paneChart, (from, to) => bubbleItems(from, to)));
    levelLayers.push(new ProfileLevels(paneChart, shownLevels));
    const l = new DrawingLayer(paneChart, {
      store: drawings, pipPoints: manifest.pip_points, note: positionNote, editor: $("text-editor"),
      styleDefaults, onStyleDefaults: (map) => remember(KEY_DRAW_STYLES, JSON.stringify(map)),
      onSelect: cb.onSelect, onToolChange: cb.onToolChange,
      profiler, profileDefaults: () => { ensureFlow("M1"); return newProfileSettings(flowSettings, manifest.symbol, instrumentBin()); },
    });
    cb.bind(l);
    return layer.add(l);
  };
  const layer = new LayerGroup({
    onToolChange: (tool) => {
      toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === (tool || "")));
      const how = tool === "text" ? "click where the note goes, then type and press Enter"
        : TOOLS[tool]?.clicks === 2 ? "click the first point, then the second" : "click the chart at the price you want";
      setHint(!tool ? null : `${TOOLS[tool].label}: ${how}. Esc cancels.${layer && layer.magnet ? " Magnet on." : ""}`);
      if (tool && picking) setPicking(false);
      if (tool && panel && panel.pickTarget) panel.setPick(null);
    },
    onSelect: (d) => {
      drawBar.box.hidden = !d;
      if (!d) return;
      const position = d.type === "long" || d.type === "short";
      drawBar.ticket.hidden = !position;
      drawBar.levels.hidden = !position;
      if (position) { // keep the typed levels in step with dragging, but never under the cursor of someone typing
        if (document.activeElement !== drawBar.stop) drawBar.stop.value = priceText(d.stop);
        if (document.activeElement !== drawBar.target) drawBar.target.value = priceText(d.target);
      }
      drawBar.text.textContent = position
        ? `${TOOLS[d.type].label} · ${positionStats(d).ratio.toFixed(2)}R`
        : d.type === "hline" || d.type === "hray" ? `${TOOLS[d.type].label} · ${priceText(d.points[0].price)}` : TOOLS[d.type].label;
      const styled = TOOLS[d.type].styled;
      drawBar.colours.hidden = !styled;
      drawBar.styles.hidden = !styled || d.type === "text";
      drawBar.editText.hidden = d.type !== "text";
      drawBar.fibLevels.hidden = d.type !== "fib";
      $("draw-profile").hidden = !d.profile;
      drawBar.colours.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.colour === (d.color || PALETTE[0])));
      drawBar.styles.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.lineStyle === (d.style || "solid")));
    },
  });
  mainPane.layer = addLayer(chart);
  drawings.load(loadSavedDrawings(manifest.symbol));
  layer.redraw();
  renderUndo();

  drawBar.colours.addEventListener("click", (event) => {
    const b = event.target.closest("[data-colour]");
    if (b) layer.restyle({ color: b.dataset.colour });
  });
  drawBar.styles.addEventListener("click", (event) => {
    const b = event.target.closest("[data-line-style]");
    if (b) layer.restyle({ style: b.dataset.lineStyle });
  });
  drawBar.editText.addEventListener("click", () => { if (layer.selected) layer.editText({ id: layer.selected.id }); });
  // ------------------------------------------------------------ Fibonacci levels
  // Each Fibonacci drawing carries its own levels; "Save as default" sets what new ones start with.
  const FIB_PRESETS = {
    standard: FIB_LEVELS,
    classic: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
    extensions: [-2, -1, -0.618, -0.27, ...FIB_LEVELS, 1.272, 1.618],
  };
  const fibDialog = $("fib-dialog");
  let fibDraft = null; // { id, rows: [{ level, on }], ote } while the dialog is open
  const loadFibDefaults = () => {
    try {
      const raw = JSON.parse(recall(KEY_FIB_DEFAULTS, "null"));
      const levels = raw && cleanFibLevels(raw.levels);
      return levels ? { levels, ote: raw.ote !== false } : null;
    } catch { return null; }
  };
  layer.setFibDefaults(loadFibDefaults());

  function renderFibRows() {
    $("fib-rows").innerHTML = fibDraft.rows.map((r, i) => `<tr data-row="${i}">
      <td><input type="checkbox" data-fib-on${r.on ? " checked" : ""}></td>
      <td><input type="number" step="any" data-fib-level value="${r.level}"></td>
      <td><button type="button" class="plain small" data-fib-remove title="Remove this level">&times;</button></td></tr>`).join("");
    $("fib-ote").checked = fibDraft.ote;
  }
  /** The levels as typed and ticked, made safe; null (with a message) when nothing usable is left. */
  function fibLevelsFromDraft() {
    const levels = cleanFibLevels(fibDraft.rows.filter((r) => r.on).map((r) => r.level));
    $("fib-message").textContent = levels ? "" : "Keep at least one level, between -5 and 10.";
    return levels;
  }
  drawBar.fibLevels.addEventListener("click", () => {
    const d = layer.selected;
    if (!d || d.type !== "fib") return;
    fibDraft = { id: d.id, rows: fibLevelsOf(d).map((level) => ({ level, on: true })), ote: d.ote !== false };
    $("fib-message").textContent = "";
    renderFibRows();
    fibDialog.showModal();
  });
  fibDialog.addEventListener("input", (event) => {
    const row = event.target.closest("[data-row]");
    if (!row || !fibDraft) return;
    const r = fibDraft.rows[Number(row.dataset.row)];
    if (event.target.matches("[data-fib-on]")) r.on = event.target.checked;
    if (event.target.matches("[data-fib-level]")) r.level = Number(event.target.value);
  });
  fibDialog.addEventListener("click", (event) => {
    if (!fibDraft) return;
    const remove = event.target.closest("[data-fib-remove]");
    if (remove) { fibDraft.rows.splice(Number(remove.closest("[data-row]").dataset.row), 1); renderFibRows(); }
    const preset = event.target.closest("[data-fib-preset]");
    if (preset) { fibDraft.rows = FIB_PRESETS[preset.dataset.fibPreset].map((level) => ({ level, on: true })); renderFibRows(); }
  });
  $("fib-ote").addEventListener("change", (event) => { if (fibDraft) fibDraft.ote = event.target.checked; });
  $("fib-add").addEventListener("click", () => {
    const input = $("fib-new");
    const value = Number(input.value);
    if (input.value.trim() === "" || !cleanFibLevels([value])) { $("fib-message").textContent = "Type a level between -5 and 10, for example 1.272."; return; }
    fibDraft.rows.push({ level: value, on: true });
    fibDraft.rows.sort((a, b) => a.level - b.level);
    input.value = "";
    $("fib-message").textContent = "";
    renderFibRows();
  });
  $("fib-new").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("fib-add").click(); } });
  $("fib-cancel").addEventListener("click", () => { fibDraft = null; fibDialog.close(); });
  $("fib-apply").addEventListener("click", () => {
    const levels = fibLevelsFromDraft();
    const d = fibDraft && drawings.get(fibDraft.id);
    if (!levels || !d) return;
    const { id, ote, ...rest } = d;
    drawings.update(id, { ...rest, levels, ...(fibDraft.ote ? {} : { ote: false }) }); // one undo step
    layer.select(id);
    fibDraft = null;
    fibDialog.close();
  });
  $("fib-default").addEventListener("click", () => {
    const levels = fibLevelsFromDraft();
    if (!levels) return;
    const defaults = { levels, ote: fibDraft.ote };
    remember(KEY_FIB_DEFAULTS, JSON.stringify(defaults));
    layer.setFibDefaults(defaults);
    $("fib-message").textContent = "";
    setHint("New Fibonacci drawings will start with these levels.");
    setTimeout(() => setHint(null), 1800);
  });

  // Typed stop and target for a long/short position. They go through the same rules as dragging
  // (stop below entry below target for a long), so a price on the wrong side stops one point short.
  for (const [input, key] of [[drawBar.stop, "stop"], [drawBar.target, "target"]]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { input.blur(); return; }
      if (event.key !== "Enter") return;
      const d = layer.selected;
      const price = Math.round(Number(input.value) * 10 ** manifest.digits);
      if (!d || !(d.type === "long" || d.type === "short") || !Number.isFinite(price) || price <= 0) {
        setHint("Type a price like 1.08500.");
        setTimeout(() => setHint(null), 1800);
        return;
      }
      const { id, ...rest } = moveHandle(d, key, { time: d.points[0].time, price });
      drawings.update(id, rest);
      layer.select(id); // still selected, so the bar shows the new numbers
      input.blur();
    });
  }

  const magnetButton = $("magnet");
  const setMagnet = (on) => {
    layer.setMagnet(on);
    magnetButton.classList.toggle("active", layer.magnet);
    remember(KEY_MAGNET, layer.magnet ? "on" : "off");
  };
  setMagnet(recall(KEY_MAGNET, "off") === "on");
  magnetButton.addEventListener("click", () => setMagnet(!layer.magnet));
  const undoDrawing = () => { layer.cancel(); if (drawings.undo()) layer.select(null); };
  const redoDrawing = () => { layer.cancel(); if (drawings.redo()) layer.select(null); };
  undoButton.addEventListener("click", undoDrawing);
  redoButton.addEventListener("click", redoDrawing);

  // The shortcut list is built from the same table that handles the keys, so it cannot go out of date.
  const kbd = (keys) => keys.split(" + ").map((k) => `<kbd>${k}</kbd>`).join(" + ");
  $("shortcut-rows").innerHTML = [...SHORTCUTS, ...OTHER_KEYS]
    .map((s) => `<tr><td>${kbd(s.keys)}</td><td>${s.label}</td></tr>`).join("");
  const shortcutsDialog = $("shortcuts-dialog");
  $("shortcuts-open").addEventListener("click", () => shortcutsDialog.showModal());
  $("shortcuts-close").addEventListener("click", () => shortcutsDialog.close());

  toolButtons.forEach((b) => b.addEventListener("click", () => {
    disarmClear();
    layer.setTool(layer.tool === b.dataset.tool ? null : b.dataset.tool || null);
  }));
  drawBar.remove.addEventListener("click", () => layer.deleteSelected());
  drawBar.ticket.addEventListener("click", () => {
    const d = layer.selected;
    if (!d) return;
    panel.loadOrder({
      side: d.type === "long" ? Side.BUY : Side.SELL, price: d.points[0].price, stopLoss: d.stop, takeProfit: d.target,
    });
  });
  clearButton.addEventListener("click", () => {
    if (drawings.items.length === 0) return;
    if (!clearArmed) { // removing everything cannot be undone, so it takes a second click
      clearArmed = true;
      clearButton.classList.add("armed");
      setHint(`Remove all ${drawings.items.length} drawings? Click the bin again to confirm, or press Esc. (Ctrl + Z brings them back.)`);
      return;
    }
    disarmClear();
    drawings.clear();
  });

  const tfButtons = [...$("timeframes").querySelectorAll("button")];
  function setTimeframe(tf, { keepPlace = true } = {}) {
    // Stay at the same place in history, unless you were at the newest candle: then stay at the newest.
    const keepTime = keepPlace && !chart.latestVisible() ? chart.rightEdgeTime() : null;
    current = tf;
    view = viewFor(tf);
    view.setPosition(clock.position);
    remember(KEY_TIMEFRAME, tf);
    tfButtons.forEach((b) => b.classList.toggle("active", b.dataset.tf === tf));
    chart.setCandles(tf, view.display, { keepTime });
    drawTrades();
  }
  tfButtons.forEach((b) => {
    b.disabled = timeframeOf(b.dataset.tf).seconds < manifest.bar_seconds; // no candles finer than the replay's
    if (b.disabled) b.title = `${b.title}: not in 1-hour (swing) mode`;
    b.addEventListener("click", () => setTimeframe(b.dataset.tf));
  });
  setTimeframe(current, { keepPlace: false });

  // ------------------------------------------------------------ second chart
  const layoutButton = $("layout-toggle");
  const sideSelect = $("side-tf");
  sideSelect.innerHTML = usable.map((t) => `<option value="${t.id}">${t.id}</option>`).join("");

  /** The side chart's timeframe. It starts at the same moment as the main chart's right edge. */
  function setSideTimeframe(tf) {
    sidePane.tf = tf;
    sidePane.view = new TimeframeView(m5, tf, history[tf] || null);
    sidePane.view.setPosition(clock.position);
    sideSelect.value = tf;
    remember(KEY_SIDE_TF, tf);
    const keepTime = chart.latestVisible() ? null : chart.rightEdgeTime();
    sidePane.chart.setCandles(tf, sidePane.view.display, { keepTime });
    drawTrades();
    layer.redraw();
  }
  sideSelect.addEventListener("change", () => setSideTimeframe(sideSelect.value));

  /** One chart, or two side by side. The second chart is made the first time it is wanted. */
  function setLayout(two) {
    layoutTwo = two;
    remember(KEY_LAYOUT, two ? "two" : "one");
    layoutButton.classList.toggle("active", two);
    $("chart-view").classList.toggle("split", two);
    $("pane-side").hidden = !two;
    if (two) {
      if (!sidePane.chart) {
        sidePane.chart = new ChartView($("chart2"), chartOptions(sidePane));
        sidePane.chart.setSessionsVisible(sessionsOn);
        sidePane.chart.setIndicators(indicators);
        sidePane.chart.setFlowLines((full, tfId, from) => flowLinesFor(full, tfId, from));
      }
      if (!sidePane.layer) sidePane.layer = addLayer(sidePane.chart);
      setSideTimeframe(sidePane.tf);
    } else if (sidePane.layer) {
      sidePane.layer.select(null);
      layer.remove(sidePane.layer); // a hidden chart takes no part in drawing
      sidePane.layer.setTool(null);
      sidePane.layer = null;
    }
  }
  layoutButton.addEventListener("click", () => setLayout(!layoutTwo));

  // Jump to setup time (J) and the next session opens (1, 2, 3): see jump.js.
  function stoppedHint() {
    const t = trading.broker.trades;
    const last = t.slice().reverse().find((x) => x.status === "CLOSED" || x.status === "OPEN");
    return `Jump stopped at ${formatDateTime(m5.time[clock.position - 1] + manifest.bar_seconds)} IST: ` +
      (trading.challenge && trading.challenge.outcome !== "RUNNING" ? `the challenge ${trading.challenge.outcome.toLowerCase()}.`
        : last ? `trade #${last.id} ${last.status === "CLOSED" ? "closed" : "filled"}.` : "an order changed.");
  }
  function jumpTo(jump, what) {
    if (!clock.active) { setHint("Jumps work during a replay. Start one first."); return; }
    if (!clock.live) { setHint("Jumps work only at the live edge: press End (Live) first."); return; }
    if (!jump) { setHint("This strategy has no setup time. Set one in Strategies (Jump: none)."); return; }
    const next = nextJump(jump, m5, m5.length, clock.position, manifest.bar_seconds);
    if (!next) { setHint(`No later ${what} in this data.`); return; }
    const atSetup = pauseAtSetups() ? () => !!setupFinder().newAt(clock.position) : null; // a setup on the way stops it too
    const done = jumpClock(clock, trading, next.position, atSetup);
    allToLatest();
    const s = done.early && atSetup ? setupFinder().newAt(clock.position) : null;
    setHint(s ? setupHint(s, `Jump to ${what} stopped`) : done.early ? stoppedHint() : `At ${what}: ${formatDateTime(next.target)} IST. Paused.`);
  }
  const jumpSetup = () => jumpTo(backtests ? backtests.jumpOf(backtests.journal) : null, backtests ? jumpLabel(backtests.jumpOf(backtests.journal)) : "the setup");
  $("jump-setup").addEventListener("click", jumpSetup);

  // ------------------------------------------------------------ setup finder: next setup (N), pause, the card
  const setupHint = (s, lead) => `${lead}: ${s.side} setup, the 4-hour candle closed at ${formatDateTime(s.closeTime)} IST. Paused.`;

  /** Play forward, candle by candle, to the close of the next setup's 4-hour candle (at most 60 days), then pause. */
  function jumpToNextSetup() {
    if (!clock.active) { setHint("Jumps work during a replay. Start one first."); return; }
    if (!clock.live) { setHint("Jumps work only at the live edge: press End (Live) first."); return; }
    if (!setupRules.on) { setHint("Switch the setup finder on first: Indicators, Setup finder."); return; }
    if (clock.finished) { setHint("The replay has reached the end of the data."); return; }
    const f = setupFinder();
    const done = jumpClock(clock, trading, setupJumpLimit(m5, clock.position), () => !!f.newAt(clock.position));
    allToLatest();
    const s = f.newAt(clock.position);
    if (s) setHint(setupHint(s, "Next setup"));
    else if (done.early) setHint(stoppedHint());
    else if (clock.finished) setHint("No setup before the end of the data.");
    else setHint(`No setup in the next 60 days; the replay is at ${formatDateTime(m5.time[clock.position - 1] + manifest.bar_seconds)} IST. Press N to keep looking.`);
  }
  $("jump-next-setup").addEventListener("click", jumpToNextSetup);

  // While playing, stop at the close of each setup's candle so it cannot go by unseen.
  clock.onReveal((from, to) => {
    if (!clock.playing || !pauseAtSetups()) return;
    const f = setupFinder();
    for (let p = from + 1; p <= to; p++) {
      const s = f.newAt(p);
      if (!s) continue;
      clock.pause();
      const late = to - p; // at fast speeds several candles arrive at once: say how far past the close it stopped
      setHint(setupHint(s, "Stopped") + (late > 0 ? ` (${late} ${manifest.timeframe} candle${late > 1 ? "s" : ""} after the close)` : ""));
      return;
    }
  });

  const setupCard = $("setup-card");

  /** The card for the setup on the newest closed 4-hour candle: what to do, at what levels, and the size. */
  function renderSetupCard() {
    const s = setupRules.on && clock.active ? setupFinder().latestAt(clock.position) : null;
    if (!s || setupState.dismissed === s.closeTime) { setupCard.hidden = true; return; }
    setupCard.hidden = false;
    const sell = s.side === "SELL";
    // Taken: from this card, or any order on the same side placed since the candle closed (the ticket, or before a resume).
    const taken = setupState.taken.has(s.closeTime) || trading.broker.trades.some((t) => t.side === s.side &&
      t.status !== Status.CANCELLED && m5.time[t.placedTime] + manifest.bar_seconds >= s.closeTime);
    const blocked = trading.blockedReason;
    let size = "";
    if (!s.skip && !blocked) {
      const sized = trading.preview({ side: s.side, type: "market", stopLoss: s.stopLoss });
      size = sized.error ? `<p class="bad small">${sized.error}</p>`
        : `<p class="small">Size <b>${formatLots(sized.units)} lots</b> · risk ${formatMoney(sized.riskMoney)}${sized.riskPercent !== null ? ` (${sized.riskPercent}%)` : ""}</p>`;
    }
    setupCard.className = `setup-card ${s.skip ? "skipped" : sell ? "sell" : "buy"}`;
    setupCard.innerHTML =
      `<div class="setup-head"><b>${s.skip ? `${s.side} setup skipped` : `${s.side} now`}</b>` +
      `<button class="plain small" data-setup-act="dismiss" title="Hide this card">&#10005;</button></div>` +
      `<p class="muted small">4-hour candle closed ${formatDateTime(s.closeTime)} IST · RSI ${s.rsi.toFixed(1)}</p>` +
      `<dl class="setup-levels"><dt>Entry</dt><dd>${priceText(s.entry)} <span class="muted">at market</span></dd>` +
      `<dt>Stop</dt><dd>${priceText(s.stopLoss)} <span class="muted">${s.stopPips.toFixed(1)} pips · ${s.stopAtr.toFixed(2)} ATR</span></dd>` +
      `<dt>Target</dt><dd>${priceText(s.takeProfit)} <span class="muted">${setupRules.targetR}R</span></dd></dl>` +
      (s.skip ? `<p class="small">${s.skip === "wide" ? `Stop wider than ${setupRules.maxStopAtr} ATR: a late, stretched entry.` : `Stop under ${setupRules.minStopPips} pips.`} Not one to take.</p>`
        : size + (taken ? '<p class="small ok">Taken.</p>'
          : `<div class="setup-actions"><button class="order-place ${sell ? "sell" : "buy"}" data-setup-act="take"${blocked ? ` disabled title="${blocked}"` : ""}>${sell ? "Sell" : "Buy"} at market</button>` +
            `<button class="plain bordered small" data-setup-act="ticket" title="Put these levels in the order ticket and decide there">Ticket</button></div>`));
  }

  setupCard.addEventListener("click", (event) => {
    const act = event.target.closest("[data-setup-act]");
    const s = act && setupFinder().latestAt(clock.position);
    if (!s) return;
    if (act.dataset.setupAct === "dismiss") { setupState.dismissed = s.closeTime; renderSetupCard(); return; }
    if (act.dataset.setupAct === "ticket") {
      panel.loadOrder({ side: s.side, price: s.entry, stopLoss: s.stopLoss, takeProfit: s.takeProfit });
      panel.type = "market"; // the setup's entry is at market; the ticket keeps the stop and the target
      panel.say("Setup levels copied: market order. Check them, then place it.");
      panel.render();
      return;
    }
    try {
      const trade = trading.place({ side: s.side, type: "market", stopLoss: s.stopLoss, takeProfit: s.takeProfit });
      setupState.taken.add(s.closeTime);
      notes.toggleTag(trade.id, "setup finder"); // so the setup finder's trades can be picked out in Analytics
      panel.say(`#${trade.id} ${trade.side} ${formatLots(trading.account.units(trade))} lots: market order placed from the setup; it fills at the next candle's open.`, "ok");
    } catch (err) {
      if (!(err instanceof InvalidOrder)) throw err;
      panel.say(err.message, "bad");
    }
    refreshTrading();
  });
  for (const s of SESSION_OPENS) $(`jump-${s.id === "asia" ? "tokyo" : s.id}`).addEventListener("click", () => jumpTo(s.jump, `the ${s.label} open`));

  // ------------------------------------------------------------ order flow settings (Phase 3)
  // One dialog, two uses: from the toolbar it sets the defaults for new profiles, this pair's bin and the
  // levels drawn for you; from a selected profile's "Profile settings" it changes that profile only.
  const flowDialog = $("flow-dialog");
  let flowEditing = null; // the selected profile drawing being edited, or null for the defaults
  const percent = (v) => Math.round(v * 100);
  function openFlowDialog(drawing) {
    flowEditing = drawing || null;
    const s = flowEditing ? flowEditing.profile : { ...flowSettings.defaults, bin: flowSettings.bins[manifest.symbol] ?? instrumentBin() };
    $("flow-title").textContent = flowEditing ? "Profile settings" : "Order flow";
    $("flow-auto").hidden = !!flowEditing;
    $("flow-source").value = s.source;
    $("flow-bin").value = s.bin ?? instrumentBin();
    $("flow-bin").step = String(1 / 10 ** manifest.digits);
    $("flow-bin-note").textContent = flowEditing ? "this profile" : `for ${manifest.symbol} (its default: ${instrumentBin()})`;
    $("flow-va").value = percent(s.valueArea);
    $("flow-lvn").value = percent(s.lvn);
    $("flow-smoothing").value = String(s.smoothing);
    $("flow-width").value = percent(s.width);
    $("flow-side").value = s.side;
    $("flow-extend").checked = s.extend;
    $("flow-colour").value = s.colour;
    $("flow-poc-colour").value = s.pocColour;
    $("flow-prior").checked = flowSettings.priorDay;
    $("flow-naked").checked = flowSettings.naked;
    $("flow-naked-days").value = flowSettings.nakedDays;
    $("layer-show").checked = flowLayer.show;
    for (const k of ["rvol", "bubbles", "absorption", "cvd", "deltaBars", "divergence", "fallback"]) $(`layer-${k}`).checked = flowLayer[k];
    $("layer-min-rvol").value = flowLayer.minRvol;
    $("layer-medium").value = flowLayer.medium;
    $("layer-large").value = flowLayer.large;
    $("layer-bubble-move").value = bubbleMove();
    $("layer-absorption-move").value = absorptionMove();
    for (const id of ["layer-bubble-move", "layer-absorption-move"]) $(id).step = String(1 / 10 ** manifest.digits);
    $("layer-move-note").textContent = `for ${manifest.symbol}`;
    $("layer-reset").value = flowLayer.reset;
    $("layer-anchor-note").textContent = flowLayer.anchor ? `from ${formatDateTime(flowLayer.anchor)} IST` : "not set";
    $("layer-lookback").value = flowLayer.lookback;
    $("state-on").checked = stateSettings.on;
    $("state-labels").checked = stateSettings.labels;
    $("state-tf").value = String(stateSettings.timeframe);
    $("state-accept").value = stateSettings.accept;
    $("state-window").value = stateSettings.window / 60;
    $("flow-message").textContent = "";
    flowDialog.showModal();
  }
  function readLayerForm() {
    const flag = (k) => $(`layer-${k}`).checked;
    return cleanFlowLayer({
      ...flowLayer, show: flag("show"), rvol: flag("rvol"), bubbles: flag("bubbles"), absorption: flag("absorption"), cvd: flag("cvd"),
      deltaBars: flag("deltaBars"), divergence: flag("divergence"), fallback: flag("fallback"),
      minRvol: Number($("layer-min-rvol").value), medium: Number($("layer-medium").value), large: Number($("layer-large").value),
      bubbleMove: { ...flowLayer.bubbleMove, [manifest.symbol]: Number($("layer-bubble-move").value) },
      absorptionMove: { ...flowLayer.absorptionMove, [manifest.symbol]: Number($("layer-absorption-move").value) },
      reset: $("layer-reset").value, lookback: Number($("layer-lookback").value),
    });
  }
  $("layer-anchor-pick").addEventListener("click", () => {
    flowLayer = readLayerForm(); // keep what was typed, then pick
    flowDialog.close();
    setAnchorPicking(true);
  });
  function readFlowForm() {
    return cleanProfileSettings({
      source: $("flow-source").value, bin: $("flow-bin").value, valueArea: Number($("flow-va").value) / 100,
      lvn: Number($("flow-lvn").value) / 100, smoothing: Number($("flow-smoothing").value), width: Number($("flow-width").value) / 100,
      side: $("flow-side").value, extend: $("flow-extend").checked, colour: $("flow-colour").value, pocColour: $("flow-poc-colour").value,
    });
  }
  $("flow-open").addEventListener("click", () => openFlowDialog(null));
  $("draw-profile").addEventListener("click", () => { if (layer.selected && layer.selected.profile) openFlowDialog(layer.selected); });
  $("flow-close").addEventListener("click", () => flowDialog.close());
  $("flow-save").addEventListener("click", () => {
    const s = readFlowForm();
    if (flowEditing) {
      layer.setProfileSettings(s);
    } else {
      flowSettings = cleanFlowSettings({
        ...flowSettings, defaults: s, bins: { ...flowSettings.bins, [manifest.symbol]: s.bin },
        priorDay: $("flow-prior").checked, naked: $("flow-naked").checked, nakedDays: Number($("flow-naked-days").value),
      });
      remember(KEY_FLOW, JSON.stringify(flowSettings));
      stateSettings = cleanStateSettings({
        on: $("state-on").checked, labels: $("state-labels").checked, timeframe: Number($("state-tf").value),
        accept: Number($("state-accept").value), window: Number($("state-window").value) * 60,
      });
      remember(KEY_STATE, JSON.stringify(stateSettings));
      flowLayer = readLayerForm();
      remember(KEY_FLOW_LAYER, JSON.stringify(flowLayer));
      showFlowActive();
      refreshFlowLayer();
    }
    flowDialog.close();
    redrawProfiles();
    drawTrades();
  });
  function showFlowActive() {
    const on = flowSettings.priorDay || flowSettings.naked || stateSettings.on || wantsFlowSeries() || flowLayer.bubbles || flowLayer.absorption;
    $("flow-open").classList.toggle("active", on);
    if (on) ensureFlow("M1");
  }
  showFlowActive();
  renderStateBox();
  refreshFlowLayer();

  // ------------------------------------------------------------ indicators
  const indicatorsDialog = $("indicators-dialog");
  const indicatorsButton = $("indicators-open");
  // Moving averages: a row per line (SMA 1-5, EMA 1-5), each with its own on/off, period and colour.
  const MA_NOTES = { sma: "simple moving average of the closes", ema: "exponential moving average: recent closes count more" };
  $("ma-rows").innerHTML = ["sma", "ema"].map((kind) => indicators[kind].map((_, slot) =>
    `<tr><td><label class="check"><input type="checkbox" data-ma-on="${kind}:${slot}"> ${kind.toUpperCase()} ${slot + 1}</label></td>` +
    `<td><label>Period <input type="number" data-ma-period="${kind}:${slot}" min="2" max="500" step="1"></label></td>` +
    `<td><input type="color" data-ma-colour="${kind}:${slot}" aria-label="${kind.toUpperCase()} ${slot + 1} colour"></td>` +
    `<td class="muted">${slot === 0 ? MA_NOTES[kind] : ""}</td></tr>`).join("")).join("");
  const maInput = (what, kind, slot) => indicatorsDialog.querySelector(`[data-ma-${what}="${kind}:${slot}"]`);
  const isMa = (key) => key === "sma" || key === "ema";
  function renderIndicatorForm() {
    for (const [key, s] of Object.entries(indicators)) {
      if (isMa(key)) {
        s.forEach((line, slot) => {
          maInput("on", key, slot).checked = line.on;
          maInput("period", key, slot).value = line.period;
          maInput("colour", key, slot).value = line.colour;
        });
        continue;
      }
      indicatorsDialog.querySelector(`[data-ind="${key}"]`).checked = s.on;
      const period = indicatorsDialog.querySelector(`[data-period="${key}"]`);
      if (period) period.value = s.period;
      const levels = indicatorsDialog.querySelector(`[data-levels="${key}"]`);
      if (levels) levels.checked = s.levels;
      const mult = indicatorsDialog.querySelector(`[data-mult="${key}"]`);
      if (mult) mult.value = s.mult;
      const start = indicatorsDialog.querySelector(`[data-start="${key}"]`);
      if (start) start.value = s.start;
      const minutes = indicatorsDialog.querySelector(`[data-minutes="${key}"]`);
      if (minutes) minutes.value = s.minutes;
      const breakout = indicatorsDialog.querySelector(`[data-breakout="${key}"]`);
      if (breakout) breakout.checked = s.breakout;
      const buffer = indicatorsDialog.querySelector(`[data-buffer="${key}"]`);
      if (buffer) { // shown and set for the pair on screen only
        buffer.value = (bufferPoints(s, manifest.symbol, manifest.digits, manifest.pip_points) / 10 ** manifest.digits).toFixed(manifest.digits);
        buffer.step = String(1 / 10 ** manifest.digits);
        indicatorsDialog.querySelector(`[data-buffer-note="${key}"]`).textContent = `for ${manifest.symbol}`;
      }
    }
    indicatorsButton.classList.toggle("active", Object.values(indicators).some((s) => (Array.isArray(s) ? s.some((l) => l.on) : s.on)));
  }
  function applyIndicators() {
    const raw = {};
    for (const key of Object.keys(indicators)) {
      if (isMa(key)) {
        raw[key] = indicators[key].map((_, slot) => ({
          on: maInput("on", key, slot).checked, period: maInput("period", key, slot).value, colour: maInput("colour", key, slot).value,
        }));
        continue;
      }
      const period = indicatorsDialog.querySelector(`[data-period="${key}"]`);
      const levels = indicatorsDialog.querySelector(`[data-levels="${key}"]`);
      const mult = indicatorsDialog.querySelector(`[data-mult="${key}"]`);
      const start = indicatorsDialog.querySelector(`[data-start="${key}"]`);
      const minutes = indicatorsDialog.querySelector(`[data-minutes="${key}"]`);
      const breakout = indicatorsDialog.querySelector(`[data-breakout="${key}"]`);
      const buffer = indicatorsDialog.querySelector(`[data-buffer="${key}"]`);
      raw[key] = {
        on: indicatorsDialog.querySelector(`[data-ind="${key}"]`).checked,
        ...(period ? { period: period.value } : {}), ...(levels ? { levels: levels.checked } : {}), ...(mult ? { mult: mult.value } : {}),
        ...(start ? { start: start.value } : {}), ...(minutes ? { minutes: minutes.value } : {}),
        ...(breakout ? { breakout: breakout.checked } : {}),
        ...(buffer ? { buffers: { ...indicators[key].buffers, [manifest.symbol]: buffer.value } } : {}),
      };
    }
    indicators = cleanIndicators(raw);
    remember(KEY_INDICATORS, JSON.stringify(indicators));
    for (const c of [chart, sidePane.chart]) if (c) c.setIndicators(indicators);
    drawTrades(); // the breakout marker follows the settings
    renderIndicatorForm(); // a refused period snaps back to what is used
  }
  indicatorsDialog.addEventListener("change", (event) => {
    if (event.target.closest("[data-setup]")) applySetupRules(); else applyIndicators();
  });
  indicatorsButton.addEventListener("click", () => { renderIndicatorForm(); indicatorsDialog.showModal(); });
  $("indicators-close").addEventListener("click", () => indicatorsDialog.close());
  renderIndicatorForm();

  // The setup finder's settings, at the bottom of the same dialog; kept in this browser.
  const setupInput = (key) => indicatorsDialog.querySelector(`[data-setup="${key}"]`);
  function renderSetupForm() {
    for (const [key, value] of Object.entries(setupRules)) {
      const input = setupInput(key);
      if (!input) continue;
      if (input.type === "checkbox") input.checked = value; else input.value = value;
    }
    setupInput("pause").disabled = !setupRules.on;
  }
  function useSetupRules(rules) {
    setupRules = cleanSetupRules(rules);
    remember(KEY_SETUPS, JSON.stringify(setupRules));
    if (finder) finder.setRules(setupRules);
    setupState.dismissed = null;
    renderSetupForm(); // a refused value snaps back to what is used
    refreshTrading();
  }
  function applySetupRules() {
    const raw = {};
    indicatorsDialog.querySelectorAll("[data-setup]").forEach((input) => { raw[input.dataset.setup] = input.type === "checkbox" ? input.checked : input.value; });
    useSetupRules(raw);
  }
  $("setup-defaults").addEventListener("click", () => useSetupRules({ on: setupRules.on, pause: setupRules.pause }));
  renderSetupForm();

  // ------------------------------------------------------------ replay
  const ui = {
    toggle: $("replay-toggle"), controls: $("replay-controls"), back: $("replay-back"),
    play: $("replay-play"), forward: $("replay-forward"), speed: $("replay-speed"),
    live: $("replay-live"), exit: $("replay-exit"), clock: $("clock"),
  };
  let exitArmed = false; // ✕ was clicked once and the save failed
  ui.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}x</option>`).join("");

  function setPicking(on) {
    if (on) layer.setTool(null);
    picking = on;
    setHint(on ? "Click the candle you want the replay to start from. Press Esc to cancel." : null);
    ui.toggle.classList.toggle("active", on);
    $("chart-view").classList.toggle("picking", on);
  }

  function renderReplayUi() {
    ui.toggle.hidden = clock.active;
    ui.controls.hidden = !clock.active;
    document.body.classList.toggle("replaying", clock.active);
    if (!clock.active) {
      ui.clock.textContent = "";
      return;
    }
    ui.play.innerHTML = clock.playing ? "&#10074;&#10074;" : "&#9654;";
    ui.play.title = clock.playing ? "Pause (Space)" : "Play (Space)";
    ui.forward.disabled = clock.finished;
    ui.live.hidden = clock.live;
    for (const id of ["jump-setup", "jump-next-setup", "jump-tokyo", "jump-london", "jump-newyork"]) {
      const b = $(id);
      b.disabled = !clock.live || clock.finished;
      if (!b.dataset.title) b.dataset.title = b.title;
      b.title = clock.live ? b.dataset.title : "Jumps work only at the live edge: press End (Live) first";
    }
    const now = m5.time[clock.position - 1] + manifest.bar_seconds; // close of the last revealed candle
    const behind = clock.furthest - clock.position;
    ui.clock.textContent = `Replay · ${formatDateTime(now)} IST` +
      (behind > 0 ? ` · viewing history (${number(behind)} ${manifest.timeframe} back)` : "");
    ui.clock.classList.toggle("history", behind > 0);
  }

  clock.onChange(() => redrawProfiles()); // anchored profiles grow, and the day levels move, with the replay
  clock.onChange((_, reason) => {
    if (reason === "start" && !resuming) { // a new replay is a new run: no trades carried over
      trading.reset();
      shotsTaken.clear();
      setupState.dismissed = null;
      setupState.taken.clear();
      notes.load({});
      const startTime = m5.time[clock.position - 1];
      backtests.begin(startTime, manifest.symbol);
      // Drawings come along only if they sit wholly before the replay's "now" (no look-ahead).
      drawings.load(drawingsBefore(drawings.toJSON(), startTime + manifest.bar_seconds));
      layer.select(null);
      layer.storeChanged();
    }
    if (exitArmed && reason !== "stop") { exitArmed = false; setHint(null); }
    for (const p of panes()) updatePane(p, reason);
    renderReplayUi();
    refreshTrading();
  });

  /** Bring one chart up to the replay clock: only what changed, or everything after a start, stop or jump. */
  function updatePane(p, reason) {
    const c = p.chart, v = p.view;
    const follow = c.latestVisible();
    const change = v.setPosition(clock.position);
    if (reason === "start") {
      c.setCandles(p.tf, v.display, { bars: c.visibleBarCount() }); // replay edge at the right
    } else if (reason === "stop") {
      c.setCandles(p.tf, v.display, { keepTime: c.rightEdgeTime(), bars: c.visibleBarCount() });
    } else if (change.reset) {
      c.setCandles(p.tf, v.display, { preserveView: true });
      if (follow) c.goToLatest();
    } else if (change.to >= change.from) {
      c.updateBars(change.from, change.to);
    }
  }
  const allToLatest = () => { for (const p of panes()) p.chart.goToLatest(); };

  ui.toggle.addEventListener("click", () => setPicking(!picking));
  ui.play.addEventListener("click", () => clock.toggle());
  ui.forward.addEventListener("click", () => clock.stepForward(view));
  ui.back.addEventListener("click", () => clock.stepBack(view));
  ui.live.addEventListener("click", () => { clock.backToLive(); allToLatest(); });
  // Leaving saves the backtest; open trades and orders stay open in it, ready to resume.
  ui.exit.addEventListener("click", async () => {
    clock.pause();
    await shotQueue; // screenshots still uploading belong in this save
    const wasSaved = backtests.worthSaving;
    if (exitArmed) {
      backtests.abandon(); // second click after a failed save: leave without saving
    } else if (!(await backtests.end())) {
      exitArmed = true;
      setHint("This backtest could not be saved (see the bottom bar). Click ✕ again to leave without saving it.");
      return;
    }
    exitArmed = false;
    setHint(null);
    leaveReplay();
    panel.say(wasSaved ? "Backtest saved. Open Backtests to carry on with it later." : "", "ok");
  });

  function leaveReplay() {
    clock.stop();
    trading.challengeRules = loadChallengeRules(); // likewise its challenge rules
    trading.reset();
    trading.updateSettings(loadSettings()); // a resumed backtest brought its own settings; go back to yours
    panel.renderSettings();
    useChartDrawings();
    notes.load({});
    journalBox.pick(null);
  }

  /** Rebuild a saved backtest and open it at the point it had reached. Returns the rebuild's problems. */
  async function resumeBacktest(journal, id) {
    const saved = await store.getBacktest(journal, id);
    const savedBase = saved.barSeconds === 3600 ? "H1" : "M1"; // swing sessions replayed hours
    if ((saved.symbol || "EURUSD") !== manifest.symbol || (saved.barSeconds && savedBase !== baseMode)) {
      await switchSymbol(saved.symbol || "EURUSD", `${journal}/${id}`, savedBase); // open the app on its pair and candles, then resume there
      return [];
    }
    const result = rebuild(saved, { m5, pipPoints: manifest.pip_points, pointValue: pointValueFor(manifest.symbol, manifest.digits, manifest.contract_size), barSeconds: manifest.bar_seconds });
    await shotQueue;
    if (clock.active && !(await backtests.end())) {
      throw new Error("the replay on screen could not be saved, so it was left open.");
    }
    markShotsTaken(result.trading.broker.trades);
    clock.pause();
    layer.setTool(null);
    setPicking(false);
    resuming = true;
    try { clock.start(result.position); } finally { resuming = false; }
    notes.load(saved.notes || {});
    trading.adopt(result.trading);
    backtests.continueWith(saved);
    journalBox.pick(null);
    drawings.load(saved.drawings);
    layer.select(null);
    layer.storeChanged();
    if (TIMEFRAMES.some((t) => t.id === saved.timeframe)) setTimeframe(saved.timeframe, { keepPlace: false });
    panel.renderSettings();
    refreshTrading();
    panel.say(result.problems.length
      ? `Resumed "${saved.name}", but the rebuild does not match the save (see Backtests).`
      : `Resumed "${saved.name}": ${saved.actions.length} action(s) repeated; every trade matches the save.`,
    result.problems.length ? "bad" : "ok");
    return result.problems;
  }
  ui.speed.addEventListener("change", () => clock.setSpeed(Number(ui.speed.value)));

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement) return; // typing, not a shortcut
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Escape" && panes().some((p) => p.chart.cancelDrag())) return;
    if (event.key === "Escape" && clearArmed) { disarmClear(); return; }
    if (event.key === "Escape" && layer.cancel()) return;
    if ((event.key === "Delete" || event.key === "Backspace") && layer.deleteSelected()) { event.preventDefault(); return; }
    const action = shortcutFor(event);
    if (action) {
      event.preventDefault(); // Alt + F would otherwise open the browser's menu
      disarmClear();
      if (action.startsWith("tool:")) {
        const tool = action.slice(5);
        layer.setTool(layer.tool === tool ? null : tool);
      } else if (action === "magnet") {
        setMagnet(!layer.magnet);
        setHint(`Magnet ${layer.magnet ? "on: a point near a candle's open, high, low or close jumps onto it" : "off"}.`);
        setTimeout(() => setHint(null), 1800);
      } else if (action === "flowlayer") {
        flowLayer = cleanFlowLayer({ ...flowLayer, show: !flowLayer.show });
        remember(KEY_FLOW_LAYER, JSON.stringify(flowLayer));
        if (flowLayer.show) showFlowActive();
        refreshFlowLayer();
        setHint(`Order-flow layer ${flowLayer.show ? "shown" : "hidden"} (Alt + O).`);
        setTimeout(() => setHint(null), 1800);
      } else if (action === "undo") undoDrawing();
      else if (action === "redo") redoDrawing();
      else if (action === "help") shortcutsDialog.showModal();
      return;
    }
    if (event.key === "Escape" && picking) { setPicking(false); return; }
    if (event.key === "Escape" && anchorPicking) { setAnchorPicking(false); return; }
    if (event.key === "Escape" && panel.pickTarget) { panel.setPick(null); return; }
    if (!clock.active) return;
    if (event.key === " ") { event.preventDefault(); clock.toggle(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); event.shiftKey ? clock.advance(1) : clock.stepForward(view); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); clock.stepBack(view); }
    else if (event.key === "End") { clock.backToLive(); allToLatest(); }
    else if ((event.key === "j" || event.key === "J") && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); jumpSetup(); }
    else if ((event.key === "n" || event.key === "N") && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); jumpToNextSetup(); }
    else if (["1", "2", "3"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const s = SESSION_OPENS.find((x) => x.key === event.key);
      event.preventDefault();
      jumpTo(s.jump, `the ${s.label} open`);
    }
  });
  panel = new TradingPanel($("trading-panel"), {
    trading, m5, digits: manifest.digits,
    onPickChange: (label) => setHint(label ? `Click the chart at the price for your ${label}. Press Esc to cancel.` : null),
    notes,
    onPickTrade: (id) => journalBox.pick(journalBox.id === id ? null : id),
    planCheck: (order) => (adrPanel ? adrPanel.check(order) : []),
  });
  // The ADR plan: today's ADR and the plan's thresholds, for the replay's day (or the newest day outside a replay).
  adrPanel = new AdrPanel($("adr-plan"), { m5, nowIndex: () => clock.position - 1, pipPoints: manifest.pip_points });
  journalBox = new JournalPanel($("journal-box"), {
    store,
    notes,
    describe: (id) => {
      const t = clock.active ? trading.broker.trades.find((trade) => trade.id === id) : null;
      if (!t) return null;
      const state = t.status === Status.CLOSED ? formatR(t.resultR) : t.status.toLowerCase();
      return `#${t.id} ${t.side} · ${state}`;
    },
    journal: () => backtests && backtests.current ? backtests.current.journal : null,
    onScreenshot: (id) => takeScreenshot(id, "added"),
    onRemoveScreenshot: (id, name) => {
      const bt = backtests.current;
      if (bt) store.deleteScreenshot(bt.journal, name);
      notes.removeScreenshot(id, name);
    },
    onPick: (id) => { panel.pickedTrade = id; panel.render(); },
    checklist: () => (backtests && backtests.current ? backtests.checklist(backtests.current.journal) : []),
  });
  backtests = new Backtests({
    store,
    dialog: $("backtests-dialog"),
    status: $("status-backtest"),
    collect: () => ({ trading, drawings, notes, m5, clock, manifest, timeframe: current }),
    onResume: resumeBacktest,
    onNewSession: newSession,
    chip: $("strategy-name"),
    onStrategiesChanged: () => journalBox.render(),
  });
  backtests.loadLabels();

  /** "New session" in the Strategies dialog: save and leave the session on screen, then pick a start candle. */
  async function newSession(journal) {
    if (clock.active) {
      clock.pause();
      await shotQueue;
      if (!(await backtests.end())) {
        panel.say("The session on screen could not be saved (see the bottom bar), so it is still open.", "bad");
        return;
      }
      leaveReplay();
    }
    setPicking(true);
    setHint(`New ${backtests.label(journal)} session: click the candle you want the replay to start from. Press Esc to cancel.`);
  }
  $("backtests-open").addEventListener("click", () => { clock.pause(); backtests.open(); });
  window.addEventListener("pagehide", () => backtests.saveOnUnload());

  /** Open the app on another pair: save and leave the session on screen first. `resume` = "journal/id" to open there. */
  async function switchSymbol(next, resume = null, base = baseMode) {
    if (!known(next)) { panel.say(`There is no ${next} data. Put an MT5 export of it in data/ and restart the app.`, "bad"); return; }
    if (clock.active) {
      clock.pause();
      await shotQueue;
      if (!(await backtests.end())) {
        symbolBox.value = manifest.symbol;
        baseBox.value = baseMode;
        panel.say("The session on screen could not be saved (see the bottom bar), so it is still open.", "bad");
        return;
      }
    }
    try { localStorage.setItem(KEY_SYMBOL, next); } catch { /* private mode: not kept */ }
    try { localStorage.setItem(KEY_BASE, base); } catch { /* private mode: not kept */ }
    const query = new URLSearchParams({ symbol: next, base });
    if (resume) query.set("resume", resume);
    location.search = query.toString();
  }
  symbolBox.addEventListener("change", () => switchSymbol(symbolBox.value));
  baseBox.addEventListener("change", () => switchSymbol(manifest.symbol, null, baseBox.value));

  // Opened to resume a session of this pair (after switching from another pair).
  if (params.get("resume")) {
    const [journal, id] = params.get("resume").split("/");
    window.history.replaceState(null, "", `?symbol=${manifest.symbol}&base=${baseMode}`); // window.history: `history` here is the older candles
    resumeBacktest(journal, id).catch((err) => panel.say(`Could not resume: ${err.message}`, "bad"));
  }
  renderReplayUi();
  refreshTrading();

  // ------------------------------------------------------------ sessions
  const sessionsButton = $("sessions-toggle");
  let sessionsOn = recall(KEY_SESSIONS, "on") === "on";
  const applySessions = () => {
    for (const c of [chart, sidePane.chart]) if (c) c.setSessionsVisible(sessionsOn);
    sessionsButton.classList.toggle("active", sessionsOn);
    $("session-key").hidden = !sessionsOn;
  };
  sessionsButton.addEventListener("click", () => {
    sessionsOn = !sessionsOn;
    remember(KEY_SESSIONS, sessionsOn ? "on" : "off");
    applySessions();
  });
  applySessions();
  renderSessionKey($("session-key"));
  const openSessionSettings = setupSessionSettings($("sessions-dialog"), {
    // India-time preview for the date you are looking at: the replay time, or the newest candle.
    referenceTime: () => m5.time[clock.position - 1],
    onSaved: () => {
      for (const c of [chart, sidePane.chart]) if (c) c.refreshSessions();
      renderSessionKey($("session-key"));
    },
  });
  $("sessions-settings").addEventListener("click", openSessionSettings);

  // ------------------------------------------------------------ go to date / latest
  const goto = $("goto");
  goto.min = toIndiaInput(manifest.first);
  goto.max = toIndiaInput(manifest.last);
  goto.addEventListener("change", () => {
    const when = parseIndiaInput(goto.value);
    if (when !== null) for (const p of panes()) p.chart.goTo(when);
  });
  $("latest").addEventListener("click", allToLatest);
  setLayout(layoutTwo); // after the sessions are set up: the side chart copies their visibility

  // ------------------------------------------------------------ tabs
  const tabViews = { chart: $("chart-view"), analytics: $("analytics-view"), data: $("data-view") };
  const analytics = new AnalyticsView($("analytics-view"), store);
  document.querySelectorAll("[data-view]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.view;
      Object.entries(tabViews).forEach(([key, el]) => { el.hidden = key !== name; });
      document.querySelectorAll("[data-view]").forEach((t) => t.classList.toggle("active", t === tab));
      if (name === "data") redrawData();
      if (name === "analytics") {
        clock.pause();
        // Save the replay on screen first, so its latest trades are in the journal being read.
        (backtests.current ? backtests.save() : Promise.resolve()).then(() => analytics.open());
      }
    });
  });

  // Handy in the browser console and for automated checks.
  window.forexReplay = {
    manifest, quality, m5, chart, clock, trading, panel, viewFor, setTimeframe, drawings, layer, backtests, notes, journalBox,
    sidePane, setLayout, setSideTimeframe,
    get timeframe() { return current; },
    get view() { return view; },
  };
}

boot().catch((err) => {
  console.error(err);
  showError(`Something went wrong while starting the app.\n${err.message}`);
});
