// Trading sessions, each defined in its own city's clock.
//
// Defining London as "08:00-17:00 Europe/London" (not as fixed UTC or India
// hours) means the shading stays right through daylight-saving changes: the
// London open is 12:30 IST in summer and 13:30 IST in winter, automatically.
//
// Edit SESSIONS to change the hours or colours.

export const SESSIONS = [
  { id: "asia", label: "Asia", zone: "Asia/Tokyo", start: 9, end: 18, colour: "245, 166, 35" },
  { id: "london", label: "London", zone: "Europe/London", start: 8, end: 17, colour: "41, 98, 255" },
  { id: "newyork", label: "New York", zone: "America/New_York", start: 8, end: 17, colour: "171, 71, 188" },
];

const DAY = 86400;
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

/** UTC seconds for a wall-clock time (year, month 1-12, day, hour) in a zone. */
export function zonedTimeToUtc(zone, year, month, day, hour) {
  const guess = Date.UTC(year, month - 1, day, hour) / 1000;
  const utc = guess - zoneOffsetSeconds(zone, guess);
  return guess - zoneOffsetSeconds(zone, utc); // second pass settles times near a clock change
}

const cache = new Map();

/**
 * Sessions that open on a given calendar date (in each session's own zone).
 * `dayNumber` is days since 1970-01-01. Returns [{ session, start, end }] in UTC seconds.
 */
export function sessionsOn(dayNumber) {
  if (!cache.has(dayNumber)) {
    const date = new Date(dayNumber * DAY * 1000);
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    cache.set(dayNumber, SESSIONS.map((session) => ({
      session,
      start: zonedTimeToUtc(session.zone, y, m, d, session.start),
      end: zonedTimeToUtc(session.zone, y, m, d, session.end),
    })));
  }
  return cache.get(dayNumber);
}

/** All session windows overlapping [fromUtc, toUtc]. */
export function sessionsBetween(fromUtc, toUtc) {
  const out = [];
  // One day of margin each side: Tokyo's calendar day starts before the UTC day does.
  for (let day = Math.floor(fromUtc / DAY) - 1; day <= Math.floor(toUtc / DAY) + 1; day++) {
    for (const window of sessionsOn(day)) {
      if (window.end > fromUtc && window.start <= toUtc) out.push(window);
    }
  }
  return out;
}

/** Which sessions are open at an instant (for labels and, later, the journal). */
export function sessionsAt(utcSeconds) {
  return sessionsBetween(utcSeconds, utcSeconds)
    .filter((w) => utcSeconds >= w.start && utcSeconds < w.end)
    .map((w) => w.session.id);
}
