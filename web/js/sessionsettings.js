// The "Session settings" dialog: edit names, timezones, hours and colours,
// add or remove sessions, or load a preset. Saved in the browser between visits.

import { getSessions, PRESETS, sessionWindow, setSessions, validateSessions, ZONES } from "./sessions.js";
import { formatDate, formatDateTime } from "./time.js";

const STORAGE_KEY = "forexreplay.sessionlist";

/** Load the saved list at start-up; fall back to the standard sessions if it is missing or broken. */
export function loadSavedSessions() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && validateSessions(saved).length === 0) setSessions(saved);
  } catch { /* unreadable storage: keep the defaults */ }
}

function save(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* private mode: not saved */ }
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "12:30 – 21:30" in India time for a session on the date of `referenceUtc`. */
export function indiaHours(session, referenceUtc) {
  const d = new Date(referenceUtc * 1000);
  const w = sessionWindow(session, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  const time = (t) => formatDateTime(t).split(", ")[1];
  return `${time(w.start)} – ${time(w.end)}`;
}

/** Colour key shown in the status bar. */
export function renderSessionKey(element) {
  element.innerHTML = getSessions().filter((s) => s.enabled)
    .map((s) => `<i style="background: ${s.colour}"></i>${escapeHtml(s.label)}`).join("");
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {object} options { referenceTime(): UTC seconds for the India-time preview, onSaved() }
 */
export function setupSessionSettings(dialog, { referenceTime, onSaved }) {
  const rows = dialog.querySelector("#session-rows");
  const error = dialog.querySelector("#session-error");
  const previewNote = dialog.querySelector("#session-preview-note");
  let draft = [];

  const zoneOptions = (selected) => ZONES.map((z) =>
    `<option value="${z.id}"${z.id === selected ? " selected" : ""}>${z.label}</option>`).join("");

  function render() {
    const reference = referenceTime();
    previewNote.textContent = `India time shown for ${formatDate(reference)}. It shifts by an hour when a city changes its clocks.`;
    rows.innerHTML = draft.map((s, i) => {
      const valid = validateSessions([s]).length === 0;
      return `<tr data-row="${i}">
        <td><input type="checkbox" data-field="enabled"${s.enabled ? " checked" : ""} title="Show this session"></td>
        <td><input type="text" data-field="label" value="${escapeHtml(s.label)}" maxlength="24"></td>
        <td><select data-field="zone">${zoneOptions(s.zone)}</select></td>
        <td><input type="time" data-field="start" value="${escapeHtml(s.start)}"></td>
        <td><input type="time" data-field="end" value="${escapeHtml(s.end)}"></td>
        <td class="india-hours">${valid ? indiaHours(s, reference) : "–"}</td>
        <td><input type="color" data-field="colour" value="${escapeHtml(s.colour)}"></td>
        <td><button type="button" class="plain" data-remove title="Remove this session">&#10005;</button></td>
      </tr>`;
    }).join("");
    error.textContent = "";
  }

  rows.addEventListener("change", (event) => {
    const row = event.target.closest("tr");
    const field = event.target.dataset.field;
    if (!row || !field) return;
    const session = draft[Number(row.dataset.row)];
    session[field] = field === "enabled" ? event.target.checked : event.target.value;
    // Update only the preview cell, so the field being edited keeps the focus.
    row.querySelector(".india-hours").textContent =
      validateSessions([session]).length === 0 ? indiaHours(session, referenceTime()) : "–";
  });

  rows.addEventListener("click", (event) => {
    if (!event.target.closest("[data-remove]")) return;
    draft.splice(Number(event.target.closest("tr").dataset.row), 1);
    render();
  });

  dialog.querySelector("#session-add").addEventListener("click", () => {
    draft.push({ id: `custom-${Date.now()}`, label: "New session", zone: "Europe/London",
      start: "08:00", end: "10:00", colour: "#26a69a", enabled: true });
    render();
  });

  dialog.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      draft = PRESETS[button.dataset.preset].sessions.map((s) => ({ ...s }));
      render();
    });
  });

  dialog.querySelector("#session-cancel").addEventListener("click", () => dialog.close());

  dialog.querySelector("#session-save").addEventListener("click", () => {
    const problems = validateSessions(draft);
    if (problems.length) {
      error.textContent = problems.join(". ");
      return;
    }
    setSessions(draft);
    save(getSessions());
    dialog.close();
    onSaved();
  });

  return function open() {
    draft = getSessions();
    render();
    dialog.showModal();
  };
}
