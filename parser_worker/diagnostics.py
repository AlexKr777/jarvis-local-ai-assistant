r"""Read-only Parser qualification diagnostics.

Examples:
  .venv\Scripts\python.exe -m parser_worker.diagnostics --since 24h
  .venv\Scripts\python.exe -m parser_worker.diagnostics --gate NO_CONTEXT_GATE --potential-missed
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from parser_worker.storage import ParserStore


def _since(value: str) -> str:
    raw = str(value).strip().casefold()
    if raw.endswith("h") and raw[:-1].isdigit():
        return (datetime.now(UTC) - timedelta(hours=int(raw[:-1]))).isoformat().replace("+00:00", "Z")
    if raw.endswith("d") and raw[:-1].isdigit():
        return (datetime.now(UTC) - timedelta(days=int(raw[:-1]))).isoformat().replace("+00:00", "Z")
    parsed = datetime.fromisoformat(raw.replace("z", "+00:00"))
    return (parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)).isoformat().replace("+00:00", "Z")


def format_report(report: object) -> str:
    """Render diagnostics safely in legacy Windows console encodings."""
    return json.dumps(report, ensure_ascii=True, indent=2)


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect Parser qualification audit history.")
    parser.add_argument("--database", default="data/parser/parser.db")
    parser.add_argument("--since", default="24h")
    parser.add_argument("--trace")
    parser.add_argument("--outcome")
    parser.add_argument("--gate")
    parser.add_argument("--group")
    parser.add_argument("--text")
    parser.add_argument("--potential-missed", action="store_true")
    parser.add_argument("--limit", type=int, default=200)
    args = parser.parse_args()
    database = Path(args.database)
    if not database.is_file():
        parser.error(f"Parser database was not found: {database}")
    store = ParserStore(database)
    try:
        filters = {
            "since": _since(args.since), "outcome": args.outcome, "gate": args.gate,
            "group": args.group, "text": args.text, "potentialMissed": args.potential_missed,
            "limit": args.limit,
        }
        if args.trace:
            filters["trace"] = args.trace
        report = store.list_qualification_history(filters)
        summary: dict[str, int] = {}
        for item in report["items"]:
            key = f"{item['gate']}|{item.get('aiOutcome') or item['aiState']}"
            summary[key] = summary.get(key, 0) + 1
        print(format_report({"since": filters["since"], "total": report["total"], "summary": summary, "items": report["items"]}))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
