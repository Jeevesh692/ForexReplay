// The Analytics tab: statistics, an equity curve, a histogram of results and breakdowns,
// for one journal, filtered by run, side, session or tag.
//
// The numbers come from analytics.js (held to stats.py by a recorded test). This file only
// fetches the journal, draws, and handles the filters. Everything drawn from the journal is
// escaped first: notes and tags are typed by hand and must never become page markup.

import {
  applyFilters, breakdown, computeStats, equityCurve, filterChoices, gaveBack, histogram, money, parseRows, propCheck,
} from "./analytics.js";

const UP = "#26a69a", DOWN = "#ef5350", LINE = "#2962ff", GRID = "#2a2e39", MUTED = "#868993";
const KEY_JOURNAL = "forexreplay.analytics.journal";
const KEY_RISK = "forexreplay.analytics.risk";

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const r2 = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}R` : "–");
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "–");
const ratio = (v) => (v === Infinity ? "∞" : Number.isFinite(v) ? v.toFixed(2) : "–");
const usd = (v) => `${v < -0.004 ? "-" : v >= 0.005 ? "+" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
/** Whole number, halves to even, the way Python's report prints it (32.5 -> 32), so both show the same figure. */
const roundEven = (v) => { const f = Math.floor(v); const d = v - f; return d > 0.5 + 1e-9 || (Math.abs(d - 0.5) <= 1e-9 && f % 2 !== 0) ? f + 1 : f; };

function recall(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

export class AnalyticsView {
  /** @param {HTMLElement} root  the analytics section */
  /** @param {HTMLElement} root  the analytics section; @param {object} store  where journals are kept (store.js) */
  constructor(root, store) {
    this.store = store;
    this.root = root;
    this.el = (id) => root.querySelector(`#${id}`);
    this.trades = [];
    this.filters = { run: "", side: "", session: "", tag: "" };
    this.backtests = [];
    this.el("an-journal").addEventListener("change", (event) => {
      remember(KEY_JOURNAL, event.target.value);
      this.loadJournal(event.target.value);
    });
    for (const key of Object.keys(this.filters)) {
      this.el(`an-${key}`).addEventListener("change", (event) => { this.filters[key] = event.target.value; this.render(); });
    }
    this.el("an-risk").value = recall(KEY_RISK, "1");
    this.el("an-risk").addEventListener("change", () => { remember(KEY_RISK, this.el("an-risk").value); this.render(); });
    this.el("an-clear").addEventListener("click", () => {
      for (const key of Object.keys(this.filters)) { this.filters[key] = ""; this.el(`an-${key}`).value = ""; }
      this.render();
    });
  }

  /** Called when the tab opens: refresh the list of journals and the chosen journal. */
  async open() {
    let journals = [], backtests = [];
    try {
      [journals, backtests] = await Promise.all([
        this.store.listJournals(),
        this.store.listBacktests(),
      ]);
    } catch (err) {
      this.message(`Could not reach the app's server: ${err.message}`);
      return;
    }
    this.backtests = backtests;
    const select = this.el("an-journal");
    if (journals.length === 0) {
      select.innerHTML = "";
      this.trades = [];
      this.message("No journal yet. Trades appear here once a backtest with a closed trade has been saved.");
      return;
    }
    const wanted = recall(KEY_JOURNAL, "");
    const chosen = journals.some((j) => j.name === wanted) ? wanted : journals[0].name;
    select.innerHTML = journals.map((j) => `<option value="${escapeHtml(j.name)}"${j.name === chosen ? " selected" : ""}>` +
      `${escapeHtml(j.name)} (${j.trades})</option>`).join("");
    await this.loadJournal(chosen);
  }

  async loadJournal(name) {
    this.journal = name;
    try {
      this.trades = parseRows(await this.store.journalRows(name));
    } catch (err) {
      this.message(`Could not read the journal: ${err.message}`);
      return;
    }
    // Keep a filter only if its value still exists in this journal.
    const choices = filterChoices(this.trades);
    for (const key of Object.keys(this.filters)) {
      if (!choices[key].includes(this.filters[key])) this.filters[key] = "";
      const label = { run: "All runs", side: "Both sides", session: "All sessions", tag: "All tags" }[key];
      const names = key === "run" ? this.runNames() : {};
      this.el(`an-${key}`).innerHTML = `<option value="">${label}</option>` + choices[key]
        .map((v) => `<option value="${escapeHtml(v)}"${v === this.filters[key] ? " selected" : ""}>${escapeHtml(names[v] || v)}</option>`).join("");
    }
    this.render();
  }

  /** Backtest names for run ids, so the filter says "EURUSD from Thu 13 Aug…" rather than "bt-2026…". */
  runNames() {
    return Object.fromEntries(this.backtests.filter((b) => b.name).map((b) => [b.id, b.name]));
  }

  message(text) {
    this.el("an-message").textContent = text;
    this.el("an-message").hidden = !text;
    this.el("an-body").hidden = !!text;
  }

  render() {
    const trades = applyFilters(this.trades, this.filters);
    const stats = computeStats(trades);
    if (!stats) {
      this.message(this.trades.length ? "No trades match these filters." : "This journal has no closed trades yet.");
      return;
    }
    this.message("");
    const filtered = trades.length !== this.trades.length;
    this.el("an-count").textContent = filtered ? `${trades.length} of ${this.trades.length} trades` : `${trades.length} trades`;
    this.renderTiles(stats, trades);
    this.renderEquity(trades);
    this.renderHistogram(trades);
    this.renderInsights(stats, trades);
    this.renderBreakdowns(trades);
    this.renderTrades(trades);
  }

  renderTiles(s, trades) {
    const m = money(trades);
    const tiles = [
      ["Trades", `${s.trades}`, `${s.wins} won · ${s.losses} lost · ${s.breakevens} breakeven`],
      ["Win rate", pct(s.win_rate), `breakeven = within ±0.05R`],
      ["Expectancy", r2(s.expectancy_r), "average result per trade", tone(s.expectancy_r)],
      ["Total", r2(s.total_r), m.trades ? `${usd(m.net)} on ${m.trades} trade${m.trades === 1 ? "" : "s"} with $` : "no $ recorded", tone(s.total_r)],
      ["Profit factor", ratio(s.profit_factor), "won R ÷ lost R"],
      ["Payoff", ratio(s.payoff_ratio), `avg win ${r2(s.avg_win_r)} · avg loss ${r2(s.avg_loss_r)}`],
      ["Max drawdown", Number.isFinite(s.max_drawdown_r) ? `${s.max_drawdown_r.toFixed(2)}R` : "–", "largest fall from a peak"],
      ["Streaks", `${s.longest_win_streak} / ${s.longest_loss_streak}`, "longest wins / losses in a row"],
      ["Average MFE", Number.isFinite(s.avg_mfe_r) ? `${s.avg_mfe_r.toFixed(2)}R` : "–", mfeNote(trades)],
      ["Worst day", r2(s.worst_day_r), "results summed per run and day", tone(s.worst_day_r)],
      ["Average duration", Number.isFinite(s.avg_duration_min) ? `${roundEven(s.avg_duration_min)} min` : "–", "entry to exit"],
      ["Commission", m.trades ? usd(-m.commission) : "–", m.trades ? "included in the $ total" : "no $ recorded"],
    ];
    this.el("an-tiles").innerHTML = tiles.map(([label, value, note, t = ""]) =>
      `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value ${t}">${escapeHtml(value)}</div>` +
      `<div class="tile-note">${escapeHtml(note)}</div></div>`).join("");
  }

  /** Cumulative R after each trade: one line, a light wash under it, a crosshair with the trade under the pointer. */
  renderEquity(trades) {
    const W = 760, H = 240, L = 48, R = 16, T = 14, B = 26;
    const curve = [0, ...equityCurve(trades)];
    const lo = Math.min(0, ...curve), hi = Math.max(0, ...curve);
    const pad = (hi - lo) * 0.08 || 1;
    const y0 = lo - pad, y1 = hi + pad;
    const X = (i) => L + (i / Math.max(1, curve.length - 1)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const step = niceStep((y1 - y0) / 4);
    const ticks = [];
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) ticks.push(+v.toFixed(6));
    const path = curve.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const area = `${path}L${X(curve.length - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;
    const last = curve[curve.length - 1];
    const svg = this.el("an-equity");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML =
      ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}" stroke-width="1"/>` +
        `<text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis">${v}R</text>`).join("") +
      `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="${MUTED}" stroke-width="1"/>` +
      `<path d="${area}" fill="${LINE}" fill-opacity="0.10"/>` +
      `<path d="${path}" fill="none" stroke="${LINE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${X(curve.length - 1)}" cy="${Y(last)}" r="4" fill="${LINE}" stroke="#1e222d" stroke-width="2"/>` +
      `<text x="${Math.min(X(curve.length - 1), W - R)}" y="${Y(last) - 9}" text-anchor="end" class="label">${escapeHtml(r2(last))}</text>` +
      `<text x="${L}" y="${H - 6}" class="axis">trade 1</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="axis">trade ${trades.length}</text>` +
      `<line class="crosshair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${MUTED}" stroke-width="1" visibility="hidden"/>` +
      `<circle class="hover-dot" r="4" fill="${LINE}" stroke="#1e222d" stroke-width="2" visibility="hidden"/>`;
    const tip = this.el("an-equity-tip");
    svg.onpointermove = (event) => {
      const box = svg.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * W;
      const i = Math.max(1, Math.min(curve.length - 1, Math.round(((x - L) / (W - L - R)) * (curve.length - 1))));
      const t = trades[i - 1];
      svg.querySelector(".crosshair").setAttribute("x1", X(i));
      svg.querySelector(".crosshair").setAttribute("x2", X(i));
      svg.querySelector(".crosshair").setAttribute("visibility", "visible");
      const dot = svg.querySelector(".hover-dot");
      dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(curve[i])); dot.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = `<b>${escapeHtml(r2(curve[i]))}</b> after trade ${i}<br><span class="muted">#${escapeHtml(t.row.trade_id)} ${escapeHtml(t.side)} ` +
        `${escapeHtml(r2(t.r))} · ${escapeHtml(t.row.exit_time || "")}</span>`;
      tip.style.left = `${Math.min(box.width - 190, Math.max(0, (X(i) / W) * box.width + 10))}px`;
      tip.style.top = `${(Y(curve[i]) / H) * box.height - 40}px`;
    };
    svg.onpointerleave = () => {
      tip.hidden = true;
      svg.querySelector(".crosshair").setAttribute("visibility", "hidden");
      svg.querySelector(".hover-dot").setAttribute("visibility", "hidden");
    };
  }

  /** How many trades ended in each half-R band: losses red, wins green. */
  renderHistogram(trades) {
    const buckets = histogram(trades, 0.5);
    const W = 760, H = 210, L = 36, R = 8, T = 14, B = 40;
    const max = Math.max(...buckets.map((b) => b.count));
    const slot = (W - L - R) / buckets.length;
    const bar = Math.min(24, slot - 2);
    const Y = (n) => T + (1 - n / max) * (H - T - B);
    const svg = this.el("an-histogram");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const every = Math.ceil(buckets.length / 12); // keep the axis labels apart
    svg.innerHTML = `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="${MUTED}" stroke-width="1"/>` +
      `<text x="${L - 6}" y="${Y(max) + 4}" text-anchor="end" class="axis">${max}</text>` +
      buckets.map((b, i) => {
        const x = L + i * slot + (slot - bar) / 2;
        const colour = b.to <= 0 ? DOWN : b.from >= 0 ? UP : MUTED;
        const h = Y(0) - Y(b.count);
        const r = Math.min(4, h / 2, bar / 2);
        const shape = b.count === 0 ? "" : `<path d="M${x},${Y(0)}V${Y(b.count) + r}Q${x},${Y(b.count)} ${x + r},${Y(b.count)}H${x + bar - r}` +
          `Q${x + bar},${Y(b.count)} ${x + bar},${Y(b.count) + r}V${Y(0)}Z" fill="${colour}"/>`;
        const label = i % every === 0 ? `<text x="${L + i * slot + slot / 2}" y="${H - 24}" text-anchor="middle" class="axis">${b.from}</text>` : "";
        return `<g class="bucket" data-tip="${b.count} trade${b.count === 1 ? "" : "s"} from ${b.from}R to ${b.to}R">` +
          `<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>${shape}${label}</g>`;
      }).join("") +
      `<text x="${W - R}" y="${H - 4}" text-anchor="end" class="axis">result in R: each bar counts trades from its label up to the next (half an R)</text>`;
    const tip = this.el("an-histogram-tip");
    svg.onpointermove = (event) => {
      const g = event.target.closest(".bucket");
      svg.querySelectorAll(".bucket.hover").forEach((n) => n.classList.remove("hover"));
      if (!g) { tip.hidden = true; return; }
      g.classList.add("hover");
      const box = svg.getBoundingClientRect();
      tip.hidden = false;
      tip.textContent = g.dataset.tip;
      tip.style.left = `${Math.min(box.width - 190, event.clientX - box.left + 10)}px`;
      tip.style.top = `${event.clientY - box.top - 30}px`;
    };
    svg.onpointerleave = () => { tip.hidden = true; svg.querySelectorAll(".bucket.hover").forEach((n) => n.classList.remove("hover")); };
  }

  renderInsights(s, trades) {
    const risk = Number(this.el("an-risk").value) || 1;
    const p = propCheck(s, risk);
    const g = gaveBack(trades, 1);
    const flag = (bad, okText, badText) => `<span class="${bad ? "down" : "up"}">${bad ? "✗ " + badText : "✓ " + okText}</span>`;
    const runs = new Set(trades.map((t) => t.run));
    const challenges = this.backtests.filter((b) => b.journal === this.journal && runs.has(b.id) && b.result && b.result.challenge);
    const count = (outcome) => challenges.filter((b) => b.result.challenge === outcome).length;
    this.el("an-insights").innerHTML =
      `<li><b>As a prop-firm account at ${escapeHtml(String(risk))}% risk per trade</b> (8% target, 5% daily, 10% max loss, every trade in a row as one account): ` +
      `return ${p.return_pct >= 0 ? "+" : ""}${p.return_pct.toFixed(1)}%, max drawdown ${p.max_drawdown_pct.toFixed(1)}%, ` +
      `worst day ${Number.isFinite(p.worst_day_pct) ? p.worst_day_pct.toFixed(1) + "%" : "–"}. ` +
      `${flag(!p.hits_target, "target reached", "target not reached")} · ${flag(p.breaches_daily, "daily limit kept", "daily limit broken")} · ` +
      `${flag(p.breaches_max, "max loss kept", "max loss broken")}</li>` +
      `<li><b>Losses that were +1R first:</b> ${g.reached} of ${g.known} losing trades with MFE recorded` +
      `${g.known < g.losers ? ` (${g.losers - g.known} older losses have none)` : ""}. ` +
      `${g.reached ? "A stop moved to breakeven at +1R would have turned these into scratches." : ""}</li>` +
      (challenges.length ? `<li><b>Challenge runs in this selection:</b> ${count("PASSED")} passed, ${count("FAILED")} failed, ${count("RUNNING")} unfinished.</li>` : "");
  }

  renderBreakdowns(trades) {
    const names = this.runNames();
    const groups = [
      ["Session", "session"], ["Weekday", "weekday"], ["Side", "side"], ["Exit", "exitReason"],
      ["Tag", (t) => (t.tags.length ? t.tags : ["(no tag)"])], ["Run", "run"],
    ];
    this.el("an-breakdowns").innerHTML = groups.map(([title, by]) => {
      const table = breakdown(trades, by);
      const most = Math.max(...table.map((row) => Math.abs(row.total_r)), 0.0001);
      return `<div class="block"><h2>By ${title.toLowerCase()}</h2><table class="grid">` +
        `<thead><tr><th>${title}</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Avg</th><th class="num">Total R</th><th></th></tr></thead><tbody>` +
        table.map((row) => {
          const width = (Math.abs(row.total_r) / most) * 50;
          const label = title === "Run" ? names[row.group] || row.group : row.group || "(blank)";
          return `<tr><td>${escapeHtml(label)}</td><td class="num">${row.trades}</td><td class="num">${pct(row.win_rate)}</td>` +
            `<td class="num ${tone(row.expectancy_r)}">${r2(row.expectancy_r)}</td>` +
            `<td class="num ${tone(row.total_r)}">${r2(row.total_r)}</td>` +
            `<td><div class="divbar" title="Total R: losses to the left of the centre line, wins to the right">` +
            `<i style="${row.total_r >= 0 ? "left:50%" : `left:${50 - width}%`};width:${width}%;background:${row.total_r >= 0 ? UP : DOWN}"></i></div></td></tr>`;
        }).join("") + "</tbody></table></div>";
    }).join("");
  }

  renderTrades(trades) {
    const shown = trades.slice(-300).reverse();
    this.el("an-trades-note").textContent = trades.length > shown.length ? `Latest ${shown.length} of ${trades.length}.` : "";
    this.el("an-trades").innerHTML = shown.map((t) => {
      const shots = (t.row.screenshots || "").split(";").map((s) => s.trim()).filter(Boolean);
      const links = !this.store.screenshots ? "" : shots.map((name, i) => `<a href="${this.store.screenshotUrl(this.journal, name)}" target="_blank" rel="noopener">${i + 1}</a>`).join(" ");
      return `<tr><td>#${escapeHtml(t.row.trade_id)}</td><td>${escapeHtml(t.side)}</td><td class="nowrap">${escapeHtml(t.row.entry_time)}</td>` +
        `<td class="num ${tone(t.r)}">${r2(t.r)}</td><td class="num">${Number.isFinite(t.money) ? usd(t.money) : ""}</td>` +
        `<td>${escapeHtml(t.exitReason.toLowerCase().replace("_", " "))}</td><td>${escapeHtml(t.tags.join(", "))}</td>` +
        `<td class="note">${escapeHtml(t.row.note || "")}</td><td>${links}</td></tr>`;
    }).join("");
  }
}

/** How far trades went your way, and on how many it is known (older rows have no MFE). */
function mfeNote(trades) {
  const known = trades.filter((t) => Number.isFinite(t.mfe)).length;
  return known === trades.length ? "how far trades went your way" : `how far trades went your way · only ${known} of ${trades.length} have it`;
}

/** 1, 2 or 5 times a power of ten: tidy gridline spacing. */
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}
