"""Strategies: each folder under strategies/ is one strategy, with its own sessions and journal.

    strategies/<name>/strategy.json      {"label": "Liquidity sweep", "logger": "sweep"}
    strategies/<name>/backtests/*.json   its saved sessions (backtests.py)
    strategies/<name>/trades.csv         its journal
    strategies/<name>/screenshots/       its chart pictures
    strategies/<name>/*.xlsx             its Excel workbook, if you keep one there

`logger` says which automatic log a save writes beside the journal: "none", "nbb"
(docs/plan-nbb-logger.md) or "sweep" (docs/plan-sweep-logger.md). A folder without
strategy.json is still a strategy (an older journal), with no logger.
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


def slug(label: str) -> str:
    """A folder name for a strategy's label: "Asian sweep (London)" -> "asian_sweep_london"."""
    text = re.sub(r"[^a-z0-9]+", "_", str(label).lower()).strip("_")
    return text[:48].rstrip("_")


def read_config(name: str, root: Path = JOURNALS_DIR) -> dict:
    """The strategy's label and logger; defaults when strategy.json is missing or damaged."""
    config = {"label": name, "logger": "none"}
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
    """Create a strategy, or change its label or logger. Its sessions and journal are never touched."""
    check_name(name, "A strategy name")
    if not isinstance(data, dict):
        raise BacktestError("A strategy must be a JSON object.")
    label = data.get("label", name)
    if not isinstance(label, str) or not label.strip() or len(label.strip()) > MAX_LABEL:
        raise BacktestError(f"A strategy needs a name of 1 to {MAX_LABEL} characters.")
    logger = data.get("logger", "none")
    if logger not in LOGGERS:
        raise BacktestError(f"Unknown log {logger!r}; choose one of {', '.join(LOGGERS)}.")
    config = {"label": label.strip(), "logger": logger}
    folder = root / name
    with _lock:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / (CONFIG + ".tmp")
        tmp.write_text(json.dumps(config, indent=1) + "\n", encoding="utf-8")
        tmp.replace(folder / CONFIG)
    return {"ok": True, "name": name, **config}
