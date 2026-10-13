"""Your own checklist answers for each closed trade, for Excel: strategies/<strategy>/checklist_log.csv.

A strategy's questions live in its strategy.json (strategy_folders.py); you answer them for each trade
in the journal box, and the answers travel with the trade in the saved session (trade["answers"],
by question id). One column per question, headed with the question's text, after the trade itself.

A question you remove or rename later keeps its old column, so earlier sessions' answers are never lost.
"""

from __future__ import annotations

import csv
from pathlib import Path

from .loglib import Candles, replace_file, trade_fields

LOG_FILE = "checklist_log.csv"
BASE_COLUMNS = ["run_id", "trade_id", "date_ny", "weekday", "side", "entry_time_ny", "exit_time_ny", "actual_r",
                "pnl_usd", "tags", "note"]


def answer_text(question: dict, value) -> str:
    """An answer as written: Yes/No, one of the choices, or a number; blank when it does not fit the question."""
    text = "" if value is None else str(value).strip()
    if not text:
        return ""
    if question["kind"] == "yesno":
        return text if text in ("Yes", "No") else ""
    if question["kind"] == "choice":
        return text if text in question.get("options", []) else ""
    try:
        number = float(text)
    except ValueError:
        return ""
    if len(text) > 20 or number != number or number in (float("inf"), float("-inf")):
        return ""
    return str(int(number)) if number.is_integer() else repr(number)  # as JavaScript's String(Number(text))


def write_log(data: dict, folder: Path, questions: list[dict], m5: Candles | None) -> dict:
    """Rewrite this session's rows of checklist_log.csv; other sessions' rows and old question columns are kept."""
    path = Path(folder) / LOG_FILE
    closed = [t for t in data.get("trades") or [] if t.get("status") == "CLOSED" and t.get("entryTime") is not None]
    empty = Candles.from_rows([])
    rows = []
    for t in closed:
        base = trade_fields(t, data, m5 if m5 is not None else empty)
        answers = t.get("answers") if isinstance(t.get("answers"), dict) else {}
        row = {c: base.get(c, "") for c in BASE_COLUMNS}
        row.update({q["text"]: answer_text(q, answers.get(q["id"])) for q in questions})
        rows.append(row)
    old_header, kept = [], []
    if path.exists():
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            old_header = list(reader.fieldnames or [])
            kept = [r for r in reader if r.get("run_id") != data["id"]]
    current = [q["text"] for q in questions]
    columns = BASE_COLUMNS + current + [c for c in old_header if c not in BASE_COLUMNS and c not in current]
    every = sorted(kept + rows, key=lambda r: (r.get("date_ny", ""), r.get("run_id", ""),
                                              int(r["trade_id"]) if str(r.get("trade_id", "")).isdigit() else 0))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for r in every:
            writer.writerow({c: r.get(c, "") for c in columns})
    replace_file(tmp, path)
    return {"trades": len(rows), "questions": len(questions)}

