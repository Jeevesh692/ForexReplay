// Trading sessions, each defined in its own city's clock.
//
// Defining London as "08:00-17:00 Europe/London" (not as fixed UTC or India
// hours) means the shading stays right through daylight-saving changes: the
// London open is 12:30 IST in summer and 13:30 IST in winter, automatically.
//
// The list is user-editable (Sessions settings in the app). A session is
//   { id, label, zone, start: "HH:MM", end: "HH:MM", colour: "#rrggbb", enabled }
// If `end` is not after `start`, the session runs past midnight into the next day.

export const ZONES = [
  { id: "Asia/Tokyo", label: "Tokyo" },
  { id: "Asia/Hong_Kong", label: "Hong Kong" },
  { id: "Asia/Singapore", label: "Singapore" },
  { id: "Australia/Sydney", label: "Sydney" },
  { id: "Asia/Kolkata", label: "India" },
  { id: "Europe/Berlin", label: "Frankfurt" },
  { id: "Europe/London", label: "London" },
  { id: "America/New_York", label: "New York" },
  { id: "UTC", label: "UTC" },
];

export const PRESETS = {
  standard: {
    label: "Standard sessions",
    sessions: [
      { id: "asia", label: "Asia", zone: "Asia/Tokyo", start: "09:00", end: "18:00", colour: "#f5a623", enabled: true },
      { id: "london", label: "London", zone: "Europe/London", start: "08:00", end: "17:00", colour: "#2962ff", enabled: true },
      { id: "newyork", label: "New York", zone: "America/New_York", start: "08:00", end: "17:00", colour: "#ab47bc", enabled: true },
    ],
  },
  killzones: {
    label: "ICT killzones",
    sessions: [
      { id: "asia-kz", label: "Asia KZ", zone: "America/New_York", start: "20:00", end: "00:00", colour: "#f5a623", enabled: true },
      { id: "london-kz", label: "London KZ", zone: "America/New_York", start: "02:00", end: "05:00", colour: "#2962ff", enabled: true },
      { id: "ny-kz", label: "New York KZ", zone: "America/New_York", start: "07:00", end: "10:00", colour: "#ab47bc", enabled: true },
      { id: "london-close-kz", label: "London close KZ", zone: "America/New_York", start: "10:00", end: "12:00", colour: "#26a69a", enabled: true },
    ],
  },
};

const DAY = 86400;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const clone = (list) => list.map((s) => ({ ...s }));
let sessions = clone(PRESETS.standard.sessions);
const windowCache = new Map();

export function getSessions() {
  return clone(sessions);
}

/** Check a session list; returns a list of problems (empty when valid). */
export function validateSessions(list) {
  const problems = [];
  if (!Array.isArray(list)) return ["Sessions must be a list"];
  list.forEach((s, i) => {
    const name = s && s.label ? `"${s.label}"` : `Session ${i + 1}`;
    if (!s || typeof s !== "object") { problems.push(`${name}: not a session`); return; }
    if (!s.label || !String(s.label).trim()) problems.push(`Session ${i + 1}: needs a name`);
    if (!ZONES.some((z) => z.id === s.zone)) problems.push(`${name}: unknown timezone`);
    if (!TIME_PATTERN.test(s.start)) problems.push(`${name}: start must be HH:MM`);
    if (!TIME_PATTERN.test(s.end)) problems.push(`${name}: end must be HH:MM`);
    if (!COLOUR_PATTERN.test(s.colour)) problems.push(`${name}: colour must look like #2962ff`);
  });
  return problems;
}

/** Replace the session list (throws if it is invalid). */
export function setSessions(list) {
  const problems = validateSessions(list);
  if (problems.length) throw new Error(problems.join("; "));
  sessions = list.map((s, i) => ({
    id: s.id || `session-${i + 1}`,
    label: String(s.label).trim(),
    zone: s.zone, start: s.start, end: s.end, colour: s.colour.toLowerCase(),
    enabled: s.enabled !== false,
  }));
  windowCache.clear();
}

/** "#2962ff" -> "41, 98, 255" for use inside rgba(). */
export function rgb(colour) {
  const n = parseInt(colour.slice(1), 16);
  return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
}

const formatters = new Map();

function formatterFor(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return formatters.get(zone);
}

/** Seconds that `zone` is ahead of UTC at this instant (e.g. Tokyo = 32400). */
export function zoneOffsetSeconds(zone, utcSeconds) {
  const p = {};
  for (const part of formatterFor(zone).formatToParts(new Date(utcSeconds * 1000))) p[part.type] = Number(part.value);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asIfUtc - utcSeconds;
}

/** UTC seconds for a wall-clock time (year, month 1-12, day, hour, minute) in a zone. */
export function zonedTimeToUtc(zone, year, month, day, hour, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const utc = guess - zoneOffsetSeconds(zone, guess);
  return guess - zoneOffsetSeconds(zone, utc); // second pass settles times near a clock change
}

const minutesOf = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));

/** Start and end (UTC seconds) of one session opening on the calendar date y-m-d in its own zone. */
export function sessionWindow(session, y, m, d) {
  const startMinutes = minutesOf(session.start);
  const endMinutes = minutesOf(session.end);
  const start = zonedTimeToUtc(session.zone, y, m, d, Math.floor(startMinutes / 60), startMinutes % 60);
  // Not after the start -> the session ends on the next calendar day.
  const next = endMinutes <= startMinutes ? new Date(Date.UTC(y, m - 1, d + 1)) : new Date(Date.UTC(y, m - 1, d));
  const end = zonedTimeToUtc(session.zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(),
    Math.floor(endMinutes / 60), endMinutes % 60);
  return { session, start, end };
}

/** Enabled sessions that open on a given calendar date. `dayNumber` is days since 1970-01-01. */
export function sessionsOn(dayNumber) {
  if (!windowCache.has(dayNumber)) {
    const date = new Date(dayNumber * DAY * 1000);
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    windowCache.set(dayNumber, sessions.filter((s) => s.enabled).map((s) => sessionWindow(s, y, m, d)));
  }
  return windowCache.get(dayNumber);
}

/** All session windows overlapping [fromUtc, toUtc]. */
export function sessionsBetween(fromUtc, toUtc) {
  const out = [];
  // Two days of margin before: a session can open on the previous calendar day and run past midnight.
  for (let day = Math.floor(fromUtc / DAY) - 2; day <= Math.floor(toUtc / DAY) + 1; day++) {
    for (const window of sessionsOn(day)) {
      if (window.end > fromUtc && window.start <= toUtc) out.push(window);
    }
  }
  return out;
}

/** Ids of the sessions open at an instant (for labels and, later, the journal). */
export function sessionsAt(utcSeconds) {
  return sessionsBetween(utcSeconds, utcSeconds)
    .filter((w) => utcSeconds >= w.start && utcSeconds < w.end)
    .map((w) => w.session.id);
}
