"""Your manual trades against the mechanical rules: every trade the rules would have taken differently.

    python -m forex_replay mbt compare <strategy> --config configs/mechanical.yaml

Each saved session of the strategy is replayed by the engine over the same stretch of the same pair, and the
trades are paired: the same side placed within 15 minutes of each other is the same trade. Every pair and every
trade left over is written to <output>/compare_<strategy>/compare.csv:

  same          you and the rules took it, with stop and target within 1 pip
  different     you both took it, but the rules' stop or target differ (both shown)
  manual only   you took it, the rules did not; why: what the rules turned down near that moment, or the state
  rules only    the rules took it, you did not
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from .. import flow
from ..backtests import JOURNALS_DIR, check_name
from ..loglib import load_base
from ..oflog import ist_text
from .engine import PairRun, in_window, load_news
from .report import manifest

MATCH_SECONDS = 15 * 60
COLUMNS = ["session", "pair", "kind", "side", "model", "manual_time_ist", "rules_time_ist", "manual_entry", "rules_entry",
           "manual_stop", "rules_stop", "manual_target", "rules_target", "manual_r", "rules_r_after_costs", "why"]


def why_not(run: PairRun, trade: dict) -> str:
    """Why the rules did not take a manual trade: what they turned down within 15 minutes of it, or the state then."""
    side = "long" if trade["side"] == "BUY" else "short"
    t = int(trade.get("placedTime") or trade["entryTime"]) + 60
    near = [s for s in run.skipped if s["side"] == side and abs(s["time"] - t) <= MATCH_SECONDS]
    if near:
        return "; ".join(sorted({f"{s['model']}: {s['reason']}" for s in near}))
    windows = [m for m, key in (("A", "model_a"), ("B", "model_b")) if run.c[key]["enabled"] and in_window(t, run.c[key]["window"])]
    if not windows:
        return "outside both models' windows"
    info = run.day(t)
    if not info["prior"]:
        return "no prior value area"
    state = run.state(t - t % 300, info["prior"])["state"]
    return f"no setup: the market state was {state.replace('_', ' ')}"


def compare(strategy: str, config: dict, root: Path = JOURNALS_DIR, load=None) -> dict:
    """`load(symbol)` -> (base candles, order-flow minutes, manifest); the app's data by default (tests pass their own)."""
    load = load or (lambda symbol: (load_base(symbol), flow.read_flow(symbol, "M1"), manifest(symbol)))
    folder = root / check_name(strategy, "A strategy name")
    sessions = sorted((folder / "backtests").glob("*.json"))
    if not sessions:
        return {"rows": [], "text": f"No saved sessions in {folder}."}
    news = load_news(config["limits"]["news_file"])
    price = lambda points, digits: "" if points is None else f"{points / 10 ** digits:.{digits}f}"
    rows = []
    for path in sessions:
        data = json.loads(path.read_text(encoding="utf-8"))
        symbol = data.get("symbol") or "EURUSD"
        manual = [t for t in data.get("trades") or [] if t.get("status") == "CLOSED" and t.get("entryTime") is not None]
        base, m1, man = load(symbol)
        if m1 is None or symbol not in config["pair_settings"]:
            rows += [{"session": data["id"], "pair": symbol, "kind": "manual only", "side": t["side"],
                      "manual_time_ist": ist_text(t.get("placedTime")), "why": f"no order-flow data or settings for {symbol}"} for t in manual]
            continue
        run = PairRun(symbol, config, base, m1, news, contract=man.get("contract_size"), digits=man.get("digits"),
                      pip_points=man.get("pip_points", 10), s15_reader=man.get("s15_reader"))
        start = int(data.get("startTime") or (min(int(t["placedTime"]) for t in manual) if manual else 0)) - 86400
        run.run(start, int(data["furthestTime"]) + 60)
        digits, pip = run.digits, run.pip
        rules = list(run.closed)
        for t in manual:
            side = t["side"]
            match = min((r for r in rules if r["side"] == side and abs(r["placedTime"] - int(t["placedTime"])) <= MATCH_SECONDS),
                        key=lambda r: abs(r["placedTime"] - int(t["placedTime"])), default=None)
            row = {"session": data["id"], "pair": symbol, "side": side, "manual_time_ist": ist_text(t.get("placedTime")),
                   "manual_entry": price(t.get("entryPrice"), digits), "manual_stop": price(t.get("initialStop"), digits),
                   "manual_target": price(t.get("takeProfit"), digits), "manual_r": f"{t['resultR']:.2f}" if t.get("resultR") is not None else ""}
            if match is None:
                row.update(kind="manual only", why=why_not(run, t))
            else:
                rules.remove(match)
                stop_off = abs(match["initialStop"] - (t.get("initialStop") or 0)) / pip
                target_off = abs(match["takeProfit"] - (t.get("takeProfit") or 0)) / pip
                kind = "same" if stop_off <= 1 and target_off <= 1 else "different"
                row.update(kind=kind, model=match["answers"]["model"], rules_time_ist=ist_text(match["placedTime"]),
                           rules_entry=price(match["entryPrice"], digits), rules_stop=price(match["initialStop"], digits),
                           rules_target=price(match["takeProfit"], digits), rules_r_after_costs=f"{match['netR']:.2f}",
                           why="" if kind == "same" else f"stop {stop_off:.1f} pips and target {target_off:.1f} pips from yours")
            rows.append(row)
        for r in rules:
            rows.append({"session": data["id"], "pair": symbol, "kind": "rules only", "side": r["side"], "model": r["answers"]["model"],
                         "rules_time_ist": ist_text(r["placedTime"]), "rules_entry": price(r["entryPrice"], digits),
                         "rules_stop": price(r["initialStop"], digits), "rules_target": price(r["takeProfit"], digits),
                         "rules_r_after_costs": f"{r['netR']:.2f}", "why": r["note"]})
    out = Path(config["output"]) / f"compare_{strategy}"
    out.mkdir(parents=True, exist_ok=True)
    with (out / "compare.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    counts = {k: sum(1 for r in rows if r["kind"] == k) for k in ("same", "different", "manual only", "rules only")}
    text = (f"{len(sessions)} sessions: {counts['same']} same, {counts['different']} different, {counts['manual only']} yours only, "
            f"{counts['rules only']} the rules' only. Details in {out / 'compare.csv'}")
    return {"rows": rows, "counts": counts, "text": text, "folder": str(out)}
