import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from parser_worker import storage as storage_module
from parser_worker.storage import ParserStore


class ParserStoreTests(unittest.TestCase):
    def test_discovery_run_titles_and_relation_schema(self):
        title_for = getattr(storage_module, "discovery_run_title", None)
        self.assertTrue(callable(title_for), "discovery_run_title must be public and callable")
        self.assertEqual(title_for(["saas founders"]), "Saas founders")
        self.assertEqual(title_for(["  saas founders  ", "ecommerce", "agency"]), "Saas founders +2")
        self.assertNotIn("+0", title_for(["founders"]))

        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "parser.db"
            store = ParserStore(database)
            try:
                store.initialize()
                names = {row[0] for row in store.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"
                )}
                run_columns = {row[1] for row in store.connection.execute("PRAGMA table_info(discovery_runs)")}
                self.assertIn("discovery_run_groups", names)
                self.assertIn("idx_discovery_run_groups_group", names)
                self.assertIn("idx_discovery_runs_started", names)
                self.assertIn("title", run_columns)
                self.assertIn("is_legacy", run_columns)
            finally:
                store.close()

    def test_discovery_runs_list_exact_many_to_many_membership(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                self.assertTrue(callable(getattr(store, "link_group_to_discovery_run", None)))
                self.assertTrue(callable(getattr(store, "list_discovery_runs", None)))
                first = store.create_discovery_run(["saas founders"])
                second = store.create_discovery_run(["startup", "ecommerce"])
                group = store.upsert_group({
                    "telegramGroupId": "-100500", "title": "Shared founders",
                    "type": "supergroup", "score": 88, "confidence": "PRELIMINARY",
                })

                self.assertTrue(store.link_group_to_discovery_run(first["id"], group["id"], "saas founders"))
                self.assertFalse(store.link_group_to_discovery_run(first["id"], group["id"], "repeat"))
                self.assertTrue(store.link_group_to_discovery_run(second["id"], group["id"], "startup"))

                result = store.list_discovery_runs()

                self.assertEqual(result["total"], 2)
                self.assertEqual([item["id"] for item in result["items"]], [second["id"], first["id"]])
                self.assertEqual(result["items"][0]["title"], "Startup +1")
                self.assertEqual(result["items"][0]["queryCount"], 2)
                self.assertEqual(result["items"][0]["uniqueGroupCount"], 1)
                self.assertEqual(result["items"][0]["state"], "RUNNING")
                self.assertFalse(result["items"][0]["isLegacy"])
                self.assertEqual(store.count_run_groups(first["id"]), 1)
            finally:
                store.close()

    def test_legacy_discovery_migration_is_truthful_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "parser.db"
            store = ParserStore(database)
            store.initialize()
            old_first = store.create_discovery_run(["first historical query"])
            old_second = store.create_discovery_run(["second historical query"])
            for telegram_id in ("-100701", "-100702", "-100703"):
                store.upsert_group({
                    "telegramGroupId": telegram_id, "title": f"Legacy {telegram_id}",
                    "type": "supergroup", "score": 70, "confidence": "PRELIMINARY",
                })
            store.close()

            migrated = ParserStore(database)
            try:
                migrated.initialize()
                runs = migrated.list_discovery_runs(limit=10)["items"]
                legacy = [run for run in runs if run["isLegacy"]]
                self.assertEqual(len(legacy), 1)
                self.assertEqual(legacy[0]["title"], "Legacy discoveries")
                self.assertEqual(legacy[0]["state"], "COMPLETED")
                self.assertEqual(legacy[0]["uniqueGroupCount"], 3)
                self.assertEqual(migrated.count_run_groups(old_first["id"]), 0)
                self.assertEqual(migrated.count_run_groups(old_second["id"]), 0)
                first_counts = (
                    len(runs),
                    migrated.connection.execute("SELECT COUNT(*) FROM discovery_run_groups").fetchone()[0],
                )
                migrated.initialize()
                second_counts = (
                    migrated.list_discovery_runs(limit=10)["total"],
                    migrated.connection.execute("SELECT COUNT(*) FROM discovery_run_groups").fetchone()[0],
                )
                self.assertEqual(second_counts, first_counts)
            finally:
                migrated.close()

    def test_group_list_filters_selected_run_union_without_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                run_a = store.create_discovery_run(["alpha"])
                run_b = store.create_discovery_run(["beta"])
                run_c = store.create_discovery_run(["gamma"])
                shared = store.upsert_group({
                    "telegramGroupId": "-100901", "title": "Shared", "type": "supergroup",
                    "score": 99, "confidence": "PRELIMINARY",
                })
                only_a = store.upsert_group({
                    "telegramGroupId": "-100902", "title": "Only A", "type": "supergroup",
                    "score": 88, "confidence": "PRELIMINARY",
                })
                only_b = store.upsert_group({
                    "telegramGroupId": "-100903", "title": "Only B", "type": "supergroup",
                    "score": 77, "confidence": "PRELIMINARY",
                })
                unrelated = store.upsert_group({
                    "telegramGroupId": "-100904", "title": "Unrelated", "type": "supergroup",
                    "score": 100, "confidence": "PRELIMINARY",
                })
                for run_id, group, query in [
                    (run_a["id"], shared, "alpha"), (run_b["id"], shared, "beta"),
                    (run_a["id"], only_a, "alpha"), (run_b["id"], only_b, "beta"),
                    (run_c["id"], unrelated, "gamma"),
                ]:
                    store.link_group_to_discovery_run(run_id, group["id"], query)

                result = store.list_groups({"runIds": [run_a["id"], run_b["id"]], "sort": "score"})

                self.assertEqual(result["total"], 3)
                self.assertEqual(
                    [item["telegramGroupId"] for item in result["items"]],
                    ["-100901", "-100902", "-100903"],
                )
                self.assertEqual(result["items"][0]["foundInRuns"], 2)
                self.assertEqual(result["items"][0]["lifecycle"], "NEW")
            finally:
                store.close()

    def test_group_list_status_filter_uses_canonical_global_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                run = store.create_discovery_run(["status"])
                statuses = [
                    ("-101001", "DISCOVERED", "NEW"),
                    ("-101002", "QUEUED", "QUEUED"),
                    ("-101003", "JOINED", "JOINED"),
                    ("-101004", "MONITORING", "MONITORING"),
                ]
                groups = []
                for telegram_id, stored, _ in statuses:
                    group = store.upsert_group({
                        "telegramGroupId": telegram_id, "title": stored, "type": "supergroup",
                        "score": 80, "confidence": "PRELIMINARY", "status": stored,
                    })
                    groups.append(group)
                    store.link_group_to_discovery_run(run["id"], group["id"], "status")

                for _, _, lifecycle in statuses:
                    result = store.list_groups({"runIds": [run["id"]], "status": lifecycle})
                    self.assertEqual(result["total"], 1, lifecycle)
                    self.assertEqual(result["items"][0]["lifecycle"], lifecycle)
                all_groups = store.list_groups({"runIds": [run["id"]], "status": "ALL"})
                self.assertEqual(all_groups["total"], 4)
            finally:
                store.close()

    def test_queue_add_accepts_only_new_groups_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                groups = {}
                for name in ["new", "queued", "joined", "monitoring", "ignored"]:
                    groups[name] = store.upsert_group({
                        "telegramGroupId": f"-1020{len(groups) + 1}", "title": name,
                        "type": "supergroup", "score": 80, "confidence": "PRELIMINARY",
                    })
                store.add_to_queue([groups["queued"]["id"]])
                store.set_group_status(groups["joined"]["id"], "JOINED")
                store.set_group_status(groups["monitoring"]["id"], "JOINED")
                store.set_monitored(groups["monitoring"]["id"], True)
                store.set_group_status(groups["ignored"]["id"], "IGNORED")

                result = store.add_to_queue([
                    groups["new"]["id"], groups["new"]["id"], groups["queued"]["id"],
                    groups["joined"]["id"], groups["monitoring"]["id"],
                    groups["ignored"]["id"], "missing-group",
                ])

                self.assertIsInstance(result, dict)
                self.assertEqual(result["addedIds"], [groups["new"]["id"]])
                self.assertEqual(result["addedCount"], 1)
                self.assertEqual(set(result["skippedIds"]), {
                    groups["queued"]["id"], groups["joined"]["id"],
                    groups["monitoring"]["id"], groups["ignored"]["id"], "missing-group",
                })
                self.assertEqual(store.get_group(groups["new"]["id"])["status"], "QUEUED")
                self.assertEqual(store.get_group(groups["queued"]["id"])["status"], "QUEUED")
                self.assertEqual(store.get_group(groups["joined"]["id"])["status"], "JOINED")
                self.assertEqual(store.get_group(groups["monitoring"]["id"])["status"], "MONITORING")
                self.assertEqual(store.get_group(groups["ignored"]["id"])["status"], "IGNORED")
            finally:
                store.close()

    def test_clear_completed_queue_preserves_active_and_every_non_queue_domain(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                run = store.create_discovery_run(["queue safety"])
                terminal_states = ["JOINED", "PRIVATE", "UNAVAILABLE", "BANNED", "DELETED", "LIMIT_REACHED"]
                active_states = ["QUEUED", "JOINING", "WAITING", "RETRYABLE", "FLOOD_WAIT"]
                queue_ids = {}
                for index, state in enumerate(terminal_states + active_states, start=1):
                    group = store.upsert_group({
                        "telegramGroupId": f"-103{index:03d}", "title": state,
                        "type": "supergroup", "score": 80, "confidence": "PRELIMINARY",
                    })
                    store.link_group_to_discovery_run(run["id"], group["id"], "queue safety")
                    store.add_to_queue([group["id"]])
                    item = next(item for item in store.list_queue()["items"] if item["groupId"] == group["id"])
                    store.update_queue_item(item["id"], state)
                    queue_ids[state] = item["id"]
                    if state == "JOINED":
                        store.set_group_status(group["id"], "JOINED")
                        store.set_monitored(group["id"], True)
                        store.update_group_organization(group["id"], folder_organized=True, archived=True)

                candidate = store.save_candidate({
                    "telegramGroupId": "-103001", "messageId": 44, "messageText": "Need a site",
                    "messageTimestamp": "2026-08-25T10:00:00Z", "fingerprint": "queue-safety-candidate",
                    "status": "QUALIFIED",
                })
                lead = store.save_lead({
                    "candidateId": candidate["id"], "telegramGroupId": "-103001", "messageId": 44,
                    "messageTimestamp": "2026-08-25T10:00:00Z", "messageText": "Need a site",
                    "aiClass": "BUYER", "score": 90, "confidence": 0.9,
                    "fingerprint": "queue-safety-lead",
                })
                store.ensure_notification_attempt(lead["id"])

                protected_tables = [
                    "telegram_groups", "monitored_groups", "telegram_group_organization",
                    "discovery_runs", "discovery_queries", "discovery_run_groups",
                    "message_candidates", "leads", "notification_attempts",
                ]
                before = {
                    table: [tuple(row) for row in store.connection.execute(
                        f"SELECT * FROM {table} ORDER BY rowid"
                    ).fetchall()]
                    for table in protected_tables
                }

                self.assertTrue(callable(getattr(store, "clear_completed_queue", None)))
                result = store.clear_completed_queue()

                self.assertEqual(result["cleared"], len(terminal_states))
                remaining = {item["status"]: item["id"] for item in store.list_queue()["items"]}
                self.assertEqual(remaining, {state: queue_ids[state] for state in active_states})
                after = {
                    table: [tuple(row) for row in store.connection.execute(
                        f"SELECT * FROM {table} ORDER BY rowid"
                    ).fetchall()]
                    for table in protected_tables
                }
                self.assertEqual(after, before)
            finally:
                store.close()

    def test_per_row_queue_remove_rejects_terminal_history(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                terminal = store.upsert_group({
                    "telegramGroupId": "-104001", "title": "Joined", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                active = store.upsert_group({
                    "telegramGroupId": "-104002", "title": "Queued", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                store.add_to_queue([terminal["id"], active["id"]])
                by_group = {item["groupId"]: item for item in store.list_queue()["items"]}
                store.update_queue_item(by_group[terminal["id"]]["id"], "JOINED")
                store.set_group_status(terminal["id"], "MONITORING")

                self.assertFalse(store.remove_queue_item(by_group[terminal["id"]]["id"]))
                self.assertEqual(store.get_group(terminal["id"])["status"], "MONITORING")
                self.assertTrue(store.remove_queue_item(by_group[active["id"]]["id"]))
                self.assertEqual(store.get_group(active["id"])["status"], "DISCOVERED")
            finally:
                store.close()

    def test_initialize_repairs_legacy_canonical_status_from_joined_queue_and_monitoring(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "parser.db"
            store = ParserStore(database)
            store.initialize()
            monitored = store.upsert_group({
                "telegramGroupId": "-108001", "title": "Monitored legacy", "type": "supergroup",
                "score": 80, "confidence": "PRELIMINARY",
            })
            joined = store.upsert_group({
                "telegramGroupId": "-108002", "title": "Joined legacy", "type": "supergroup",
                "score": 80, "confidence": "PRELIMINARY",
            })
            store.add_to_queue([monitored["id"], joined["id"]])
            by_group = {item["groupId"]: item for item in store.list_queue()["items"]}
            for group in (monitored, joined):
                store.update_queue_item(by_group[group["id"]]["id"], "JOINED")
            store.set_group_status(monitored["id"], "JOINED")
            store.set_monitored(monitored["id"], True)
            store.set_group_status(monitored["id"], "QUEUED")
            store.set_group_status(joined["id"], "QUEUED")
            before_queue = [(item["id"], item["status"]) for item in store.list_queue()["items"]]
            store.close()

            repaired = ParserStore(database)
            try:
                repaired.initialize()
                self.assertEqual(repaired.get_group(monitored["id"])["status"], "MONITORING")
                self.assertEqual(repaired.get_group(joined["id"])["status"], "JOINED")
                self.assertEqual(
                    [(item["id"], item["status"]) for item in repaired.list_queue()["items"]],
                    before_queue,
                )
                self.assertTrue(repaired.list_monitored()["items"][0]["enabled"])
            finally:
                repaired.close()

    def test_initializes_required_entities_indexes_and_safe_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "parser.db"
            store = ParserStore(database)
            store.initialize()

            inspection = sqlite3.connect(database)
            try:
                names = {row[0] for row in inspection.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"
                )}
            finally:
                inspection.close()
            for name in [
                "parser_settings", "telegram_account_state", "discovery_runs", "discovery_queries",
                "telegram_groups", "join_queue_items", "monitored_groups", "message_candidates",
                "leads", "ignored_authors", "ignored_chats", "lead_feedback", "notification_attempts",
                "idx_groups_telegram_id", "idx_candidates_message", "idx_leads_score", "idx_queue_status",
            ]:
                self.assertIn(name, names)

            settings = store.get_settings()
            self.assertFalse(settings["aiEnabled"])
            self.assertEqual(settings["minimumLeadScore"], 70)
            self.assertEqual(settings["authorCooldownHours"], 24)
            self.assertFalse(settings["autoStart"])
            self.assertGreater(len(settings["intentPhrases"]), 10)
            self.assertGreater(len(settings["servicePhrases"]), 10)
            store.close()

    def test_filter_settings_are_normalized_and_retention_deletes_only_unqualified_old_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                settings = store.update_settings({
                    "intentPhrases": [" custom intent ", "CUSTOM INTENT", ""],
                    "servicePhrases": ["custom service"], "negativePhrases": ["custom seller"],
                })
                self.assertEqual(settings["intentPhrases"], ["custom intent"])
                candidate = store.save_candidate({
                    "telegramGroupId": "-1", "messageId": 1, "messageText": "old candidate", "messageTimestamp": "2020-01-01T00:00:00Z",
                    "fingerprint": "old-fingerprint", "status": "UNCLASSIFIED",
                })
                store.connection.execute("UPDATE message_candidates SET created_at='2020-01-01T00:00:00Z' WHERE id=?", (candidate["id"],))
                store.connection.commit()
                self.assertEqual(store.cleanup_retention(30), 1)
                self.assertIsNone(store.find_candidate("old-fingerprint"))
            finally:
                store.close()

    def test_group_observations_update_score_inputs_without_storing_message_text(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                group = store.upsert_group({
                    "telegramGroupId": "-10088", "title": "Founders", "type": "supergroup",
                    "score": 40, "confidence": "PRELIMINARY",
                })
                observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
                store.record_group_observation("-10088", "author-secret-id", "SELLER", observed_at)
                observed = store.get_group(group["id"])
                self.assertEqual(observed["confidence"], "OBSERVED")
                self.assertEqual(observed["uniqueAuthors"], 1)
                self.assertEqual(observed["sellerRatio"], 1.0)
                database_bytes = (Path(directory) / "parser.db").read_bytes()
                self.assertNotIn(b"author-secret-id", database_bytes)
            finally:
                store.close()

    def test_settings_update_is_allowlisted_and_never_accepts_secret_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            store.initialize()
            updated = store.update_settings({"minimumLeadScore": 82, "aiEnabled": True, "botToken": "bad"})

            self.assertEqual(updated["minimumLeadScore"], 82)
            self.assertTrue(updated["aiEnabled"])
            self.assertNotIn("botToken", updated)
            self.assertNotIn(b"bad", (Path(directory) / "parser.db").read_bytes())
            store.close()

    def test_candidate_and_lead_dedup_are_persistent_and_notification_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            store.initialize()
            candidate = {
                "telegramGroupId": "-1001", "messageId": 7, "authorId": "9", "messageText": "Need a website",
                "messageTimestamp": "2026-08-25T10:00:00Z", "fingerprint": "fp-1", "status": "AI_PENDING",
            }
            first = store.save_candidate(candidate)
            second = store.save_candidate(candidate)
            self.assertEqual(first["id"], second["id"])

            lead = store.save_lead({**candidate, "candidateId": first["id"], "aiClass": "BUYER", "score": 91,
                                    "confidence": 0.94, "reason": "Explicit request", "detectedNeed": "website"})
            duplicate = store.save_lead({**candidate, "candidateId": first["id"], "aiClass": "BUYER", "score": 91,
                                         "confidence": 0.94, "reason": "Explicit request", "detectedNeed": "website"})
            self.assertEqual(lead["id"], duplicate["id"])
            attempt = store.ensure_notification_attempt(lead["id"])
            same_attempt = store.ensure_notification_attempt(lead["id"])
            self.assertEqual(attempt["id"], same_attempt["id"])
            store.close()

    def test_public_group_and_queue_payloads_never_expose_telegram_access_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                group = store.upsert_group({
                    "telegramGroupId": "-100123", "accessHash": "sensitive-access-hash",
                    "title": "Founders", "type": "supergroup", "score": 80,
                    "confidence": "PRELIMINARY",
                })
                store.add_to_queue([group["id"]])

                self.assertNotIn("accessHash", group)
                self.assertNotIn("accessHash", store.list_groups()["items"][0])
                self.assertNotIn("accessHash", store.list_queue()["items"][0])
                self.assertEqual(store.get_group_private(group["id"])["accessHash"], "sensitive-access-hash")
            finally:
                store.close()

    def test_group_and_lead_lists_apply_limit_offset_and_report_full_total(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                topics = ("founders", "founders", "ecommerce")
                activities = (90, 60, 80)
                for index, score in enumerate((91, 82, 73), start=1):
                    store.upsert_group({
                        "telegramGroupId": f"-100{index}", "title": f"Group {index}",
                        "type": "supergroup", "score": score, "confidence": "PRELIMINARY",
                        "topic": topics[index - 1], "activityScore": activities[index - 1],
                    })
                    store.save_lead({
                        "telegramGroupId": f"-100{index}", "messageId": index,
                        "messageTimestamp": f"2026-08-25T10:0{index}:00Z", "messageText": f"Need {index}",
                        "aiClass": "BUYER", "score": score, "confidence": 0.9,
                        "fingerprint": f"lead-{index}",
                    })

                groups = store.list_groups({"limit": 1, "offset": 1, "sort": "score"})
                leads = store.list_leads({"limit": 1, "offset": 1, "minimumScore": 0})

                self.assertEqual(groups["total"], 3)
                self.assertEqual([item["score"] for item in groups["items"]], [82])
                self.assertEqual(leads["total"], 3)
                self.assertEqual([item["score"] for item in leads["items"]], [82])
                filtered = store.list_groups({"topic": "founders", "minimumActivity": 70})
                self.assertEqual([item["score"] for item in filtered["items"]], [91])
            finally:
                store.close()

    def test_monitored_daily_counters_reset_when_the_utc_day_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                group = store.upsert_group({
                    "telegramGroupId": "-10055", "title": "Daily metrics", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                store.set_group_status(group["id"], "JOINED")
                store.set_monitored(group["id"], True)
                store.record_monitored_metric("-10055", "message", "2026-08-24T23:59:00Z")
                store.record_monitored_metric("-10055", "message", "2026-08-25T00:01:00Z")
                store.record_monitored_metric("-10055", "candidate", "2026-08-25T00:02:00Z")

                monitored = store.list_monitored()["items"][0]
                self.assertEqual(monitored["messagesToday"], 1)
                self.assertEqual(monitored["candidatesToday"], 1)
                self.assertEqual(monitored["leadsToday"], 0)
            finally:
                store.close()

    def test_organization_state_is_independent_from_join_state(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                group = store.upsert_group({
                    "telegramGroupId": "-10077", "accessHash": "private-hash",
                    "title": "Parser managed", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                store.set_group_status(group["id"], "JOINED")
                store.set_monitored(group["id"], True)

                initial = store.ensure_group_organization(group["id"])
                failed = store.update_group_organization(
                    group["id"], folder_organized=False, archived=False,
                    error_code="RETRYABLE", retry_after="2026-08-25T12:00:00Z",
                )

                self.assertFalse(initial["folderOrganized"])
                self.assertFalse(failed["archived"])
                self.assertEqual(failed["errorCode"], "RETRYABLE")
                self.assertEqual(store.get_group(group["id"])["status"], "MONITORING")
                self.assertTrue(store.is_monitored_telegram_id("-10077"))
                self.assertNotIn("accessHash", store.organization_summary())
            finally:
                store.close()

    def test_managed_joined_groups_exclude_unmanaged_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                managed = store.upsert_group({
                    "telegramGroupId": "-10088", "accessHash": "managed-hash",
                    "title": "Managed", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                unrelated = store.upsert_group({
                    "telegramGroupId": "-10099", "accessHash": "unrelated-hash",
                    "title": "Unrelated", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                store.add_to_queue([managed["id"]])
                queue_item = store.list_queue()["items"][0]
                store.update_queue_item(queue_item["id"], "JOINED")
                store.set_group_status(managed["id"], "JOINED")

                rows = store.list_managed_joined_groups()

                self.assertEqual([row["id"] for row in rows], [managed["id"]])
                self.assertEqual(rows[0]["accessHash"], "managed-hash")
                self.assertNotEqual(rows[0]["id"], unrelated["id"])
            finally:
                store.close()

    def test_monitoring_and_summary_expose_only_safe_organization_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                group = store.upsert_group({
                    "telegramGroupId": "-100111", "accessHash": "must-not-leak",
                    "title": "Safe evidence", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                store.set_group_status(group["id"], "JOINED")
                store.set_monitored(group["id"], True)
                store.update_group_organization(group["id"], folder_organized=True, archived=True)
                store.save_organization_folder(7, "DialogFilter", "парсер")

                monitored = store.list_monitored()["items"][0]
                summary = store.organization_summary()

                self.assertTrue(monitored["folderOrganized"])
                self.assertTrue(monitored["archived"])
                self.assertEqual(summary["folderTitle"], "парсер")
                self.assertEqual(summary["managedGroups"], 1)
                self.assertEqual(summary["needsReconciliation"], 0)
                self.assertNotIn("filterId", summary)
                self.assertNotIn("accessHash", monitored)
                self.assertNotIn("must-not-leak", str((monitored, summary)))
            finally:
                store.close()

    def test_monitoring_totals_and_history_cursor_survive_daily_rollover(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                group = store.upsert_group({
                    "telegramGroupId": "-100212", "title": "Durable monitoring", "type": "supergroup",
                    "score": 80, "confidence": "PRELIMINARY",
                })
                store.set_group_status(group["id"], "JOINED")
                store.set_monitored(group["id"], True)

                store.record_monitored_metric("-100212", "message", "2026-08-24T23:59:00Z")
                store.record_monitored_metric("-100212", "message", "2026-08-25T00:01:00Z")
                store.record_monitored_metric("-100212", "candidate", "2026-08-25T00:02:00Z")
                store.advance_monitored_history_cursor(group["id"], "2026-08-25T00:03:00Z")

                monitored = store.list_monitored()["items"][0]
                self.assertEqual(monitored["messagesToday"], 1)
                self.assertEqual(monitored["messagesTotal"], 2)
                self.assertEqual(monitored["candidatesTotal"], 1)
                self.assertEqual(monitored["leadsTotal"], 0)
                self.assertEqual(monitored["historyCursorAt"], "2026-08-25T00:03:00Z")
                self.assertIsNotNone(monitored["monitoringStartedAt"])
            finally:
                store.close()

    def test_processed_message_receipts_are_not_expired_by_candidate_retention(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                self.assertTrue(store.claim_processed_message("-100313", 7, "2026-01-01T00:00:00Z"))
                store.connection.execute(
                    "UPDATE processed_messages SET processed_at='2026-01-01T00:00:00Z'"
                )
                store.connection.commit()

                store.cleanup_retention(1)

                self.assertFalse(store.claim_processed_message("-100313", 7, "2026-01-01T00:00:00Z"))
            finally:
                store.close()

    def test_qualification_audit_uses_exact_delivery_identity_and_keeps_edits_as_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                payload = {
                    "accountScope": "default", "telegramGroupId": "-100501", "messageId": 42,
                    "messageTimestamp": "2026-09-01T10:00:00Z", "receivedTimestamp": "2026-09-01T10:00:02Z",
                    "originalText": "Need a website", "normalizedText": "need a website",
                    "contentType": "text", "gate": "STRONG_CONTEXT_GATE",
                    "gateReason": "INTENT_WITH_ENABLED_DOMAIN", "aiState": "AI_PENDING",
                }

                first = store.record_qualification_revision(payload)
                duplicate = store.record_qualification_revision(payload)
                edited = store.record_qualification_revision({
                    **payload, "originalText": "Need a website, budget $3000",
                    "normalizedText": "need a website budget $3000", "editTimestamp": "2026-09-01T10:05:00Z",
                })
                identical_other_message = store.record_qualification_revision({
                    **payload, "messageId": 43,
                })

                self.assertEqual(first["revision"], 1)
                self.assertEqual(duplicate["id"], first["id"])
                self.assertEqual(edited["revision"], 2)
                self.assertNotEqual(identical_other_message["messageAuditId"], first["messageAuditId"])
                self.assertEqual(store.list_qualification_revisions("default", "-100501", 42)["total"], 2)
            finally:
                store.close()

    def test_qualification_feedback_is_revision_scoped_and_keeps_a_durable_history(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                revision = store.record_qualification_revision({
                    "accountScope": "default", "telegramGroupId": "-100502", "messageId": 43,
                    "messageTimestamp": "2026-09-01T10:00:00Z", "originalText": "Need a website",
                    "normalizedText": "need a website", "contentType": "text",
                    "gate": "STRONG_CONTEXT_GATE", "gateReason": "INTENT_WITH_ENABLED_DOMAIN",
                    "aiState": "AI_SUCCEEDED", "aiOutcome": "CLIENT_LEAD", "processingTraceId": "trace-42",
                })

                first = store.save_qualification_feedback(revision["id"], "correct_lead")
                second = store.save_qualification_feedback(
                    revision["id"], "wrong_category", corrected_category="BACKEND", reason="API work",
                )
                stored = store.connection.execute(
                    "SELECT verdict, corrected_category, reason FROM qualification_feedback WHERE revision_id=? ORDER BY created_at, rowid",
                    (revision["id"],),
                ).fetchall()
                history = store.list_qualification_history({"outcome": "CLIENT_LEAD", "trace": "trace-42"})["items"]

                self.assertIsNotNone(first)
                self.assertEqual(second["correctedCategory"], "BACKEND")
                self.assertEqual([row["verdict"] for row in stored], ["correct_lead", "wrong_category"])
                self.assertEqual(history[0]["feedbackState"], "wrong_category")
                self.assertEqual(history[0]["processingTraceId"], "trace-42")
                self.assertIsNone(store.save_qualification_feedback("missing", "correct_lead"))
            finally:
                store.close()

    def test_interrupted_history_catch_up_returns_to_pending_for_the_next_start(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ParserStore(Path(directory) / "parser.db")
            try:
                store.initialize()
                store.record_monitoring_gap("2026-09-01T10:00:00Z")
                store.connection.execute(
                    "UPDATE parser_runtime_state SET catch_up_state='RUNNING', catch_up_from_at='2026-09-01T10:00:00Z', catch_up_until_at='2026-09-01T10:15:00Z' WHERE id=1"
                )
                store.connection.commit()

                state = store.interrupt_history_catch_up()

                self.assertEqual(state["state"], "PENDING")
                self.assertEqual(state["fromAt"], "2026-09-01T10:00:00Z")
                self.assertEqual(state["untilAt"], "2026-09-01T10:15:00Z")
            finally:
                store.close()

    def test_initialize_repairs_stale_running_history_catch_up_when_parser_is_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "parser.db"
            store = ParserStore(database)
            try:
                store.initialize()
                store.connection.execute(
                    "UPDATE parser_runtime_state SET state='STOPPED', was_running=0, catch_up_state='RUNNING', catch_up_from_at='2026-09-01T10:00:00Z' WHERE id=1"
                )
                store.connection.commit()
            finally:
                store.close()

            restarted = ParserStore(database)
            try:
                restarted.initialize()
                self.assertEqual(restarted.get_runtime_state()["historyCatchUp"]["state"], "PENDING")
            finally:
                restarted.close()


if __name__ == "__main__":
    unittest.main()
