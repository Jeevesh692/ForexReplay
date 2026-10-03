// App start-up: load data, build the chart, wire the top bar and the replay.

import { formatLots, formatSignedMoney, loadSettings, pointValuePerLot } from "./account.js";
import { ChartView } from "./chart.js";
import { loadJSON, loadSymbol } from "./data.js";
import { renderDataView } from "./dataview.js";
import { OrderType } from "./broker.js";
import { ReplayClock, SPEEDS } from "./replay.js";
import { loadSavedSessions, renderSessionKey, setupSessionSettings } from "./sessionsettings.js";
import { formatDateTime, IST_OFFSET_SECONDS } from "./time.js";
import { TIMEFRAMES, TimeframeView } from "./timeframes.js";
import { InvalidOrder, Side, Status, Trading } from "./trading.js";
import { TradingPanel } from "./tradingpanel.js";

const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString("en-IN");
const KEY_TIMEFRAME = "forexreplay.timeframe";
const KEY_SESSIONS = "forexreplay.sessions";

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
function renderLegend(symbol, timeframeId, digits, info, forming) {
  const el = $("legend");
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
    `<span class="legend-volume">Vol ${number(info.volume)}</span>`;
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
  const health = await loadJSON("/api/health").catch(() => null);
  if (health) $("status-version").textContent = `app v${health.version}`;

  const lib = window.LightweightCharts;
  $("status-lib").innerHTML = lib
    ? `<span class="ok">Chart library v${lib.version()} ready</span>`
    : '<span class="bad">Chart library missing</span>';

  let loaded, quality;
  try {
    [loaded, quality] = await Promise.all([loadSymbol("EURUSD"), loadJSON("data/EURUSD/quality.json")]);
  } catch (err) {
    console.error(err);
    showError(`Could not load the market data.\n${err.message}\n\n` +
      "Fix: close this tab, then run  python -m forex_replay app --rebuild");
    return;
  }
  const { manifest, candles: m5 } = loaded;

  $("status-data").textContent =
    `${manifest.symbol} · ${number(manifest.bars)} M5 candles · ` +
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
    if (!views.has(tf)) views.set(tf, new TimeframeView(m5, tf));
    return views.get(tf);
  };

  let current = recall(KEY_TIMEFRAME, "M15");
  if (!TIMEFRAMES.some((t) => t.id === current)) current = "M15";
  let view = viewFor(current);
  let picking = false; // waiting for a click on the candle to start the replay from
  let panel = null; // trading panel (created below, once the chart exists)
  loadSavedSessions();

  const hint = $("hint");
  const setHint = (text) => {
    hint.hidden = !text;
    hint.textContent = text || "";
  };

  const chart = new ChartView($("chart"), {
    lib,
    symbol: manifest.symbol,
    digits: manifest.digits,
    onHover: (info) => renderLegend(manifest.symbol, current, manifest.digits, info,
      info && info.index === view.display.length - 1 && view.isForming()),
    onClick: (index, price) => {
      if (picking) {
        if (index === null) return;
        setPicking(false);
        clock.start(view.endOf(index)); // the clicked candle is the last one shown
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

  // ------------------------------------------------------------ trading
  const UP = "#26a69a", DOWN = "#ef5350", PENDING = "#ffb74d", ENTRY = "#d1d4dc";
  const trading = new Trading({
    m5, clock, pipPoints: manifest.pip_points, pointValue: pointValuePerLot(manifest.digits),
    settings: loadSettings(), onChange: () => refreshTrading(),
  });
  const formatR = (r) => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
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
      ? ` · ${formatSignedMoney(trading.account.money(trading.account.openUnits(t), points))} on what is open` : "";
    return `${text} · ${(points / manifest.pip_points).toFixed(1)} pips from entry (${formatR(points / t.plannedRisk)})${money}`;
  }

  /** Lines for active trades and entry/exit markers for the timeframe on screen. */
  function drawTrades() {
    const lines = [];
    const markers = [];
    const shown = view.display.length;
    const draggable = !trading.blockedReason; // lines can be moved only when orders can be placed
    for (const t of trading.broker.trades) {
      if (t.status === Status.CANCELLED) continue;
      const buy = t.side === Side.BUY;
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
      if (t.exitTime !== null && view.bucketOf[t.exitTime] < shown) {
        markers.push({
          time: view.full.time[view.bucketOf[t.exitTime]], above: buy, colour: t.resultR >= 0 ? UP : DOWN,
          shape: "circle", text: formatR(t.resultR),
        });
      }
    }
    chart.setTradeLines(lines);
    chart.setTradeMarkers(markers);
  }

  function refreshTrading() {
    if (panel) panel.render();
    drawTrades();
  }

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
    b.disabled = false;
    b.addEventListener("click", () => setTimeframe(b.dataset.tf));
  });
  setTimeframe(current, { keepPlace: false });

  // ------------------------------------------------------------ replay
  const ui = {
    toggle: $("replay-toggle"), controls: $("replay-controls"), back: $("replay-back"),
    play: $("replay-play"), forward: $("replay-forward"), speed: $("replay-speed"),
    live: $("replay-live"), exit: $("replay-exit"), clock: $("clock"),
  };
  let exitArmed = false; // ✕ was clicked once while trades were open
  ui.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}x</option>`).join("");

  function setPicking(on) {
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
    const now = m5.time[clock.position - 1] + manifest.bar_seconds; // close of the last revealed candle
    const behind = clock.furthest - clock.position;
    ui.clock.textContent = `Replay · ${formatDateTime(now)} IST` +
      (behind > 0 ? ` · viewing history (${number(behind)} M5 back)` : "");
    ui.clock.classList.toggle("history", behind > 0);
  }

  clock.onChange((_, reason) => {
    if (reason === "start") trading.reset(); // a new replay is a new run: no trades carried over
    if (exitArmed && reason !== "stop") { exitArmed = false; setHint(null); }
    const follow = chart.latestVisible();
    const change = view.setPosition(clock.position);
    if (reason === "start") {
      chart.setCandles(current, view.display, { bars: chart.visibleBarCount() }); // replay edge at the right
    } else if (reason === "stop") {
      chart.setCandles(current, view.display, { keepTime: chart.rightEdgeTime(), bars: chart.visibleBarCount() });
    } else if (change.reset) {
      chart.setCandles(current, view.display, { preserveView: true });
      if (follow) chart.goToLatest();
    } else if (change.to >= change.from) {
      chart.updateBars(change.from, change.to);
    }
    renderReplayUi();
    refreshTrading();
  });

  ui.toggle.addEventListener("click", () => setPicking(!picking));
  ui.play.addEventListener("click", () => clock.toggle());
  ui.forward.addEventListener("click", () => clock.stepForward(view));
  ui.back.addEventListener("click", () => clock.stepBack(view));
  ui.live.addEventListener("click", () => { clock.backToLive(); chart.goToLatest(); });
  ui.exit.addEventListener("click", () => {
    const { open, pending } = trading.summary();
    if (open + pending > 0 && !exitArmed) {
      exitArmed = true;
      setHint(`Exiting closes ${open} open trade(s) at the current price and cancels ${pending} order(s). Click ✕ again to confirm.`);
      return;
    }
    exitArmed = false;
    setHint(null);
    if (open + pending > 0) {
      clock.pause();
      clock.backToLive();
      trading.flatten();
    }
    clock.stop();
  });
  ui.speed.addEventListener("change", () => clock.setSpeed(Number(ui.speed.value)));

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Escape" && chart.cancelDrag()) return;
    if (event.key === "Escape" && picking) { setPicking(false); return; }
    if (event.key === "Escape" && panel.pickTarget) { panel.setPick(null); return; }
    if (!clock.active) return;
    if (event.key === " ") { event.preventDefault(); clock.toggle(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); event.shiftKey ? clock.advance(1) : clock.stepForward(view); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); clock.stepBack(view); }
    else if (event.key === "End") { clock.backToLive(); chart.goToLatest(); }
  });
  panel = new TradingPanel($("trading-panel"), {
    trading, m5, digits: manifest.digits,
    onPickChange: (label) => setHint(label ? `Click the chart at the price for your ${label}. Press Esc to cancel.` : null),
  });
  renderReplayUi();
  refreshTrading();

  // ------------------------------------------------------------ sessions
  const sessionsButton = $("sessions-toggle");
  let sessionsOn = recall(KEY_SESSIONS, "on") === "on";
  const applySessions = () => {
    chart.setSessionsVisible(sessionsOn);
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
      chart.refreshSessions();
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
    if (when !== null) chart.goTo(when);
  });
  $("latest").addEventListener("click", () => chart.goToLatest());

  // ------------------------------------------------------------ tabs
  const tabViews = { chart: $("chart-view"), data: $("data-view") };
  document.querySelectorAll("[data-view]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.view;
      Object.entries(tabViews).forEach(([key, el]) => { el.hidden = key !== name; });
      document.querySelectorAll("[data-view]").forEach((t) => t.classList.toggle("active", t === tab));
      if (name === "data") redrawData();
    });
  });

  // Handy in the browser console and for automated checks.
  window.forexReplay = {
    manifest, quality, m5, chart, clock, trading, panel, viewFor, setTimeframe,
    get timeframe() { return current; },
    get view() { return view; },
  };
}

boot().catch((err) => {
  console.error(err);
  showError(`Something went wrong while starting the app.\n${err.message}`);
});
