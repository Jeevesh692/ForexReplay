// The ADR plan card in the trading panel: today's ADR and every threshold of the plan in pips.
// The numbers come from adrplan.js. The card is redrawn only when the day or the plan changes,
// so it costs nothing while the replay plays and never interrupts typing in it.

import { adrBefore, checkOrder, cleanPlan, DEFAULT_PLAN, STORAGE_KEY, thresholds } from "./adrplan.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Fri 11 Sep" for a broker-server date number. */
function dayText(date) {
  const d = new Date(date * 86400000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export class AdrPanel {
  /**
   * @param {HTMLElement} root  the card
   * @param {object} options { m5, nowIndex() -> index of the last revealed M5 candle, pipPoints }
   */
  constructor(root, { m5, nowIndex, pipPoints }) {
    this.root = root;
    this.m5 = m5;
    this.nowIndex = nowIndex;
    this.pipPoints = pipPoints;
    this.el = (id) => root.querySelector(`#${id}`);
    this.plan = this.load();
    this.key = null;
    this.adr = NaN;

    root.addEventListener("change", (event) => this.edited(event));
    root.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-adr-remove]");
      if (remove) { this.plan.rows.splice(Number(remove.dataset.adrRemove), 1); this.save(); }
      if (event.target.id === "adr-add") {
        let n = 1;
        while (this.plan.rows.some((r) => r.id === `custom${n}`)) n++;
        this.plan.rows.push({ id: `custom${n}`, label: "New threshold", mult: 0.1 });
        this.save();
      }
      if (event.target.id === "adr-reset") { this.plan = structuredClone(DEFAULT_PLAN); this.save(); }
    });
    this.render();
  }

  load() {
    try { return cleanPlan(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); } catch { return cleanPlan(null); }
  }

  save() {
    this.plan = cleanPlan(this.plan);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.plan)); } catch { /* private mode: not kept */ }
    this.render(true);
  }

  edited(event) {
    const t = event.target;
    if (t.id === "adr-period") this.plan.period = Number(t.value);
    else if (t.id === "adr-rr") this.plan.rrFloor = Number(t.value);
    else if (t.dataset.adrMult !== undefined) this.plan.rows[Number(t.dataset.adrMult)].mult = Number(t.value);
    else if (t.dataset.adrLabel !== undefined) this.plan.rows[Number(t.dataset.adrLabel)].label = t.value;
    else return;
    this.save(); // an impossible value is replaced by what is kept, which the redraw shows
  }

  /** Warnings for an order (see adrplan.checkOrder). */
  check(order) {
    return checkOrder(this.plan, this.adr, order, this.pipPoints);
  }

  /** Called on every change; works anything out again only when the day or the plan changed. */
  render(force = false) {
    const i = this.nowIndex();
    const key = JSON.stringify([this.plan, i >= 0 ? Math.floor(this.m5.time[i] / 3600) : null]); // a new hour may be a new day
    if (!force && key === this.key) return;
    this.key = key;
    const { adr, days, today } = adrBefore(this.m5, i, this.plan.period);
    this.adr = adr;
    const pips = (points) => (points / this.pipPoints).toFixed(1);
    const n = this.plan.period;
    this.el("adr-summary").textContent = Number.isFinite(adr)
      ? `ADR${n} ${pips(adr)} pips` + (this.plan.rows.some((r) => r.id === "minStop") ? ` · minStop ${pips(adr * this.plan.rows.find((r) => r.id === "minStop").mult)}` : "")
      : `ADR${n}: not enough days yet`;
    this.el("adr-asof").textContent = Number.isFinite(adr)
      ? `For ${dayText(today)}, from the ${n} completed days ${dayText(days[0].date)} to ${dayText(days[days.length - 1].date)} (days close at 17:00 New York). Fixed for the whole day.`
      : `Needs ${n} completed days before ${dayText(today)}; ${days.length} so far.`;
    const focused = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset.adrMult || document.activeElement.dataset.adrLabel : null;
    if (focused !== null && !force) return; // never redraw under someone typing
    // Two lines per threshold, so the full name fits the narrow panel: the name, then "0.02 × ADR = 1.0 pips".
    this.el("adr-rows").innerHTML = thresholds(this.plan, adr).map((r, k) => `<div class="adr-row">
      <input type="text" data-adr-label="${k}" value="${escapeHtml(r.label)}" maxlength="80" aria-label="Name">
      <div class="adr-line"><input type="number" step="0.01" min="0" max="10" data-adr-mult="${k}" value="${r.mult}" aria-label="Times ADR">
        <span class="muted">&times; ADR =</span> <b class="adr-pips">${Number.isFinite(r.points) ? `${pips(r.points)} pips` : "–"}</b>
        <button class="plain small" data-adr-remove="${k}" title="Remove this row">&times;</button></div></div>`).join("") +
      `<div class="adr-row"><span class="adr-name">R:R floor (for structural targets)</span>
      <div class="adr-line"><input type="number" step="0.1" min="0" max="20" id="adr-rr" value="${this.plan.rrFloor}" aria-label="R:R floor">
        <span class="muted">reward : risk at least</span> <b class="adr-pips">${this.plan.rrFloor}</b></div></div>`;
    this.el("adr-period").value = this.plan.period;
  }
}
