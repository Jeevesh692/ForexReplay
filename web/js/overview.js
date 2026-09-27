// Small canvas line chart of closes over the whole dataset (a data sanity check,
// not the trading chart: that is TradingView Lightweight Charts from day 2).

import { formatMonthKey } from "./time.js";

export function drawOverview(canvas, candles, months) {
  const css = getComputedStyle(document.documentElement);
  const colour = (name) => css.getPropertyValue(name).trim();
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight || 220;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);

  const left = 8, right = 64, top = 10, bottom = 26;
  const plotW = width - left - right, plotH = height - top - bottom;
  const n = candles.length;

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, candles.low[i]);
    hi = Math.max(hi, candles.high[i]);
  }
  const x = (i) => left + (i / (n - 1)) * plotW;
  const y = (points) => top + (1 - (points - lo) / (hi - lo)) * plotH;

  // horizontal grid + price labels
  ctx.font = "11px Segoe UI, Roboto, sans-serif";
  ctx.fillStyle = colour("--muted");
  ctx.strokeStyle = colour("--border");
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const points = lo + ((hi - lo) * k) / 4;
    const yy = Math.round(y(points)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, yy);
    ctx.lineTo(left + plotW, yy);
    ctx.stroke();
    ctx.fillText(candles.price(points).toFixed(4), left + plotW + 8, yy + 4);
  }

  // month labels at each month's first candle
  let index = 0;
  months.forEach((m, k) => {
    if (k % 2 === 0) ctx.fillText(formatMonthKey(m.month), x(index) + 2, height - 8);
    index += m.bars;
  });

  // one point per pixel column: the close of the last candle in that column
  ctx.strokeStyle = colour("--blue");
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(n / plotW));
  for (let i = 0; i < n; i += step) {
    const px = x(i), py = y(candles.close[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineTo(x(n - 1), y(candles.close[n - 1]));
  ctx.stroke();
}
