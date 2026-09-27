// Day-1 app shell: load the market data, show a data check, and confirm that
// TradingView Lightweight Charts is available for day 2.

import { loadJSON, loadSymbol } from "./data.js";
import { drawOverview } from "./overview.js";
import { formatDate, formatDateTime, formatMonthKey, IST_OFFSET_SECONDS } from "./time.js";

const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString("en-IN");

function card(label, value, note = "", tone = "") {
  return `<div class="card ${tone}"><div class="label">${label}</div>` +
    `<div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
}

function showError(message) {
  const box = $("error");
  box.hidden = false;
  box.textContent = message;
  $("lead").textContent = "Something needs fixing before the app can run.";
}

function renderCards(manifest, quality) {
  const holidays = quality.holiday_closes.map((t) => formatDate(Date.parse(t) / 1000)).join(", ");
  $("cards").innerHTML = [
    card("Candles", number(manifest.bars), `${manifest.symbol} ${manifest.timeframe}, bid prices`),
    card("First candle", formatDateTime(manifest.first).split(", ")[0], formatDateTime(manifest.first).split(", ")[1] + " IST"),
    card("Last candle", formatDateTime(manifest.last).split(", ")[0], formatDateTime(manifest.last).split(", ")[1] + " IST"),
    card("Bad candles", number(quality.bad_ohlc_candles), "high below open/close etc.",
      quality.bad_ohlc_candles === 0 ? "ok" : "warn"),
    card("Missing candles", number(quality.missing_bars_in_short_gaps),
      `in ${quality.short_gaps} short gaps, mostly the daily broker rollover`),
    card("Market closures", `${quality.weekend_closes} + ${quality.holiday_closes.length}`,
      `weekends + holidays; reopened ${holidays || "never"}`),
  ].join("");
}

function renderMonths(manifest) {
  $("months").querySelector("tbody").innerHTML = manifest.months.map((m) =>
    `<tr><td>${formatMonthKey(m.month)}</td><td class="num">${number(m.bars)}</td>` +
    `<td>${formatDateTime(m.first)}</td><td>${formatDateTime(m.last)}</td></tr>`).join("");
}

/** Proof that the chart library works: the latest 200 candles. The real chart arrives on day 2. */
function renderPreview(candles) {
  const target = $("preview");
  const lib = window.LightweightCharts;
  if (!lib) {
    target.innerHTML = '<div class="message">TradingView Lightweight Charts is not downloaded yet. ' +
      "Restart the app with an internet connection, or attach the file in the chat.</div>";
    return null;
  }
  const chart = lib.createChart(target, {
    autoSize: true,
    layout: { background: { color: "#1e222d" }, textColor: "#d1d4dc", attributionLogo: true },
    grid: { vertLines: { color: "#2a2e39" }, horzLines: { color: "#2a2e39" } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a2e39" },
    rightPriceScale: { borderColor: "#2a2e39" },
  });
  const series = chart.addSeries(lib.CandlestickSeries, {
    upColor: "#26a69a", downColor: "#ef5350", wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    borderVisible: false, priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
  });
  const from = Math.max(0, candles.length - 200);
  const bars = [];
  for (let i = from; i < candles.length; i++) {
    const b = candles.bar(i);
    // The library shows times in UTC; shifting by +5:30 makes its labels read as India time.
    bars.push({ time: b.time + IST_OFFSET_SECONDS, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  series.setData(bars);
  chart.timeScale().fitContent();
  $("preview-note").textContent = `(last ${bars.length} of ${number(candles.length)}, drawn by TradingView Lightweight Charts)`;
  return chart;
}

async function boot() {
  try {
    const health = await loadJSON("/api/health").catch(() => null);
    if (health) $("status-version").textContent = `app v${health.version}`;

    const libVersion = window.LightweightCharts?.version?.();
    $("status-lib").innerHTML = libVersion
      ? `<span class="ok">Chart library v${libVersion} ready</span>`
      : '<span class="bad">Chart library missing</span>';

    const [{ manifest, candles }, quality] = await Promise.all([
      loadSymbol("EURUSD"),
      loadJSON("data/EURUSD/quality.json"),
    ]);

    $("lead").textContent =
      `${number(manifest.bars)} five-minute EURUSD candles from your MT5 export, ` +
      `${formatDate(manifest.first)} to ${formatDate(manifest.last)}, shown in India time.`;
    $("status-data").textContent =
      `${manifest.symbol} ${manifest.timeframe} · ${number(manifest.bars)} candles · ` +
      `${formatDateTime(manifest.first)} → ${formatDateTime(manifest.last)} IST`;

    renderCards(manifest, quality);
    renderMonths(manifest);
    const canvas = $("overview");
    const redraw = () => drawOverview(canvas, candles, manifest.months);
    redraw();
    window.addEventListener("resize", redraw);
    renderPreview(candles);

    window.forexReplay = { manifest, quality, candles }; // handy in the browser console
  } catch (err) {
    console.error(err);
    showError(`Could not load the market data.\n${err.message}\n\n` +
      "Fix: close this tab, then run  python -m forex_replay app --rebuild");
  }
}

boot();
