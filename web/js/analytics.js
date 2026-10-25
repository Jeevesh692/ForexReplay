// Trade statistics for the analytics page, measured in R.
//
// The definitions are those of forex_replay/stats.py (the `report` command). They are
// repeated here so the page can redraw at once when you filter, and
// web/tests/analytics.test.mjs holds them to the numbers stats.py recorded in
// web/tests/fixtures/stats_golden.json. Change stats.py first, then this file, then run
// `python -m forex_replay.stats_golden`.
//
// As in stats.py, trades are taken in the order they were logged (the order you took
// them), not sorted by date: replaying the same weeks twice would otherwise interleave.

export const BREAKEVEN_R = 0.05; // |result| below this counts as breakeven

/** A journal cell as a number; an empty cell is "no value" (NaN), never 0. */
export const num = (text) => (text === undefined || text === null || String(text).trim() === "" ? NaN : Number(text));

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
const sum = (values) => values.reduce((a, b) => a + b, 0);

export function classify(r) {
  if (r > BREAKEVEN_R) return "win";
  if (r < -BREAKEVEN_R) return "loss";
  return "breakeven";
}

/**
 * Journal rows (text, as the server sends them) as trades with numbers.
 * Rows without a result (an open trade logged by mistake, a damaged line) are left out, as stats.py does.
 */
export function parseRows(rows) {
  const out = [];
  for (const row of rows) {
    const r = num(row.result_r);
    if (!Number.isFinite(r)) continue;
    out.push({
      row,
      r,
      run: row.run_id || "",
      side: row.side || "",
      session: row.session || "",
      weekday: row.weekday || "",
      exitReason: row.exit_reason || "",
      exitDay: (row.exit_time || "").slice(0, 10),
      mfe: num(row.mfe_r),
      duration: num(row.duration_min),
      money: num(row.pnl_usd),
      commission: num(row.commission_usd),
      tags: (row.tags || "").split(";").map((t) => t.trim()).filter(Boolean),
    });
  }
  return out;
}

/** Cumulative R after each trade. */
export function equityCurve(trades) {
  let total = 0;
  return trades.map((t) => (total += t.r));
}

/**
 * Trades, win rate, total R and net dollars per day or month (period "day" or "month"), newest first,
 * as forex_replay/stats.py period_table: by the broker-server date the trade closed; rows with no dollars
 * add to trades and R only; every run on a date is added together. Returns [{ group, trades, win_rate, total_r, net_usd }].
 */
export function periodTable(trades, period) {
  const width = period === "day" ? 10 : 7; // "2026-03-11" or "2026-03"
  const groups = new Map();
  for (const t of trades) {
    const key = (t.row.exit_time || "").slice(0, width);
    if (key.length !== width) continue; // no exit time
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([group, list]) => {
    const withMoney = list.filter((t) => Number.isFinite(t.money));
    return {
      group, trades: list.length, win_rate: list.filter((t) => t.r > BREAKEVEN_R).length / list.length,
      total_r: sum(list.map((t) => t.r)), net_usd: withMoney.length ? sum(withMoney.map((t) => t.money)) : NaN,
    };
  });
}

/**
 * The dollar side of the trades, as forex_replay/stats.py money_stats: wins and losses by the sign of the
 * dollar result; trades without dollars left out; days per run and closing date; with the session's
 * starting balance, the ending balance, the return % and the largest fall of the balance in % of its peak.
 */
export function moneyStats(trades, startBalance = null) {
  const withMoney = trades.filter((t) => Number.isFinite(t.money));
  const usd = withMoney.map((t) => t.money);
  const won = usd.filter((v) => v > 0), lost = usd.filter((v) => v < 0);
  const has = usd.length > 0;
  const grossProfit = has ? sum(won) : NaN, grossLoss = has ? -sum(lost) : NaN;
  const rs = trades.map((t) => t.r);
  const planned = trades.map((t) => num(t.row.planned_rr)).filter(Number.isFinite);
  const out = {
    trades_with_usd: usd.length,
    net_usd: has ? sum(usd) : NaN,
    gross_profit_usd: grossProfit,
    gross_loss_usd: grossLoss,
    profit_factor_usd: has ? (grossLoss ? grossProfit / grossLoss : Infinity) : NaN,
    avg_win_usd: won.length ? mean(won) : NaN,
    avg_loss_usd: lost.length ? mean(lost) : NaN,
    largest_win_usd: won.length ? Math.max(...won) : NaN,
    largest_loss_usd: lost.length ? Math.min(...lost) : NaN,
    largest_win_r: rs.some((r) => r > BREAKEVEN_R) ? Math.max(...rs) : NaN,
    largest_loss_r: rs.some((r) => r < -BREAKEVEN_R) ? Math.min(...rs) : NaN,
    best_day_r: NaN, best_day_usd: NaN, worst_day_usd: NaN,
    avg_planned_rr: planned.length ? mean(planned) : NaN,
    max_drawdown_usd: maxDrawdownMoney(trades),
    start_balance: NaN, end_balance: NaN, return_pct: NaN, max_drawdown_pct: NaN,
  };
  const days = new Map(); // "run|date" -> { r, usd, hasUsd }
  for (const t of trades) {
    if (!t.exitDay) continue;
    const key = `${t.run}|${t.exitDay}`;
    const d = days.get(key) || { r: 0, usd: 0, hasUsd: false };
    d.r += t.r;
    if (Number.isFinite(t.money)) { d.usd += t.money; d.hasUsd = true; }
    days.set(key, d);
  }
  if (days.size) {
    out.best_day_r = Math.max(...[...days.values()].map((d) => d.r));
    const dollarDays = [...days.values()].filter((d) => d.hasUsd).map((d) => d.usd);
    if (has && dollarDays.length) { out.best_day_usd = Math.max(...dollarDays); out.worst_day_usd = Math.min(...dollarDays); }
  }
  if (Number.isFinite(startBalance) && startBalance > 0) {
    const net = has ? out.net_usd : 0;
    out.start_balance = startBalance;
    out.end_balance = startBalance + net;
    out.return_pct = (net / startBalance) * 100;
    let balance = startBalance, peak = startBalance, worst = 0;
    for (const v of usd) {
      balance += v;
      peak = Math.max(peak, balance);
      worst = Math.max(worst, (peak - balance) / peak);
    }
    out.max_drawdown_pct = worst * 100;
  }
  return out;
}

/** Largest fall from a peak of the dollar equity curve (from 0, in logged order); NaN when no trade has dollars. */
export function maxDrawdownMoney(trades) {
  const values = trades.filter((t) => Number.isFinite(t.money)).map((t) => t.money);
  if (!values.length) return NaN;
  let total = 0, peak = 0, worst = 0;
  for (const v of values) {
    total += v;
    peak = Math.max(peak, total);
    worst = Math.max(worst, peak - total);
  }
  return worst;
}

/** Largest fall from a peak of the equity curve (which starts at 0), in R, as a positive number. */
export function maxDrawdown(trades) {
  let peak = 0, worst = 0;
  for (const value of [0, ...equityCurve(trades)]) {
    peak = Math.max(peak, value);
    worst = Math.max(worst, peak - value);
  }
  return worst;
}

/** Longest run of wins (or losses). A breakeven neither extends nor breaks a run. */
export function longestStreak(trades, kind) {
  let best = 0, current = 0;
  for (const t of trades) {
    const outcome = classify(t.r);
    if (outcome === kind) best = Math.max(best, ++current);
    else if (outcome !== "breakeven") current = 0;
  }
  return best;
}

/** The same fields as stats.py's Stats, or null for no trades. */
export function computeStats(trades) {
  if (trades.length === 0) return null;
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => classify(r) === "win");
  const losses = rs.filter((r) => classify(r) === "loss");
  const grossProfit = sum(wins), grossLoss = -sum(losses);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0;
  // Worst day: results summed per run and exit date (a date on the broker clock, as written in the journal).
  const days = new Map();
  for (const t of trades) {
    if (!t.exitDay) continue;
    const key = `${t.run}|${t.exitDay}`;
    days.set(key, (days.get(key) || 0) + t.r);
  }
  const mfes = trades.map((t) => t.mfe).filter(Number.isFinite);
  const durations = trades.map((t) => t.duration).filter(Number.isFinite);
  return {
    trades: rs.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: rs.length - wins.length - losses.length,
    win_rate: wins.length / rs.length,
    avg_win_r: avgWin,
    avg_loss_r: avgLoss,
    payoff_ratio: avgLoss ? avgWin / -avgLoss : Infinity,
    expectancy_r: mean(rs),
    total_r: sum(rs),
    profit_factor: grossLoss ? grossProfit / grossLoss : Infinity,
    max_drawdown_r: maxDrawdown(trades),
    longest_win_streak: longestStreak(trades, "win"),
    longest_loss_streak: longestStreak(trades, "loss"),
    avg_mfe_r: mfes.length ? mean(mfes) : NaN,
    worst_day_r: days.size ? Math.min(...days.values()) : NaN,
    avg_duration_min: durations.length ? mean(durations) : NaN,
  };
}

/**
 * Trades, win rate, total R and expectancy per group, most trades first.
 * `by` is a field name, or a function returning a list of groups (a trade with two tags counts in both).
 */
export function breakdown(trades, by) {
  const groups = new Map();
  for (const t of trades) {
    const keys = typeof by === "function" ? by(t) : [t[by]];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
  }
  const table = [...groups].map(([group, list]) => {
    const rs = list.map((t) => t.r);
    const dollars = list.filter((t) => Number.isFinite(t.money)).map((t) => t.money);
    return {
      group, trades: rs.length, win_rate: rs.filter((r) => r > BREAKEVEN_R).length / rs.length,
      total_r: sum(rs), expectancy_r: mean(rs), net_usd: dollars.length ? sum(dollars) : NaN,
    };
  });
  return table.sort((a, b) => b.trades - a.trades); // a stable sort: ties keep the order first seen
}

/** v1's prop-firm check: R turned into account % at a fixed risk per trade (no compounding). */
export function propCheck(stats, riskPct, { targetPct = 8, dailyPct = 5, maxPct = 10 } = {}) {
  const check = {
    return_pct: stats.total_r * riskPct,
    max_drawdown_pct: stats.max_drawdown_r * riskPct,
    worst_day_pct: stats.worst_day_r * riskPct,
  };
  return {
    ...check,
    hits_target: check.return_pct >= targetPct,
    breaches_daily: check.worst_day_pct <= -dailyPct,
    breaches_max: check.max_drawdown_pct >= maxPct,
  };
}

/** How many trades fall in each bucket of `size` R: [{ from, to, count }], from the lowest result to the highest. */
export function histogram(trades, size = 0.5) {
  if (trades.length === 0) return [];
  const index = (r) => Math.floor(r / size + 1e-9);
  const lo = Math.min(...trades.map((t) => index(t.r)));
  const hi = Math.max(...trades.map((t) => index(t.r)));
  const buckets = [];
  for (let i = lo; i <= hi; i++) buckets.push({ from: i * size, to: (i + 1) * size, count: 0 });
  for (const t of trades) buckets[index(t.r) - lo].count++;
  return buckets;
}

/** Losing trades that had been at least `reach` R in profit first: the ones a moved stop or a partial could have saved. */
export function gaveBack(trades, reach = 1) {
  const losers = trades.filter((t) => classify(t.r) === "loss");
  const known = losers.filter((t) => Number.isFinite(t.mfe));
  return { losers: losers.length, known: known.length, reached: known.filter((t) => t.mfe >= reach).length };
}

/** Dollar totals, from the rows that have them (rows written by the v1 window have none). */
export function money(trades) {
  const withMoney = trades.filter((t) => Number.isFinite(t.money));
  return {
    trades: withMoney.length,
    net: sum(withMoney.map((t) => t.money)),
    commission: sum(withMoney.map((t) => (Number.isFinite(t.commission) ? t.commission : 0))),
  };
}

/** Choices for the filters: the values that occur, most common first. */
export function filterChoices(trades) {
  const count = (values) => {
    const c = new Map();
    for (const v of values) if (v) c.set(v, (c.get(v) || 0) + 1);
    return [...c.keys()].sort((a, b) => c.get(b) - c.get(a) || a.localeCompare(b));
  };
  return {
    run: count(trades.map((t) => t.run)),
    side: count(trades.map((t) => t.side)),
    session: count(trades.map((t) => t.session)),
    tag: count(trades.flatMap((t) => t.tags)),
  };
}

/** Keep the trades that match every chosen filter ({ run, side, session, tag }; "" = any). */
export function applyFilters(trades, filters) {
  return trades.filter((t) => (!filters.run || t.run === filters.run) && (!filters.side || t.side === filters.side) &&
    (!filters.session || t.session === filters.session) && (!filters.tag || t.tags.includes(filters.tag)));
}

// ----- money over time: the balance graph and the P&L calendar ---------------------
// These only regroup the journal's own $ column by exit time; stats.py has no twin of
// them, so web/tests/analytics.test.mjs checks them directly.

/**
 * The closed balance after each trade that has $ recorded, in the order trades closed:
 * [{ balance, trade }], starting from `start` (0 gives cumulative $ only).
 */
export function balanceCurve(trades, start = 0) {
  const closed = trades.filter((t) => Number.isFinite(t.money) && t.row.exit_time)
    .map((t, i) => [t, i]).sort((a, b) => a[0].row.exit_time.localeCompare(b[0].row.exit_time) || a[1] - b[1]).map(([t]) => t);
  let balance = start;
  return closed.map((trade) => ({ balance: (balance += trade.money), trade }));
}

/** Results per trading day (the exit date on the broker clock): Map "YYYY-MM-DD" -> { money, r, trades, withMoney }. */
export function dailyPnl(trades) {
  const days = new Map();
  for (const t of trades) {
    if (!t.exitDay) continue;
    const d = days.get(t.exitDay) || { money: 0, r: 0, trades: 0, withMoney: 0 };
    d.trades += 1;
    d.r += t.r;
    if (Number.isFinite(t.money)) { d.money += t.money; d.withMoney += 1; }
    days.set(t.exitDay, d);
  }
  return days;
}

/**
 * A month as calendar weeks, Sunday first, each with the days shown and the week's total
 * over all seven days (days of the next or previous month included, as the week is one week).
 * `month` is 1-12. Returns [{ days: [{ date, inMonth, result|null }], total: { money, r, trades, withMoney } }].
 */
export function monthWeeks(year, month, days) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const first = Date.UTC(year, month - 1, 1);
  const DAY = 86400000;
  let start = first - new Date(first).getUTCDay() * DAY;
  const weeks = [];
  while (weeks.length === 0 || new Date(start).getUTCMonth() === month - 1) {
    const week = { days: [], total: { money: 0, r: 0, trades: 0, withMoney: 0 } };
    for (let i = 0; i < 7; i++) {
      const date = iso(start + i * DAY);
      const result = days.get(date) || null;
      week.days.push({ date, inMonth: Number(date.slice(5, 7)) === month, result });
      if (result) for (const key of Object.keys(week.total)) week.total[key] += result[key];
    }
    weeks.push(week);
    start += 7 * DAY;
  }
  return weeks;
}
