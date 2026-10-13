// Strategies: each one is a folder of sessions and a journal (strategies/<name>/ in the desktop app).
// A strategy has a label you choose ("Liquidity sweep") and a folder name made from it
// ("liquidity_sweep"), plus which automatic log a save writes beside its journal.
// The desktop app keeps this in strategies/<name>/strategy.json (forex_replay/strategy_folders.py).

export const LOGGERS = [
  { id: "none", label: "No automatic log", file: "" },
  { id: "nbb", label: "NBB (Market Maker + OTE)", file: "nbb_log.csv" },
  { id: "sweep", label: "Liquidity sweep (NY session)", file: "sweep_log.csv" },
];
export const MAX_LABEL = 60;
const NAME = /^[A-Za-z0-9_-]{1,48}$/;

/** A folder name for a label, the same as forex_replay.strategy_folders.slug: "Asian sweep (London)" -> "asian_sweep_london". */
export function slug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48).replace(/_+$/, "");
}

/** A strategy's label and logger as given, or an error message. */
export function cleanStrategy(name, data) {
  if (typeof name !== "string" || !NAME.test(name)) return { error: "A strategy name may use only letters, digits, - and _." };
  const label = data && typeof data.label === "string" ? data.label.trim() : "";
  if (!label || label.length > MAX_LABEL) return { error: `A strategy needs a name of 1 to ${MAX_LABEL} characters.` };
  const logger = data.logger === undefined ? "none" : data.logger;
  if (!LOGGERS.some((l) => l.id === logger)) return { error: `Unknown log "${logger}".` };
  const checklist = cleanChecklist(data.checklist);
  if (checklist.error) return checklist;
  return { label, logger, checklist };
}

/**
 * The strategies list, as the server gives it, from sessions and saved strategy settings:
 * each with its sessions, the newest one ("latest"), and the closed trades in its journal.
 * `sessions` are backtest summaries (newest save first); `configs` maps name -> { label, logger }.
 */
export function strategyList(sessions, configs = {}, tradeCounts = {}) {
  const names = new Set([...Object.keys(configs), ...sessions.filter((s) => !s.error).map((s) => s.journal)]);
  const list = [...names].filter((n) => NAME.test(n)).map((name) => {
    const own = sessions.filter((s) => s.journal === name && !s.error);
    const config = configs[name] || {};
    return {
      name, label: config.label || name, logger: config.logger || "none", checklist: config.checklist || [],
      sessions: own.length, latest: own[0] || null, trades: tradeCounts[name] || 0, workbooks: [],
    };
  });
  return list.sort((a, b) => String((b.latest || {}).saved || "").localeCompare(String((a.latest || {}).saved || "")) || a.name.localeCompare(b.name));
}

// ----- checklist: your own questions, answered for each trade ---------------------------
// A strategy without an automatic log (and one with) can have up to 30 questions. Each trade's answers
// are saved with its note and tags, and the desktop app writes them to strategies/<name>/checklist_log.csv,
// one column per question, for Excel. The same rules as forex_replay/strategy_folders.py.
export const KINDS = [
  { id: "yesno", label: "Yes / No" },
  { id: "choice", label: "Choice" },
  { id: "number", label: "Number" },
];
export const MAX_QUESTIONS = 30, MAX_QUESTION = 80, MAX_OPTIONS = 12, MAX_OPTION = 30;
const QUESTION_ID = /^[a-z0-9_]{1,40}$/;

/** A question id from its text, unique among `taken`: "Asian high swept?" -> "asian_high_swept". */
export function questionId(text, taken = []) {
  const base = slug(text).slice(0, 36).replace(/_+$/, "") || "q";
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
}

/** A checklist as kept, or { error }. Options are only kept for "choice" questions. */
export function cleanChecklist(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) return { error: `A checklist is a list of at most ${MAX_QUESTIONS} questions.` };
  const out = [];
  for (const q of raw) {
    const text = q && typeof q.text === "string" ? q.text.trim() : "";
    if (!text || text.length > MAX_QUESTION) return { error: `Each question needs 1 to ${MAX_QUESTION} characters.` };
    if (!KINDS.some((k) => k.id === q.kind)) return { error: `"${text}": unknown answer type.` };
    const id = typeof q.id === "string" && QUESTION_ID.test(q.id) ? q.id : questionId(text, out.map((x) => x.id));
    if (out.some((x) => x.id === id)) return { error: `Two questions have the same id "${id}".` };
    if (out.some((x) => x.text === text)) return { error: `"${text}" is asked twice.` };
    const item = { id, text, kind: q.kind };
    if (q.kind === "choice") {
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => String(o).trim()).filter(Boolean);
      if (options.length < 2 || options.length > MAX_OPTIONS || options.some((o) => o.length > MAX_OPTION) || new Set(options).size !== options.length) {
        return { error: `"${text}" needs 2 to ${MAX_OPTIONS} different choices of up to ${MAX_OPTION} characters.` };
      }
      item.options = options;
    }
    out.push(item);
  }
  return out;
}

/** An answer as kept: "Yes"/"No", one of the choices, or a number as text; "" when it does not fit. */
export function cleanAnswer(question, value) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!text) return "";
  if (question.kind === "yesno") return text === "Yes" || text === "No" ? text : "";
  if (question.kind === "choice") return question.options.includes(text) ? text : "";
  const n = Number(text);
  return Number.isFinite(n) && text.length <= 20 ? String(n) : "";
}
