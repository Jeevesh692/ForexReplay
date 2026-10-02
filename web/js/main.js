// App start-up: load data, build the chart, wire the top bar.

import { ChartView } from "./chart.js";
import { loadJSON, loadSymbol } from "./data.js";
import { renderDataView } from "./dataview.js";
import { formatDateTime, IST_OFFSET_SECONDS } from "./time.js";
import { aggregate, TIMEFRAMES } from "./timeframes.js";

const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString("en-IN");
const STORAGE_KEY = "forexreplay.timeframe";

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
function renderLegend(symbol, timeframeId, digits, info) {
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
    `<span class="legend-time">${info.timeText}</span>` +
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

  // ---- data tab
  const redrawData = renderDataView($("data-view"), { manifest, quality, candles: m5 });

  // ---- chart
  if (!lib) {
    showError("TradingView Lightweight Charts is not downloaded yet.\n" +
      "Restart the app with an internet connection, or attach the file in the chat.");
    return;
  }

  // Higher timeframes are built once from M5 and cached.
  const cache = new Map([["M5", m5]]);
  const candlesFor = (tf) => {
    if (!cache.has(tf)) cache.set(tf, aggregate(m5, tf).candles);
    return cache.get(tf);
  };

  let current = recall(STORAGE_KEY, "M15");
  if (!TIMEFRAMES.some((t) => t.id === current)) current = "M15";

  const chart = new ChartView($("chart"), {
    lib,
    symbol: manifest.symbol,
    digits: manifest.digits,
    onHover: (info) => renderLegend(manifest.symbol, current, manifest.digits, info),
  });

  const buttons = [...$("timeframes").querySelectorAll("button")];
  function setTimeframe(tf, { keepPlace = true } = {}) {
    const keepTime = keepPlace ? chart.rightEdgeTime() : null;
    current = tf;
    remember(STORAGE_KEY, tf);
    buttons.forEach((b) => b.classList.toggle("active", b.dataset.tf === tf));
    chart.setCandles(tf, candlesFor(tf), { keepTime });
  }
  buttons.forEach((b) => {
    b.disabled = false;
    b.addEventListener("click", () => setTimeframe(b.dataset.tf));
  });
  setTimeframe(current, { keepPlace: false });

  // ---- go to date / latest
  const goto = $("goto");
  goto.min = toIndiaInput(manifest.first);
  goto.max = toIndiaInput(manifest.last);
  goto.addEventListener("change", () => {
    const when = parseIndiaInput(goto.value);
    if (when !== null) chart.goTo(when);
  });
  $("latest").addEventListener("click", () => chart.goToLatest());

  // ---- tabs
  const views = { chart: $("chart-view"), data: $("data-view") };
  document.querySelectorAll("[data-view]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.view;
      Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
      document.querySelectorAll("[data-view]").forEach((t) => t.classList.toggle("active", t === tab));
      if (name === "data") redrawData();
    });
  });

  // Handy in the browser console and for automated checks.
  window.forexReplay = { manifest, quality, m5, chart, candlesFor, setTimeframe, get timeframe() { return current; } };
}

boot().catch((err) => {
  console.error(err);
  showError(`Something went wrong while starting the app.\n${err.message}`);
});
