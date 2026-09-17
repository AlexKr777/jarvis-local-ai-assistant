from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any, Awaitable, Callable
from uuid import uuid4

from parser_worker.classifier import build_message_url, classify_fast, compute_group_score, detect_language
from parser_worker.providers import ProviderError
from parser_worker.qualification import (
    ContextSegment,
    build_qualification_route,
    default_qualification_settings,
    normalize_for_matching,
)
from parser_worker.storage import ParserStore, utc_now
from parser_worker.telegram_organizer import OrganizationFailure, TelegramChatOrganizer


logger = logging.getLogger("jarvis.parser")

PARSER_STATES = {"SETUP_REQUIRED", "STOPPED", "STARTING", "RUNNING", "PAUSED", "DEGRADED", "ERROR", "STOPPING"}
AI_CLASSES = {"BUYER", "SELLER", "JOB_SEEKER", "HIRING", "DISCUSSION", "SPAM", "UNKNOWN"}
PHONE_PATTERN = re.compile(r"^\+[1-9]\d{6,14}$")
HISTORY_REPLAY_OVERLAP = timedelta(minutes=2)


class ParserError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class FloodWait(Exception):
    def __init__(self, seconds: int):
        super().__init__("Telegram FLOOD_WAIT")
        self.seconds = max(1, int(seconds))


def _mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 6:
        return "••••"
    return f"+{digits[:3]} ••• •• {digits[-2:]}"


def _unique_queries(value: Any) -> list[str]:
    source = value if isinstance(value, list) else re.split(r"[,\r\n]+", str(value or ""))
    seen = set()
    result = []
    for item in source:
        query = re.sub(r"\s+", " ", str(item)).strip()
        key = query.casefold()
        if 2 <= len(query) <= 100 and key not in seen:
            seen.add(key)
            result.append(query)
    if not result or len(result) > 100:
        raise ParserError("INVALID_DISCOVERY_QUERIES", "Enter between 1 and 100 discovery queries.")
    return result


def _utc_timestamp(value: str) -> datetime | None:
    try:
        timestamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return timestamp.replace(tzinfo=UTC) if timestamp.tzinfo is None else timestamp.astimezone(UTC)


def _is_within_history_window(timestamp: str, after: str, before: str) -> bool:
    value = _utc_timestamp(timestamp)
    start = _utc_timestamp(after)
    end = _utc_timestamp(before)
    return bool(value and start and end and start < value <= end)


def _history_replay_start(cursor: str) -> str:
    """Replay a short, receipt-deduplicated window before a completed cursor.

    Telegram message dates have second precision whereas the local cursor has
    microseconds. Replaying this overlap prevents a boundary message from being
    skipped after a restart if it arrived while the previous history request was
    still in flight.
    """
    value = _utc_timestamp(cursor)
    if value is None:
        return cursor
    return (value - HISTORY_REPLAY_OVERLAP).isoformat().replace("+00:00", "Z")


class ParserService:
    def __init__(
        self,
        *,
        store: ParserStore,
        secrets: Any,
        telegram: Any,
        organizer: Any | None = None,
        ai_factory: Callable[[dict[str, Any], Any], Any],
        notifier_factory: Callable[[dict[str, Any], Any], Any],
        emit: Callable[[dict[str, Any]], None] = lambda _: None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self.store = store
        self.secrets = secrets
        self.telegram = telegram
        self.organizer = organizer or TelegramChatOrganizer(telegram)
        self.ai_factory = ai_factory
        self.notifier_factory = notifier_factory
        self.emit = emit
        self.sleep = sleep
        self.state = "SETUP_REQUIRED"
        self.background: dict[str, asyncio.Task] = {}
        self.periodic: list[asyncio.Task] = []
        self.discovery_stop = asyncio.Event()
        self.message_times: deque[float] = deque(maxlen=20_000)
        self.candidate_times: deque[float] = deque(maxlen=10_000)
        self.ai_latencies_ms: deque[float] = deque(maxlen=100)
        self.shutdown_started = False
        self.initialized = False
        if hasattr(self.telegram, "set_disconnect_callback"):
            self.telegram.set_disconnect_callback(self._telegram_connection_lost)

    async def _telegram_connection_lost(self) -> None:
        if self.shutdown_started or self.state in {"STOPPED", "STOPPING", "SETUP_REQUIRED"}:
            return
        self.store.record_monitoring_gap()
        self.state = "DEGRADED"
        self.store.set_runtime_state(self.state, was_running=True)
        self.store.set_account_state("DISCONNECTED", errorCode="CONNECTION_LOST")
        self.store.set_queue_control(paused=True, reason="Telegram disconnected")
        for task in list(self.periodic):
            task.cancel()
        self.periodic.clear()
        self.emit({"type": "parser_state", "state": "DEGRADED", "reason": "telegram_disconnect", "occurredAt": utc_now()})

    async def initialize(self) -> dict[str, Any]:
        if self.initialized:
            return await self.status()
        self.store.initialize()
        self.store.cleanup_retention(self.store.get_settings()["retentionDays"])
        self.initialized = True
        if not getattr(self.telegram, "available", False):
            self.state = "SETUP_REQUIRED"
            self.store.set_runtime_state(self.state, was_running=False)
            return await self.status()

        api_id = self.store.get_settings().get("telegramApiId")
        api_hash = self.secrets.get("telegram_api_hash")
        phone = self.secrets.get("telegram_phone")
        session = self.secrets.get("telegram_session")
        restored = None
        if api_id and api_hash and phone and session:
            self.store.set_account_state("CONNECTING")
            try:
                restored = await self.telegram.restore(api_id=api_id, api_hash=api_hash, phone=phone, session=session)
            except Exception:
                restored = None
        if restored:
            self.store.set_account_state(
                "CONNECTED", phoneMasked=_mask_phone(phone), userId=str(restored.get("userId") or "") or None,
                username=restored.get("username"), displayName=restored.get("displayName"), errorCode=None,
            )
            runtime = self.store.get_runtime_state()
            if self.store.get_settings().get("autoStart") and runtime.get("wasRunning"):
                await self.start()
            else:
                self.state = "STOPPED"
                self.store.set_runtime_state(self.state, was_running=runtime.get("wasRunning", False))
            self._start_organization_reconciliation()
        else:
            if session:
                self.store.set_account_state("SESSION_EXPIRED", phoneMasked=_mask_phone(phone or ""), errorCode="SESSION_EXPIRED")
            else:
                self.store.set_account_state("DISCONNECTED", phoneMasked=_mask_phone(phone) if phone else None, errorCode=None)
            self.state = "SETUP_REQUIRED"
            self.store.set_runtime_state(self.state, was_running=False)
        return await self.status()

    async def status(self) -> dict[str, Any]:
        account = self.store.get_account_state()
        settings = self.store.get_settings()
        metrics = {**self.store.metrics(), **self._runtime_metrics()}
        queue = self.store.list_queue()
        configured = {
            "telegram": account["state"] == "CONNECTED",
            "ai": bool(settings.get("aiEnabled") and settings.get("aiModel") and self.secrets.has("openrouter_key")),
            "notificationBot": bool(self.secrets.has("bot_token") and self.secrets.has("destination_id")),
        }
        return {
            "state": self.state,
            "worker": "RUNNING",
            "telegram": account,
            "connections": configured,
            "metrics": metrics,
            "joinQueue": {"total": len(queue["items"]), "paused": queue["paused"], "reason": queue["reason"], "resumeAt": queue["resumeAt"]},
            "discovery": self.store.get_discovery_run(),
            "settings": self._public_settings(settings),
            "dependencyAvailable": bool(getattr(self.telegram, "available", False)),
            "telegramOrganization": self.store.organization_summary(),
            "historyCatchUp": self.store.get_runtime_state()["historyCatchUp"],
        }

    def _runtime_metrics(self) -> dict[str, int]:
        cutoff = time.monotonic() - 60
        while self.message_times and self.message_times[0] < cutoff:
            self.message_times.popleft()
        while self.candidate_times and self.candidate_times[0] < cutoff:
            self.candidate_times.popleft()
        latency = round(sum(self.ai_latencies_ms) / len(self.ai_latencies_ms)) if self.ai_latencies_ms else 0
        return {
            "messagesPerMinute": len(self.message_times),
            "candidatesPerMinute": len(self.candidate_times),
            "aiLatencyMs": latency,
        }

    def _public_settings(self, settings: dict[str, Any] | None = None) -> dict[str, Any]:
        current = dict(settings or self.store.get_settings())
        current.update({
            "hasTelegramApiHash": self.secrets.has("telegram_api_hash"),
            "hasTelegramSession": self.secrets.has("telegram_session"),
            "hasOpenRouterKey": self.secrets.has("openrouter_key"),
            "hasBotToken": self.secrets.has("bot_token"),
            "hasDestinationId": self.secrets.has("destination_id"),
        })
        return current

    def _notification_status(self, score: int, settings: dict[str, Any]) -> str:
        if not self.secrets.has("bot_token") or not self.secrets.has("destination_id"):
            return "NOT_CONFIGURED"
        if int(score) < 70 and not settings.get("notifyMaybeLeads"):
            return "SKIPPED_MAYBE"
        return "PENDING"

    async def dispatch(self, method: str, params: dict[str, Any] | None = None) -> Any:
        params = params if isinstance(params, dict) else {}
        handlers = {
            "status": lambda: self.status(),
            "settings_get": lambda: self._return(self._public_settings()),
            "settings_save": lambda: self.save_settings(params),
            "telegram_send_code": lambda: self.telegram_send_code(params),
            "telegram_verify": lambda: self.telegram_verify(params),
            "telegram_reconnect": self.telegram_reconnect,
            "telegram_disconnect": self.telegram_disconnect,
            "start": self.start,
            "stop": self.stop,
            "discovery_start": lambda: self.start_discovery(params),
            "discovery_stop": self.stop_discovery,
            "discovery_resume": lambda: self.resume_discovery(params.get("runId")),
            "discovery_status": lambda: self._return(self.store.get_discovery_run(params.get("runId"))),
            "discovery_runs_list": lambda: self._return(self.store.list_discovery_runs(
                limit=int(params.get("limit") or 100), offset=int(params.get("offset") or 0)
            )),
            "groups_list": lambda: self._return(self.store.list_groups(params)),
            "groups_ignore": lambda: self._return(self.store.set_group_status(str(params.get("groupId") or ""), "IGNORED")),
            "queue_add": lambda: self.queue_add(params),
            "queue_list": lambda: self._return(self.store.list_queue()),
            "queue_pause": self.pause_queue,
            "queue_resume": self.resume_queue,
            "queue_remove": lambda: self._return({"removed": self.store.remove_queue_item(str(params.get("itemId") or ""))}),
            "queue_clear_completed": self.clear_completed_queue,
            "monitoring_list": lambda: self._return(self.store.list_monitored()),
            "monitoring_stop": lambda: self.monitoring_set(params, False),
            "monitoring_start": lambda: self.monitoring_set(params, True),
            "leave_group": lambda: self.leave_group(params),
            "leads_list": lambda: self._return(self.store.list_leads(params)),
            "audit_history_list": lambda: self._return(self.store.list_qualification_history(params)),
            "audit_feedback": lambda: self.audit_feedback(params),
            "lead_feedback": lambda: self.lead_feedback(params),
            "ignore_author": lambda: self.ignore_author(params),
            "ignore_chat": lambda: self.ignore_chat(params),
            "ai_test": self.test_ai,
            "notification_test": self.test_notification,
        }
        handler = handlers.get(method)
        if handler is None:
            raise ParserError("UNKNOWN_METHOD", "Unknown Parser command.")
        return await handler()

    @staticmethod
    async def _return(value: Any) -> Any:
        return value

    async def save_settings(self, params: dict[str, Any]) -> dict[str, Any]:
        changes = params.get("settings") if isinstance(params.get("settings"), dict) else {}
        if "telegramApiId" in changes:
            api_id = int(changes["telegramApiId"])
            if api_id <= 0:
                raise ParserError("INVALID_API_ID", "Telegram API ID is invalid.")
            changes["telegramApiId"] = api_id
        settings = self.store.update_settings(changes)
        secret_fields = {
            "openrouterKey": "openrouter_key", "botToken": "bot_token", "destinationId": "destination_id",
            "telegramApiHash": "telegram_api_hash", "phone": "telegram_phone",
        }
        for field, name in secret_fields.items():
            value = params.get(field)
            if value is not None and str(value).strip():
                self.secrets.set(name, str(value).strip())
        self.emit({"type": "settings_saved", "occurredAt": utc_now()})
        return self._public_settings(settings)

    async def telegram_send_code(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            api_id = int(params.get("apiId"))
        except (TypeError, ValueError):
            raise ParserError("INVALID_API_ID", "Telegram API ID is invalid.")
        api_hash = str(params.get("apiHash") or self.secrets.get("telegram_api_hash") or "").strip()
        phone = re.sub(r"[\s()\-]", "", str(params.get("phone") or self.secrets.get("telegram_phone") or ""))
        if api_id <= 0 or not re.fullmatch(r"[a-fA-F0-9]{16,64}", api_hash):
            raise ParserError("INVALID_TELEGRAM_CREDENTIALS", "Check Telegram API ID and API Hash.")
        if not PHONE_PATTERN.fullmatch(phone):
            raise ParserError("INVALID_PHONE", "Use an international phone number starting with +.")
        self.store.update_settings({"telegramApiId": api_id})
        self.secrets.set("telegram_api_hash", api_hash)
        self.secrets.set("telegram_phone", phone)
        self.store.set_account_state("SENDING_CODE", phoneMasked=_mask_phone(phone), errorCode=None)
        try:
            result = await self.telegram.send_code(api_id=api_id, api_hash=api_hash, phone=phone)
        except FloodWait as error:
            until = (datetime.now(UTC) + timedelta(seconds=error.seconds)).isoformat().replace("+00:00", "Z")
            self.store.set_account_state("FLOOD_WAIT", phoneMasked=_mask_phone(phone), floodWaitUntil=until, errorCode="FLOOD_WAIT")
            return await self.status()
        except Exception:
            self.store.set_account_state("ERROR", phoneMasked=_mask_phone(phone), errorCode="SEND_CODE_FAILED")
            raise ParserError("SEND_CODE_FAILED", "Telegram could not send a login code.")
        self.store.set_account_state(result.get("state") or "WAITING_FOR_CODE", phoneMasked=_mask_phone(phone), errorCode=None)
        self.emit({"type": "telegram_login", "state": "WAITING_FOR_CODE", "occurredAt": utc_now()})
        return await self.status()

    async def telegram_reconnect(self) -> dict[str, Any]:
        settings = self.store.get_settings()
        api_id = settings.get("telegramApiId")
        api_hash = self.secrets.get("telegram_api_hash")
        phone = self.secrets.get("telegram_phone")
        session = self.secrets.get("telegram_session")
        if not all((api_id, api_hash, phone, session)):
            raise ParserError("SESSION_UNAVAILABLE", "A saved Telegram session is not available. Send a new code instead.")
        resume_running = bool(self.store.get_runtime_state().get("wasRunning"))
        self.store.set_account_state("CONNECTING", errorCode=None)
        try:
            restored = await self.telegram.restore(api_id=api_id, api_hash=api_hash, phone=phone, session=session)
        except Exception:
            restored = None
        if not restored:
            self.state = "SETUP_REQUIRED"
            self.store.set_account_state("SESSION_EXPIRED", phoneMasked=_mask_phone(phone), errorCode="SESSION_EXPIRED")
            self.store.set_runtime_state(self.state, was_running=False)
            raise ParserError("SESSION_EXPIRED", "The saved Telegram session expired. Send a new login code.")
        self.store.set_account_state(
            "CONNECTED", phoneMasked=_mask_phone(phone), userId=str(restored.get("userId") or "") or None,
            username=restored.get("username"), displayName=restored.get("displayName"), errorCode=None,
        )
        self.state = "STOPPED"
        self.store.set_runtime_state(self.state, was_running=resume_running)
        self.emit({"type": "telegram_connected", "reconnected": True, "occurredAt": utc_now()})
        if resume_running:
            result = await self.start()
        else:
            result = await self.status()
        self._start_organization_reconciliation()
        return result

    async def telegram_verify(self, params: dict[str, Any]) -> dict[str, Any]:
        code = re.sub(r"\s", "", str(params.get("code") or ""))
        password = str(params.get("password") or "")
        if not code and not password:
            raise ParserError("INVALID_CODE", "Enter the Telegram code or 2FA password.")
        self.store.set_account_state("CONNECTING")
        try:
            result = await self.telegram.verify_code(code=code, password=password or None)
        except Exception:
            self.store.set_account_state("ERROR", errorCode="LOGIN_FAILED")
            raise ParserError("LOGIN_FAILED", "Telegram login failed. Check the code and try again.")
        if result.get("state") == "WAITING_FOR_2FA":
            self.store.set_account_state("WAITING_FOR_2FA", errorCode=None)
            return await self.status()
        if result.get("state") != "CONNECTED" or not result.get("session"):
            raise ParserError("LOGIN_FAILED", "Telegram login did not complete.")
        self.secrets.set("telegram_session", result["session"])
        phone = self.secrets.get("telegram_phone") or ""
        self.store.set_account_state(
            "CONNECTED", phoneMasked=_mask_phone(phone), userId=str(result.get("userId") or "") or None,
            username=result.get("username"), displayName=result.get("displayName"), errorCode=None, floodWaitUntil=None,
        )
        self.state = "STOPPED"
        self.store.set_runtime_state(self.state, was_running=False)
        self.emit({"type": "telegram_connected", "occurredAt": utc_now()})
        self._start_organization_reconciliation()
        return await self.status()

    async def telegram_disconnect(self) -> dict[str, Any]:
        await self.stop()
        try:
            await self.telegram.disconnect(revoke=True)
        finally:
            self.secrets.delete("telegram_session")
        phone = self.secrets.get("telegram_phone")
        self.store.set_account_state("DISCONNECTED", phoneMasked=_mask_phone(phone) if phone else None, userId=None, username=None, displayName=None, errorCode=None)
        self.state = "SETUP_REQUIRED"
        self.store.set_runtime_state(self.state, was_running=False)
        self.emit({"type": "telegram_disconnected", "occurredAt": utc_now()})
        return await self.status()

    async def start(self) -> dict[str, Any]:
        if self.store.get_account_state()["state"] != "CONNECTED":
            self.state = "SETUP_REQUIRED"
            return await self.status()
        if self.state == "RUNNING":
            return await self.status()
        self.state = "STARTING"
        self.store.set_runtime_state(self.state, was_running=True)
        try:
            await self.telegram.start_monitoring(self.process_message)
            self.state = "RUNNING"
            self.store.set_runtime_state(self.state, was_running=True)
            catch_up = self.store.begin_history_catch_up(utc_now())
            if catch_up:
                self._start_background("catch_up", self._catch_up_history(catch_up))
            if not self.store.get_queue_control()["paused"]:
                self._start_background("join", self._join_loop())
            elif self.store.get_queue_control().get("resumeAt"):
                self._start_background("queue_resume", self._resume_queue_after_wait(self.store.get_queue_control()["resumeAt"]))
            self._start_periodic_tasks()
            self.emit({"type": "parser_state", "state": "RUNNING", "occurredAt": utc_now()})
        except Exception:
            self.state = "DEGRADED"
            self.store.set_runtime_state(self.state, was_running=True)
            raise ParserError("MONITORING_START_FAILED", "Telegram monitoring could not start.")
        return await self.status()

    async def stop(self) -> dict[str, Any]:
        if not self.initialized:
            return {"state": "STOPPED"}
        if self.state not in {"STOPPED", "SETUP_REQUIRED"}:
            self.store.record_monitoring_gap()
            self.state = "STOPPING"
            self.emit({"type": "parser_state", "state": "STOPPING", "occurredAt": utc_now()})
        self.discovery_stop.set()
        await self.telegram.stop_monitoring()
        discovery_task = self.background.get("discovery")
        if discovery_task and not discovery_task.done():
            await asyncio.gather(discovery_task, return_exceptions=True)
        for task in list(self.periodic):
            task.cancel()
        if self.periodic:
            await asyncio.gather(*self.periodic, return_exceptions=True)
        self.periodic.clear()
        join_task = self.background.get("join")
        if join_task and not join_task.done():
            join_task.cancel()
            await asyncio.gather(join_task, return_exceptions=True)
        catch_up_task = self.background.get("catch_up")
        if catch_up_task and not catch_up_task.done():
            catch_up_task.cancel()
            await asyncio.gather(catch_up_task, return_exceptions=True)
            self.store.interrupt_history_catch_up()
        self.state = "STOPPED" if self.store.get_account_state()["state"] == "CONNECTED" else "SETUP_REQUIRED"
        self.store.set_runtime_state(self.state, was_running=False)
        self.emit({"type": "parser_state", "state": self.state, "occurredAt": utc_now()})
        return await self.status()

    def _start_periodic_tasks(self) -> None:
        if self.periodic:
            return
        self.periodic = [
            asyncio.create_task(self._periodic_ai()),
            asyncio.create_task(self._periodic_notifications()),
            asyncio.create_task(self._periodic_retention()),
        ]

    async def _periodic_ai(self) -> None:
        while self.state == "RUNNING":
            result = await self.process_pending_ai_once()
            # A stale queued item can be rejected locally after a vocabulary
            # upgrade. Drain those cheap rechecks without waiting two seconds
            # each, while yielding so live Telegram callbacks remain responsive.
            if result and result.get("status") in {"NEGATIVE_GATE", "NO_CONTEXT_GATE"}:
                await asyncio.sleep(0)
                continue
            await asyncio.sleep(2)

    async def _periodic_notifications(self) -> None:
        while self.state == "RUNNING":
            await self.process_pending_notification_once()
            await asyncio.sleep(3)

    async def _periodic_retention(self) -> None:
        while self.state == "RUNNING":
            await asyncio.sleep(6 * 60 * 60)
            if self.state == "RUNNING":
                self.store.cleanup_retention(self.store.get_settings()["retentionDays"])

    async def _catch_up_history(self, checkpoint: dict[str, Any]) -> None:
        checkpoint_from_at = str(checkpoint.get("fromAt") or "")
        until_at = str(checkpoint.get("untilAt") or "")
        if not _utc_timestamp(checkpoint_from_at) or not _utc_timestamp(until_at):
            self.store.fail_history_catch_up("INVALID_CHECKPOINT")
            return
        failed = False
        for group in self.store.list_monitored_private_groups():
            saved_cursor = str(group.get("historyCursorAt") or "")
            from_at = (
                _history_replay_start(saved_cursor)
                if _utc_timestamp(saved_cursor)
                else str(group.get("monitoringStartedAt") or checkpoint_from_at)
            )
            if not _utc_timestamp(from_at) or not _is_within_history_window(until_at, from_at, until_at):
                continue
            scanned = 0
            processed = 0
            persisted_scanned = 0
            persisted_processed = 0
            group_completed = True
            if self.state != "RUNNING":
                return
            while self.state == "RUNNING":
                try:
                    async for message in self.telegram.iter_group_messages(group, after=from_at, before=until_at):
                        if self.state != "RUNNING":
                            return
                        if not _is_within_history_window(str(message.get("messageTimestamp") or ""), from_at, until_at):
                            continue
                        scanned += 1
                        result = await self.process_message(message)
                        if result.get("status") != "DUPLICATE":
                            processed += 1
                        if scanned - persisted_scanned >= 25:
                            self.store.record_history_catch_up_progress(
                                scanned=scanned - persisted_scanned,
                                processed=processed - persisted_processed,
                            )
                            persisted_scanned = scanned
                            persisted_processed = processed
                    break
                except FloodWait as error:
                    self.emit({
                        "type": "history_catchup", "state": "FLOOD_WAIT", "seconds": error.seconds,
                        "occurredAt": utc_now(),
                    })
                    await self.sleep(error.seconds)
                except Exception as error:
                    logger.warning(
                        "History catch-up failed for managed group %s: %s",
                        group["id"], type(error).__name__,
                    )
                    failed = True
                    group_completed = False
                    self.store.fail_history_catch_up("HISTORY_READ_FAILED")
                    break
            self.store.record_history_catch_up_progress(
                scanned=scanned - persisted_scanned,
                processed=processed - persisted_processed,
            )
            if group_completed:
                self.store.advance_monitored_history_cursor(group["id"], until_at)
        if self.state != "RUNNING":
            return
        if failed:
            self.emit({"type": "history_catchup", "state": "FAILED", "occurredAt": utc_now()})
            return
        complete = self.store.complete_history_catch_up(checkpoint_from_at)
        self.emit({
            "type": "history_catchup", "state": complete["state"],
            "scanned": complete["scanned"], "processed": complete["processed"], "occurredAt": utc_now(),
        })

    def _start_background(self, name: str, coroutine: Awaitable[Any]) -> asyncio.Task:
        current = self.background.get(name)
        if current and not current.done():
            return current
        task = asyncio.create_task(coroutine)
        self.background[name] = task
        return task

    async def wait_for_background(self, name: str) -> None:
        task = self.background.get(name)
        if task:
            await asyncio.gather(task, return_exceptions=False)

    async def start_discovery(self, params: dict[str, Any]) -> dict[str, Any]:
        if self.store.get_account_state()["state"] != "CONNECTED":
            raise ParserError("TELEGRAM_DISCONNECTED", "Connect the secondary Telegram account first.")
        current = self.background.get("discovery")
        if current and not current.done():
            raise ParserError("DISCOVERY_RUNNING", "Discovery is already running.")
        queries = _unique_queries(params.get("queries"))
        run = self.store.create_discovery_run(queries)
        self.discovery_stop = asyncio.Event()
        self._start_background("discovery", self._discovery_loop(run["id"]))
        return run

    async def _discovery_loop(self, run_id: str) -> None:
        settings = self.store.get_settings()
        groups_found = self.store.get_discovery_run(run_id)["groupsFound"]
        duplicates = self.store.get_discovery_run(run_id)["duplicatesRemoved"]
        errors = self.store.get_discovery_run(run_id)["errors"]
        queries = self.store.list_discovery_queries(run_id, pending_only=True)
        for index, query_row in enumerate(queries):
            if self.discovery_stop.is_set():
                self.store.update_discovery_run(run_id, status="PAUSED")
                return
            query = query_row["query"]
            self.store.update_discovery_query(query_row["id"], "RUNNING")
            self.emit({"type": "discovery_progress", "state": "RUNNING", "query": query, "occurredAt": utc_now()})
            count = 0
            try:
                found = await self.telegram.search_groups(query, settings["discoveryLimitPerQuery"])
                for raw in found:
                    scoring = compute_group_score({
                        "title": raw.get("title"), "username": raw.get("username"), "type": raw.get("type"),
                        "members": raw.get("members"), "language": raw.get("language"),
                    }, query=query)
                    language = raw.get("language") or detect_language(f"{raw.get('title', '')} {query}")
                    group = self.store.upsert_group({
                        **raw, **scoring, "language": language, "topic": raw.get("topic") or query,
                        "discoveredQuery": query,
                    })
                    if self.store.link_group_to_discovery_run(run_id, group["id"], query):
                        groups_found += 1
                    else:
                        duplicates += 1
                    count += 1
                self.store.update_discovery_query(query_row["id"], "COMPLETED", groups_found=count)
            except FloodWait as error:
                errors += 1
                self.store.update_discovery_query(query_row["id"], "FAILED", error_code="FLOOD_WAIT")
                self.store.update_discovery_run(run_id, status="PAUSED", errors=errors, groupsFound=groups_found, duplicatesRemoved=duplicates)
                self.emit({"type": "discovery_progress", "state": "FLOOD_WAIT", "seconds": error.seconds, "occurredAt": utc_now()})
                return
            except Exception:
                errors += 1
                self.store.update_discovery_query(query_row["id"], "FAILED", error_code="SEARCH_FAILED")
            self.store.update_discovery_run(
                run_id, currentIndex=query_row["position"] + 1, groupsFound=groups_found,
                duplicatesRemoved=duplicates, errors=errors,
            )
            if index < len(queries) - 1:
                await self.sleep(settings["discoveryDelayMs"] / 1000)
        completed = self.store.update_discovery_run(run_id, status="COMPLETED", completedAt=utc_now())
        self.emit({
            "type": "discovery_completed", "runId": run_id, "title": completed["title"],
            "groupsFound": groups_found, "occurredAt": utc_now(),
        })

    async def stop_discovery(self) -> dict[str, Any] | None:
        self.discovery_stop.set()
        await self.wait_for_background("discovery")
        return self.store.get_discovery_run()

    async def resume_discovery(self, run_id: str | None) -> dict[str, Any]:
        if self.store.get_account_state()["state"] != "CONNECTED":
            raise ParserError("TELEGRAM_DISCONNECTED", "Connect the secondary Telegram account first.")
        current = self.background.get("discovery")
        if current and not current.done():
            raise ParserError("DISCOVERY_RUNNING", "Discovery is already running.")
        run = self.store.get_discovery_run(run_id)
        if not run or run["status"] not in {"PAUSED", "FAILED"}:
            raise ParserError("DISCOVERY_NOT_RESUMABLE", "There is no paused discovery run to resume.")
        self.store.update_discovery_run(run["id"], status="RUNNING")
        self.discovery_stop = asyncio.Event()
        self._start_background("discovery", self._discovery_loop(run["id"]))
        return self.store.get_discovery_run(run["id"])

    async def queue_add(self, params: dict[str, Any]) -> dict[str, Any]:
        ids = params.get("groupIds")
        if not isinstance(ids, list) or not ids or len(ids) > 200 or any(not isinstance(item, str) for item in ids):
            raise ParserError("INVALID_GROUP_SELECTION", "Select between 1 and 200 discovered groups.")
        result = self.store.add_to_queue(ids)
        self.emit({"type": "queue_updated", "count": result["addedCount"], "occurredAt": utc_now()})
        if self.state == "RUNNING" and not self.store.get_queue_control()["paused"]:
            self._start_background("join", self._join_loop())
        return result

    async def clear_completed_queue(self) -> dict[str, Any]:
        result = self.store.clear_completed_queue()
        self.emit({
            "type": "queue_updated", "cleared": result["cleared"], "occurredAt": utc_now(),
        })
        return result

    async def _join_loop(self) -> None:
        settings = self.store.get_settings()
        items = [item for item in self.store.list_queue()["items"] if item["status"] in {"QUEUED", "RETRYABLE"}]
        for index, item in enumerate(items):
            if self.state != "RUNNING" or self.store.get_queue_control()["paused"]:
                return
            self.store.update_queue_item(item["id"], "JOINING")
            self.emit({"type": "join_progress", "state": "JOINING", "group": item["title"], "occurredAt": utc_now()})
            try:
                private_group = self.store.get_group_private(item["groupId"])
                if private_group is None:
                    raise ParserError("GROUP_NOT_FOUND", "Telegram group was not found.")
                result = await self.telegram.join_group(private_group)
                status = result.get("status") or "JOINED"
                if status in {"JOINED", "ALREADY_JOINED"}:
                    self.store.update_queue_item(item["id"], "JOINED")
                    self.store.set_group_status(item["groupId"], "JOINED")
                    self.store.set_monitored(item["groupId"], True)
                    self.emit({"type": "join_progress", "state": "JOINED", "group": item["title"], "occurredAt": utc_now()})
                    await self._organize_group(private_group)
                else:
                    self.store.update_queue_item(item["id"], status, error_code=status)
            except FloodWait as error:
                resume_at = (datetime.now(UTC) + timedelta(seconds=error.seconds)).isoformat().replace("+00:00", "Z")
                self.store.update_queue_item(item["id"], "FLOOD_WAIT", error_code="FLOOD_WAIT", next_attempt_at=resume_at)
                self.store.set_queue_control(paused=True, reason="Telegram FLOOD_WAIT", resume_at=resume_at)
                self.emit({"type": "join_progress", "state": "FLOOD_WAIT", "group": item["title"], "seconds": error.seconds, "occurredAt": utc_now()})
                self._start_background("queue_resume", self._resume_queue_after_wait(resume_at))
                return
            except Exception as error:
                code = getattr(error, "code", "FAILED")
                allowed = {"PRIVATE", "UNAVAILABLE", "BANNED", "DELETED", "LIMIT_REACHED", "ALREADY_JOINED"}
                self.store.update_queue_item(item["id"], code if code in allowed else "RETRYABLE", error_code=code)
            if index < len(items) - 1:
                await self.sleep(settings["joinDelaySeconds"])

    @staticmethod
    def _organization_error_code(error: OrganizationFailure) -> str:
        if isinstance(error.cause, FloodWait):
            return "FLOOD_WAIT"
        return f"{error.stage}_FAILED"

    async def _organize_group(self, group: dict[str, Any]) -> None:
        self.store.ensure_group_organization(group["id"])
        try:
            result = await self.organizer.organize_joined_group(group)
        except OrganizationFailure as error:
            retry_after = None
            if isinstance(error.cause, FloodWait):
                retry_after = (datetime.now(UTC) + timedelta(seconds=error.cause.seconds)).isoformat().replace("+00:00", "Z")
            self.store.update_group_organization(
                group["id"],
                folder_organized=error.folder_organized,
                archived=error.archived,
                error_code=self._organization_error_code(error),
                retry_after=retry_after,
            )
            if isinstance(error.cause, FloodWait):
                self._schedule_organization_retry(error.cause.seconds)
            return
        except Exception:
            self.store.update_group_organization(
                group["id"], folder_organized=False, archived=False,
                error_code="ORGANIZATION_FAILED", retry_after=None,
            )
            self.store.set_organization_folder_error("ORGANIZATION_FAILED")
            return
        self.store.update_group_organization(
            group["id"], folder_organized=True, archived=True, error_code=None, retry_after=None
        )
        self.store.save_organization_folder(result.folder_id, result.folder_type, "парсер")
        self.emit({
            "type": "telegram_organization", "state": "FOLDER_ADDED",
            "group": group["title"], "folder": "парсер", "occurredAt": utc_now(),
        })
        self.emit({
            "type": "telegram_organization", "state": "ARCHIVED",
            "group": group["title"], "occurredAt": utc_now(),
        })

    async def _reconcile_telegram_organization(self, *, schedule_on_flood: bool = True) -> None:
        groups = self.store.list_managed_joined_groups()
        if not groups:
            return
        for group in groups:
            self.store.ensure_group_organization(group["id"])
        try:
            results = await self.organizer.reconcile_managed_groups(groups)
        except OrganizationFailure as error:
            retry_after = None
            if isinstance(error.cause, FloodWait):
                retry_after = (datetime.now(UTC) + timedelta(seconds=error.cause.seconds)).isoformat().replace("+00:00", "Z")
            code = self._organization_error_code(error)
            for group in groups:
                self.store.update_group_organization(
                    group["id"], folder_organized=error.folder_organized,
                    archived=error.archived, error_code=code, retry_after=retry_after,
                )
            self.store.set_organization_folder_error(code)
            if schedule_on_flood and isinstance(error.cause, FloodWait):
                self._schedule_organization_retry(error.cause.seconds)
            return
        except Exception:
            for group in groups:
                self.store.update_group_organization(
                    group["id"], folder_organized=False, archived=False,
                    error_code="ORGANIZATION_FAILED", retry_after=None,
                )
            self.store.set_organization_folder_error("ORGANIZATION_FAILED")
            return
        group_by_id = {group["id"]: group for group in groups}
        for result in results:
            self.store.update_group_organization(
                result.group_id, folder_organized=True, archived=True,
                error_code=None, retry_after=None,
            )
            self.store.save_organization_folder(result.folder_id, result.folder_type, "парсер")
            group = group_by_id.get(result.group_id)
            if group and result.folder_changed:
                self.emit({
                    "type": "telegram_organization", "state": "FOLDER_ADDED",
                    "group": group["title"], "folder": "парсер", "occurredAt": utc_now(),
                })
            if group and result.archive_changed:
                self.emit({
                    "type": "telegram_organization", "state": "ARCHIVED",
                    "group": group["title"], "occurredAt": utc_now(),
                })

    def _start_organization_reconciliation(self) -> None:
        current = self.background.get("telegram_organization_reconcile")
        if current and not current.done():
            return
        self._start_background(
            "telegram_organization_reconcile",
            self._reconcile_telegram_organization(),
        )

    def _schedule_organization_retry(self, seconds: int) -> None:
        current = self.background.get("telegram_organization_retry")
        if current and not current.done():
            return
        self._start_background(
            "telegram_organization_retry",
            self._retry_telegram_organization(max(1, int(seconds))),
        )

    async def _retry_telegram_organization(self, seconds: int) -> None:
        await self.sleep(seconds)
        if self.shutdown_started or self.store.get_account_state()["state"] != "CONNECTED":
            return
        await self._reconcile_telegram_organization(schedule_on_flood=False)

    async def pause_queue(self) -> dict[str, Any]:
        self.store.set_queue_control(paused=True, reason="Paused by user")
        return self.store.list_queue()

    async def _resume_queue_after_wait(self, resume_at_value: str) -> None:
        resume_at = datetime.fromisoformat(resume_at_value.replace("Z", "+00:00"))
        remaining = max(0.0, (resume_at - datetime.now(UTC)).total_seconds())
        await self.sleep(remaining)
        if self.shutdown_started or self.state != "RUNNING":
            return
        control = self.store.get_queue_control()
        if control.get("resumeAt") != resume_at_value:
            return
        if datetime.now(UTC) < resume_at:
            return
        self.store.set_queue_control(paused=False, reason=None, resume_at=None)
        self.connection_retry_queue_items()
        self._start_background("join", self._join_loop())

    async def resume_queue(self) -> dict[str, Any]:
        control = self.store.get_queue_control()
        if control.get("resumeAt"):
            resume_at = datetime.fromisoformat(control["resumeAt"].replace("Z", "+00:00"))
            if datetime.now(UTC) < resume_at:
                raise ParserError("FLOOD_WAIT_ACTIVE", "Telegram still requires the Join Queue to wait.")
        self.store.set_queue_control(paused=False, reason=None, resume_at=None)
        self.connection_retry_queue_items()
        if self.state == "RUNNING":
            self._start_background("join", self._join_loop())
        return self.store.list_queue()

    def connection_retry_queue_items(self) -> None:
        self.store.connection.execute(
            "UPDATE join_queue_items SET status='QUEUED', error_code=NULL, next_attempt_at=NULL, updated_at=? WHERE status IN ('FLOOD_WAIT','RETRYABLE')",
            (utc_now(),),
        )
        self.store.connection.commit()

    async def monitoring_set(self, params: dict[str, Any], enabled: bool) -> dict[str, Any]:
        group_id = str(params.get("groupId") or "")
        group = self.store.get_group(group_id)
        if not group:
            raise ParserError("GROUP_NOT_FOUND", "Telegram group was not found.")
        if enabled and group["status"] not in {"JOINED", "MONITORING"}:
            raise ParserError("GROUP_NOT_JOINED", "Monitoring can only be enabled for joined groups.")
        self.store.set_monitored(group_id, enabled)
        return self.store.list_monitored()

    async def leave_group(self, params: dict[str, Any]) -> dict[str, Any]:
        group = self.store.get_group_private(str(params.get("groupId") or ""))
        if not group:
            raise ParserError("GROUP_NOT_FOUND", "Telegram group was not found.")
        self.store.set_monitored(group["id"], False)
        await self.telegram.leave_group(group)
        self.store.set_group_status(group["id"], "DISCOVERED")
        return self.store.list_monitored()

    async def process_message(self, message: dict[str, Any]) -> dict[str, Any]:
        if self.state != "RUNNING":
            return {"status": "PARSER_STOPPED"}
        group_id = str(message.get("telegramGroupId") or "")
        author_id = str(message.get("authorId") or "") or None
        text = str(message.get("messageText") or "").strip()
        timestamp = str(message.get("messageTimestamp") or utc_now())
        try:
            message_id = int(message.get("messageId") or 0)
        except (TypeError, ValueError):
            return {"status": "INVALID_MESSAGE"}
        if not self.store.is_monitored_telegram_id(group_id):
            return {"status": "NOT_MONITORED"}
        event_type = str(message.get("eventType") or "CREATE").upper()
        is_edit = event_type == "EDIT" or bool(message.get("editTimestamp"))
        if not is_edit and not self.store.claim_processed_message(group_id, message_id, timestamp):
            return {"status": "DUPLICATE"}
        processing_trace_id = str(uuid4())
        self.message_times.append(time.monotonic())
        self.store.record_monitored_metric(group_id, "message", timestamp)
        settings = self.store.get_settings()
        qualification_settings = default_qualification_settings()
        qualification_settings.update({
            key: settings[key] for key in (
                "maxSignalDistanceChars", "maxContextWindowChars", "sameAuthorContextMessageLimit",
                "sameAuthorContextTimeWindowSeconds",
            ) if key in settings
        })
        qualification_settings["enabledCategories"] = tuple(settings.get("enabledLeadCategories") or ())
        segments = [ContextSegment("CURRENT_MESSAGE", text, "CURRENT_AUTHOR", chat_id=group_id, message_id=message_id, author_id=author_id)]
        reply = message.get("replyTo") if isinstance(message.get("replyTo"), dict) else None
        if reply and str(reply.get("text") or "").strip():
            segments.append(ContextSegment(
                "REPLIED_TO_MESSAGE", str(reply["text"]), "OTHER_AUTHOR",
                chat_id=str(reply.get("chatId") or group_id), message_id=reply.get("messageId"), author_id=reply.get("authorId"),
            ))
        for prior in self.store.same_author_qualification_context(
            account_scope="default", telegram_group_id=group_id, author_id=author_id,
            before_timestamp=timestamp, limit=qualification_settings["sameAuthorContextMessageLimit"],
            window_seconds=qualification_settings["sameAuthorContextTimeWindowSeconds"],
        ):
            segments.append(ContextSegment(
                "SAME_AUTHOR_PREVIOUS_MESSAGE", str(prior["original_text"]), "CURRENT_AUTHOR",
                chat_id=group_id, message_id=prior["message_id"], author_id=author_id,
            ))
        if not text:
            route_gate, route_reason, route_signals = "NO_CONTEXT_GATE", "NO_TEXTUAL_CONTENT", ()
            route_categories, primary_language, languages = (), "UNKNOWN", ()
            vocabulary_version = qualification_settings["vocabularyVersion"]
            configuration_version = qualification_settings["configurationVersion"]
        else:
            route = build_qualification_route(segments, qualification_settings)
            route_gate, route_reason, route_signals = route.gate, route.reason, route.signals
            route_categories, primary_language, languages = route.categories, route.primary_language, route.languages_detected
            vocabulary_version, configuration_version = route.vocabulary_version, route.configuration_version
        audit = self.store.record_qualification_revision({
            "accountScope": "default", "telegramGroupId": group_id, "messageId": message_id,
            "processingTraceId": processing_trace_id,
            "messageTimestamp": timestamp, "receivedTimestamp": utc_now(), "editTimestamp": message.get("editTimestamp"),
            "chatTitle": message.get("groupTitle"), "chatUsername": message.get("groupUsername"),
            "authorId": author_id, "authorUsername": message.get("authorUsername"), "authorName": message.get("authorName"),
            "sourceMessageUrl": build_message_url(message.get("groupUsername"), message_id),
            "contentType": message.get("contentType") or "text", "originalText": text, "normalizedText": normalize_for_matching(text),
            "primaryLanguage": primary_language, "languagesDetected": list(languages),
            "contextSegments": [{"kind": segment.kind, "messageId": segment.message_id, "authorRelation": segment.author_relation} for segment in segments],
            "matchedSignals": [signal.__dict__ for signal in route_signals], "vocabularyVersion": vocabulary_version,
            "configurationVersion": configuration_version, "gate": route_gate, "gateReason": route_reason,
            "aiState": "AI_NOT_REQUIRED", "decisionState": "PENDING",
            "notificationState": "NOT_REQUIRED", "rawContentExpiresAt": (
                datetime.now(UTC) + timedelta(days=int(settings["diagnosticRawRetentionDays"]))
            ).isoformat().replace("+00:00", "Z"),
        })
        if self.store.is_ignored_chat(group_id) or self.store.is_ignored_author(author_id):
            self.store.update_qualification_revision(audit["id"], decision_state="IGNORED")
            return {"id": audit["id"], "status": "IGNORED"}
        fast = classify_fast(
            text,
            intent_phrases=settings["intentPhrases"],
            service_phrases=settings["servicePhrases"],
            negative_phrases=settings["negativePhrases"],
        )
        observed_group = self.store.record_group_observation(group_id, author_id, fast["class"], timestamp)
        if observed_group:
            scoring = compute_group_score(observed_group, query=observed_group.get("discoveredQuery") or "")
            self.store.upsert_group({**observed_group, **scoring})
        if route_gate not in {"STRONG_CONTEXT_GATE", "WEAK_SEMANTIC_GATE"}:
            self.store.update_qualification_revision(audit["id"], decision_state="FINAL")
            self.emit({"type": "parser.gate.negative" if route_gate == "NEGATIVE_GATE" else "parser.gate.no_context",
                       "auditEventId": audit["id"], "processingTraceId": audit["processingTraceId"],
                       "gateReason": route_reason, "occurredAt": utc_now()})
            return {"id": audit["id"], "status": route_gate}
        ai_ready = bool(settings["aiEnabled"] and settings["aiModel"] and self.secrets.has("openrouter_key"))
        status = "AI_PENDING" if ai_ready else "AI_FINAL_FAILED"
        self.store.update_qualification_revision(
            audit["id"], ai_state=status, decision_state="PENDING" if ai_ready else "MANUAL_REVIEW",
        )
        self.candidate_times.append(time.monotonic())
        self.store.record_monitored_metric(group_id, "candidate", timestamp)
        self.emit({"type": "parser.ai.pending" if ai_ready else "parser.ai.final_failed", "auditEventId": audit["id"],
                   "processingTraceId": audit["processingTraceId"], "state": status, "occurredAt": utc_now()})
        return {"id": audit["id"], "status": status, "gate": route_gate, "categories": list(route_categories)}

    async def process_pending_ai_once(self) -> dict[str, Any] | None:
        revision = self.store.next_qualification_ai_revision()
        if revision is None:
            return None
        settings = self.store.get_settings()
        qualification_settings = default_qualification_settings()
        qualification_settings.update({
            key: settings[key] for key in (
                "maxSignalDistanceChars", "maxContextWindowChars", "sameAuthorContextMessageLimit",
                "sameAuthorContextTimeWindowSeconds",
            ) if key in settings
        })
        qualification_settings["enabledCategories"] = tuple(settings.get("enabledLeadCategories") or ())
        if revision.get("vocabularyVersion") != qualification_settings["vocabularyVersion"]:
            route = build_qualification_route([
                ContextSegment(
                    "CURRENT_MESSAGE", revision.get("originalText") or "", "CURRENT_AUTHOR",
                    chat_id=str(revision.get("telegram_group_id") or ""), message_id=revision.get("message_id"),
                    author_id=str(revision.get("author_id") or "") or None,
                )
            ], qualification_settings)
            if route.gate not in {"STRONG_CONTEXT_GATE", "WEAK_SEMANTIC_GATE"}:
                outcome_by_reason = {
                    "CLEAR_UNSAFE_FINANCIAL_EXCHANGE": "UNSAFE",
                    "CLEAR_SPAM": "SPAM",
                    "CLEAR_SELLER_AD": "SELLER_AD",
                    "CLEAR_JOB_SEEKER": "JOB_SEEKER",
                }
                self.store.update_qualification_revision(
                    revision["id"], gate=route.gate, gate_reason=route.reason,
                    matched_signals=[signal.__dict__ for signal in route.signals],
                    vocabulary_version=route.vocabulary_version,
                    configuration_version=route.configuration_version,
                    primary_language=route.primary_language, languages_detected=list(route.languages_detected),
                    ai_state="AI_NOT_REQUIRED", ai_outcome=outcome_by_reason.get(route.reason),
                    ai_result=None, decision_state="FINAL", notification_state="NOT_REQUIRED",
                )
                self.emit({
                    "type": "parser.gate.negative" if route.gate == "NEGATIVE_GATE" else "parser.gate.no_context",
                    "auditEventId": revision["id"], "processingTraceId": revision.get("processingTraceId"),
                    "gateReason": route.reason, "occurredAt": utc_now(),
                })
                return {"id": revision["id"], "status": route.gate}
        ai = self.ai_factory(settings, self.secrets)
        attempt = self.store.begin_qualification_ai_attempt(
            revision["id"], provider="openrouter", model=str(settings.get("aiModel") or ""),
        )
        started_at = time.perf_counter()
        try:
            result = await ai.classify(
                revision.get("originalText") or "", author_name=revision.get("author_name") or "",
                group_title=revision.get("chat_title") or "",
                qualification_context={
                    "normalizedText": revision.get("normalizedText"), "languagesDetected": revision.get("languagesDetected"),
                    "signals": revision.get("matchedSignals"), "contextSegments": revision.get("contextSegments"),
                    "enabledCategories": settings.get("enabledLeadCategories"),
                },
            )
            legacy_outcomes = {
                "BUYER": "CLIENT_LEAD", "HIRING": "HIRING_LEAD", "SELLER": "SELLER_AD",
                "JOB_SEEKER": "JOB_SEEKER", "DISCUSSION": "DISCUSSION", "SPAM": "SPAM", "UNKNOWN": "IRRELEVANT",
            }
            outcome = str(result.get("outcome") or legacy_outcomes.get(str(result.get("class") or "").upper()) or "").upper()
            if outcome not in {"CLIENT_LEAD", "HIRING_LEAD", "MAYBE_LEAD", "SELLER_AD", "JOB_SEEKER", "DISCUSSION", "SPAM", "UNSAFE", "IRRELEVANT"}:
                raise ValueError("invalid classifier outcome")
            confidence = min(1.0, max(0.0, float(result.get("confidence") or 0)))
        except Exception as error:
            attempts = int(attempt["attempt_number"])
            retryable = attempts < 5
            delay = min(3600, 30 * (2 ** min(6, attempts - 1))) * random.uniform(0.85, 1.15)
            next_attempt = (datetime.now(UTC) + timedelta(seconds=delay)).isoformat().replace("+00:00", "Z")
            state = "AI_RETRYABLE_FAILED" if retryable else "AI_FINAL_FAILED"
            self.store.finish_qualification_ai_attempt(
                attempt["id"], state=state, error_code=getattr(error, "code", "AI_PROCESSING_FAILED"),
                retry_after=next_attempt if retryable else None,
            )
            self.store.update_qualification_revision(
                revision["id"], ai_state=state, decision_state="MANUAL_REVIEW",
            )
            self.emit({"type": "parser.ai.retryable_failed" if retryable else "parser.ai.final_failed",
                       "auditEventId": revision["id"], "attemptId": attempt["id"], "occurredAt": utc_now()})
            return {"id": revision["id"], "status": state}
        finally:
            self.ai_latencies_ms.append((time.perf_counter() - started_at) * 1000)
        self.store.finish_qualification_ai_attempt(attempt["id"], state="AI_SUCCEEDED")
        self.store.update_qualification_revision(
            revision["id"], ai_state="AI_SUCCEEDED", ai_outcome=outcome, ai_result=result,
            decision_state="QUALIFIED" if outcome in {"CLIENT_LEAD", "HIRING_LEAD"} else "FINAL",
            notification_state="PENDING" if outcome in {"CLIENT_LEAD", "HIRING_LEAD"} else "NOT_REQUIRED",
        )
        if outcome not in {"CLIENT_LEAD", "HIRING_LEAD"}:
            self.emit({"type": "parser.decision.persisted", "auditEventId": revision["id"], "outcome": outcome, "occurredAt": utc_now()})
            return {"id": revision["id"], "status": outcome}
        fingerprint = f"audit:{revision['account_scope']}:{revision['telegram_group_id']}:{revision['message_id']}"
        existing = self.store.connection.execute(
            "SELECT id, notification_status FROM leads WHERE fingerprint=?", (fingerprint,)
        ).fetchone()
        notification_status = "NOT_CONFIGURED"
        if self.secrets.has("bot_token") and self.secrets.has("destination_id"):
            notification_status = "PENDING" if existing is None else existing["notification_status"]
        lead = self.store.save_lead({
            "telegramGroupId": revision["telegram_group_id"], "groupTitle": revision.get("chat_title"),
            "groupUsername": revision.get("chat_username"), "messageId": revision["message_id"],
            "messageTimestamp": revision["message_timestamp"], "authorId": revision.get("author_id"),
            "authorUsername": revision.get("author_username"), "authorName": revision.get("author_name"),
            "messageText": revision.get("originalText") or "", "language": result.get("primary_language") or result.get("language") or revision.get("primaryLanguage"),
            "aiClass": outcome, "score": round(confidence * 100), "confidence": confidence,
            "reason": str(result.get("reason") or "")[:500],
            "detectedNeed": str(result.get("requested_service") or result.get("requested_role") or result.get("detected_need") or "")[:300],
            "originalMessageUrl": revision.get("source_message_url"), "suggestedReply": "",
            "notificationStatus": notification_status, "fingerprint": fingerprint,
        })
        self.store.record_monitored_metric(revision["telegram_group_id"], "lead", revision["message_timestamp"])
        if existing is None and notification_status == "PENDING":
            self.store.ensure_qualification_notification(revision["messageAuditId"], revision["id"])
        self.emit({"type": "parser.decision.persisted", "auditEventId": revision["id"], "outcome": outcome, "leadId": lead["id"], "occurredAt": utc_now()})
        return lead

    async def process_pending_notification_once(self) -> dict[str, Any] | None:
        attempt = self.store.next_qualification_notification_attempt()
        if not attempt:
            return None
        fingerprint = f"audit:{attempt['account_scope']}:{attempt['telegram_group_id']}:{attempt['message_id']}"
        lead_row = self.store.connection.execute("SELECT id FROM leads WHERE fingerprint=?", (fingerprint,)).fetchone()
        lead = self.store.get_lead(lead_row["id"]) if lead_row else None
        if not lead:
            self.store.update_qualification_notification_attempt(attempt["id"], "FINAL_FAILED", error_code="LEAD_NOT_FOUND")
            return None
        notifier = self.notifier_factory(self.store.get_settings(), self.secrets)
        self.store.update_qualification_notification_attempt(attempt["id"], "SENDING")
        try:
            result = await notifier.send_lead(lead)
            updated = self.store.update_qualification_notification_attempt(
                attempt["id"], "SENT", transport_message_id=(result or {}).get("messageId"),
            )
            self.store.connection.execute("UPDATE leads SET notification_status='SENT', updated_at=? WHERE id=?", (utc_now(), lead["id"]))
            self.store.connection.commit()
            self.emit({"type": "notification_sent", "leadId": lead["id"], "occurredAt": utc_now()})
            return updated
        except Exception as error:
            # sendMessage has no idempotency key. A transport interruption can have
            # been accepted remotely, so retrying blindly would create a duplicate.
            updated = self.store.update_qualification_notification_attempt(
                attempt["id"], "DELIVERY_UNKNOWN", error_code=getattr(error, "code", "DELIVERY_UNKNOWN"),
            )
            self.store.connection.execute("UPDATE leads SET notification_status='DELIVERY_UNKNOWN', updated_at=? WHERE id=?", (utc_now(), lead["id"]))
            self.store.connection.commit()
            self.emit({"type": "parser.notification.final_failed", "leadId": lead["id"], "occurredAt": utc_now()})
            return updated

    async def lead_feedback(self, params: dict[str, Any]) -> dict[str, Any]:
        lead_id = str(params.get("leadId") or "")
        verdict = str(params.get("verdict") or "").upper()
        if verdict not in {"GOOD", "BAD"} or not self.store.get_lead(lead_id):
            raise ParserError("INVALID_FEEDBACK", "Lead feedback is invalid.")
        return self.store.save_feedback(lead_id, verdict, str(params.get("reason") or "")[:120] or None)

    async def audit_feedback(self, params: dict[str, Any]) -> dict[str, Any]:
        revision_id = str(params.get("revisionId") or "")
        verdict = str(params.get("verdict") or "").lower()
        if verdict not in {"correct_lead", "not_a_lead", "maybe_uncertain", "wrong_category"}:
            raise ParserError("INVALID_FEEDBACK", "Audit feedback is invalid.")
        corrected_category = str(params.get("correctedCategory") or "")[:80] or None
        saved = self.store.save_qualification_feedback(
            revision_id, verdict, corrected_category=corrected_category,
            reason=str(params.get("reason") or "")[:120] or None,
        )
        if saved is None:
            raise ParserError("INVALID_FEEDBACK", "Audit revision is unavailable.")
        self.emit({"type": "parser.feedback.recorded", "revisionId": revision_id, "verdict": verdict, "occurredAt": utc_now()})
        return saved

    async def ignore_author(self, params: dict[str, Any]) -> dict[str, Any]:
        author_id = str(params.get("authorId") or "")
        if not author_id:
            raise ParserError("INVALID_AUTHOR", "Lead author is unavailable.")
        self.store.ignore_author(author_id)
        return {"ignored": True, "authorId": author_id}

    async def ignore_chat(self, params: dict[str, Any]) -> dict[str, Any]:
        group_id = str(params.get("telegramGroupId") or "")
        if not group_id:
            raise ParserError("INVALID_CHAT", "Lead chat is unavailable.")
        self.store.ignore_chat(group_id)
        return {"ignored": True, "telegramGroupId": group_id}

    async def test_ai(self) -> dict[str, Any]:
        settings = self.store.get_settings()
        try:
            api_key = self.secrets.get("openrouter_key")
        except Exception:
            raise ParserError(
                "OPENROUTER_CREDENTIALS_UNREADABLE", "Saved OpenRouter credentials could not be read."
            )
        if not api_key:
            raise ParserError(
                "OPENROUTER_API_KEY_NOT_CONFIGURED", "OpenRouter API key is invalid or missing."
            )
        if not settings.get("aiModel"):
            raise ParserError("OPENROUTER_MODEL_NOT_CONFIGURED", "Configure an OpenRouter model first.")
        try:
            return await self.ai_factory(settings, self.secrets).test()
        except ProviderError as error:
            allowed = {
                "OPENROUTER_API_KEY_INVALID", "OPENROUTER_MODEL_NOT_FOUND",
                "OPENROUTER_STRUCTURED_OUTPUT_UNSUPPORTED", "OPENROUTER_CREDITS_REQUIRED",
                "OPENROUTER_RATE_LIMITED",
                "OPENROUTER_PROVIDER_UNAVAILABLE", "OPENROUTER_UNREACHABLE",
                "OPENROUTER_INVALID_CLASSIFICATION", "OPENROUTER_API_KEY_NOT_CONFIGURED",
                "OPENROUTER_MODEL_NOT_CONFIGURED",
            }
            code = error.code if error.code in allowed else "OPENROUTER_TEST_FAILED"
            message = str(error) if error.code in allowed else "OpenRouter could not complete the classifier test."
            raise ParserError(code, message) from error

    async def test_notification(self) -> dict[str, Any]:
        try:
            bot_token = self.secrets.get("bot_token")
            destination_id = self.secrets.get("destination_id")
        except Exception:
            raise ParserError(
                "NOTIFICATION_CREDENTIALS_UNREADABLE", "Saved notification credentials could not be read."
            )
        if not bot_token:
            raise ParserError("BOT_TOKEN_NOT_CONFIGURED", "Bot token is not configured.")
        if not destination_id:
            raise ParserError("DESTINATION_NOT_CONFIGURED", "Destination ID is not configured.")
        try:
            result = await self.notifier_factory(self.store.get_settings(), self.secrets).test()
        except ProviderError as error:
            allowed = {
                "BOT_TOKEN_INVALID", "DESTINATION_NOT_FOUND", "TELEGRAM_API_UNAVAILABLE",
                "TELEGRAM_NOTIFICATION_FAILED", "BOT_TOKEN_NOT_CONFIGURED", "DESTINATION_NOT_CONFIGURED",
            }
            code = error.code if error.code in allowed else "TELEGRAM_NOTIFICATION_FAILED"
            message = str(error) if error.code in allowed else "Telegram notification request failed."
            raise ParserError(code, message) from error
        self.emit({"type": "notification_test", "state": "SENT", "occurredAt": utc_now()})
        return result

    async def shutdown(self) -> None:
        if self.shutdown_started:
            return
        self.shutdown_started = True
        if self.initialized:
            if self.state not in {"STOPPED", "STOPPING", "SETUP_REQUIRED"}:
                self.store.record_monitoring_gap()
            self.discovery_stop.set()
            for task in [*self.background.values(), *self.periodic]:
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(*self.background.values(), *self.periodic, return_exceptions=True)
            try:
                await self.telegram.stop_monitoring()
                await self.telegram.disconnect(revoke=False)
            except Exception:
                pass
            self.store.close()
            self.secrets.close()
