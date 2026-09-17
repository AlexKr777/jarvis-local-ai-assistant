import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from parser_worker.providers import ProviderError
from parser_worker.service import FloodWait, ParserError, ParserService
from parser_worker.storage import ParserStore
from parser_worker.telegram_organizer import OrganizationFailure, OrganizationResult


class MemorySecrets:
    def __init__(self):
        self.values = {}

    def set(self, name, value):
        self.values[name] = value

    def get(self, name):
        return self.values.get(name)

    def has(self, name):
        return name in self.values

    def delete(self, name):
        self.values.pop(name, None)

    def close(self):
        pass


class FakeTelegram:
    available = True

    def __init__(self):
        self.connected = False
        self.monitor_callback = None
        self.join_calls = []
        self.leave_calls = []
        self.search_results = {}
        self.flood_on = None
        self.flood_seconds = 120
        self.flood_once = False
        self.disconnect_callback = None
        self.history_messages = {}
        self.history_started = asyncio.Event()
        self.history_release = asyncio.Event()
        self.history_calls = []

    def set_disconnect_callback(self, callback):
        self.disconnect_callback = callback

    async def restore(self, **credentials):
        if credentials.get("session") == "saved-session":
            self.connected = True
            return {"userId": "100", "username": "radar", "displayName": "Lead Radar"}
        return None

    async def send_code(self, **credentials):
        self.connected = True
        return {"state": "WAITING_FOR_CODE"}

    async def verify_code(self, code, password=None):
        if code == "2fa" and not password:
            return {"state": "WAITING_FOR_2FA"}
        return {
            "state": "CONNECTED", "session": "saved-session", "userId": "100",
            "username": "radar", "displayName": "Lead Radar",
        }

    async def disconnect(self, revoke=False):
        self.connected = False

    async def search_groups(self, query, limit):
        return [dict(group) for group in self.search_results.get(query, [])][:limit]

    async def join_group(self, group):
        self.join_calls.append(group["telegramGroupId"])
        if group["telegramGroupId"] == self.flood_on:
            if self.flood_once:
                self.flood_on = None
            raise FloodWait(self.flood_seconds)
        return {"status": "JOINED"}

    async def leave_group(self, group):
        self.leave_calls.append(group["telegramGroupId"])

    async def start_monitoring(self, callback):
        self.monitor_callback = callback

    async def stop_monitoring(self):
        self.monitor_callback = None

    async def iter_group_messages(self, group, *, after, before):
        self.history_calls.append({"group": group["telegramGroupId"], "after": after, "before": before})
        self.history_started.set()
        await self.history_release.wait()
        for message in self.history_messages.get(group["telegramGroupId"], []):
            yield dict(message)


class FakeAi:
    def __init__(self, result=None, error=None):
        self.result = result or {
            "class": "BUYER", "lead_score": 94, "confidence": 0.96,
            "reason": "Explicit buyer request", "detected_need": "website",
            "language": "en", "suggested_reply": "Hi, I saw your website request.",
        }
        self.error = error
        self.calls = []

    async def classify(self, message, **context):
        self.calls.append(message)
        if self.error:
            raise self.error
        return dict(self.result)

    async def test(self):
        if self.error:
            raise self.error
        return {
            "connected": True, "model": "test/model", "class": "BUYER",
            "schemaValidated": True, "latencyMs": 12,
        }


class FakeNotifier:
    def __init__(self, error=None):
        self.error = error
        self.calls = []
        self.test_calls = 0

    async def send_lead(self, lead):
        self.calls.append(dict(lead))
        if self.error:
            raise self.error
        return {"messageId": 77}

    async def test(self):
        self.test_calls += 1
        if self.error:
            raise self.error
        return {"connected": True, "botUsername": "jarvis_radar_bot"}


class FakeOrganizer:
    def __init__(self):
        self.organize_calls = []
        self.reconcile_calls = []
        self.error = None
        self.inspect_join_state = None
        self.block_reconcile = False
        self.reconcile_started = asyncio.Event()
        self.reconcile_release = asyncio.Event()

    @staticmethod
    def result(group):
        return OrganizationResult(
            group_id=group["id"], folder_organized=True, archived=True,
            folder_id=7, folder_type="DialogFilter", folder_changed=True, archive_changed=True,
        )

    async def organize_joined_group(self, group):
        self.organize_calls.append(group["id"])
        if self.inspect_join_state:
            self.inspect_join_state(group)
        if self.error:
            raise self.error
        return self.result(group)

    async def reconcile_managed_groups(self, groups):
        self.reconcile_calls.append([group["id"] for group in groups])
        self.reconcile_started.set()
        if self.block_reconcile:
            await self.reconcile_release.wait()
        if self.error:
            raise self.error
        return [self.result(group) for group in groups]


class ParserServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = ParserStore(Path(self.directory.name) / "parser.db")
        self.secrets = MemorySecrets()
        self.telegram = FakeTelegram()
        self.ai = FakeAi()
        self.notifier = FakeNotifier()
        self.organizer = FakeOrganizer()
        self.events = []
        self.service = ParserService(
            store=self.store,
            secrets=self.secrets,
            telegram=self.telegram,
            organizer=self.organizer,
            ai_factory=lambda settings, secrets: self.ai,
            notifier_factory=lambda settings, secrets: self.notifier,
            emit=self.events.append,
            sleep=lambda _: asyncio.sleep(0),
        )
        await self.service.initialize()

    async def asyncTearDown(self):
        await self.service.shutdown()
        self.directory.cleanup()

    async def connect(self):
        sent = await self.service.dispatch("telegram_send_code", {
            "apiId": 12345, "apiHash": "abcdef0123456789abcdef0123456789", "phone": "+37360000000",
        })
        self.assertEqual(sent["telegram"]["state"], "WAITING_FOR_CODE")
        connected = await self.service.dispatch("telegram_verify", {"code": "12345", "password": ""})
        self.assertEqual(connected["telegram"]["state"], "CONNECTED")
        return connected

    async def test_notification_connection_test_works_while_parser_stopped_and_ai_disabled(self):
        await self.connect()
        self.secrets.set("bot_token", "test-bot")
        self.secrets.set("destination_id", "100")

        status = await self.service.status()
        result = await self.service.dispatch("notification_test", {})
        final_status = await self.service.status()

        self.assertEqual(status["state"], "STOPPED")
        self.assertEqual(final_status["state"], "STOPPED")
        self.assertFalse(status["settings"]["aiEnabled"])
        self.assertTrue(result["connected"])
        self.assertEqual(self.notifier.test_calls, 1)
        self.assertFalse(any(
            event.get("type") == "parser_state" and event.get("state") == "RUNNING"
            for event in self.events
        ))

    async def test_notification_connection_test_does_not_require_secondary_telegram(self):
        self.secrets.set("bot_token", "test-bot")
        self.secrets.set("destination_id", "100")

        status = await self.service.status()
        result = await self.service.dispatch("notification_test", {})

        self.assertEqual(status["telegram"]["state"], "DISCONNECTED")
        self.assertTrue(result["connected"])
        self.assertEqual(self.notifier.test_calls, 1)

    async def test_notification_connection_test_reports_each_missing_credential(self):
        self.secrets.set("destination_id", "100")
        with self.assertRaises(ParserError) as missing_token:
            await self.service.dispatch("notification_test", {})
        self.assertEqual(missing_token.exception.code, "BOT_TOKEN_NOT_CONFIGURED")
        self.assertEqual(str(missing_token.exception), "Bot token is not configured.")

        self.secrets.set("bot_token", "test-bot")
        self.secrets.delete("destination_id")
        with self.assertRaises(ParserError) as missing_destination:
            await self.service.dispatch("notification_test", {})
        self.assertEqual(missing_destination.exception.code, "DESTINATION_NOT_CONFIGURED")
        self.assertEqual(str(missing_destination.exception), "Destination ID is not configured.")

    async def test_notification_connection_test_reports_unreadable_saved_credentials(self):
        self.secrets.set("bot_token", "test-bot")
        self.secrets.set("destination_id", "100")
        original_get = self.secrets.get

        def unreadable(name):
            if name == "bot_token":
                raise RuntimeError("DPAPI secret payload")
            return original_get(name)

        self.secrets.get = unreadable
        with self.assertRaises(ParserError) as failure:
            await self.service.dispatch("notification_test", {})

        self.assertEqual(failure.exception.code, "NOTIFICATION_CREDENTIALS_UNREADABLE")
        self.assertEqual(str(failure.exception), "Saved notification credentials could not be read.")
        self.assertNotIn("payload", str(failure.exception))

    async def test_ai_connection_test_reports_each_missing_configuration_value(self):
        self.store.update_settings({"aiModel": "test/model"})
        with self.assertRaises(ParserError) as missing_key:
            await self.service.dispatch("ai_test", {})
        self.assertEqual(missing_key.exception.code, "OPENROUTER_API_KEY_NOT_CONFIGURED")
        self.assertEqual(str(missing_key.exception), "OpenRouter API key is invalid or missing.")

        self.secrets.set("openrouter_key", "test-key")
        self.store.update_settings({"aiModel": ""})
        with self.assertRaises(ParserError) as missing_model:
            await self.service.dispatch("ai_test", {})
        self.assertEqual(missing_model.exception.code, "OPENROUTER_MODEL_NOT_CONFIGURED")
        self.assertEqual(str(missing_model.exception), "Configure an OpenRouter model first.")

    async def test_ai_connection_test_reports_unreadable_saved_key_without_diagnostics(self):
        self.store.update_settings({"aiModel": "test/model"})

        def unreadable(name):
            raise RuntimeError("DPAPI openrouter-secret diagnostic")

        self.secrets.get = unreadable
        with self.assertRaises(ParserError) as failure:
            await self.service.dispatch("ai_test", {})

        self.assertEqual(failure.exception.code, "OPENROUTER_CREDENTIALS_UNREADABLE")
        self.assertEqual(str(failure.exception), "Saved OpenRouter credentials could not be read.")
        self.assertNotIn("diagnostic", str(failure.exception))
        self.assertNotIn("openrouter-secret", str(failure.exception))

    async def test_ai_connection_test_preserves_only_allowlisted_provider_errors(self):
        self.store.update_settings({"aiModel": "test/model"})
        self.secrets.set("openrouter_key", "test-key")
        cases = [
            ("OPENROUTER_API_KEY_INVALID", "OpenRouter API key is invalid or missing."),
            ("OPENROUTER_MODEL_NOT_FOUND", "The configured OpenRouter model was not found."),
            ("OPENROUTER_STRUCTURED_OUTPUT_UNSUPPORTED", "The configured model does not support the required structured output."),
            ("OPENROUTER_CREDITS_REQUIRED", "OpenRouter credits are insufficient for this classifier request."),
            ("OPENROUTER_RATE_LIMITED", "OpenRouter rate limit reached. Try again shortly."),
            ("OPENROUTER_PROVIDER_UNAVAILABLE", "The OpenRouter provider is temporarily unavailable."),
            ("OPENROUTER_UNREACHABLE", "OpenRouter could not be reached."),
            ("OPENROUTER_INVALID_CLASSIFICATION", "AI responded, but the classifier output did not match the required schema."),
        ]
        for code, message in cases:
            with self.subTest(code=code):
                self.ai.error = ProviderError(message, code=code)
                with self.assertRaises(ParserError) as failure:
                    await self.service.dispatch("ai_test", {})
                self.assertEqual(failure.exception.code, code)
                self.assertEqual(str(failure.exception), message)

        self.ai.error = ProviderError("raw provider diagnostic openrouter-secret", code="UNKNOWN_PROVIDER_ERROR")
        with self.assertRaises(ParserError) as failure:
            await self.service.dispatch("ai_test", {})
        self.assertEqual(failure.exception.code, "OPENROUTER_TEST_FAILED")
        self.assertEqual(str(failure.exception), "OpenRouter could not complete the classifier test.")
        self.assertNotIn("openrouter-secret", str(failure.exception))

    def monitor(self, telegram_group_id):
        group = self.store.upsert_group({
            "telegramGroupId": telegram_group_id, "title": "Monitored group", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.set_monitored(group["id"], True)
        return group

    async def test_setup_login_masks_secrets_and_restores_session_after_restart(self):
        initial = await self.service.status()
        self.assertEqual(initial["state"], "SETUP_REQUIRED")
        connected = await self.connect()

        serialized = str(connected)
        for secret in ["abcdef0123456789abcdef0123456789", "+37360000000", "saved-session"]:
            self.assertNotIn(secret, serialized)
        self.assertEqual(self.secrets.get("telegram_session"), "saved-session")
        self.assertEqual(self.secrets.get("telegram_api_hash"), "abcdef0123456789abcdef0123456789")
        self.assertEqual(self.secrets.get("telegram_phone"), "+37360000000")

        await self.service.shutdown()
        self.service = ParserService(
            store=ParserStore(Path(self.directory.name) / "parser.db"), secrets=self.secrets,
            telegram=FakeTelegram(), ai_factory=lambda *_: self.ai, notifier_factory=lambda *_: self.notifier,
            emit=self.events.append, sleep=lambda _: asyncio.sleep(0),
        )
        restored = await self.service.initialize()
        self.assertEqual(restored["telegram"]["state"], "CONNECTED")

    async def test_discovery_deduplicates_groups_scores_them_and_persists_progress(self):
        await self.connect()
        shared = {"telegramGroupId": "-1001", "accessHash": "a", "title": "SaaS Founders", "username": "saas_founders",
                  "members": 4200, "type": "supergroup", "language": "en"}
        self.telegram.search_results = {
            "saas founders": [shared, {"telegramGroupId": "-1002", "accessHash": "b", "title": "SaaS News",
                                      "username": "saas_news", "members": 90000, "type": "channel", "language": "en"}],
            "startup founders": [shared],
        }

        run = await self.service.dispatch("discovery_start", {"queries": ["saas founders", "startup founders"]})
        await self.service.wait_for_background("discovery")
        groups = await self.service.dispatch("groups_list", {})
        progress = await self.service.dispatch("discovery_status", {"runId": run["id"]})

        self.assertEqual(len(groups["items"]), 2)
        self.assertEqual(progress["status"], "COMPLETED")
        self.assertEqual(progress["duplicatesRemoved"], 1)
        self.assertGreater(next(group for group in groups["items"] if group["telegramGroupId"] == "-1001")["score"],
                           next(group for group in groups["items"] if group["telegramGroupId"] == "-1002")["score"])

    async def test_discovery_persists_exact_run_membership_and_unique_count(self):
        await self.connect()
        shared = self.store.upsert_group({
            "telegramGroupId": "-100801", "accessHash": "shared", "title": "Existing founders",
            "username": "existing_founders", "members": 5000, "type": "supergroup",
            "language": "en", "score": 75, "confidence": "PRELIMINARY",
        })
        new_group = {
            "telegramGroupId": "-100802", "accessHash": "new", "title": "New founders",
            "username": "new_founders", "members": 3000, "type": "supergroup", "language": "en",
        }
        self.telegram.search_results = {
            "saas founders": [shared, new_group],
            "startup founders": [shared],
        }

        run = await self.service.dispatch(
            "discovery_start", {"queries": ["saas founders", "startup founders"]}
        )
        await self.service.wait_for_background("discovery")
        progress = await self.service.dispatch("discovery_status", {"runId": run["id"]})

        self.assertEqual(run["title"], "Saas founders +1")
        self.assertEqual(progress["groupsFound"], 2)
        self.assertEqual(progress["duplicatesRemoved"], 1)
        self.assertEqual(self.store.count_run_groups(run["id"]), 2)
        listed = await self.service.dispatch("discovery_runs_list", {"limit": 10, "offset": 0})
        self.assertEqual(listed["items"][0]["id"], run["id"])
        self.assertEqual(listed["items"][0]["uniqueGroupCount"], 2)
        completed = next(event for event in self.events if event.get("type") == "discovery_completed")
        self.assertEqual(completed["runId"], run["id"])
        self.assertEqual(completed["title"], "Saas founders +1")
        self.assertEqual(completed["groupsFound"], 2)

    async def test_join_queue_is_sequential_and_flood_wait_pauses_without_retry_loop(self):
        await self.connect()
        self.telegram.search_results = {"founders": [
            {"telegramGroupId": "-1001", "accessHash": "a", "title": "Founders One", "username": "founders_one",
             "members": 2000, "type": "supergroup", "language": "en"},
            {"telegramGroupId": "-1002", "accessHash": "b", "title": "Founders Two", "username": "founders_two",
             "members": 3000, "type": "supergroup", "language": "en"},
        ]}
        await self.service.dispatch("discovery_start", {"queries": ["founders"]})
        await self.service.wait_for_background("discovery")
        groups = sorted((await self.service.dispatch("groups_list", {}))["items"], key=lambda group: group["telegramGroupId"])
        await self.service.dispatch("queue_add", {"groupIds": [group["id"] for group in groups]})
        self.telegram.flood_on = "-1002"

        await self.service.dispatch("start", {})
        await self.service.wait_for_background("join")
        queue = await self.service.dispatch("queue_list", {})

        self.assertEqual(self.telegram.join_calls, ["-1001", "-1002"])
        self.assertEqual([item["status"] for item in queue["items"]], ["JOINED", "FLOOD_WAIT"])
        self.assertTrue(queue["paused"])
        self.assertEqual(queue["reason"], "Telegram FLOOD_WAIT")

    async def test_join_queue_automatically_resumes_after_the_full_flood_wait(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-100200", "title": "Flood retry", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        await self.service.dispatch("queue_add", {"groupIds": [group["id"]]})
        self.telegram.flood_on = "-100200"
        self.telegram.flood_seconds = 1
        self.telegram.flood_once = True
        self.service.sleep = asyncio.sleep

        await self.service.dispatch("start", {})
        await self.service.wait_for_background("join")
        await asyncio.wait_for(self.service.wait_for_background("queue_resume"), timeout=2)

        queue = await self.service.dispatch("queue_list", {})
        self.assertEqual(self.telegram.join_calls, ["-100200", "-100200"])
        self.assertFalse(queue["paused"])
        self.assertEqual(queue["items"][0]["status"], "JOINED")

    async def test_queue_add_reports_only_actual_eligible_rows(self):
        new_group = self.store.upsert_group({
            "telegramGroupId": "-105001", "title": "New", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        joined = self.store.upsert_group({
            "telegramGroupId": "-105002", "title": "Joined", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.set_group_status(joined["id"], "JOINED")

        result = await self.service.dispatch("queue_add", {
            "groupIds": [new_group["id"], joined["id"], new_group["id"]]
        })

        self.assertIn("addedCount", result)
        self.assertEqual(result["addedCount"], 1)
        self.assertEqual(result["addedIds"], [new_group["id"]])
        self.assertEqual(result["skippedIds"], [joined["id"]])
        queue_event = next(event for event in self.events if event.get("type") == "queue_updated")
        self.assertEqual(queue_event["count"], 1)
        self.assertEqual(self.store.get_group(joined["id"])["status"], "JOINED")

    async def test_queue_clear_completed_has_no_telegram_or_monitoring_side_effects(self):
        terminal = self.store.upsert_group({
            "telegramGroupId": "-106001", "title": "Terminal", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        active = self.store.upsert_group({
            "telegramGroupId": "-106002", "title": "Active", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.add_to_queue([terminal["id"], active["id"]])
        by_group = {item["groupId"]: item for item in self.store.list_queue()["items"]}
        self.store.update_queue_item(by_group[terminal["id"]]["id"], "JOINED")
        self.store.set_group_status(terminal["id"], "JOINED")
        self.store.set_monitored(terminal["id"], True)
        self.store.update_group_organization(terminal["id"], folder_organized=True, archived=True)
        before_monitoring = self.store.list_monitored()
        before_organization = self.store.organization_summary()

        self.assertTrue(callable(getattr(self.service, "clear_completed_queue", None)))
        result = await self.service.dispatch("queue_clear_completed", {})

        self.assertEqual(result["cleared"], 1)
        self.assertEqual(
            [(item["id"], item["status"]) for item in result["remaining"]["items"]],
            [(by_group[active["id"]]["id"], "QUEUED")],
        )
        self.assertEqual(self.store.get_group(terminal["id"])["status"], "MONITORING")
        self.assertEqual(self.store.list_monitored(), before_monitoring)
        self.assertEqual(self.store.organization_summary(), before_organization)
        self.assertEqual(self.telegram.join_calls, [])
        self.assertEqual(self.telegram.leave_calls, [])
        self.assertEqual(self.organizer.organize_calls, [])
        self.assertEqual(self.organizer.reconcile_calls, [])

    async def test_successful_join_is_persisted_and_monitored_before_organization(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10071", "accessHash": "private-access-hash",
            "title": "Organized", "username": "organized", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.add_to_queue([group["id"]])

        def inspect_join_state(private_group):
            queue_item = self.store.list_queue()["items"][0]
            self.assertEqual(queue_item["status"], "JOINED")
            self.assertEqual(self.store.get_group(private_group["id"])["status"], "MONITORING")
            self.assertTrue(self.store.is_monitored_telegram_id("-10071"))

        self.organizer.inspect_join_state = inspect_join_state
        await self.service.dispatch("start", {})
        await self.service.wait_for_background("join")

        organization = self.store.ensure_group_organization(group["id"])
        self.assertTrue(organization["folderOrganized"])
        self.assertTrue(organization["archived"])
        self.assertEqual(self.organizer.organize_calls, [group["id"]])

    async def test_organization_failure_never_rolls_back_join_or_monitoring(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10072", "accessHash": "private-access-hash",
            "title": "Retry organization", "username": "retry_org", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.add_to_queue([group["id"]])
        self.organizer.error = OrganizationFailure("FOLDER_MUTATE", RuntimeError("raw telegram detail"))

        await self.service.dispatch("start", {})
        await self.service.wait_for_background("join")

        queue_item = self.store.list_queue()["items"][0]
        organization = self.store.ensure_group_organization(group["id"])
        self.assertEqual(queue_item["status"], "JOINED")
        self.assertEqual(self.store.get_group(group["id"])["status"], "MONITORING")
        self.assertTrue(self.store.is_monitored_telegram_id("-10072"))
        self.assertFalse(organization["folderOrganized"])
        self.assertFalse(organization["archived"])
        self.assertEqual(organization["errorCode"], "FOLDER_MUTATE_FAILED")
        self.assertNotIn("raw telegram detail", str(self.events))

    async def test_unexpected_organization_exception_is_contained_after_join(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10073", "accessHash": "private-access-hash",
            "title": "Unexpected housekeeping", "username": "unexpected_org", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.add_to_queue([group["id"]])
        self.organizer.error = RuntimeError("raw unexpected organization diagnostic")

        await self.service.dispatch("start", {})
        await self.service.wait_for_background("join")

        self.assertEqual(self.store.list_queue()["items"][0]["status"], "JOINED")
        self.assertEqual(self.store.get_group(group["id"])["status"], "MONITORING")
        organization = self.store.ensure_group_organization(group["id"])
        self.assertEqual(organization["errorCode"], "ORGANIZATION_FAILED")
        self.assertNotIn("raw unexpected", str(self.events))

    async def test_failed_join_never_starts_folder_or_archive_housekeeping(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10074", "accessHash": "private-access-hash",
            "title": "Cannot join", "username": "cannot_join", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.add_to_queue([group["id"]])

        async def fail_join(_group):
            raise RuntimeError("join failed")

        self.telegram.join_group = fail_join
        await self.service.dispatch("start", {})
        await self.service.wait_for_background("join")

        self.assertEqual(self.store.list_queue()["items"][0]["status"], "RETRYABLE")
        self.assertEqual(self.organizer.organize_calls, [])
        count = self.store.connection.execute(
            "SELECT COUNT(*) FROM telegram_group_organization WHERE group_id=?", (group["id"],)
        ).fetchone()[0]
        self.assertEqual(count, 0)

    async def test_archive_failure_keeps_folder_success_and_reconciliation_finishes_it(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10075", "accessHash": "private-access-hash",
            "title": "Partial organization", "username": "partial_org", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.add_to_queue([group["id"]])
        self.organizer.error = OrganizationFailure(
            "ARCHIVE_MUTATE", RuntimeError("temporary"), folder_organized=True
        )
        await self.service.dispatch("start", {})
        await self.service.wait_for_background("join")

        partial = self.store.ensure_group_organization(group["id"])
        self.assertTrue(partial["folderOrganized"])
        self.assertFalse(partial["archived"])
        self.assertEqual(self.store.list_queue()["items"][0]["status"], "JOINED")

        self.organizer.error = None
        await self.service._reconcile_telegram_organization()

        completed = self.store.ensure_group_organization(group["id"])
        self.assertTrue(completed["folderOrganized"])
        self.assertTrue(completed["archived"])

    async def test_archived_organization_state_does_not_remove_monitoring_eligibility(self):
        await self.connect()
        await self.service.dispatch("start", {})
        group = self.store.upsert_group({
            "telegramGroupId": "-10076", "title": "Archived monitored", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.set_group_status(group["id"], "JOINED")
        self.store.set_monitored(group["id"], True)
        self.store.update_group_organization(group["id"], folder_organized=True, archived=True)

        result = await self.service.process_message({
            "telegramGroupId": "-10076", "messageId": 1, "authorId": "76",
            "messageText": "Does anyone know someone who can build our website?",
            "messageTimestamp": "2026-08-25T10:00:00Z",
        })

        self.assertNotEqual(result["status"], "NOT_MONITORED")
        monitored = self.store.list_monitored()["items"][0]
        self.assertTrue(monitored["archived"])
        self.assertEqual(monitored["messagesToday"], 1)

    async def test_restored_startup_reconciles_only_parser_managed_groups_while_stopped(self):
        await self.connect()
        managed = self.store.upsert_group({
            "telegramGroupId": "-10081", "accessHash": "managed-hash", "title": "Managed",
            "type": "supergroup", "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.set_group_status(managed["id"], "JOINED")
        self.store.set_monitored(managed["id"], True)
        self.store.upsert_group({
            "telegramGroupId": "-10082", "accessHash": "unrelated-hash", "title": "Unrelated",
            "type": "supergroup", "score": 80, "confidence": "PRELIMINARY",
        })
        await self.service.shutdown()

        self.store = ParserStore(Path(self.directory.name) / "parser.db")
        self.telegram = FakeTelegram()
        self.organizer = FakeOrganizer()
        self.service = ParserService(
            store=self.store, secrets=self.secrets, telegram=self.telegram, organizer=self.organizer,
            ai_factory=lambda *_: self.ai, notifier_factory=lambda *_: self.notifier,
            emit=self.events.append, sleep=lambda _: asyncio.sleep(0),
        )

        status = await self.service.initialize()
        await self.service.wait_for_background("telegram_organization_reconcile")

        self.assertEqual(status["state"], "STOPPED")
        self.assertEqual(self.organizer.reconcile_calls, [[managed["id"]]])
        self.assertTrue(self.store.ensure_group_organization(managed["id"])["archived"])

    async def test_restored_startup_does_not_wait_for_slow_organization_rpc(self):
        await self.connect()
        managed = self.store.upsert_group({
            "telegramGroupId": "-10084", "accessHash": "managed-hash", "title": "Slow housekeeping",
            "type": "supergroup", "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.set_group_status(managed["id"], "JOINED")
        self.store.set_monitored(managed["id"], True)
        await self.service.shutdown()

        self.store = ParserStore(Path(self.directory.name) / "parser.db")
        self.telegram = FakeTelegram()
        self.organizer = FakeOrganizer()
        self.organizer.block_reconcile = True
        self.service = ParserService(
            store=self.store, secrets=self.secrets, telegram=self.telegram, organizer=self.organizer,
            ai_factory=lambda *_: self.ai, notifier_factory=lambda *_: self.notifier,
            emit=self.events.append, sleep=lambda _: asyncio.sleep(0),
        )

        initialize_task = asyncio.create_task(self.service.initialize())
        await self.organizer.reconcile_started.wait()
        completed_before_release = initialize_task.done()
        self.organizer.reconcile_release.set()
        await initialize_task

        self.assertTrue(completed_before_release)

    async def test_reconnect_restores_monitoring_before_slow_organization_rpc_finishes(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10085", "accessHash": "managed-hash", "title": "Reconnect managed",
            "type": "supergroup", "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.set_group_status(group["id"], "JOINED")
        self.store.set_monitored(group["id"], True)
        await self.service.dispatch("start", {})
        await self.telegram.disconnect_callback()
        self.organizer.block_reconcile = True

        reconnect_task = asyncio.create_task(self.service.telegram_reconnect())
        await self.organizer.reconcile_started.wait()
        monitoring_was_active = self.telegram.monitor_callback is not None and self.service.state == "RUNNING"
        reconnect_completed = reconnect_task.done()
        self.organizer.reconcile_release.set()
        await reconnect_task

        self.assertTrue(monitoring_was_active)
        self.assertTrue(reconnect_completed)

    async def test_organization_flood_wait_sleeps_exactly_without_pausing_queue_or_monitoring(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10083", "accessHash": "managed-hash", "title": "Flood managed",
            "type": "supergroup", "score": 80, "confidence": "PRELIMINARY",
        })
        self.store.set_group_status(group["id"], "JOINED")
        self.store.set_monitored(group["id"], True)
        await self.service.dispatch("start", {})
        self.organizer.error = OrganizationFailure("FOLDER_MUTATE", FloodWait(37))
        waits = []

        async def capture_sleep(seconds):
            waits.append(seconds)

        self.service.sleep = capture_sleep
        await self.service._reconcile_telegram_organization()
        await self.service.wait_for_background("telegram_organization_retry")

        organization = self.store.ensure_group_organization(group["id"])
        self.assertEqual(waits, [37])
        self.assertEqual(organization["errorCode"], "FLOOD_WAIT")
        self.assertFalse(self.store.get_queue_control()["paused"])
        self.assertTrue(self.store.is_monitored_telegram_id("-10083"))
        self.assertIsNotNone(self.telegram.monitor_callback)
        self.assertEqual(self.service.state, "RUNNING")

    async def test_seller_is_dropped_buyer_is_saved_before_notification_failure_and_deduplicated(self):
        await self.connect()
        await self.service.dispatch("settings_save", {
            "settings": {"aiEnabled": True, "aiModel": "test/model", "minimumLeadScore": 70},
            "openrouterKey": "openrouter-secret", "botToken": "bot-secret", "destinationId": "1000",
        })
        self.notifier.error = RuntimeError("notification unavailable")
        await self.service.dispatch("start", {})
        self.monitor("-1001")

        seller = {
            "telegramGroupId": "-1001", "groupTitle": "Founders", "groupUsername": "founders",
            "messageId": 1, "messageTimestamp": "2026-08-25T10:00:00Z", "authorId": "9",
            "authorUsername": "seller", "authorName": "Seller", "messageText": "I'm a developer, DM me if you need a website.",
        }
        buyer = {**seller, "messageId": 2, "authorId": "10", "authorUsername": "buyer",
                 "messageText": "Does anyone know someone who can build our website?"}
        self.assertEqual((await self.service.process_message(seller))["status"], "NEGATIVE_GATE")
        candidate = await self.service.process_message(buyer)
        self.assertEqual(candidate["status"], "AI_PENDING")
        await self.service.process_pending_ai_once()
        await self.service.process_pending_notification_once()
        await self.service.process_message(buyer)

        leads = await self.service.dispatch("leads_list", {})
        self.assertEqual(len(leads["items"]), 1)
        self.assertEqual(leads["items"][0]["aiClass"], "CLIENT_LEAD")
        self.assertEqual(leads["items"][0]["notificationStatus"], "DELIVERY_UNKNOWN")

    async def test_no_context_message_is_audited_instead_of_silently_disappearing(self):
        await self.connect()
        self.monitor("-100902")
        await self.service.dispatch("start", {})

        result = await self.service.process_message({
            "telegramGroupId": "-100902", "messageId": 61, "messageText": "Django.",
            "messageTimestamp": "2026-09-01T12:00:00Z", "groupTitle": "Monitored group",
        })
        revisions = self.store.list_qualification_revisions("default", "-100902", 61)

        self.assertEqual(result["status"], "NO_CONTEXT_GATE")
        self.assertEqual(revisions["total"], 1)
        self.assertEqual(revisions["items"][0]["gateReason"], "ISOLATED_TECHNOLOGY")
        self.assertEqual(revisions["items"][0]["originalText"], "Django.")

    async def test_ai_qualification_notifies_client_leads_without_a_legacy_score_gate(self):
        await self.connect()
        await self.service.dispatch("settings_save", {
            "settings": {"aiEnabled": True, "aiModel": "test/model", "minimumLeadScore": 100},
            "openrouterKey": "test-key", "botToken": "test-bot", "destinationId": "1000",
        })
        self.monitor("-100903")
        await self.service.dispatch("start", {})
        self.ai.result = {
            "outcome": "CLIENT_LEAD", "category": "WEBSITES", "requested_service": "website",
            "requested_role": None, "primary_language": "EN", "languages_detected": ["EN"],
            "confidence": 0.51, "reason": "The author asks for a website.",
            "evidence": [{"quote": "Need a website"}], "project_summary": "Website request",
        }

        queued = await self.service.process_message({
            "telegramGroupId": "-100903", "messageId": 62, "authorId": "a1",
            "messageText": "Need a website for our business.", "messageTimestamp": "2026-09-01T12:01:00Z",
        })
        lead = await self.service.process_pending_ai_once()

        self.assertEqual(queued["status"], "AI_PENDING")
        self.assertEqual(lead["ai_class"], "CLIENT_LEAD")
        self.assertEqual(self.store.get_lead(lead["id"])["notificationStatus"], "PENDING")
        self.assertIsNotNone(self.store.next_qualification_notification_attempt())

    async def test_notification_timeout_is_visible_without_blind_duplicate_retry(self):
        await self.connect()
        await self.service.dispatch("settings_save", {
            "settings": {"aiEnabled": True, "aiModel": "test/model"},
            "openrouterKey": "test-key", "botToken": "test-bot", "destinationId": "1000",
        })
        self.monitor("-100904")
        await self.service.dispatch("start", {})
        self.ai.result = {
            "outcome": "CLIENT_LEAD", "category": "WEBSITES", "requested_service": "website", "requested_role": None,
            "primary_language": "EN", "languages_detected": ["EN"], "confidence": 0.9,
            "reason": "Request", "evidence": [{"quote": "Need a website", "segment": "CURRENT_MESSAGE"}],
            "project_summary": "Request",
        }
        self.notifier.error = ProviderError("temporary transport problem", code="TELEGRAM_API_UNAVAILABLE")
        await self.service.process_message({
            "telegramGroupId": "-100904", "messageId": 63, "messageText": "Need a website.",
            "messageTimestamp": "2026-09-01T12:02:00Z",
        })
        lead = await self.service.process_pending_ai_once()
        outcome = await self.service.process_pending_notification_once()

        self.assertEqual(outcome["state"], "DELIVERY_UNKNOWN")
        self.assertEqual(self.store.get_lead(lead["id"])["notificationStatus"], "DELIVERY_UNKNOWN")
        self.assertIsNone(self.store.next_qualification_notification_attempt())

    async def test_same_author_context_is_bounded_and_can_recover_a_split_project_request(self):
        await self.connect()
        self.monitor("-100905")
        await self.service.dispatch("start", {})
        first = await self.service.process_message({
            "telegramGroupId": "-100905", "messageId": 64, "authorId": "same-author",
            "messageText": "Есть проект.", "messageTimestamp": "2026-09-01T12:00:00Z",
        })
        second = await self.service.process_message({
            "telegramGroupId": "-100905", "messageId": 65, "authorId": "same-author",
            "messageText": "Django", "messageTimestamp": "2026-09-01T12:01:00Z",
        })

        self.assertEqual(first["status"], "NO_CONTEXT_GATE")
        self.assertEqual(second["gate"], "WEAK_SEMANTIC_GATE")
        self.assertEqual(second["status"], "AI_FINAL_FAILED")

    async def test_edit_to_lead_notifies_once_and_preserves_all_revisions(self):
        await self.connect()
        await self.service.dispatch("settings_save", {
            "settings": {"aiEnabled": True, "aiModel": "test/model"},
            "openrouterKey": "test-key", "botToken": "test-bot", "destinationId": "1000",
        })
        self.monitor("-100906")
        await self.service.dispatch("start", {})
        self.ai.result = {
            "outcome": "CLIENT_LEAD", "category": "BACKEND", "requested_service": "Django backend", "requested_role": None,
            "primary_language": "EN", "languages_detected": ["EN"], "confidence": 0.9,
            "reason": "Explicit request.", "evidence": [{"quote": "Need a Django developer", "segment": "CURRENT_MESSAGE"}],
            "project_summary": "Backend work",
        }
        first = await self.service.process_message({
            "telegramGroupId": "-100906", "messageId": 66, "messageText": "We have a project; details later.",
            "messageTimestamp": "2026-09-01T12:03:00Z",
        })
        edited = await self.service.process_message({
            "telegramGroupId": "-100906", "messageId": 66, "eventType": "EDIT",
            "editTimestamp": "2026-09-01T12:04:00Z", "messageText": "Need a Django developer for our project.",
            "messageTimestamp": "2026-09-01T12:03:00Z",
        })
        lead = await self.service.process_pending_ai_once()
        await self.service.process_pending_notification_once()
        second_edit = await self.service.process_message({
            "telegramGroupId": "-100906", "messageId": 66, "eventType": "EDIT",
            "editTimestamp": "2026-09-01T12:05:00Z", "messageText": "Need a Django developer, budget $3000.",
            "messageTimestamp": "2026-09-01T12:03:00Z",
        })
        await self.service.process_pending_ai_once()

        self.assertEqual(first["status"], "NO_CONTEXT_GATE")
        self.assertEqual(edited["status"], "AI_PENDING")
        self.assertEqual(second_edit["status"], "AI_PENDING")
        self.assertEqual(self.store.list_qualification_revisions("default", "-100906", 66)["total"], 3)
        self.assertEqual(self.store.list_leads({"minimumScore": 0})["total"], 1)
        self.assertEqual(len(self.notifier.calls), 1)
        self.assertEqual(self.store.get_lead(lead["id"])["notificationStatus"], "SENT")

    async def test_old_pending_ai_record_is_rechecked_before_it_can_send_a_notification(self):
        await self.connect()
        self.monitor("-1009061")
        self.secrets.set("openrouter_key", "test-key")
        self.store.update_settings({"aiEnabled": True, "aiModel": "test/model"})
        await self.service.dispatch("start", {})
        queued = await self.service.process_message({
            "telegramGroupId": "-1009061", "messageId": 71, "authorId": "spam-author",
            "messageText": "Need a website for our business.", "messageTimestamp": "2026-09-01T12:06:00Z",
        })
        self.assertEqual(queued["status"], "AI_PENDING")
        self.store.connection.execute(
            """UPDATE qualification_revisions
               SET original_text=?, normalized_text=?, vocabulary_version='2026-09-01.2'
               WHERE id=?""",
            (
                "We need USDT for INR. Buy USDT. Gaming accounts for PAYIN. "
                "Mixed funds and prepaid USDT. website",
                "we need usdt for inr. buy usdt. gaming accounts for payin. mixed funds and prepaid usdt. website",
                queued["id"],
            ),
        )
        self.store.connection.commit()

        result = await self.service.process_pending_ai_once()

        self.assertEqual(result["status"], "NEGATIVE_GATE")
        self.assertEqual(self.ai.calls, [])
        audit = self.store.list_qualification_history({"group": "-1009061"})["items"][0]
        self.assertEqual(audit["gateReason"], "CLEAR_UNSAFE_FINANCIAL_EXCHANGE")
        self.assertEqual(audit["aiState"], "AI_NOT_REQUIRED")

    async def test_disconnect_preserves_groups_and_leads_but_removes_session(self):
        await self.connect()
        self.store.upsert_group({"telegramGroupId": "-1001", "title": "Kept", "type": "supergroup", "score": 80,
                                 "confidence": "PRELIMINARY", "discoveredQuery": "kept"})
        result = await self.service.dispatch("telegram_disconnect", {})

        self.assertEqual(result["telegram"]["state"], "DISCONNECTED")
        self.assertIsNone(self.secrets.get("telegram_session"))
        self.assertEqual(len(self.store.list_groups()["items"]), 1)

    async def test_legacy_flat_filter_phrases_do_not_override_the_structured_vocabulary(self):
        await self.connect()
        await self.service.dispatch("settings_save", {"settings": {
            "intentPhrases": ["commission now"], "servicePhrases": ["orbital widget"],
            "negativePhrases": ["i sell orbital widgets"],
        }})
        await self.service.dispatch("start", {})
        self.monitor("-1007")
        buyer = await self.service.process_message({
            "telegramGroupId": "-1007", "messageId": 1, "authorId": "7",
            "messageText": "We want to commission now an orbital widget.", "messageTimestamp": "2026-08-25T10:00:00Z",
        })
        seller = await self.service.process_message({
            "telegramGroupId": "-1007", "messageId": 2, "authorId": "8",
            "messageText": "I sell orbital widgets — commission now.", "messageTimestamp": "2026-08-25T10:01:00Z",
        })
        self.assertEqual(buyer["status"], "NO_CONTEXT_GATE")
        self.assertEqual(seller["status"], "NO_CONTEXT_GATE")

        unmonitored = await self.service.process_message({
            "telegramGroupId": "-9999", "messageId": 1, "authorId": "10",
            "messageText": "We want to commission now an orbital widget.", "messageTimestamp": "2026-08-25T10:02:00Z",
        })
        self.assertEqual(unmonitored["status"], "NOT_MONITORED")

    async def test_restart_catches_up_managed_monitoring_history_without_delaying_live_monitoring(self):
        await self.connect()
        self.monitor("-10077")
        await self.service.dispatch("start", {})
        await self.service.dispatch("stop", {})
        gap_started_at = datetime.fromisoformat(
            self.store.get_runtime_state()["historyCatchUp"]["fromAt"].replace("Z", "+00:00")
        )
        self.telegram.history_messages["-10077"] = [
            {"telegramGroupId": "-10077", "messageId": 1, "authorId": "old", "messageText": "We need a website.", "messageTimestamp": (gap_started_at - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")},
            {"telegramGroupId": "-10077", "messageId": 2, "authorId": "live", "messageText": "We need a website.", "messageTimestamp": (gap_started_at + timedelta(microseconds=1)).isoformat().replace("+00:00", "Z")},
            {"telegramGroupId": "-10077", "messageId": 3, "authorId": "catchup", "messageText": "We need a website.", "messageTimestamp": (gap_started_at + timedelta(microseconds=2)).isoformat().replace("+00:00", "Z")},
        ]

        started = await self.service.dispatch("start", {})
        await self.telegram.history_started.wait()
        live = await self.service.process_message(self.telegram.history_messages["-10077"][1])

        self.assertEqual(started["state"], "RUNNING")
        self.assertIsNotNone(self.telegram.monitor_callback)
        self.assertEqual(live["status"], "AI_FINAL_FAILED")
        self.telegram.history_release.set()
        await self.service.wait_for_background("catch_up")

        self.assertEqual(self.telegram.history_calls[0]["group"], "-10077")
        self.assertEqual(self.store.list_qualification_history({"group": "-10077"})["total"], 2)
        self.assertEqual((await self.service.status())["historyCatchUp"]["state"], "COMPLETED")

    async def test_history_catch_up_persists_progress_before_a_group_is_finished(self):
        await self.connect()
        self.monitor("-100771")
        await self.service.dispatch("start", {})
        await self.service.dispatch("stop", {})
        started_at = datetime.fromisoformat(
            self.store.get_runtime_state()["historyCatchUp"]["fromAt"].replace("Z", "+00:00")
        )
        self.telegram.history_messages["-100771"] = [
            {
                "telegramGroupId": "-100771", "messageId": index, "authorId": f"author-{index}",
                "messageText": "unrelated chatter", "messageTimestamp": (
                    started_at + timedelta(microseconds=index)
                ).isoformat().replace("+00:00", "Z"),
            }
            for index in range(1, 27)
        ]
        progress_calls = []
        record_progress = self.store.record_history_catch_up_progress

        def record_progress_capture(**values):
            progress_calls.append(values)
            record_progress(**values)

        self.store.record_history_catch_up_progress = record_progress_capture
        self.telegram.history_release.set()

        await self.service.dispatch("start", {})
        await self.service.wait_for_background("catch_up")

        self.assertEqual(sum(call["scanned"] for call in progress_calls), 26)
        self.assertGreaterEqual(len(progress_calls), 2)

    async def test_start_uses_a_durable_history_cursor_for_each_monitored_group(self):
        await self.connect()
        first = self.monitor("-100781")
        second = self.monitor("-100782")
        self.store.advance_monitored_history_cursor(first["id"], "2026-08-25T10:00:00Z")
        second_start = next(
            item["monitoringStartedAt"]
            for item in self.store.list_monitored()["items"]
            if item["groupId"] == second["id"]
        )
        self.telegram.history_release.set()

        await self.service.dispatch("start", {})
        await self.service.wait_for_background("catch_up")

        requested_after = {call["group"]: call["after"] for call in self.telegram.history_calls}
        self.assertEqual(requested_after["-100781"], "2026-08-25T09:58:00Z")
        self.assertEqual(requested_after["-100782"], second_start)
        cursors = {item["telegramGroupId"]: item["historyCursorAt"] for item in self.store.list_monitored()["items"]}
        self.assertIsNotNone(cursors["-100781"])
        self.assertIsNotNone(cursors["-100782"])

    async def test_history_replays_a_safe_overlap_before_the_saved_cursor(self):
        await self.connect()
        group = self.monitor("-100783")
        self.store.advance_monitored_history_cursor(group["id"], "2026-08-25T10:00:00.500000Z")
        self.telegram.history_messages["-100783"] = [{
            "telegramGroupId": "-100783", "messageId": 91, "authorId": "boundary",
            "messageText": "We need a website.", "messageTimestamp": "2026-08-25T10:00:00Z",
        }]

        await self.service.dispatch("start", {})
        await self.telegram.history_started.wait()
        live = await self.service.process_message(self.telegram.history_messages["-100783"][0])
        self.telegram.history_release.set()
        await self.service.wait_for_background("catch_up")

        self.assertEqual(self.telegram.history_calls[0]["after"], "2026-08-25T09:58:00.500000Z")
        self.assertEqual(live["status"], "AI_FINAL_FAILED")
        self.assertEqual(self.store.list_qualification_history({"group": "-100783"})["total"], 1)

    async def test_unexpected_telegram_disconnect_degrades_parser_and_pauses_queue(self):
        await self.connect()
        await self.service.dispatch("start", {})
        await self.telegram.disconnect_callback()
        status = await self.service.status()
        self.assertEqual(status["state"], "DEGRADED")
        self.assertEqual(status["telegram"]["errorCode"], "CONNECTION_LOST")
        self.assertTrue(status["joinQueue"]["paused"])
        reconnected = await self.service.dispatch("telegram_reconnect", {})
        self.assertEqual(reconnected["state"], "RUNNING")
        self.assertEqual(reconnected["telegram"]["state"], "CONNECTED")
        self.assertTrue(reconnected["joinQueue"]["paused"])

    async def test_monitoring_can_only_be_enabled_for_joined_groups(self):
        await self.connect()
        group = self.store.upsert_group({
            "telegramGroupId": "-10077", "title": "Discovered only", "type": "supergroup",
            "score": 80, "confidence": "PRELIMINARY",
        })

        with self.assertRaisesRegex(ParserError, "joined groups"):
            await self.service.dispatch("monitoring_start", {"groupId": group["id"]})

        self.store.set_group_status(group["id"], "JOINED")
        result = await self.service.dispatch("monitoring_start", {"groupId": group["id"]})
        self.assertTrue(result["items"][0]["enabled"])

    async def test_maybe_lead_is_persisted_but_notification_respects_the_setting(self):
        await self.connect()
        self.secrets.set("openrouter_key", "test-openrouter")
        self.secrets.set("bot_token", "test-bot")
        self.secrets.set("destination_id", "100")
        self.ai.result = {
            "outcome": "MAYBE_LEAD", "category": "WEBSITES", "requested_service": "website", "requested_role": None,
            "primary_language": "EN", "languages_detected": ["EN"], "confidence": 0.6,
            "reason": "Plausible but incomplete request.", "evidence": [{"quote": "website", "segment": "CURRENT_MESSAGE"}],
            "project_summary": None,
        }
        await self.service.dispatch("settings_save", {"settings": {
            "aiEnabled": True, "aiModel": "test/model", "minimumLeadScore": 50,
            "notifyMaybeLeads": False,
        }})
        await self.service.dispatch("start", {})
        self.monitor("-1008")

        first = await self.service.process_message({
            "telegramGroupId": "-1008", "messageId": 1, "authorId": "81",
            "messageText": "We need a developer to build a website.",
            "messageTimestamp": "2026-08-25T10:00:00Z",
        })
        self.assertEqual(first["status"], "AI_PENDING")
        skipped = await self.service.process_pending_ai_once()
        self.assertEqual(skipped["status"], "MAYBE_LEAD")
        self.assertIsNone(self.store.next_qualification_notification_attempt())

        await self.service.dispatch("settings_save", {"settings": {"notifyMaybeLeads": True}})
        await self.service.process_message({
            "telegramGroupId": "-1008", "messageId": 2, "authorId": "82",
            "messageText": "We need a developer to build another website.",
            "messageTimestamp": "2026-08-25T10:01:00Z",
        })
        queued = await self.service.process_pending_ai_once()
        self.assertEqual(queued["status"], "MAYBE_LEAD")
        self.assertIsNone(self.store.next_qualification_notification_attempt())
        metrics = (await self.service.status())["metrics"]
        self.assertEqual(metrics["messagesPerMinute"], 2)
        self.assertEqual(metrics["candidatesPerMinute"], 2)
        self.assertGreaterEqual(metrics["aiLatencyMs"], 0)

    async def test_same_author_distinct_message_identities_are_never_cooldown_suppressed(self):
        await self.connect()
        self.secrets.set("openrouter_key", "test-openrouter")
        await self.service.dispatch("settings_save", {"settings": {
            "aiEnabled": True, "aiModel": "test/model", "authorCooldownHours": 24,
        }})
        await self.service.dispatch("start", {})
        self.monitor("-1009")
        for message_id, text in (
            (1, "We need a developer to build our website."),
            (2, "We also need someone to integrate Stripe into the website."),
        ):
            queued = await self.service.process_message({
                "telegramGroupId": "-1009", "messageId": message_id, "authorId": "same-author",
                "messageText": text, "messageTimestamp": f"2026-08-25T10:0{message_id}:00Z",
            })
            self.assertEqual(queued["status"], "AI_PENDING")

        first = await self.service.process_pending_ai_once()
        second = await self.service.process_pending_ai_once()
        self.assertIsNotNone(first.get("id"))
        self.assertIsNotNone(second.get("id"))
        self.assertEqual(self.store.list_leads({"minimumScore": 0})["total"], 2)


if __name__ == "__main__":
    unittest.main()
