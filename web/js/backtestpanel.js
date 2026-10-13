// Saving backtests (sessions) as you go, and the "Strategies" dialog: every strategy with its
// sessions; switch strategy, resume where you left off, start a new session, or delete one.
//
// Each replay is a backtest of one strategy. Once it has a trade or a drawing, it is saved to the
// local server a moment after anything changes, when you leave it, and when the
// tab closes. The server writes it to strategies/<strategy>/backtests/<id>.json and
// adds its closed trades to strategies/<strategy>/trades.csv.
// The rules for what is saved and how a run is rebuilt live in backtest.js; strategies in strategies.js.

import { formatSignedMoney } from "./account.js";
import { newId, snapshot, validName } from "./backtest.js";
import { LOGGERS, slug } from "./strategies.js";
import { formatDateTime } from "./time.js";

export const DEFAULT_JOURNAL = "manual_backtests";
const KEY_JOURNAL = "forexreplay.journal";
const SAVE_DELAY_MS = 1500;

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export class Backtests {
  /**
   * @param {object} options
   *   dialog, status   the dialog element and the status-bar element
   *   collect()        { trading, drawings, m5, clock, manifest, timeframe } for a save
   *   onResume(journal, id)  rebuilds and opens a saved backtest; returns its list of problems
   *   onNewSession(journal)  saves and leaves the session on screen, then lets you pick a start candle
   *   chip             the toolbar element that shows the strategy in use
   */
  constructor({ dialog, status, collect, onResume, onNewSession, chip, store }) {
    this.store = store; // files on disk (desktop app) or this browser (online): see store.js
    if (store.kind === "browser") {
      dialog.querySelector("#backtests-about").textContent = "Online, each strategy's sessions are saved in this browser as you go, " +
        "with their trades, drawings and where they got to. Only this browser on this computer can see them; clearing the site's data removes them. " +
        "Resume rebuilds a session by repeating every action on the same candles. Switching saves the session on screen first.";
    }
    this.dialog = dialog;
    this.status = status;
    this.collect = collect;
    this.onResume = onResume;
    this.onNewSession = onNewSession;
    this.chip = chip;
    this.labels = {}; // strategy name -> label, from the last list
    this.selected = null; // the strategy whose sessions the dialog lists (null = all)
    this.current = null; // { id, name, journal, created, startTime } of the run on screen
    this.everSaved = false;
    this.drawingsTouched = false;
    this.timer = null;
    this.queue = Promise.resolve(); // saves go out one after another, never overlapping
    this.armedDelete = null;

    this.el = (id) => dialog.querySelector(`#${id}`);
    this.el("strategy-logger").innerHTML = LOGGERS.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join("");
    this.el("strategy-new").addEventListener("submit", (event) => { event.preventDefault(); this.create(); });
    this.el("strategy-rows").addEventListener("click", (event) => this.handleStrategyClick(event));
    this.el("backtest-filter").addEventListener("click", (event) => {
      if (event.target.closest("[data-show-all]")) { this.selected = null; this.refresh(); }
    });
    this.el("backtest-close").addEventListener("click", () => dialog.close());
    this.el("backtest-rows").addEventListener("click", (event) => this.handleRowClick(event));
    this.renderStatus();
  }

  /** The strategy new sessions go to: the last one chosen. */
  get journal() {
    try {
      const saved = localStorage.getItem(KEY_JOURNAL);
      return validName(saved) ? saved : DEFAULT_JOURNAL;
    } catch { return DEFAULT_JOURNAL; }
  }

  set journal(name) {
    if (!validName(name)) return;
    try { localStorage.setItem(KEY_JOURNAL, name); } catch { /* private mode: not kept */ }
    this.renderChip();
  }

  label(name) { return this.labels[name] || name; }

  /** The toolbar shows the strategy of the session on screen, or the one new sessions go to. */
  renderChip() {
    if (this.chip) this.chip.textContent = `· ${this.label(this.current ? this.current.journal : this.journal)}`;
  }

  /** Learn the strategies' labels (for the toolbar) without opening the dialog. */
  async loadLabels() {
    try { this.remember(await this.store.listStrategies()); } catch { /* the toolbar shows folder names */ }
    this.renderChip();
  }

  remember(list) {
    this.labels = Object.fromEntries(list.map((s) => [s.name, s.label]));
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
    this.journal = journal; // new sessions follow the strategy you came back to
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
      const reply = await this.store.putBacktest(data);
      if (this.current && this.current.id === data.id) this.everSaved = true;
      const added = reply.journalAdded ? ` · ${reply.journalAdded} trade(s) added to ${reply.journal}` : "";
      this.renderStatus(`saved ${new Date().toLocaleTimeString("en-IN")}${added}`, "ok", data);
      return true;
    } catch (err) {
      const offline = err.message.includes("fetch") && this.store.kind === "server";
      this.renderStatus(`NOT saved: ${offline ? "the app's server is not running" : err.message}`, "bad", data);
      return false;
    }
  }

  /** Last chance when the tab is closing: send the save without waiting for an answer. */
  saveOnUnload() {
    if (!this.worthSaving) return;
    const data = snapshot(this.current, this.collect());
    try {
      this.store.putBacktestNow(data);
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
    const run = data || this.current;
    const name = run && run.name;
    this.status.hidden = !name;
    this.status.className = tone;
    this.status.textContent = name ? `${this.label(run.journal)} · "${name}"${text ? ` · ${text}` : ""}` : "";
    this.renderChip();
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
    this.selected = this.current ? this.current.journal : this.journal;
    if (!this.dialog.open) this.dialog.showModal();
    if (this.current) await this.save(); // so the list shows the run on screen as it is now
    await this.refresh();
  }

  async refresh() {
    const rows = this.el("backtest-rows");
    let list, strategies;
    try {
      [list, strategies] = await Promise.all([this.store.listBacktests(), this.store.listStrategies()]);
    } catch (err) {
      rows.innerHTML = "";
      this.say(`Could not read the saved sessions: ${err.message}`, "bad");
      return;
    }
    this.remember(strategies);
    if (this.selected && !strategies.some((s) => s.name === this.selected)) { // chosen, nothing saved in it yet
      strategies.push({ name: this.selected, label: this.selected, logger: "none", sessions: 0, latest: null, trades: 0, workbooks: [] });
    }
    this.el("strategy-rows").innerHTML = strategies.length === 0
      ? '<tr><td colspan="6" class="muted">No strategies yet. Add one below.</td></tr>'
      : strategies.map((s) => this.strategyRow(s)).join("");
    const shown = this.selected ? list.filter((b) => b.journal === this.selected) : list;
    this.el("backtest-filter").innerHTML = this.selected
      ? `of ${escapeHtml(this.label(this.selected))} · <button type="button" class="plain small" data-show-all="1">show every strategy</button>`
      : "of every strategy";
    rows.innerHTML = shown.length === 0
      ? '<tr><td colspan="7" class="muted">No saved sessions yet. Press New session, pick a start candle, then place a trade or draw something.</td></tr>'
      : shown.map((b) => this.row(b)).join("");
    this.el("backtest-target").textContent = `New sessions go to: ${this.label(this.journal)}`;
    this.renderChip();
  }

  strategyRow(s) {
    const name = escapeHtml(s.name);
    const logger = LOGGERS.find((l) => l.id === s.logger) || LOGGERS[0];
    const onScreen = !!this.current && this.current.journal === s.name;
    const latestOnScreen = onScreen && !!s.latest && s.latest.id === this.current.id;
    const books = (s.workbooks || []).map((w) => `<div class="file">&#128196; ${escapeHtml(w)}</div>`).join("");
    return `<tr class="${s.name === this.selected ? "selected" : ""}" data-select="${name}" title="Click to list this strategy's sessions">
      <td><b>${escapeHtml(s.label)}</b>${onScreen ? ' <span class="tag">on screen</span>' : ""}<div class="file">strategies/${name}/</div>${books}</td>
      <td>${s.logger === "none" ? '<span class="muted">none</span>' : `${escapeHtml(logger.label)}<div class="file">${escapeHtml(logger.file)}</div>`}</td>
      <td class="num">${s.sessions}</td>
      <td class="num">${s.trades}</td>
      <td class="nowrap">${s.latest ? formatDateTime(s.latest.furthestTime) : '<span class="muted">not started</span>'}</td>
      <td class="actions">
        ${s.latest ? `<button type="button" class="plain bordered small" data-strategy-resume="${name}/${escapeHtml(s.latest.id)}"${latestOnScreen ? " disabled" : ""} title="Open the session saved most recently, where it stopped">Resume</button>` : ""}
        <button type="button" class="plain bordered small" data-strategy-new="${name}" title="Save the session on screen, then start a new session of this strategy from a candle you pick">New session</button>
      </td></tr>`;
  }

  async create() {
    const input = this.el("strategy-label");
    const label = input.value.trim();
    const name = slug(label);
    if (!name) { this.say("Give the strategy a name with at least one letter or digit.", "bad"); return; }
    if (this.labels[name] !== undefined) { this.say(`There is already a strategy in strategies/${name}/.`, "bad"); return; }
    try {
      await this.store.putStrategy(name, { label, logger: this.el("strategy-logger").value });
    } catch (err) {
      this.say(`Could not add it: ${err.message}`, "bad");
      return;
    }
    input.value = "";
    this.selected = name;
    await this.refresh();
    this.say(`Added "${label}" in strategies/${name}/. Press New session to start testing it.`, "ok");
  }

  async handleStrategyClick(event) {
    const button = event.target.closest("button");
    if (button && button.dataset.strategyNew) {
      this.journal = button.dataset.strategyNew;
      this.dialog.close();
      await this.onNewSession(button.dataset.strategyNew);
      return;
    }
    if (button && button.dataset.strategyResume) {
      await this.resume(button.dataset.strategyResume);
      return;
    }
    const row = event.target.closest("tr[data-select]");
    if (row && row.dataset.select !== this.selected) {
      this.selected = row.dataset.select;
      this.armedDelete = null;
      await this.refresh();
    }
  }

  async resume(key) {
    const [journal, id] = key.split("/");
    this.say("Saving the session on screen, then rebuilding this one from its saved actions...");
    try {
      const problems = await this.onResume(journal, id);
      if (problems.length === 0) this.dialog.close();
      else this.say(`Resumed, but the rebuild does not match the save: ${problems.join(" ")}`, "bad");
    } catch (err) {
      this.say(`Could not resume: ${err.message}`, "bad");
    }
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
      <td>${escapeHtml(this.label(b.journal))}</td>
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
      await this.resume(button.dataset.resume);
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
        await this.store.deleteBacktest(journal, id);
        this.say("Deleted. Its trades are still in the journal.", "ok");
      } catch (err) {
        this.say(`Could not delete: ${err.message}`, "bad");
      }
      this.armedDelete = null;
      await this.refresh();
    }
  }
}
