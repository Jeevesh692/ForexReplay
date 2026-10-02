// The "Data" tab: a health check of the market data behind the chart.

import { drawOverview } from "./overview.js";
import { formatDate, formatDateTime, formatMonthKey } from "./time.js";

const number = (n) => n.toLocaleString("en-IN");

function card(label, value, note = "", tone = "") {
  return `<div class="card ${tone}"><div class="label">${label}</div>` +
    `<div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
}

export function renderDataView(root, { manifest, quality, candles }) {
  const first = formatDateTime(manifest.first).split(", ");
  const last = formatDateTime(manifest.last).split(", ");
  const holidays = quality.holiday_closes.map((t) => formatDate(Date.parse(t) / 1000)).join(", ");

  root.querySelector("#lead").textContent =
    `${number(manifest.bars)} five-minute EURUSD candles from your MT5 export, ` +
    `${formatDate(manifest.first)} to ${formatDate(manifest.last)}, shown in India time.`;

  root.querySelector("#cards").innerHTML = [
    card("Candles", number(manifest.bars), `${manifest.symbol} ${manifest.timeframe}, bid prices`),
    card("First candle", first[0], `${first[1]} IST`),
    card("Last candle", last[0], `${last[1]} IST`),
    card("Bad candles", number(quality.bad_ohlc_candles), "high below open/close etc.",
      quality.bad_ohlc_candles === 0 ? "ok" : "warn"),
    card("Missing candles", number(quality.missing_bars_in_short_gaps),
      `in ${quality.short_gaps} short gaps, mostly the daily broker rollover`),
    card("Market closures", `${quality.weekend_closes} + ${quality.holiday_closes.length}`,
      `weekends + holidays; reopened ${holidays || "never"}`),
  ].join("");

  root.querySelector("#months tbody").innerHTML = manifest.months.map((m) =>
    `<tr><td>${formatMonthKey(m.month)}</td><td class="num">${number(m.bars)}</td>` +
    `<td>${formatDateTime(m.first)}</td><td>${formatDateTime(m.last)}</td></tr>`).join("");

  const canvas = root.querySelector("#overview");
  const redraw = () => {
    if (canvas.clientWidth > 0) drawOverview(canvas, candles, manifest.months);
  };
  window.addEventListener("resize", redraw);
  return redraw; // call when the tab becomes visible (a hidden canvas has no size)
}
