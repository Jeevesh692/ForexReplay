// What you write about each trade: a note, tags, and the names of its screenshots.
//
// This is not part of the trading engine. Notes never change a result, and they can be
// written at any time, even while looking back at history or after a challenge has ended.
// They are saved with the backtest (backtest.js) and copied into the journal CSV.

export const MAX_NOTE = 2000;
export const MAX_TAGS = 10;
export const MAX_TAG = 24;
export const MAX_SCREENSHOTS = 12;
export const SUGGESTED_TAGS = ["A+ setup", "followed plan", "broke rules", "FOMO", "early exit", "late entry", "news"];

const IMAGE_NAME = /^[A-Za-z0-9_-]{1,80}\.png$/; // the same rule as the server's

/** A tag as it is kept: trimmed, single spaces, plain characters, at most MAX_TAG long. Null if nothing is left. */
export function cleanTag(text) {
  if (typeof text !== "string") return null;
  const tag = text.replace(/[^A-Za-z0-9 +&/'.-]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG).trim();
  return tag || null;
}

/** One trade's entry from storage, with anything unusable dropped. */
export function cleanEntry(raw) {
  const out = { note: "", tags: [], screenshots: [] };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.note === "string") out.note = raw.note.slice(0, MAX_NOTE);
  if (Array.isArray(raw.tags)) {
    for (const t of raw.tags) {
      const tag = cleanTag(t);
      if (tag && !out.tags.includes(tag) && out.tags.length < MAX_TAGS) out.tags.push(tag);
    }
  }
  if (Array.isArray(raw.screenshots)) {
    out.screenshots = raw.screenshots.filter((s) => typeof s === "string" && IMAGE_NAME.test(s)).slice(0, MAX_SCREENSHOTS);
  }
  return out;
}

const isEmpty = (e) => !e.note.trim() && e.tags.length === 0 && e.screenshots.length === 0;

export class TradeNotes {
  /** @param {object} options { onChange(tradeId) } called after every change */
  constructor({ onChange = () => {} } = {}) {
    this.entries = new Map(); // trade id -> { note, tags, screenshots }
    this.onChange = onChange;
  }

  /** The entry for a trade (an empty one if nothing was written). Returns a copy. */
  get(id) {
    const e = this.entries.get(id);
    return e ? { note: e.note, tags: [...e.tags], screenshots: [...e.screenshots] } : cleanEntry(null);
  }

  has(id) { return this.entries.has(id); }

  change(id, update) {
    const next = cleanEntry(update(this.get(id)));
    if (isEmpty(next)) this.entries.delete(id); else this.entries.set(id, next);
    this.onChange(id);
  }

  setNote(id, text) { this.change(id, (e) => ({ ...e, note: String(text) })); }

  /** Add the tag if the trade does not have it, remove it if it does. Returns false if the tag is unusable. */
  toggleTag(id, text) {
    const tag = cleanTag(text);
    if (!tag) return false;
    this.change(id, (e) => ({ ...e, tags: e.tags.includes(tag) ? e.tags.filter((t) => t !== tag) : [...e.tags, tag] }));
    return true;
  }

  addScreenshot(id, name) { this.change(id, (e) => ({ ...e, screenshots: [...e.screenshots, name] })); }
  removeScreenshot(id, name) { this.change(id, (e) => ({ ...e, screenshots: e.screenshots.filter((s) => s !== name) })); }

  /** Tags used in this run, most used first, then the suggestions, without repeats. */
  tagChoices() {
    const count = new Map();
    for (const e of this.entries.values()) for (const t of e.tags) count.set(t, (count.get(t) || 0) + 1);
    const used = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b));
    return [...used, ...SUGGESTED_TAGS.filter((t) => !count.has(t))];
  }

  /** { "3": { note, tags, screenshots }, ... } for the backtest file; empty entries are left out. */
  toJSON() {
    return Object.fromEntries([...this.entries].map(([id, e]) => [String(id), e]));
  }

  /** Load what a backtest saved, keeping only whole-number trade ids and usable entries. */
  load(saved) {
    this.entries.clear();
    if (saved && typeof saved === "object") {
      for (const [key, raw] of Object.entries(saved)) {
        const id = Number(key);
        const e = cleanEntry(raw);
        if (Number.isInteger(id) && id > 0 && !isEmpty(e)) this.entries.set(id, e);
      }
    }
    this.onChange(null);
  }
}
