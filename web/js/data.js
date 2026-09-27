// Loads the monthly candle files written by forex_replay/datapipe.py.
// Each bar is 7 little-endian int32 values: time (UTC seconds), open, high,
// low, close (price in points, i.e. price * 10^digits), tick volume, spread.

export const FIELDS = ["time", "open", "high", "low", "close", "volume", "spread"];

/** Column-oriented candles: one typed array per field, prices kept as integer points. */
export class Candles {
  constructor(length, digits = 5) {
    this.length = length;
    this.digits = digits;
    for (const f of FIELDS) this[f] = new Int32Array(length);
  }

  /** Decode one month file (ArrayBuffer) into Candles. */
  static fromBuffer(buffer, digits = 5) {
    if (buffer.byteLength % (4 * FIELDS.length) !== 0) {
      throw new Error(`Corrupt candle file: ${buffer.byteLength} bytes is not a whole number of bars`);
    }
    const flat = new Int32Array(buffer);
    const n = flat.length / FIELDS.length;
    const out = new Candles(n, digits);
    for (let i = 0; i < n; i++) {
      const row = i * FIELDS.length;
      for (let f = 0; f < FIELDS.length; f++) out[FIELDS[f]][i] = flat[row + f];
    }
    return out;
  }

  /** Join months in order, checking that time only moves forward. */
  static concat(list, digits = 5) {
    const total = list.reduce((sum, c) => sum + c.length, 0);
    const out = new Candles(total, digits);
    let offset = 0;
    for (const c of list) {
      for (const f of FIELDS) out[f].set(c[f], offset);
      offset += c.length;
    }
    for (let i = 1; i < out.length; i++) {
      if (out.time[i] <= out.time[i - 1]) throw new Error(`Candles out of order at index ${i}`);
    }
    return out;
  }

  price(points) {
    return points / 10 ** this.digits;
  }

  /** Plain object for one bar, prices as numbers (for display). */
  bar(i) {
    return {
      time: this.time[i],
      open: this.price(this.open[i]),
      high: this.price(this.high[i]),
      low: this.price(this.low[i]),
      close: this.price(this.close[i]),
      volume: this.volume[i],
      spread: this.spread[i],
    };
  }
}

export async function loadJSON(url, fetchFn = fetch) {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Load manifest + every monthly file for a symbol. */
export async function loadSymbol(symbol = "EURUSD", base = "data", fetchFn = fetch) {
  const manifest = await loadJSON(`${base}/${symbol}/manifest.json`, fetchFn);
  const months = await Promise.all(
    manifest.months.map(async (m) => {
      const response = await fetchFn(`${base}/${m.file}`);
      if (!response.ok) throw new Error(`${m.file}: HTTP ${response.status}`);
      const candles = Candles.fromBuffer(await response.arrayBuffer(), manifest.digits);
      if (candles.length !== m.bars) throw new Error(`${m.file}: expected ${m.bars} bars, got ${candles.length}`);
      return candles;
    }),
  );
  return { manifest, candles: Candles.concat(months, manifest.digits) };
}
