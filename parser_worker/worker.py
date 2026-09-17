from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parser_worker.providers import OpenRouterClassifier, TelegramNotifier
from parser_worker.security import DpapiSecretStore, redact_text
from parser_worker.service import ParserError, ParserService
from parser_worker.storage import ParserStore, utc_now
from parser_worker.telegram_adapter import TelethonAdapter
from parser_worker.telegram_organizer import TelegramChatOrganizer


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": self.formatTime(record), "level": record.levelname,
            "event": getattr(record, "event_name", "parser.runtime"),
            "message": record.getMessage(),
        }
        return redact_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def configure_logging(data_dir: Path) -> logging.Logger:
    logger = logging.getLogger("jarvis.parser")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    handler = RotatingFileHandler(data_dir / "parser.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    return logger


def emit_json(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def run(data_dir: Path) -> int:
    data_dir.mkdir(parents=True, exist_ok=True)
    logger = configure_logging(data_dir)
    store = ParserStore(data_dir / "parser.db")
    secrets = DpapiSecretStore(data_dir / "secrets.db")
    telegram = TelethonAdapter()
    def emit_event(event: dict[str, Any]) -> None:
        logger.info(json.dumps(event, ensure_ascii=False, separators=(",", ":")), extra={"event_name": event.get("type", "parser.runtime")})
        emit_json({"type": "event", "event": event})

    service = ParserService(
        store=store,
        secrets=secrets,
        telegram=telegram,
        organizer=TelegramChatOrganizer(telegram),
        ai_factory=lambda settings, secret_store: OpenRouterClassifier(settings, secret_store),
        notifier_factory=lambda settings, secret_store: TelegramNotifier(secret_store),
        emit=emit_event,
    )
    service_closed = False
    try:
        await service.initialize()
        logger.info("Parser worker initialized")
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if line == "":
                break
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Rejected malformed JSON request")
                continue
            request_id = str(request.get("id") or "") if isinstance(request, dict) else ""
            method = request.get("method") if isinstance(request, dict) else None
            params = request.get("params") if isinstance(request, dict) else None
            if not request_id or not isinstance(method, str) or (params is not None and not isinstance(params, dict)):
                if request_id:
                    emit_json({
                        "id": request_id,
                        "ok": False,
                        "error": {"code": "INVALID_REQUEST", "message": "Parser request is invalid."},
                    })
                continue
            if method == "shutdown":
                await service.shutdown()
                service_closed = True
                emit_json({"id": request_id, "ok": True, "result": {"stopped": True}})
                break
            try:
                result = await service.dispatch(method, params or {})
                emit_json({"id": request_id, "ok": True, "result": result})
            except ParserError as error:
                logger.warning("Parser command failed: %s", error.code)
                emit_json({
                    "id": request_id,
                    "ok": False,
                    "error": {"code": error.code, "message": str(error)[:240]},
                })
            except Exception as error:
                logger.error("Unhandled Parser command failure: %s", redact_text(type(error).__name__))
                emit_json({
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "PARSER_INTERNAL_ERROR", "message": "Parser could not complete the request."},
                })
    finally:
        if not service_closed:
            await service.shutdown()
        logger.info("Parser worker stopped at %s", utc_now())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="JARVIS Parser isolated worker")
    parser.add_argument("--data-dir", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        return asyncio.run(run(arguments.data_dir.resolve()))
    except Exception as error:
        sys.stderr.write(f"JARVIS Parser worker failed: {redact_text(type(error).__name__)}\n")
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
