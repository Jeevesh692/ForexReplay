"""Strategies: each folder under strategies/ is one strategy, with its own sessions and journal.

    strategies/<name>/strategy.json      {"label": "Liquidity sweep", "logger": "sweep"}
    strategies/<name>/backtests/*.json   its saved sessions (backtests.py)
    strategies/<name>/trades.csv         its journal
    strategies/<name>/screenshots/       its chart pictures
    strategies/<name>/*.xlsx             its Excel workbook, if you keep one there

`logger` says which automatic log a save writes beside the journal: "none", "nbb"
(docs/plan-nbb-logger.md) or "sweep" (docs/plan-sweep-logger.md). A folder without
strategy.json is still a strategy (an older journal), with no logger.

`checklist` is your own list of questions (Yes/No, a choice, or a number) answered for each
trade in the journal box; a save writes the answers to checklist_log.csv (checklist.py).
The same rules as cleanChecklist in web/js/strategies.js.
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path

from .backtests import NAME, BacktestError, _lock, check_name, list_backtests
from .config import JOURNALS_DIR

LOGGERS = ("none", "nbb", "sweep")
CONFIG = "strategy.json"
MAX_LABEL = 60
KINDS = ("yesno", "choice", "number")
MAX_QUESTIONS, MAX_QUESTION, MAX_OPTIONS, MAX_OPTION = 30, 80, 12, 30
QUESTION_ID = re.compile(r"^[a-z0-9_]{1,40}$")


def slug(label: str) -> str:
    """A folder name for a strategy's label: "Asian sweep (London)" -> "asian_sweep_london"."""
    text = re.sub(r"[^a-z0-9]+", "_", str(label).lower()).strip("_")
    return text[:48].rstrip("_")


def question_id(text: str, taken: list[str]) -> str:
    base = slug(text)[:36].rstrip("_") or "q"
    qid, n = base, 2
    while qid in taken:
        qid, n = f"{base}_{n}", n + 1
    return qid


def clean_checklist(raw) -> list[dict]:
    """A checklist as kept; BacktestError (in plain words) when it cannot be kept."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_QUESTIONS:
        raise BacktestError(f"A checklist is a list of at most {MAX_QUESTIONS} questions.")
    out: list[dict] = []
    for q in raw:
        text = q.get("text", "").strip() if isinstance(q, dict) and isinstance(q.get("text"), str) else ""
        if not text or len(text) > MAX_QUESTION:
            raise BacktestError(f"Each question needs 1 to {MAX_QUESTION} characters.")
        if q.get("kind") not in KINDS:
            raise BacktestError(f'"{text}": unknown answer type.')
        qid = q["id"] if isinstance(q.get("id"), str) and QUESTION_ID.match(q["id"]) else question_id(text, [x["id"] for x in out])
        if any(x["id"] == qid for x in out):
            raise BacktestError(f'Two questions have the same id "{qid}".')
        if any(x["text"] == text for x in out):
            raise BacktestError(f'"{text}" is asked twice.')
        item = {"id": qid, "text": text, "kind": q["kind"]}
        if q["kind"] == "choice":
            options = [str(o).strip() for o in (q.get("options") or []) if str(o).strip()] if isinstance(q.get("options"), list) else []
            if not 2 <= len(options) <= MAX_OPTIONS or any(len(o) > MAX_OPTION for o in options) or len(set(options)) != len(options):
                raise BacktestError(f'"{text}" needs 2 to {MAX_OPTIONS} different choices of up to {MAX_OPTION} characters.')
            item["options"] = options
        out.append(item)
    return out


def read_config(name: str, root: Path = JOURNALS_DIR) -> dict:
    """The strategy's label, logger and checklist; defaults when strategy.json is missing or damaged."""
    config = {"label": name, "logger": "none", "checklist": []}
    path = root / check_name(name, "A strategy name") / CONFIG
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return config
    if isinstance(data, dict):
        if isinstance(data.get("label"), str) and data["label"].strip():
            config["label"] = data["label"].strip()[:MAX_LABEL]
        if data.get("logger") in LOGGERS:
            config["logger"] = data["logger"]
        try:
            config["checklist"] = clean_checklist(data.get("checklist"))
        except BacktestError:
            pass  # a damaged checklist reads as none rather than breaking the list
    return config


def _count_rows(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open(newline="", encoding="utf-8") as f:
        return sum(1 for _ in csv.DictReader(f))


def list_strategies(root: Path = JOURNALS_DIR) -> list[dict]:
    """Every strategy folder, with its sessions, the latest one, its journal size and workbooks."""
    if not root.exists():
        return []
    sessions = list_backtests(root)  # newest save first
    out = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir() and NAME.match(p.name)):
        own = [s for s in sessions if s.get("journal") == folder.name and not s.get("error")]
        if not (own or (folder / CONFIG).exists() or (folder / "trades.csv").exists()):
            continue
        out.append({
            "name": folder.name,
            **read_config(folder.name, root),
            "sessions": len(own),
            "latest": own[0] if own else None,
            "trades": _count_rows(folder / "trades.csv"),
            "workbooks": sorted(p.name for p in folder.glob("*.xlsx") if not p.name.startswith("~$")),
        })
    return sorted(out, key=lambda s: (s["latest"] or {}).get("saved") or "", reverse=True)


def save_strategy(name: str, data: dict, root: Path = JOURNALS_DIR) -> dict:
    """Create a strategy, or change its label, logger or checklist. Its sessions and journal are never touched.
    A request without a checklist keeps the one the strategy has."""
    check_name(name, "A strategy name")
    if not isinstance(data, dict):
        raise BacktestError("A strategy must be a JSON object.")
    label = data.get("label", name)
    if not isinstance(label, str) or not label.strip() or len(label.strip()) > MAX_LABEL:
        raise BacktestError(f"A strategy needs a name of 1 to {MAX_LABEL} characters.")
    logger = data.get("logger", "none")
    if logger not in LOGGERS:
        raise BacktestError(f"Unknown log {logger!r}; choose one of {', '.join(LOGGERS)}.")
    checklist = clean_checklist(data["checklist"]) if "checklist" in data else read_config(name, root)["checklist"]
    config = {"label": label.strip(), "logger": logger, "checklist": checklist}
    folder = root / name
    with _lock:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / (CONFIG + ".tmp")
        tmp.write_text(json.dumps(config, indent=1) + "\n", encoding="utf-8")
        tmp.replace(folder / CONFIG)
    return {"ok": True, "name": name, **config}
