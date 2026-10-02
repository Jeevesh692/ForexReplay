// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionsAt, sessionsBetween, zonedTimeToUtc, zoneOffsetSeconds } from "../js/sessions.js";
import { formatDateTime } from "../js/time.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const dayNumber = (text) => Math.floor(utc(text + "T00:00") / 86400);
const find = (windows, id, day) => windows.find((w) => w.session.id === id && Math.floor(w.start / 86400) === dayNumber(day));

test("zone offsets follow each city's daylight saving", () => {
  assert.equal(zoneOffsetSeconds("Asia/Tokyo", utc("2026-01-15T12:00")), 9 * 3600);
  assert.equal(zoneOffsetSeconds("Europe/London", utc("2026-01-15T12:00")), 0);
  assert.equal(zoneOffsetSeconds("Europe/London", utc("2026-07-15T12:00")), 3600);
  assert.equal(zoneOffsetSeconds("America/New_York", utc("2026-01-15T12:00")), -5 * 3600);
  assert.equal(zoneOffsetSeconds("America/New_York", utc("2026-07-15T12:00")), -4 * 3600);
});

test("London opens at 12:30 India time in summer and 13:30 in winter", () => {
  const summer = zonedTimeToUtc("Europe/London", 2026, 7, 15, 8);
  const winter = zonedTimeToUtc("Europe/London", 2026, 1, 15, 8);
  assert.equal(formatDateTime(summer), "Wed 15 Jul 2026, 12:30");
  assert.equal(formatDateTime(winter), "Thu 15 Jan 2026, 13:30");
});

test("New York opens at 17:30 or 18:30 India time, and the mismatch weeks in March are handled", () => {
  // 10 March 2026: the US has moved to summer time (8 March), Europe has not (29 March).
  const ny = zonedTimeToUtc("America/New_York", 2026, 3, 10, 8);
  const london = zonedTimeToUtc("Europe/London", 2026, 3, 10, 8);
  assert.equal(formatDateTime(ny), "Tue 10 Mar 2026, 17:30");
  assert.equal(formatDateTime(london), "Tue 10 Mar 2026, 13:30");
  assert.equal(formatDateTime(zonedTimeToUtc("America/New_York", 2026, 1, 15, 8)), "Thu 15 Jan 2026, 18:30");
});

test("Tokyo session is 05:30 to 14:30 India time all year", () => {
  const windows = sessionsBetween(utc("2026-07-15T00:00"), utc("2026-07-15T23:59"));
  const asia = find(windows, "asia", "2026-07-15");
  assert.equal(formatDateTime(asia.start), "Wed 15 Jul 2026, 05:30");
  assert.equal(formatDateTime(asia.end), "Wed 15 Jul 2026, 14:30");
});

test("overlap: London and New York are both open at 14:00 UTC in July", () => {
  assert.deepEqual(sessionsAt(utc("2026-07-15T14:00")), ["london", "newyork"]);
  assert.deepEqual(sessionsAt(utc("2026-07-15T02:00")), ["asia"]);
  assert.deepEqual(sessionsAt(utc("2026-07-15T22:00")), []);
});

// ---- user-defined sessions ----
import { getSessions, PRESETS, rgb, sessionWindow, setSessions, validateSessions } from "../js/sessions.js";

test("a session whose end is not after its start runs past midnight", () => {
  const asiaKz = PRESETS.killzones.sessions.find((s) => s.id === "asia-kz"); // 20:00-00:00 New York
  const w = sessionWindow(asiaKz, 2026, 7, 14);
  assert.equal((w.end - w.start) / 3600, 4);
  assert.equal(formatDateTime(w.start), "Wed 15 Jul 2026, 05:30"); // 20:00 New York (summer) = 05:30 IST next day
  assert.equal(formatDateTime(w.end), "Wed 15 Jul 2026, 09:30");
});

test("the ICT killzone preset follows New York time through the year", () => {
  setSessions(PRESETS.killzones.sessions);
  try {
    assert.deepEqual(sessionsAt(utc("2026-07-15T07:00")), ["london-kz"]);   // 03:00 New York (summer)
    assert.deepEqual(sessionsAt(utc("2026-01-15T07:00")), ["london-kz"]);   // 02:00 New York (winter)
    assert.deepEqual(sessionsAt(utc("2026-01-15T06:30")), []);              // 01:30 New York (winter)
    assert.deepEqual(sessionsAt(utc("2026-07-15T02:00")), ["asia-kz"]);     // 22:00 New York the evening before
    assert.deepEqual(sessionsAt(utc("2026-07-15T14:30")), ["london-close-kz"]);
  } finally {
    setSessions(PRESETS.standard.sessions);
  }
});

test("custom sessions: minutes, switching off, and changes take effect at once", () => {
  setSessions([
    { label: "Frankfurt open", zone: "Europe/Berlin", start: "08:30", end: "09:15", colour: "#00AA88", enabled: true },
    { label: "Off", zone: "UTC", start: "00:00", end: "23:59", colour: "#ffffff", enabled: false },
  ]);
  try {
    assert.equal(getSessions().at(0).id, "session-1");
    assert.equal(getSessions().at(0).colour, "#00aa88");
    assert.deepEqual(sessionsAt(utc("2026-07-15T06:45")), ["session-1"]); // 08:45 Frankfurt (summer)
    assert.deepEqual(sessionsAt(utc("2026-07-15T07:15")), []);            // 09:15 is the end, not included
  } finally {
    setSessions(PRESETS.standard.sessions);
  }
  assert.deepEqual(sessionsAt(utc("2026-07-15T02:00")), ["asia"]); // back to the standard list
});

test("bad session settings are rejected with a readable reason", () => {
  const problems = validateSessions([
    { label: "", zone: "Mars/Olympus", start: "25:00", end: "9:00", colour: "blue" },
  ]);
  assert.equal(problems.length, 5);
  assert.throws(() => setSessions([{ label: "X", zone: "UTC", start: "08:00", end: "bad", colour: "#000000" }]), /end must be HH:MM/);
  assert.equal(getSessions().length, 3); // a rejected list changes nothing
});

test("rgb converts a hex colour for use in rgba()", () => {
  assert.equal(rgb("#2962ff"), "41, 98, 255");
});
