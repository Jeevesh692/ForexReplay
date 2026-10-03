// Saving backtests as you go, and the "Backtests" dialog (resume or delete a saved one).
//
// Each replay is a backtest. Once it has a trade or a drawing, it is saved to the
// local server a moment after anything changes, when you leave it, and when the
// tab closes. The server writes it to strategies/<journal>/backtests/<id>.json and
// adds its closed trades to strategies/<journal>/trades.csv.
// The rules for what is saved and how a run is rebuilt live in backtest.js.

import { formatSignedMoney } from "./account.js";
import { newId, snapshot, validName } from "./backtest.js";
import { formatDateTime } from "./time.js";

export const DEFAULT_JOURNAL = "manual_backtests";
const KEY_JOURNAL = "forexreplay.journal";
const SAVE_DELAY_MS = 1500;

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const url = (journal, id) => `/api/backtests/${encodeURIComponent(journal)}/${encodeURIComponent(id)}`;

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export class Backtests {
  /**
   * @param {object} options
   *   dialog, status   the dialog element and the status-bar element
   *   collect()        { trading, drawings, m5, clock, manifest, timeframe } for a save
   *   onResume(journal, id)  rebuilds and opens a saved backtest; returns its list of problems
   */
  constructor({ dialog, status, collect, onResume }) {
    this.dialog = dialog;
    this.status = status;
    this.collect = collect;
    this.onResume = onResume;
    this.current = null; // { id, name, journal, created, startTime } of the run on screen
    this.everSaved = false;
    this.drawingsTouched = false;
    this.timer = null;
    this.queue = Promise.resolve(); // saves go out one after another, never overlapping
    this.armedDelete = null;

    this.el = (id) => dialog.querySelector(`#${id}`);
    this.el("backtest-journal").value = this.journal;
    this.el("backtest-journal").addEventListener("change", (event) => {
      const name = event.target.value.trim();
      if (validName(name)) {
        try { localStorage.setItem(KEY_JOURNAL, name); } catch { /* private mode: not kept */ }
        this.say(`New replays will be journaled in strategies/${name}/trades.csv.`, "ok");
      } else {
        this.say("A journal name may use only letters, digits, - and _.", "bad");
      }
      event.target.value = this.journal;
    });
    this.el("backtest-close").addEventListener("click", () => dialog.close());
    this.el("backtest-rows").addEventListener("click", (event) => this.handleRowClick(event));
    this.renderStatus();
  }

  get journal() {
    try {
      const saved = localStorage.getItem(KEY_JOURNAL);
      return validName(saved) ? saved : DEFAULT_JOURNAL;
    } catch { return DEFAULT_JOURNAL; }
  }

  // ----- the run on screen ------------------------------------------------
  /** A new replay has started with its last candle at `startTime`. */
  begin(startTime, symbol) {
    this.stopTimer();
    this.current = {
      id: newId(), name: `${symbol} from ${formatDateTime(startTime)}`, journal: this.journal,
      created: new Date().toISOString(), startTime,
    };
    this.everSaved = false;
    this.drawingsTouched = false;
    this.renderStatus();
  }

  /** A saved backtest has been rebuilt and is on screen again. */
  continueWith(saved) {
    this.stopTimer();
    const { id, name, journal, created, startTime } = saved;
    this.current = { id, name, journal, created, startTime };
    this.everSaved = true;
    this.drawingsTouched = false;
    this.renderStatus(`resumed · saved ${new Date(saved.saved).toLocaleTimeString("en-IN")}`);
  }

  /** A replay with no trades and no drawings is just a look around; it is not written to disk. */
  get worthSaving() {
    return !!this.current && (this.everSaved || this.drawingsTouched || this.collect().trading.actions.length > 0);
  }

  drawingsChanged() {
    this.drawingsTouched = true;
    this.changed();
  }

  /** Something changed: save shortly (at most one save per SAVE_DELAY_MS while the replay plays). */
  changed() {
    if (!this.current || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  stopTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Save now. Resolves to true when saved (or there was nothing worth saving), false on failure. */
  save() {
    this.stopTimer();
    if (!this.worthSaving) {
      this.renderStatus("not saved: no trades or drawings yet");
      return Promise.resolve(true);
    }
    const data = snapshot(this.current, this.collect()); // the state at this moment, even if the save waits in the queue
    const result = this.queue.then(() => this.put(data));
    this.queue = result;
    return result;
  }

  async put(data) {
    try {
      const reply = await request(url(data.journal, data.id), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (this.current && this.current.id === data.id) this.everSaved = true;
      const added = reply.journalAdded ? ` · ${reply.journalAdded} trade(s) added to ${reply.journal}` : "";
      this.renderStatus(`saved ${new Date().toLocaleTimeString("en-IN")}${added}`, "ok", data);
      return true;
    } catch (err) {
      this.renderStatus(`NOT saved: ${err.message.includes("fetch") ? "the app's server is not running" : err.message}`, "bad", data);
      return false;
    }
  }

  /** Last chance when the tab is closing: send the save without waiting for an answer. */
  saveOnUnload() {
    if (!this.worthSaving) return;
    const data = snapshot(this.current, this.collect());
    try {
      fetch(url(data.journal, data.id), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), keepalive: true,
      });
    } catch { /* the tab is going away; nothing more can be done */ }
  }

  /** Leaving the replay: save, then forget the run. Resolves to false (and keeps the run) if the save failed. */
  async end() {
    const ok = await this.save();
    if (ok) this.abandon();
    return ok;
  }

  abandon() {
    this.stopTimer();
    this.current = null;
    this.renderStatus();
  }

  renderStatus(text = "", tone = "", data = null) {
    const name = (data && data.name) || (this.current && this.current.name);
    this.status.hidden = !name;
    this.status.className = tone;
    this.status.textContent = name ? `Backtest "${name}"${text ? ` · ${text}` : ""}` : "";
  }

  // ----- dialog -----------------------------------------------------------
  say(text, tone = "") {
    const box = this.el("backtest-message");
    box.textContent = text;
    box.className = `order-message ${tone}`;
  }

  async open() {
    this.armedDelete = null;
    this.say("");
    this.el("backtest-journal").value = this.journal;
    if (!this.dialog.open) this.dialog.showModal();
    if (this.current) await this.save(); // so the list shows the run on screen as it is now
    await this.refresh();
  }

  async refresh() {
    const rows = this.el("backtest-rows");
    let list;
    try {
      list = (await request("/api/backtests")).backtests;
    } catch (err) {
      rows.innerHTML = "";
      this.say(`Could not read the saved backtests: ${err.message}`, "bad");
      return;
    }
    rows.innerHTML = list.length === 0
      ? '<tr><td colspan="7" class="muted">No saved backtests yet. Start a replay and place a trade or draw something.</td></tr>'
      : list.map((b) => this.row(b)).join("");
  }

  row(b) {
    const key = `${escapeHtml(b.journal)}/${escapeHtml(b.id)}`;
    if (b.error) {
      return `<tr><td colspan="6">${escapeHtml(b.id)} <span class="bad">${escapeHtml(b.error)}</span></td>` +
        `<td class="actions"><button class="plain small" data-delete="${key}">Delete</button></td></tr>`;
    }
    const r = b.result || {};
    const running = this.current && this.current.id === b.id;
    const tone = (r.totalR || 0) >= 0 ? "up" : "down";
    const trades = `${r.closed || 0}` + (r.open || r.pending ? ` + ${(r.open || 0) + (r.pending || 0)} active` : "");
    return `<tr>
      <td>${escapeHtml(b.name)}${running ? ' <span class="tag">on screen</span>' : ""}</td>
      <td>${escapeHtml(b.journal)}</td>
      <td class="nowrap">${formatDateTime(b.furthestTime)}</td>
      <td class="num">${trades}</td>
      <td class="num ${tone}">${r.challenge ? `<span class="tag ${r.challenge.toLowerCase()}" title="Prop-firm challenge">${r.challenge === "RUNNING" ? "challenge" : r.challenge}</span> ` : ""}${(r.totalR || 0) >= 0 ? "+" : ""}${(r.totalR || 0).toFixed(2)}R · ${formatSignedMoney(r.money || 0)}</td>
      <td class="nowrap muted">${b.saved ? new Date(b.saved).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : ""}</td>
      <td class="actions">
        <button class="plain bordered small" data-resume="${key}"${running ? " disabled" : ""}>Resume</button>
        <button class="plain small" data-delete="${key}"${running ? " disabled" : ""}>Delete</button>
      </td></tr>`;
  }

  async handleRowClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.resume) {
      const [journal, id] = button.dataset.resume.split("/");
      this.say("Rebuilding the run from its saved actions...");
      try {
        const problems = await this.onResume(journal, id);
        if (problems.length === 0) this.dialog.close();
        else this.say(`Resumed, but the rebuild does not match the save: ${problems.join(" ")}`, "bad");
      } catch (err) {
        this.say(`Could not resume: ${err.message}`, "bad");
      }
    } else if (button.dataset.delete) {
      if (this.armedDelete !== button.dataset.delete) { // deleting cannot be undone, so it takes a second click
        this.armedDelete = button.dataset.delete;
        button.textContent = "Delete?";
        button.classList.add("armed");
        this.say("Click Delete? again to remove this backtest for good. Its trades stay in the journal.");
        return;
      }
      const [journal, id] = button.dataset.delete.split("/");
      try {
        await request(url(journal, id), { method: "DELETE" });
        this.say("Deleted. Its trades are still in the journal.", "ok");
      } catch (err) {
        this.say(`Could not delete: ${err.message}`, "bad");
      }
      this.armedDelete = null;
      await this.refresh();
    }
  }
}
