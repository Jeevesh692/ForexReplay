"""Save / load replay sessions as human-readable JSON."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .broker import Trade
from .drawings import Drawings

SESSION_VERSION = 1


@dataclass
class SessionState:
    run_id: str
    current: int
    furthest: int
    trades: list[Trade]
    drawings: Drawings


def save_session(path: str | Path, state: SessionState) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": SESSION_VERSION,
        "run_id": state.run_id,
        "current": int(state.current),
        "furthest": int(state.furthest),
        "trades": [t.to_dict() for t in state.trades],
        "drawings": state.drawings.to_list(),
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)  # atomic: a crash never leaves a half-written session


def load_session(path: str | Path) -> SessionState:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("version") != SESSION_VERSION:
        raise ValueError(f"Unsupported session version: {data.get('version')}")
    return SessionState(
        run_id=data["run_id"],
        current=data["current"],
        furthest=data["furthest"],
        trades=[Trade.from_dict(t) for t in data["trades"]],
        drawings=Drawings.from_list(data["drawings"]),
    )
