// The journal box under the trade lists: the note, checklist answers, tags and screenshots of the trade you picked.
//
// It is rebuilt only when you pick another trade or its tags or pictures change, never on
// every candle, so typing a note is not interrupted while the replay plays.

import { cleanAnswer } from "./strategies.js";
import { MAX_NOTE } from "./tradenotes.js";

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KEY_AUTO = "forexreplay.autoscreenshots";

export class JournalPanel {
  /**
   * @param {HTMLElement} root  the journal section
   * @param {object} options { notes: TradeNotes, describe(id) -> "#3 BUY · +1.20R" or null,
   *   journal() -> current journal name or null, onScreenshot(id), onRemoveScreenshot(id, name), onPick(id),
   *   checklist() -> the current strategy's questions (strategies.js) }
   */
  constructor(root, { notes, describe, journal, onScreenshot, onRemoveScreenshot, onPick, store, checklist }) {
    this.store = store;
    this.root = root;
    this.notes = notes;
    this.describe = describe;
    this.journal = journal;
    this.onPick = onPick || (() => {});
    this.checklist = checklist || (() => []);
    this.id = null;
    this.el = (id) => root.querySelector(`#${id}`);
    const answers = this.el("journal-checklist");
    const answer = (key, value) => {
      const q = this.checklist().find((x) => x.id === key);
      if (q && this.id !== null) this.notes.setAnswer(this.id, key, cleanAnswer(q, value));
    };
    answers.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-answer]");
      if (!chip || this.id === null) return;
      const current = this.notes.get(this.id).answers[chip.dataset.answer];
      answer(chip.dataset.answer, current === chip.dataset.value ? "" : chip.dataset.value); // a second click clears it
    });
    answers.addEventListener("change", (event) => {
      const key = event.target.dataset.answerInput;
      if (key) answer(key, event.target.value);
    });
    this.noteBox = this.el("journal-note");
    this.noteBox.maxLength = MAX_NOTE;

    this.typing = null; // a note waiting to be saved
    this.noteBox.addEventListener("input", () => { // saved a moment after you stop typing
      clearTimeout(this.typing);
      const id = this.id;
      this.typing = setTimeout(() => { this.typing = null; if (id === this.id) this.saveNote(); }, 400);
    });
    this.noteBox.addEventListener("blur", () => this.saveNote());
    this.el("journal-tags").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-tag]");
      if (chip && this.id !== null) this.notes.toggleTag(this.id, chip.dataset.tag);
    });
    this.el("journal-tag-input").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || this.id === null) return;
      event.preventDefault();
      const tag = event.target.value;
      if (this.notes.get(this.id).tags.includes(tag.trim())) { event.target.value = ""; return; }
      if (this.notes.toggleTag(this.id, tag)) event.target.value = "";
    });
    this.el("journal-shot").addEventListener("click", () => { if (this.id !== null) onScreenshot(this.id); });
    this.el("journal-shots").addEventListener("click", (event) => {
      const x = event.target.closest("[data-remove]");
      if (x && this.id !== null) { event.preventDefault(); onRemoveScreenshot(this.id, x.dataset.remove); }
    });
    const auto = this.el("journal-auto");
    if (!store.screenshots) { // online: no screenshots (browser storage is too small for pictures)
      this.el("journal-shot").hidden = true;
      const label = auto.closest("label");
      label.hidden = true;
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = "Screenshots are kept only in the desktop app.";
      label.after(note);
    }
    auto.checked = this.autoScreenshots;
    auto.addEventListener("change", () => {
      try { localStorage.setItem(KEY_AUTO, auto.checked ? "on" : "off"); } catch { /* private mode: not kept */ }
    });
    this.render();
  }

  /** Screenshots at entry and exit are taken automatically unless this is switched off. */
  get autoScreenshots() {
    if (!this.store.screenshots) return false;
    try { return localStorage.getItem(KEY_AUTO) !== "off"; } catch { return true; }
  }

  /** Save the text box now if it differs from what is stored. */
  saveNote() {
    clearTimeout(this.typing);
    this.typing = null;
    if (this.id !== null && this.noteBox.value !== this.notes.get(this.id).note) this.notes.setNote(this.id, this.noteBox.value);
  }

  /** Show this trade's journal (null: none). */
  pick(id) {
    this.saveNote();
    this.id = id;
    this.onPick(id);
    this.render();
  }

  /** The notes changed: redraw tags and pictures; leave the text box alone while it is being typed in. */
  refresh() {
    if (this.id !== null && !this.describe(this.id)) { this.pick(null); return; } // the trade is gone (a new run)
    this.render(document.activeElement === this.noteBox || this.typing !== null); // never wipe text not yet saved
  }

  /** Your checklist questions for this trade, each with its answer control. */
  renderChecklist(entry) {
    const box = this.el("journal-checklist");
    const questions = this.checklist();
    box.hidden = questions.length === 0;
    const active = document.activeElement;
    if (box.contains(active) && active.type === "number") return; // never redraw under someone typing a number
    box.innerHTML = questions.map((q) => {
      const value = entry.answers[q.id] || "";
      const key = escapeHtml(q.id);
      let control;
      if (q.kind === "yesno") {
        control = ["Yes", "No"].map((v) => `<button class="chip${value === v ? " on" : ""}" data-answer="${key}" data-value="${v}">${v}</button>`).join("");
      } else if (q.kind === "choice") {
        control = `<select data-answer-input="${key}"><option value="">–</option>${q.options.map((o) =>
          `<option${o === value ? " selected" : ""}>${escapeHtml(o)}</option>`).join("")}</select>`;
      } else {
        control = `<input type="number" step="any" data-answer-input="${key}" value="${escapeHtml(value)}">`;
      }
      return `<div class="question"><span>${escapeHtml(q.text)}</span>${control}</div>`;
    }).join("");
  }

  render(keepText = false) {
    const id = this.id;
    const title = id === null ? null : this.describe(id);
    this.el("journal-editor").hidden = !title;
    this.el("journal-empty").hidden = !!title;
    this.el("journal-title").textContent = title || "";
    if (!title) return;
    const entry = this.notes.get(id);
    if (!keepText) this.noteBox.value = entry.note;
    this.renderChecklist(entry);
    this.el("journal-tags").innerHTML = this.notes.tagChoices().concat(entry.tags.filter((t) => !this.notes.tagChoices().includes(t)))
      .map((t) => `<button class="chip${entry.tags.includes(t) ? " on" : ""}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("");
    const journal = this.journal();
    this.el("journal-shots").innerHTML = !journal ? "" : entry.screenshots.map((name) => {
      const url = this.store.screenshotUrl(journal, name);
      const kind = name.includes("-entry") ? "entry" : name.includes("-exit") ? "exit" : "added";
      return `<a class="shot" href="${url}" target="_blank" rel="noopener" title="Open full size (${kind})">` +
        `<img src="${url}" alt="Chart at ${kind}" loading="lazy"><span>${kind}</span>` +
        `<b data-remove="${escapeHtml(name)}" title="Remove this screenshot">&times;</b></a>`;
    }).join("");
  }
}
