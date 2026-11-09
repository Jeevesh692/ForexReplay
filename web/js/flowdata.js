// Order-flow data (Phase 1): the M1 bars and 15-second buckets built from ticks by forex_replay/flow.py.
//
// Files: data/<PAIR>/flow/manifest.json, and data/<PAIR>/flow/<M1|S15>/<YYYY-MM>.bin, one per UTC month.
// Each bar is 10 little-endian int32 (manifest.fields): time (UTC seconds, the bar's open), open, high, low,
// close (the mid, as 2 x the price in points, so a half-point mid stays exact), tick_count, up_ticks,
// down_ticks, spread_x10 (average spread in tenths of a point) and baseline_x2 (twice the median tick count
// of the same slot over the previous 20 trading days; -1 while there were fewer). Nothing is computed here:
// the browser reads what Python wrote, so the two can never disagree on a bar.

export const FLOW_FIELDS = ["time", "open", "high", "low", "close", "tick_count", "up_ticks", "down_ticks", "spread_x10", "baseline_x2"];

/** Bars from raw bytes: { length, time, open, ..., baseline_x2 } as Int32Arrays (fields in FLOW_FIELDS order). */
export function decodeFlow(buffer) {
  const all = new Int32Array(buffer);
  const n = FLOW_FIELDS.length;
  if (all.length % n !== 0) throw new Error(`Order-flow file is ${all.length * 4} bytes: not whole ${n * 4}-byte bars.`);
  const length = all.length / n;
  const out = { length };
  FLOW_FIELDS.forEach((name, k) => {
    const column = new Int32Array(length);
    for (let i = 0; i < length; i++) column[i] = all[i * n + k];
    out[name] = column;
  });
  return out;
}

/** Join months into one set of bars, in order. */
export function joinFlow(parts) {
  const length = parts.reduce((sum, p) => sum + p.length, 0);
  const out = { length };
  for (const name of FLOW_FIELDS) {
    const column = new Int32Array(length);
    let at = 0;
    for (const p of parts) { column.set(p[name], at); at += p.length; }
    out[name] = column;
  }
  return out;
}

/** Load one dataset ("M1" or "S15") of a pair: { manifest, bars }, or null when it has not been built. */
export async function loadFlow(symbol, dataset, base = "data", fetchFn = fetch) {
  const response = await fetchFn(`${base}/${symbol}/flow/manifest.json`);
  if (!response.ok) return null;
  const manifest = await response.json();
  const info = manifest.datasets[dataset];
  if (!info) return null;
  const parts = [];
  for (const m of info.months) {
    const file = await fetchFn(`${base}/${symbol}/flow/${dataset}/${m.month}.bin`);
    if (!file.ok) throw new Error(`${symbol} ${dataset} ${m.month}: missing`);
    parts.push(decodeFlow(await file.arrayBuffer()));
  }
  return { manifest, bars: joinFlow(parts) };
}

/** Prices and counts as numbers, for showing: mid prices in price units, spread in points, baseline (null if none). */
export function flowValues(bars, i, manifest) {
  const price = (v) => v / manifest.price_scale;
  return {
    time: bars.time[i], open: price(bars.open[i]), high: price(bars.high[i]), low: price(bars.low[i]), close: price(bars.close[i]),
    tickCount: bars.tick_count[i], upTicks: bars.up_ticks[i], downTicks: bars.down_ticks[i],
    spreadPoints: bars.spread_x10[i] / 10, baseline: bars.baseline_x2[i] < 0 ? null : bars.baseline_x2[i] / 2,
  };
}
