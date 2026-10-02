// App start-up: load data, build the chart, wire the top bar and the replay.

import { ChartView } from "./chart.js";
import { loadJSON, loadSymbol } from "./data.js";
import { renderDataView } from "./dataview.js";
import { ReplayClock, SPEEDS } from "./replay.js";
import { formatDateTime, IST_OFFSET_SECONDS } from "./time.js";
import { TIMEFRAMES, TimeframeView } from "./timeframes.js";

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

  const chart = new ChartView($("chart"), {
    lib,
    symbol: manifest.symbol,
    digits: manifest.digits,
    onHover: (info) => renderLegend(manifest.symbol, current, manifest.digits, info,
      info && info.index === view.display.length - 1 && view.isForming()),
    onClick: (index) => {
      if (!picking) return;
      setPicking(false);
      clock.start(view.endOf(index)); // the clicked candle is the last one shown
    },
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
    live: $("replay-live"), exit: $("replay-exit"), clock: $("clock"), hint: $("hint"),
  };
  ui.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}x</option>`).join("");

  function setPicking(on) {
    picking = on;
    ui.hint.hidden = !on;
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
  });

  ui.toggle.addEventListener("click", () => setPicking(!picking));
  ui.play.addEventListener("click", () => clock.toggle());
  ui.forward.addEventListener("click", () => clock.stepForward(view));
  ui.back.addEventListener("click", () => clock.stepBack(view));
  ui.live.addEventListener("click", () => { clock.backToLive(); chart.goToLatest(); });
  ui.exit.addEventListener("click", () => clock.stop());
  ui.speed.addEventListener("change", () => clock.setSpeed(Number(ui.speed.value)));

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === "Escape" && picking) { setPicking(false); return; }
    if (!clock.active) return;
    if (event.key === " ") { event.preventDefault(); clock.toggle(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); event.shiftKey ? clock.advance(1) : clock.stepForward(view); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); clock.stepBack(view); }
    else if (event.key === "End") { clock.backToLive(); chart.goToLatest(); }
  });
  renderReplayUi();

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
    manifest, quality, m5, chart, clock, viewFor, setTimeframe,
    get timeframe() { return current; },
    get view() { return view; },
  };
}

boot().catch((err) => {
  console.error(err);
  showError(`Something went wrong while starting the app.\n${err.message}`);
});
