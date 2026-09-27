// Time helpers. Candle times are stored in UTC (unix seconds); everything the
// user sees is India Standard Time (UTC+5:30, no daylight saving).

export const DISPLAY_TIMEZONE = "Asia/Kolkata";
export const DISPLAY_LABEL = "IST";
export const IST_OFFSET_SECONDS = 5.5 * 3600;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Month names come from our own list: browsers disagree on "Sep" vs "Sept".
const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TIMEZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function pick(unixSeconds) {
  const out = {};
  for (const p of parts.formatToParts(new Date(unixSeconds * 1000))) out[p.type] = p.value;
  out.month = MONTHS[Number(out.month) - 1];
  return out;
}

/** "Fri 01 Aug 2025, 05:30" in India time. */
export function formatDateTime(unixSeconds) {
  const p = pick(unixSeconds);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "01 Aug 2025" in India time. */
export function formatDate(unixSeconds) {
  const p = pick(unixSeconds);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "Aug 2025" for a "2025-08" month key. */
export function formatMonthKey(key) {
  const [year, month] = key.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}
