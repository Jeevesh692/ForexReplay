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
  return { label, logger };
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
      name, label: config.label || name, logger: config.logger || "none",
      sessions: own.length, latest: own[0] || null, trades: tradeCounts[name] || 0, workbooks: [],
    };
  });
  return list.sort((a, b) => String((b.latest || {}).saved || "").localeCompare(String((a.latest || {}).saved || "")) || a.name.localeCompare(b.name));
}
