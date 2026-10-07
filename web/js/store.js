// Where backtests, journals and screenshots are kept.
//
// On your computer the app runs with its Python server, which keeps them as files under
// strategies/ (forex_replay/backtests.py). Online (a static website, built with
// `python -m forex_replay site`) there is no server, so they are kept in the visitor's own
// browser instead: each visitor has their own, nobody else can see them, and clearing the
// browser's site data removes them. Screenshots are not kept online (browser storage is too small).
//
// Both stores offer the same calls, so the rest of the app does not care which one it has.

import { serverOffsetSeconds } from "./timeframes.js";

/** The static build writes site.json; the Python server does not serve one. */
export async function openStore(fetchFn = fetch) {
  try {
    const response = await fetchFn("site.json", { cache: "no-store" });
    if (response.ok && (await response.json()).static === true) return new BrowserStore();
  } catch { /* no site.json: the local app */ }
  return new ServerStore(fetchFn);
}

async function request(fetchFn, path, options = {}) {
  const response = await fetchFn(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

const enc = encodeURIComponent;

/** Files on disk through the local Python server (the desktop app). */
export class ServerStore {
  constructor(fetchFn = fetch) {
    this.kind = "server";
    this.screenshots = true;
    this.fetch = fetchFn;
  }

  health() { return request(this.fetch, "api/health").catch(() => null); }
  listBacktests() { return request(this.fetch, "api/backtests").then((b) => b.backtests || []); }
  getBacktest(journal, id) { return request(this.fetch, `api/backtests/${enc(journal)}/${enc(id)}`); }
  putBacktest(data) {
    return request(this.fetch, `api/backtests/${enc(data.journal)}/${enc(data.id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
  }
  /** The tab is closing: send without waiting. */
  putBacktestNow(data) {
    try {
      this.fetch(`api/backtests/${enc(data.journal)}/${enc(data.id)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), keepalive: true,
      });
    } catch { /* the tab is going away */ }
  }
  deleteBacktest(journal, id) { return request(this.fetch, `api/backtests/${enc(journal)}/${enc(id)}`, { method: "DELETE" }); }
  listJournals() { return request(this.fetch, "api/journals").then((b) => b.journals || []); }
  journalRows(name) { return request(this.fetch, `api/journal/${enc(name)}`).then((b) => b.rows); }
  screenshotUrl(journal, name) { return `api/screenshots/${enc(journal)}/${enc(name)}`; }
  async putScreenshot(journal, name, blob) {
    const response = await this.fetch(this.screenshotUrl(journal, name), { method: "PUT", headers: { "Content-Type": "image/png" }, body: blob });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  }
  async deleteScreenshot(journal, name) { await this.fetch(this.screenshotUrl(journal, name), { method: "DELETE" }); }
}

export const BROWSER_KEY = "forexreplay.store.v1";
const SUMMARY = ["id", "name", "journal", "symbol", "startTime", "furthestTime", "created", "saved", "result", "settings", "challenge"];

/** Backtests in this browser (the online site). */
export class BrowserStore {
  constructor(storage = globalThis.localStorage) {
    this.kind = "browser";
    this.screenshots = false;
    this.storage = storage;
  }

  read() {
    try {
      const data = JSON.parse(this.storage.getItem(BROWSER_KEY) || "null");
      return data && typeof data.backtests === "object" ? data : { backtests: {} };
    } catch { return { backtests: {} }; }
  }

  write(data) {
    try {
      this.storage.setItem(BROWSER_KEY, JSON.stringify(data));
    } catch (err) {
      throw new Error(err && err.name === "QuotaExceededError"
        ? "this browser's storage is full; delete some old backtests" : "this browser does not allow saving (private window?)");
    }
  }

  async health() { return { ok: true, version: "online" }; }

  async listBacktests() {
    return Object.values(this.read().backtests)
      .map((b) => Object.fromEntries(SUMMARY.map((k) => [k, b[k] ?? null])))
      .sort((a, b) => String(b.saved).localeCompare(String(a.saved)));
  }

  async getBacktest(journal, id) {
    const b = this.read().backtests[`${journal}/${id}`];
    if (!b) throw new Error(`No saved backtest ${journal}/${id}.`);
    return b;
  }

  async putBacktest(data) {
    const all = this.read();
    const key = `${data.journal}/${data.id}`;
    const closed = (d) => new Set((d ? d.trades : []).filter((t) => t.status === "CLOSED").map((t) => t.id));
    const before = closed(all.backtests[key]);
    all.backtests[key] = data;
    this.write(all);
    const added = [...closed(data)].filter((id) => !before.has(id)).length;
    return { ok: true, journalAdded: added, journal: "this browser" };
  }

  putBacktestNow(data) {
    try { this.putBacktest(data); } catch { /* the tab is going away */ }
  }

  async deleteBacktest(journal, id) {
    const all = this.read();
    delete all.backtests[`${journal}/${id}`];
    this.write(all);
    return { ok: true };
  }

  /** Journals: the closed trades of the backtests saved under each journal name. */
  async listJournals() {
    const counts = new Map();
    for (const b of Object.values(this.read().backtests)) {
      counts.set(b.journal, (counts.get(b.journal) || 0) + (b.trades || []).filter((t) => t.status === "CLOSED").length);
    }
    return [...counts].filter(([, n]) => n > 0).map(([name, trades]) => ({ name, trades })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async journalRows(name) {
    return Object.values(this.read().backtests)
      .filter((b) => b.journal === name)
      .sort((a, b) => String(a.created).localeCompare(String(b.created))) // in the order the runs were made
      .flatMap((b) => (b.trades || []).filter((t) => t.status === "CLOSED").map((t) => journalRow(t, b)));
  }

  screenshotUrl() { return ""; }
  async putScreenshot() { throw new Error("screenshots are kept only in the desktop app"); }
  async deleteScreenshot() {}
}

// ----- journal rows, as forex_replay/journal.py writes them --------------------------
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// v1's sessions, in broker-server hours (forex_replay/sessions.py)
const SESSIONS = [["Asia", 0, 10], ["London", 10, 15], ["London/NY overlap", 15, 19], ["New York", 19, 24]];

/** A UTC time as broker-server time text, "2026-03-05 11:05:00". */
function serverText(utc) {
  return new Date((utc + serverOffsetSeconds(utc)) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** The same row the Python server writes to trades.csv for a closed trade of the browser app (as text). */
export function journalRow(trade, backtest) {
  const scale = 10 ** backtest.digits, pip = backtest.pipPoints;
  const text = (v) => (v === null || v === undefined || Number.isNaN(v) ? "" : String(v));
  const price = (p) => (p === null || p === undefined ? "" : String(Math.round((p / scale) * scale) / scale));
  const round = (v, n) => (v === null || v === undefined ? "" : String(Math.round(v * 10 ** n) / 10 ** n));
  const entry = trade.entryTime;
  const serverEntry = entry === null ? null : new Date((entry + serverOffsetSeconds(entry)) * 1000);
  const hour = serverEntry ? serverEntry.getUTCHours() : null;
  return {
    trade_id: text(trade.id), run_id: backtest.id, symbol: backtest.symbol || "EURUSD", side: trade.side, order_type: trade.orderType,
    placed_time: trade.placedTime === null ? "" : serverText(trade.placedTime),
    entry_time: entry === null ? "" : serverText(entry),
    exit_time: trade.exitTime === null ? "" : serverText(trade.exitTime),
    entry_price: price(trade.entryPrice), exit_price: price(trade.exitPrice),
    stop_loss: price(trade.stopLoss), take_profit: price(trade.takeProfit),
    risk_pips: round(trade.plannedRisk / pip, 1), pnl_pips: trade.pnl === null ? "" : round(trade.pnl / pip, 1),
    result_r: round(trade.resultR, 2), planned_rr: round(trade.plannedRewardR, 2),
    mfe_r: round(trade.mfeR, 2), mae_r: round(trade.maeR, 2), exit_reason: text(trade.exitReason),
    session: hour === null ? "" : (SESSIONS.find(([, a, b]) => hour >= a && hour < b) || ["Unknown"])[0],
    weekday: serverEntry ? WEEKDAYS[serverEntry.getUTCDay()] : "",
    duration_min: entry === null || trade.exitTime === null ? "" : round((trade.exitTime - entry) / 60, 0),
    lots: round(trade.lots, 2), pnl_usd: round(trade.money, 2), commission_usd: round(trade.commission, 2),
    note: typeof trade.note === "string" ? trade.note : "",
    tags: Array.isArray(trade.tags) ? trade.tags.join("; ") : "",
    screenshots: Array.isArray(trade.screenshots) ? trade.screenshots.join("; ") : "",
  };
}
