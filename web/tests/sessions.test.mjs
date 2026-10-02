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
