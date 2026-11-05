// Jump to setup time: one key press takes the replay forward to a strategy's moment of the day, then pauses.
//
// A strategy's `jump` (strategy.json) is one of
//   { kind: "session", session: "asia", edge: "end", offset: -15 }   a session's start or end, in its own city
//   { kind: "clock", zone: "America/New_York", time: "05:00", offset: 0 }   a time of day in a zone
// `offset` is minutes before (negative) or after the target. Sessions come from both presets in sessions.js,
// whatever is shaded on the chart, so Tokyo's close is 18:00 Tokyo all year and London's open follows UK time.
//
// The jump itself (ReplayClock.jumpTo) reveals every 1-minute candle on the way, in order, so stops, targets,
// pending orders and challenge limits are checked exactly as if the replay had been played through.
// forex_replay/strategy_folders.py checks the same setting on the server.

import { PRESETS, ZONES, sessionWindow, zonedTimeToUtc, zoneOffsetSeconds } from "./sessions.js";

export const JUMP_SESSIONS = [...PRESETS.standard.sessions, ...PRESETS.killzones.sessions].map((s) => ({ ...s }));
export const MAX_OFFSET = 720; // minutes either way
export const GAP_SECONDS = 6 * 3600; // a target with no candle within this long after it is a closed day (weekend, holiday)
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A jump as given, cleaned: { jump } (null for none) or { error }. The server applies the same rules. */
export function validateJump(raw) {
  if (raw === undefined || raw === null) return { jump: null };
  if (typeof raw !== "object") return { error: "A jump must be an object." };
  const offset = raw.offset === undefined ? 0 : Number(raw.offset);
  if (!Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET) return { error: `The jump's offset must be whole minutes, at most ${MAX_OFFSET} either way.` };
  if (raw.kind === "session") {
    if (!JUMP_SESSIONS.some((s) => s.id === raw.session)) return { error: `Unknown session "${raw.session}".` };
    if (raw.edge !== "start" && raw.edge !== "end") return { error: "A session jump goes to its start or its end." };
    return { jump: { kind: "session", session: raw.session, edge: raw.edge, offset } };
  }
  if (raw.kind === "clock") {
    if (!ZONES.some((z) => z.id === raw.zone)) return { error: `Unknown timezone "${raw.zone}".` };
    if (!TIME.test(raw.time || "")) return { error: "A clock jump needs a time as HH:MM." };
    return { jump: { kind: "clock", zone: raw.zone, time: raw.time, offset } };
  }
  return { error: "A jump is a session's start or end, or a clock time." };
}

/** A saved jump, or null: a damaged value reads as "no jump" and never breaks the strategy list. */
export function cleanJump(raw) {
  const { jump } = validateJump(raw);
  return jump || null;
}

const sessionOf = (id) => JUMP_SESSIONS.find((s) => s.id === id);
const zoneOf = (jump) => (jump.kind === "session" ? sessionOf(jump.session).zone : jump.zone);

export function jumpLabel(jump) {
  if (!jump) return "none";
  const shift = jump.offset ? ` ${jump.offset > 0 ? "+" : "−"} ${Math.abs(jump.offset)} min` : "";
  if (jump.kind === "session") return `${sessionOf(jump.session).label} ${jump.edge}${shift}`;
  const zone = ZONES.find((z) => z.id === jump.zone);
  return `${jump.time} ${zone ? zone.label : jump.zone}${shift}`;
}

/** The target (UTC seconds) for the calendar date y-m-d in the jump's own zone. */
export function targetOn(jump, y, m, d) {
  let t;
  if (jump.kind === "session") {
    const w = sessionWindow(sessionOf(jump.session), y, m, d);
    t = jump.edge === "start" ? w.start : w.end;
  } else {
    t = zonedTimeToUtc(jump.zone, y, m, d, Number(jump.time.slice(0, 2)), Number(jump.time.slice(3, 5)));
  }
  return t + jump.offset * 60;
}

/** First index in times[0..length) whose time is at least t. */
function firstAtOrAfter(times, length, t) {
  let lo = 0, hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Where the next jump lands: { position, target } or null when the data has no later one.
 * `position` is the number of base candles to have revealed: every candle that opened before the target.
 * If the target falls in a short gap, the first candle after it is revealed too. A target with no candle
 * within GAP_SECONDS after it is a closed day (a weekend, a holiday) and is skipped. Never backwards:
 * the result is always past `position` now.
 */
export function nextJump(jump, candles, length, position, barSeconds, limitDays = 30) {
  if (!jump || position >= length) return null;
  const now = candles.time[position - 1] + barSeconds; // close of the last revealed candle
  const zone = zoneOf(jump);
  const local = new Date((now + zoneOffsetSeconds(zone, now)) * 1000); // today in the target's own city
  for (let k = -1; k <= limitDays; k++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k));
    const target = targetOn(jump, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    if (target <= now) continue;
    const at = firstAtOrAfter(candles.time, length, target);
    if (at >= length) return null;
    if (candles.time[at] - target > GAP_SECONDS) continue; // nothing trades then
    const landing = candles.time[at] - target >= barSeconds ? at + 1 : at; // in a gap: show the first candle after it
    if (landing > position) return { position: landing, target };
  }
  return null;
}

/** The three quick jumps that need no strategy setting. */
export const SESSION_OPENS = [
  { id: "asia", key: "1", label: "Tokyo" },
  { id: "london", key: "2", label: "London" },
  { id: "newyork", key: "3", label: "New York" },
].map((s) => ({ ...s, jump: { kind: "session", session: s.id, edge: "start", offset: 0 } }));

/** A fingerprint of every live trade and the challenge: a jump stops at the candle where it changes. */
export function tradingState(trading) {
  const live = trading.broker.trades.filter((t) => t.status === "OPEN" || t.status === "PENDING");
  return {
    watching: live.length > 0,
    key: () => trading.broker.trades.map((t) => `${t.id}:${t.status}:${t.remaining}`).join(",") +
      `|${trading.challenge ? trading.challenge.outcome : ""}`,
  };
}

/**
 * Reveal up to `position` and pause; stop early where a live trade or order changes, or where `alsoStop()`
 * says so (the setup finder: a setup's candle has just closed, decision 0030). Returns { early, at }.
 */
export function jumpClock(clock, trading, position, alsoStop = null) {
  const state = tradingState(trading);
  const before = state.watching ? state.key() : null;
  const traded = state.watching ? () => state.key() !== before : null;
  const stop = traded && alsoStop ? () => traded() || alsoStop() : traded || alsoStop || undefined;
  const result = clock.jumpTo(position, stop);
  return { ...result, at: clock.position };
}

