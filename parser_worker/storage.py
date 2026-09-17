from __future__ import annotations

import json
import hashlib
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from parser_worker.classifier import DEFAULT_INTENT_PHRASES, DEFAULT_SERVICE_PHRASES, SELLER_PHRASES


_UNSET = object()
TERMINAL_QUEUE_STATUSES = (
    "JOINED", "PRIVATE", "UNAVAILABLE", "BANNED", "DELETED", "LIMIT_REACHED",
)
ACTIVE_QUEUE_STATUSES = ("QUEUED", "JOINING", "WAITING", "RETRYABLE", "FLOOD_WAIT")


DEFAULT_SETTINGS = {
    "telegramApiId": None,
    "aiEnabled": False,
    "aiModel": "",
    "minimumLeadScore": 70,
    "notifyMaybeLeads": False,
    "authorCooldownHours": 24,
    "discoveryLimitPerQuery": 50,
    "discoveryDelayMs": 3000,
    "joinDelaySeconds": 90,
    "autoResumeFloodWait": False,
    "autoStart": False,
    "retentionDays": 30,
    "diagnosticRawRetentionDays": 7,
    "targetLanguages": ["ru", "en", "ro", "mixed"],
    "enabledLeadCategories": [
        "WEBSITES", "WEB_APPLICATIONS", "BACKEND", "FULL_STACK", "API_INTEGRATIONS",
        "TELEGRAM", "AUTOMATION", "ADMIN_TOOLS", "PAYMENTS_COMMERCE",
    ],
    "maxSignalDistanceChars": 240,
    "maxContextWindowChars": 360,
    "sameAuthorContextMessageLimit": 2,
    "sameAuthorContextTimeWindowSeconds": 1200,
    "intentPhrases": list(DEFAULT_INTENT_PHRASES),
    "servicePhrases": list(DEFAULT_SERVICE_PHRASES),
    "negativePhrases": list(SELLER_PHRASES),
    "maxAiQueue": 1000,
}

ALLOWED_SETTINGS = {
    "telegramApiId",
    "aiEnabled", "aiModel", "minimumLeadScore", "notifyMaybeLeads", "authorCooldownHours",
    "discoveryLimitPerQuery", "discoveryDelayMs", "joinDelaySeconds", "autoResumeFloodWait",
    "autoStart", "retentionDays", "diagnosticRawRetentionDays", "targetLanguages", "enabledLeadCategories",
    "maxSignalDistanceChars", "maxContextWindowChars", "sameAuthorContextMessageLimit",
    "sameAuthorContextTimeWindowSeconds", "intentPhrases", "servicePhrases", "negativePhrases",
    "maxAiQueue",
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _parse_utc_timestamp(value: str | None) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def discovery_run_title(queries: list[str]) -> str:
    normalized = [str(query).strip() for query in queries if str(query).strip()]
    if not normalized:
        return "Discovery run"
    first = normalized[0]
    title = f"{first[:1].upper()}{first[1:]}"
    if len(normalized) > 1:
        title = f"{title} +{len(normalized) - 1}"
    return title[:160]


def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


class ParserStore:
    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.database_path, timeout=10, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")

    def initialize(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS parser_settings (
              id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS telegram_account_state (
              id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, phone_masked TEXT, user_id TEXT,
              username TEXT, display_name TEXT, error_code TEXT, flood_wait_until TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parser_runtime_state (
              id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, was_running INTEGER NOT NULL DEFAULT 0,
              monitoring_gap_started_at TEXT, catch_up_state TEXT NOT NULL DEFAULT 'IDLE',
              catch_up_from_at TEXT, catch_up_until_at TEXT, catch_up_scanned INTEGER NOT NULL DEFAULT 0,
              catch_up_processed INTEGER NOT NULL DEFAULT 0, catch_up_error TEXT,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS discovery_runs (
              id TEXT PRIMARY KEY, title TEXT, is_legacy INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL, total_queries INTEGER NOT NULL, current_index INTEGER NOT NULL DEFAULT 0,
              groups_found INTEGER NOT NULL DEFAULT 0, duplicates_removed INTEGER NOT NULL DEFAULT 0,
              error_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS discovery_queries (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
              query TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
              groups_found INTEGER NOT NULL DEFAULT 0, error_code TEXT, updated_at TEXT NOT NULL,
              UNIQUE(run_id, position)
            );
            CREATE TABLE IF NOT EXISTS telegram_groups (
              id TEXT PRIMARY KEY, telegram_group_id TEXT NOT NULL UNIQUE, access_hash TEXT, title TEXT NOT NULL,
              username TEXT, members INTEGER, group_type TEXT NOT NULL, language TEXT, topic TEXT,
              activity_score REAL, unique_authors INTEGER, spam_ratio REAL, seller_ratio REAL,
              score INTEGER NOT NULL, confidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DISCOVERED',
              discovered_query TEXT, discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS discovery_run_groups (
              run_id TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
              group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
              matched_query TEXT, discovered_at TEXT NOT NULL,
              PRIMARY KEY(run_id, group_id)
            );
            CREATE TABLE IF NOT EXISTS join_queue_items (
              id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
              status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
              error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(group_id)
            );
            CREATE TABLE IF NOT EXISTS monitored_groups (
              id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
              enabled INTEGER NOT NULL DEFAULT 1, messages_today INTEGER NOT NULL DEFAULT 0,
              candidates_today INTEGER NOT NULL DEFAULT 0, leads_today INTEGER NOT NULL DEFAULT 0,
              messages_total INTEGER NOT NULL DEFAULT 0, candidates_total INTEGER NOT NULL DEFAULT 0,
              leads_total INTEGER NOT NULL DEFAULT 0, monitoring_started_at TEXT, history_cursor_at TEXT,
              metrics_day TEXT, last_message_at TEXT, last_lead_at TEXT, last_error TEXT,
              updated_at TEXT NOT NULL, UNIQUE(group_id)
            );
            CREATE TABLE IF NOT EXISTS group_daily_observations (
              group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE, day TEXT NOT NULL,
              messages INTEGER NOT NULL DEFAULT 0, seller_messages INTEGER NOT NULL DEFAULT 0,
              spam_messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(group_id, day)
            );
            CREATE TABLE IF NOT EXISTS group_author_observations (
              group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE, author_hash TEXT NOT NULL,
              last_seen TEXT NOT NULL, PRIMARY KEY(group_id, author_hash)
            );
            CREATE TABLE IF NOT EXISTS message_candidates (
              id TEXT PRIMARY KEY, telegram_group_id TEXT NOT NULL, message_id INTEGER NOT NULL, author_id TEXT,
              author_username TEXT, author_name TEXT, message_text TEXT NOT NULL, message_timestamp TEXT NOT NULL,
              language TEXT, fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, fast_class TEXT,
              fast_score INTEGER, ai_attempts INTEGER NOT NULL DEFAULT 0, next_ai_attempt_at TEXT,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(telegram_group_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS processed_messages (
              telegram_group_id TEXT NOT NULL, message_id INTEGER NOT NULL, message_timestamp TEXT NOT NULL,
              processed_at TEXT NOT NULL, PRIMARY KEY(telegram_group_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS leads (
              id TEXT PRIMARY KEY, candidate_id TEXT UNIQUE REFERENCES message_candidates(id), telegram_group_id TEXT NOT NULL,
              group_title TEXT, group_username TEXT, message_id INTEGER NOT NULL, message_timestamp TEXT NOT NULL,
              author_id TEXT, author_username TEXT, author_name TEXT, message_text TEXT NOT NULL, language TEXT,
              ai_class TEXT NOT NULL, score INTEGER NOT NULL, confidence REAL NOT NULL, reason TEXT,
              detected_need TEXT, original_message_url TEXT, suggested_reply TEXT, notification_status TEXT NOT NULL DEFAULT 'PENDING',
              feedback_status TEXT, ignored INTEGER NOT NULL DEFAULT 0, fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ignored_authors (
              author_id TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ignored_chats (
              telegram_group_id TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS lead_feedback (
              id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
              verdict TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notification_attempts (
              id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
              status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
              error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS qualification_message_audit (
              id TEXT PRIMARY KEY, account_scope TEXT NOT NULL DEFAULT 'default', telegram_group_id TEXT NOT NULL,
              message_id INTEGER NOT NULL, message_timestamp TEXT NOT NULL, first_received_at TEXT NOT NULL,
              last_received_at TEXT NOT NULL, chat_title TEXT, chat_username TEXT, author_id TEXT,
              author_username TEXT, author_name TEXT, source_message_url TEXT,
              UNIQUE(account_scope, telegram_group_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS qualification_revisions (
              id TEXT PRIMARY KEY, processing_trace_id TEXT, message_audit_id TEXT NOT NULL REFERENCES qualification_message_audit(id) ON DELETE CASCADE,
              revision INTEGER NOT NULL, received_at TEXT NOT NULL, processed_at TEXT NOT NULL, edit_timestamp TEXT,
              content_type TEXT NOT NULL, original_text TEXT, normalized_text TEXT, primary_language TEXT,
              languages_json TEXT NOT NULL DEFAULT '[]', context_json TEXT NOT NULL DEFAULT '[]',
              signals_json TEXT NOT NULL DEFAULT '[]', vocabulary_version TEXT, configuration_version TEXT,
              gate TEXT NOT NULL, gate_reason TEXT NOT NULL, ai_state TEXT NOT NULL,
              ai_outcome TEXT, ai_result_json TEXT, decision_state TEXT NOT NULL DEFAULT 'PENDING',
              notification_state TEXT NOT NULL DEFAULT 'NOT_REQUIRED', feedback_state TEXT,
              raw_content_expires_at TEXT, compacted_at TEXT,
              UNIQUE(message_audit_id, revision)
            );
            CREATE TABLE IF NOT EXISTS qualification_ai_attempts (
              id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES qualification_revisions(id) ON DELETE CASCADE,
              attempt_number INTEGER NOT NULL, state TEXT NOT NULL, provider TEXT, model TEXT,
              error_code TEXT, retry_after TEXT, started_at TEXT NOT NULL, completed_at TEXT,
              UNIQUE(revision_id, attempt_number)
            );
            CREATE TABLE IF NOT EXISTS qualification_notification_attempts (
              id TEXT PRIMARY KEY, message_audit_id TEXT NOT NULL REFERENCES qualification_message_audit(id) ON DELETE CASCADE,
              revision_id TEXT NOT NULL REFERENCES qualification_revisions(id) ON DELETE CASCADE,
              logical_notification_id TEXT NOT NULL UNIQUE, attempt_number INTEGER NOT NULL, state TEXT NOT NULL,
              transport_message_id TEXT, error_code TEXT, retry_after TEXT, started_at TEXT NOT NULL, completed_at TEXT,
              UNIQUE(message_audit_id, attempt_number)
            );
            CREATE TABLE IF NOT EXISTS qualification_feedback (
              id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES qualification_revisions(id) ON DELETE CASCADE,
              verdict TEXT NOT NULL, corrected_category TEXT, reason TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS queue_control (
              id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0, reason TEXT,
              resume_at TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS telegram_group_organization (
              group_id TEXT PRIMARY KEY REFERENCES telegram_groups(id) ON DELETE CASCADE,
              folder_organized INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              error_code TEXT, retry_after TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS telegram_organization_state (
              id INTEGER PRIMARY KEY CHECK(id=1), filter_id INTEGER, filter_type TEXT,
              folder_title TEXT, folder_status TEXT NOT NULL DEFAULT 'UNKNOWN',
              error_code TEXT, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_groups_telegram_id ON telegram_groups(telegram_group_id);
            CREATE INDEX IF NOT EXISTS idx_groups_status ON telegram_groups(status);
            CREATE INDEX IF NOT EXISTS idx_groups_score ON telegram_groups(score DESC);
            CREATE INDEX IF NOT EXISTS idx_discovery_run_groups_group ON discovery_run_groups(group_id, run_id);
            CREATE INDEX IF NOT EXISTS idx_discovery_runs_started ON discovery_runs(started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_queue_status ON join_queue_items(status, next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_candidates_message ON message_candidates(telegram_group_id, message_id);
            CREATE INDEX IF NOT EXISTS idx_processed_messages_created ON processed_messages(processed_at);
            CREATE INDEX IF NOT EXISTS idx_group_authors_seen ON group_author_observations(group_id, last_seen);
            CREATE INDEX IF NOT EXISTS idx_candidates_author ON message_candidates(author_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_candidates_status ON message_candidates(status, next_ai_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_leads_author ON leads(author_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(notification_status, created_at);
            CREATE INDEX IF NOT EXISTS idx_feedback_created ON lead_feedback(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_notification_status ON notification_attempts(status, next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_qualification_audit_identity ON qualification_message_audit(account_scope, telegram_group_id, message_id);
            CREATE INDEX IF NOT EXISTS idx_qualification_revisions_route ON qualification_revisions(gate, ai_state, notification_state, processed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_qualification_revisions_outcome ON qualification_revisions(ai_outcome, processed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_qualification_ai_attempt_state ON qualification_ai_attempts(state, retry_after);
            CREATE INDEX IF NOT EXISTS idx_qualification_notification_state ON qualification_notification_attempts(state, retry_after);
            CREATE INDEX IF NOT EXISTS idx_qualification_feedback_revision ON qualification_feedback(revision_id, created_at DESC);
            """
        )
        discovery_run_columns = {
            row[1] for row in self.connection.execute("PRAGMA table_info(discovery_runs)").fetchall()
        }
        if "title" not in discovery_run_columns:
            self.connection.execute("ALTER TABLE discovery_runs ADD COLUMN title TEXT")
        if "is_legacy" not in discovery_run_columns:
            self.connection.execute(
                "ALTER TABLE discovery_runs ADD COLUMN is_legacy INTEGER NOT NULL DEFAULT 0"
            )
        self._migrate_discovery_history()
        monitored_columns = {row[1] for row in self.connection.execute("PRAGMA table_info(monitored_groups)").fetchall()}
        for column, definition in (
            ("metrics_day", "TEXT"), ("messages_total", "INTEGER NOT NULL DEFAULT 0"),
            ("candidates_total", "INTEGER NOT NULL DEFAULT 0"), ("leads_total", "INTEGER NOT NULL DEFAULT 0"),
            ("monitoring_started_at", "TEXT"), ("history_cursor_at", "TEXT"),
        ):
            if column not in monitored_columns:
                self.connection.execute(f"ALTER TABLE monitored_groups ADD COLUMN {column} {definition}")
        self.connection.execute(
            """UPDATE monitored_groups SET messages_total=MAX(COALESCE(messages_total, 0), COALESCE(messages_today, 0)),
               candidates_total=MAX(COALESCE(candidates_total, 0), COALESCE(candidates_today, 0)),
               leads_total=MAX(COALESCE(leads_total, 0), COALESCE(leads_today, 0)),
               monitoring_started_at=COALESCE(monitoring_started_at, updated_at)"""
        )
        runtime_columns = {row[1] for row in self.connection.execute("PRAGMA table_info(parser_runtime_state)").fetchall()}
        for column, definition in (
            ("monitoring_gap_started_at", "TEXT"), ("catch_up_state", "TEXT NOT NULL DEFAULT 'IDLE'"),
            ("catch_up_from_at", "TEXT"), ("catch_up_until_at", "TEXT"),
            ("catch_up_scanned", "INTEGER NOT NULL DEFAULT 0"), ("catch_up_processed", "INTEGER NOT NULL DEFAULT 0"),
            ("catch_up_error", "TEXT"),
        ):
            if column not in runtime_columns:
                self.connection.execute(f"ALTER TABLE parser_runtime_state ADD COLUMN {column} {definition}")
        qualification_revision_columns = {
            row[1] for row in self.connection.execute("PRAGMA table_info(qualification_revisions)").fetchall()
        }
        if "processing_trace_id" not in qualification_revision_columns:
            self.connection.execute("ALTER TABLE qualification_revisions ADD COLUMN processing_trace_id TEXT")
        now = utc_now()
        self.connection.execute(
            "INSERT OR IGNORE INTO parser_settings(id, value_json, updated_at) VALUES(1, ?, ?)",
            (json.dumps(DEFAULT_SETTINGS, ensure_ascii=False), now),
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO telegram_account_state(id, state, updated_at) VALUES(1, 'DISCONNECTED', ?)",
            (now,),
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO parser_runtime_state(id, state, was_running, updated_at) VALUES(1, 'STOPPED', 0, ?)",
            (now,),
        )
        # A task object cannot survive a process restart.  Never let an old
        # persisted RUNNING label claim that catch-up is currently active.
        self.connection.execute(
            """UPDATE parser_runtime_state SET catch_up_state='PENDING', catch_up_error=NULL, updated_at=?
               WHERE id=1 AND catch_up_state='RUNNING'""",
            (now,),
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO queue_control(id, paused, updated_at) VALUES(1, 0, ?)",
            (now,),
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO telegram_organization_state(id, folder_status, updated_at) VALUES(1, 'UNKNOWN', ?)",
            (now,),
        )
        self.connection.execute("UPDATE discovery_runs SET status='PAUSED', updated_at=? WHERE status='RUNNING'", (now,))
        self.connection.execute("UPDATE join_queue_items SET status='QUEUED', updated_at=? WHERE status='JOINING'", (now,))
        self.connection.execute(
            """UPDATE telegram_groups SET status='MONITORING', updated_at=?
               WHERE id IN (
                 SELECT q.group_id FROM join_queue_items q
                 JOIN monitored_groups m ON m.group_id=q.group_id AND m.enabled=1
                 WHERE q.status='JOINED'
               )""",
            (now,),
        )
        self.connection.execute(
            """UPDATE telegram_groups SET status='JOINED', updated_at=?
               WHERE id IN (
                 SELECT q.group_id FROM join_queue_items q
                 LEFT JOIN monitored_groups m ON m.group_id=q.group_id AND m.enabled=1
                 WHERE q.status='JOINED' AND m.group_id IS NULL
               )""",
            (now,),
        )
        self.connection.commit()

    def _migrate_discovery_history(self) -> None:
        untitled = self.connection.execute(
            "SELECT id FROM discovery_runs WHERE title IS NULL OR TRIM(title)=''"
        ).fetchall()
        for row in untitled:
            query_rows = self.connection.execute(
                "SELECT query FROM discovery_queries WHERE run_id=? ORDER BY position",
                (row["id"],),
            ).fetchall()
            title = discovery_run_title([query["query"] for query in query_rows])
            self.connection.execute(
                "UPDATE discovery_runs SET title=? WHERE id=?", (title, row["id"])
            )

        unassigned = int(self.connection.execute(
            """SELECT COUNT(*) FROM telegram_groups g
               WHERE NOT EXISTS(
                 SELECT 1 FROM discovery_run_groups rg WHERE rg.group_id=g.id
               )"""
        ).fetchone()[0])
        if unassigned == 0:
            return

        legacy = self.connection.execute(
            "SELECT id FROM discovery_runs WHERE is_legacy=1 ORDER BY started_at LIMIT 1"
        ).fetchone()
        legacy_id = legacy["id"] if legacy else str(uuid4())
        now = utc_now()
        if legacy is None:
            self.connection.execute(
                """INSERT INTO discovery_runs(
                     id, title, is_legacy, status, total_queries, current_index,
                     groups_found, started_at, updated_at, completed_at
                   ) VALUES(?, 'Legacy discoveries', 1, 'COMPLETED', 0, 0, 0, ?, ?, ?)""",
                (legacy_id, now, now, now),
            )
        self.connection.execute(
            """INSERT OR IGNORE INTO discovery_run_groups(
                 run_id, group_id, matched_query, discovered_at
               )
               SELECT ?, g.id, NULL, g.discovered_at
               FROM telegram_groups g
               WHERE NOT EXISTS(
                 SELECT 1 FROM discovery_run_groups rg WHERE rg.group_id=g.id
               )""",
            (legacy_id,),
        )
        count = int(self.connection.execute(
            "SELECT COUNT(*) FROM discovery_run_groups WHERE run_id=?", (legacy_id,)
        ).fetchone()[0])
        self.connection.execute(
            "UPDATE discovery_runs SET groups_found=?, updated_at=? WHERE id=?",
            (count, now, legacy_id),
        )

    def get_runtime_state(self) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM parser_runtime_state WHERE id=1").fetchone()
        return {
            "state": row["state"], "wasRunning": bool(row["was_running"]), "updatedAt": row["updated_at"],
            "historyCatchUp": {
                "state": row["catch_up_state"], "fromAt": row["catch_up_from_at"] or row["monitoring_gap_started_at"],
                "untilAt": row["catch_up_until_at"],
                "scanned": int(row["catch_up_scanned"] or 0), "processed": int(row["catch_up_processed"] or 0),
                "errorCode": row["catch_up_error"],
            },
        }

    def set_runtime_state(self, state: str, *, was_running: bool | None = None) -> dict[str, Any]:
        current = self.get_runtime_state()
        running = current["wasRunning"] if was_running is None else bool(was_running)
        now = utc_now()
        self.connection.execute(
            "UPDATE parser_runtime_state SET state=?, was_running=?, updated_at=? WHERE id=1",
            (str(state), int(running), now),
        )
        self.connection.commit()
        return self.get_runtime_state()

    def record_monitoring_gap(self, stopped_at: str | None = None) -> dict[str, Any]:
        timestamp = str(stopped_at or utc_now())
        self.connection.execute(
            """UPDATE parser_runtime_state
               SET monitoring_gap_started_at=COALESCE(monitoring_gap_started_at, ?),
                   catch_up_state=CASE WHEN monitoring_gap_started_at IS NULL THEN 'PENDING' ELSE catch_up_state END,
                   catch_up_error=CASE WHEN monitoring_gap_started_at IS NULL THEN NULL ELSE catch_up_error END,
                   updated_at=? WHERE id=1""",
            (timestamp, utc_now()),
        )
        self.connection.commit()
        return self.get_runtime_state()

    def begin_history_catch_up(self, until_at: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT monitoring_gap_started_at FROM parser_runtime_state WHERE id=1"
        ).fetchone()
        cursor = self.connection.execute(
            """SELECT MIN(COALESCE(m.history_cursor_at, m.monitoring_started_at)) AS from_at
               FROM monitored_groups m JOIN telegram_groups g ON g.id=m.group_id
               WHERE m.enabled=1 AND g.status='MONITORING'
                 AND COALESCE(m.history_cursor_at, m.monitoring_started_at) IS NOT NULL
                 AND COALESCE(m.history_cursor_at, m.monitoring_started_at) < ?""",
            (str(until_at),),
        ).fetchone()
        from_at = (row["monitoring_gap_started_at"] if row else None) or (cursor["from_at"] if cursor else None)
        if not from_at:
            return None
        self.connection.execute(
            """UPDATE parser_runtime_state SET catch_up_state='RUNNING', catch_up_from_at=?, catch_up_until_at=?,
               catch_up_scanned=0, catch_up_processed=0, catch_up_error=NULL, updated_at=? WHERE id=1""",
            (from_at, str(until_at), utc_now()),
        )
        self.connection.commit()
        return self.get_runtime_state()["historyCatchUp"]

    def record_history_catch_up_progress(self, *, scanned: int = 0, processed: int = 0) -> None:
        self.connection.execute(
            """UPDATE parser_runtime_state SET catch_up_scanned=catch_up_scanned+?, catch_up_processed=catch_up_processed+?,
               updated_at=? WHERE id=1""",
            (max(0, int(scanned)), max(0, int(processed)), utc_now()),
        )
        self.connection.commit()

    def complete_history_catch_up(self, from_at: str) -> dict[str, Any]:
        self.connection.execute(
            """UPDATE parser_runtime_state SET monitoring_gap_started_at=NULL, catch_up_state='COMPLETED',
               catch_up_error=NULL, updated_at=? WHERE id=1""",
            (utc_now(),),
        )
        self.connection.commit()
        return self.get_runtime_state()["historyCatchUp"]

    def fail_history_catch_up(self, error_code: str) -> dict[str, Any]:
        self.connection.execute(
            """UPDATE parser_runtime_state SET catch_up_state='FAILED', catch_up_error=?, updated_at=? WHERE id=1""",
            (str(error_code), utc_now()),
        )
        self.connection.commit()
        return self.get_runtime_state()["historyCatchUp"]

    def interrupt_history_catch_up(self) -> dict[str, Any]:
        """Persist an interrupted replay as resumable, never as a fictitious running task."""
        self.connection.execute(
            """UPDATE parser_runtime_state SET catch_up_state='PENDING', catch_up_error=NULL, updated_at=?
               WHERE id=1 AND catch_up_state='RUNNING'""",
            (utc_now(),),
        )
        self.connection.commit()
        return self.get_runtime_state()["historyCatchUp"]

    def get_account_state(self) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM telegram_account_state WHERE id=1").fetchone()
        return {
            "state": row["state"], "phoneMasked": row["phone_masked"], "userId": row["user_id"],
            "username": row["username"], "displayName": row["display_name"], "errorCode": row["error_code"],
            "floodWaitUntil": row["flood_wait_until"], "updatedAt": row["updated_at"],
        }

    def set_account_state(self, state: str, **values: Any) -> dict[str, Any]:
        current = self.get_account_state()
        merged = {**current, **values, "state": state, "updatedAt": utc_now()}
        self.connection.execute(
            """UPDATE telegram_account_state SET state=?, phone_masked=?, user_id=?, username=?, display_name=?,
               error_code=?, flood_wait_until=?, updated_at=? WHERE id=1""",
            (merged["state"], merged.get("phoneMasked"), merged.get("userId"), merged.get("username"),
             merged.get("displayName"), merged.get("errorCode"), merged.get("floodWaitUntil"), merged["updatedAt"]),
        )
        self.connection.commit()
        return self.get_account_state()

    def get_settings(self) -> dict[str, Any]:
        row = self.connection.execute("SELECT value_json FROM parser_settings WHERE id=1").fetchone()
        stored = json.loads(row[0]) if row else {}
        return {**DEFAULT_SETTINGS, **{key: value for key, value in stored.items() if key in ALLOWED_SETTINGS}}

    def update_settings(self, changes: dict[str, Any]) -> dict[str, Any]:
        current = self.get_settings()
        for key, value in changes.items():
            if key in ALLOWED_SETTINGS:
                current[key] = value
        current["minimumLeadScore"] = min(100, max(0, int(current["minimumLeadScore"])))
        current["authorCooldownHours"] = min(720, max(1, int(current["authorCooldownHours"])))
        current["discoveryLimitPerQuery"] = min(100, max(1, int(current["discoveryLimitPerQuery"])))
        current["discoveryDelayMs"] = min(60_000, max(500, int(current["discoveryDelayMs"])))
        current["joinDelaySeconds"] = min(86_400, max(15, int(current["joinDelaySeconds"])))
        current["retentionDays"] = min(365, max(1, int(current["retentionDays"])))
        current["diagnosticRawRetentionDays"] = min(30, max(1, int(current["diagnosticRawRetentionDays"])))
        current["maxAiQueue"] = min(10_000, max(100, int(current["maxAiQueue"])))
        current["maxSignalDistanceChars"] = min(2_000, max(20, int(current["maxSignalDistanceChars"])))
        current["maxContextWindowChars"] = min(10_000, max(60, int(current["maxContextWindowChars"])))
        current["sameAuthorContextMessageLimit"] = min(5, max(0, int(current["sameAuthorContextMessageLimit"])))
        current["sameAuthorContextTimeWindowSeconds"] = min(86_400, max(60, int(current["sameAuthorContextTimeWindowSeconds"])))
        current["aiModel"] = str(current["aiModel"] or "").strip()[:160]
        languages = current.get("targetLanguages")
        current["targetLanguages"] = [item for item in languages if item in {"ru", "en", "ro", "mixed"}] if isinstance(languages, list) else ["ru", "en", "ro"]
        allowed_categories = {
            "WEBSITES", "WEB_APPLICATIONS", "BACKEND", "FULL_STACK", "API_INTEGRATIONS",
            "TELEGRAM", "AUTOMATION", "ADMIN_TOOLS", "PAYMENTS_COMMERCE", "DESIGN", "MARKETING", "MOBILE",
        }
        categories = current.get("enabledLeadCategories")
        current["enabledLeadCategories"] = [
            category for category in categories if category in allowed_categories
        ] if isinstance(categories, list) else list(DEFAULT_SETTINGS["enabledLeadCategories"])
        for key, defaults in (
            ("intentPhrases", DEFAULT_INTENT_PHRASES),
            ("servicePhrases", DEFAULT_SERVICE_PHRASES),
            ("negativePhrases", SELLER_PHRASES),
        ):
            values = current.get(key)
            normalized = []
            seen = set()
            if isinstance(values, list):
                for item in values[:200]:
                    phrase = " ".join(str(item).split()).strip()[:120]
                    folded = phrase.casefold()
                    if len(phrase) >= 2 and folded not in seen:
                        seen.add(folded)
                        normalized.append(phrase)
            current[key] = normalized or list(defaults)
        now = utc_now()
        self.connection.execute(
            "UPDATE parser_settings SET value_json=?, updated_at=? WHERE id=1",
            (json.dumps(current, ensure_ascii=False), now),
        )
        self.connection.commit()
        return current

    def create_discovery_run(self, queries: list[str]) -> dict[str, Any]:
        run_id = str(uuid4())
        now = utc_now()
        self.connection.execute(
            """INSERT INTO discovery_runs(
                 id, title, status, total_queries, started_at, updated_at
               ) VALUES(?, ?, 'RUNNING', ?, ?, ?)""",
            (run_id, discovery_run_title(queries), len(queries), now, now),
        )
        self.connection.executemany(
            "INSERT INTO discovery_queries(id, run_id, query, position, updated_at) VALUES(?, ?, ?, ?, ?)",
            [(str(uuid4()), run_id, query, position, now) for position, query in enumerate(queries)],
        )
        self.connection.commit()
        return self.get_discovery_run(run_id)

    def get_discovery_run(self, run_id: str | None = None) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM discovery_runs WHERE id=?" if run_id else "SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 1",
            (run_id,) if run_id else (),
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"], "title": row["title"] or "Discovery run",
            "isLegacy": bool(row["is_legacy"]),
            "status": row["status"], "totalQueries": row["total_queries"],
            "currentIndex": row["current_index"], "groupsFound": row["groups_found"],
            "duplicatesRemoved": row["duplicates_removed"], "errors": row["error_count"],
            "startedAt": row["started_at"], "updatedAt": row["updated_at"], "completedAt": row["completed_at"],
        }

    def link_group_to_discovery_run(
        self, run_id: str, group_id: str, matched_query: str | None
    ) -> bool:
        cursor = self.connection.execute(
            """INSERT OR IGNORE INTO discovery_run_groups(
                 run_id, group_id, matched_query, discovered_at
               ) VALUES(?, ?, ?, ?)""",
            (run_id, group_id, matched_query, utc_now()),
        )
        self.connection.commit()
        return cursor.rowcount == 1

    def count_run_groups(self, run_id: str) -> int:
        return int(self.connection.execute(
            "SELECT COUNT(*) FROM discovery_run_groups WHERE run_id=?", (run_id,)
        ).fetchone()[0])

    def list_discovery_runs(self, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        limit = min(200, max(1, int(limit)))
        offset = min(100_000, max(0, int(offset)))
        total = int(self.connection.execute("SELECT COUNT(*) FROM discovery_runs").fetchone()[0])
        rows = self.connection.execute(
            """SELECT r.*, COUNT(DISTINCT rg.group_id) AS unique_group_count
               FROM discovery_runs r
               LEFT JOIN discovery_run_groups rg ON rg.run_id=r.id
               GROUP BY r.id
               -- `utc_now()` has second-level precision.  A UUID is not a chronology
               -- tie-breaker, so two runs created in the same second must fall back to
               -- SQLite insertion order for a stable, newest-first UI.
               ORDER BY r.started_at DESC, r.rowid DESC
               LIMIT ? OFFSET ?""",
            (limit, offset),
        ).fetchall()
        return {
            "items": [{
                "id": row["id"], "title": row["title"] or "Discovery run",
                "queryCount": row["total_queries"],
                "uniqueGroupCount": int(row["unique_group_count"]),
                "state": row["status"], "isLegacy": bool(row["is_legacy"]),
                "startedAt": row["started_at"], "updatedAt": row["updated_at"],
                "completedAt": row["completed_at"],
            } for row in rows],
            "total": total,
        }

    def list_discovery_queries(self, run_id: str, *, pending_only: bool = False) -> list[dict[str, Any]]:
        sql = "SELECT * FROM discovery_queries WHERE run_id=?"
        params: list[Any] = [run_id]
        if pending_only:
            sql += " AND status IN ('PENDING', 'RUNNING', 'FAILED')"
        sql += " ORDER BY position"
        return [dict(row) for row in self.connection.execute(sql, params).fetchall()]

    def update_discovery_query(self, query_id: str, status: str, *, groups_found: int = 0, error_code: str | None = None) -> None:
        self.connection.execute(
            "UPDATE discovery_queries SET status=?, groups_found=?, error_code=?, updated_at=? WHERE id=?",
            (status, groups_found, error_code, utc_now(), query_id),
        )
        self.connection.commit()

    def update_discovery_run(self, run_id: str, **changes: Any) -> dict[str, Any]:
        mapping = {
            "status": "status", "currentIndex": "current_index", "groupsFound": "groups_found",
            "duplicatesRemoved": "duplicates_removed", "errors": "error_count", "completedAt": "completed_at",
        }
        parts = []
        values = []
        for key, column in mapping.items():
            if key in changes:
                parts.append(f"{column}=?")
                values.append(changes[key])
        parts.append("updated_at=?")
        values.extend([utc_now(), run_id])
        self.connection.execute(f"UPDATE discovery_runs SET {', '.join(parts)} WHERE id=?", values)
        self.connection.commit()
        return self.get_discovery_run(run_id)

    def find_group_by_telegram_id(self, telegram_group_id: str | int) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT * FROM telegram_groups WHERE telegram_group_id=?", (str(telegram_group_id),)).fetchone()
        return self._public_group(row)

    def get_group(self, group_id: str) -> dict[str, Any] | None:
        return self._public_group(self.connection.execute("SELECT * FROM telegram_groups WHERE id=?", (group_id,)).fetchone())

    def get_group_private(self, group_id: str) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT * FROM telegram_groups WHERE id=?", (group_id,)).fetchone()
        group = self._public_group(row)
        if group is not None:
            group["accessHash"] = row["access_hash"]
        return group

    def upsert_group(self, group: dict[str, Any]) -> dict[str, Any]:
        existing = self.connection.execute(
            "SELECT id FROM telegram_groups WHERE telegram_group_id=?", (str(group["telegramGroupId"]),)
        ).fetchone()
        group_id = existing["id"] if existing else str(group.get("id") or uuid4())
        now = utc_now()
        self.connection.execute(
            """INSERT INTO telegram_groups(
                 id, telegram_group_id, access_hash, title, username, members, group_type, language, topic,
                 activity_score, unique_authors, spam_ratio, seller_ratio, score, confidence, status,
                 discovered_query, discovered_at, updated_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(telegram_group_id) DO UPDATE SET
                 access_hash=COALESCE(excluded.access_hash, telegram_groups.access_hash), title=excluded.title,
                 username=excluded.username, members=excluded.members, group_type=excluded.group_type,
                 language=COALESCE(excluded.language, telegram_groups.language), topic=COALESCE(excluded.topic, telegram_groups.topic),
                 activity_score=COALESCE(excluded.activity_score, telegram_groups.activity_score),
                 unique_authors=COALESCE(excluded.unique_authors, telegram_groups.unique_authors),
                 spam_ratio=COALESCE(excluded.spam_ratio, telegram_groups.spam_ratio),
                 seller_ratio=COALESCE(excluded.seller_ratio, telegram_groups.seller_ratio),
                 score=excluded.score, confidence=excluded.confidence, updated_at=excluded.updated_at""",
            (group_id, str(group["telegramGroupId"]), group.get("accessHash"), str(group.get("title") or "Без названия")[:300],
             group.get("username"), group.get("members"), group.get("type") or "group", group.get("language"),
             group.get("topic"), group.get("activityScore"), group.get("uniqueAuthors"), group.get("spamRatio"),
             group.get("sellerRatio"), int(group.get("score") or 0), group.get("confidence") or "PRELIMINARY",
             group.get("status") or "DISCOVERED", group.get("discoveredQuery"), now, now),
        )
        self.connection.commit()
        return self.get_group(group_id)

    @staticmethod
    def _public_group(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        lifecycle = "NEW" if row["status"] == "DISCOVERED" else row["status"]
        found_in_runs = int(row["found_in_runs"]) if "found_in_runs" in row.keys() else 0
        return {
            "id": row["id"], "telegramGroupId": row["telegram_group_id"],
            "title": row["title"], "username": row["username"], "members": row["members"], "type": row["group_type"],
            "language": row["language"], "topic": row["topic"], "activityScore": row["activity_score"],
            "uniqueAuthors": row["unique_authors"], "spamRatio": row["spam_ratio"], "sellerRatio": row["seller_ratio"],
            "score": row["score"], "confidence": row["confidence"], "status": row["status"],
            "lifecycle": lifecycle, "foundInRuns": found_in_runs,
            "discoveredQuery": row["discovered_query"], "discoveredAt": row["discovered_at"], "updatedAt": row["updated_at"],
        }

    def list_groups(self, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        filters = filters or {}
        clauses = []
        params: list[Any] = []
        if "runIds" in filters:
            run_ids = list(dict.fromkeys(
                str(run_id) for run_id in (filters.get("runIds") or []) if str(run_id)
            ))[:100]
            if run_ids:
                placeholders = ",".join("?" for _ in run_ids)
                clauses.append(
                    f"EXISTS(SELECT 1 FROM discovery_run_groups selected_rg "
                    f"WHERE selected_rg.group_id=telegram_groups.id "
                    f"AND selected_rg.run_id IN ({placeholders}))"
                )
                params.extend(run_ids)
            else:
                clauses.append("0")
        lifecycle_status = {
            "NEW": "DISCOVERED", "QUEUED": "QUEUED", "JOINED": "JOINED",
            "MONITORING": "MONITORING",
        }.get(str(filters.get("status") or "ALL").upper())
        if lifecycle_status:
            clauses.append("status=?")
            params.append(lifecycle_status)
        if filters.get("search"):
            clauses.append("(title LIKE ? OR username LIKE ?)")
            term = f"%{str(filters['search'])[:100]}%"
            params.extend([term, term])
        if filters.get("minimumMembers") is not None:
            clauses.append("COALESCE(members, 0) >= ?")
            params.append(int(filters["minimumMembers"]))
        if filters.get("minimumScore") is not None:
            clauses.append("score >= ?")
            params.append(int(filters["minimumScore"]))
        if filters.get("language"):
            clauses.append("language=?")
            params.append(filters["language"])
        if filters.get("topic"):
            clauses.append("topic LIKE ?")
            params.append(f"%{str(filters['topic'])[:100]}%")
        if filters.get("minimumActivity") is not None:
            clauses.append("COALESCE(activity_score, 0) >= ?")
            params.append(float(filters["minimumActivity"]))
        if filters.get("type"):
            clauses.append("group_type=?")
            params.append(filters["type"])
        if not filters.get("includeIgnored"):
            clauses.append("status <> 'IGNORED'")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sort_map = {"members": "members", "activity": "activity_score", "name": "title", "date": "discovered_at", "score": "score"}
        sort = sort_map.get(filters.get("sort"), "score")
        direction = "ASC" if filters.get("direction") == "asc" else "DESC"
        limit = min(500, max(1, int(filters.get("limit") or 200)))
        offset = min(100_000, max(0, int(filters.get("offset") or 0)))
        total = int(self.connection.execute(f"SELECT COUNT(*) FROM telegram_groups {where}", params).fetchone()[0])
        rows = self.connection.execute(
            f"""SELECT telegram_groups.*,
                       (SELECT COUNT(*) FROM discovery_run_groups all_rg
                        WHERE all_rg.group_id=telegram_groups.id) AS found_in_runs
                FROM telegram_groups {where}
                ORDER BY {sort} {direction}, discovered_at DESC, id ASC LIMIT ? OFFSET ?""",
            (*params, limit, offset),
        ).fetchall()
        return {"items": [self._public_group(row) for row in rows], "total": total}

    def set_group_status(self, group_id: str, status: str) -> dict[str, Any]:
        self.connection.execute("UPDATE telegram_groups SET status=?, updated_at=? WHERE id=?", (status, utc_now(), group_id))
        self.connection.commit()
        return self.get_group(group_id)

    def add_to_queue(self, group_ids: list[str]) -> dict[str, Any]:
        requested = list(dict.fromkeys(str(group_id) for group_id in group_ids))[:200]
        rows: dict[str, sqlite3.Row] = {}
        if requested:
            placeholders = ",".join("?" for _ in requested)
            rows = {
                row["id"]: row for row in self.connection.execute(
                    f"""SELECT g.id, g.status, q.id AS queue_id
                        FROM telegram_groups g
                        LEFT JOIN join_queue_items q ON q.group_id=g.id
                        WHERE g.id IN ({placeholders})""",
                    requested,
                ).fetchall()
            }
        added_ids: list[str] = []
        skipped_ids: list[str] = []
        now = utc_now()
        for group_id in requested:
            row = rows.get(group_id)
            if row is None or row["status"] != "DISCOVERED" or row["queue_id"] is not None:
                skipped_ids.append(group_id)
                continue
            cursor = self.connection.execute(
                """INSERT OR IGNORE INTO join_queue_items(
                     id, group_id, status, created_at, updated_at
                   ) VALUES(?, ?, 'QUEUED', ?, ?)""",
                (str(uuid4()), group_id, now, now),
            )
            if cursor.rowcount != 1:
                skipped_ids.append(group_id)
                continue
            self.connection.execute(
                "UPDATE telegram_groups SET status='QUEUED', updated_at=? WHERE id=?",
                (now, group_id),
            )
            added_ids.append(group_id)
        self.connection.commit()
        queue = self.list_queue()
        return {
            **queue, "addedIds": added_ids, "skippedIds": skipped_ids,
            "addedCount": len(added_ids), "skippedCount": len(skipped_ids),
        }

    def list_queue(self) -> dict[str, Any]:
        rows = self.connection.execute(
            """SELECT q.*, g.title, g.username, g.telegram_group_id, g.access_hash, g.group_type, g.score
               FROM join_queue_items q JOIN telegram_groups g ON g.id=q.group_id ORDER BY q.created_at, q.rowid"""
        ).fetchall()
        control = self.get_queue_control()
        items = [self._public_queue(row) for row in rows]
        terminal = set(TERMINAL_QUEUE_STATUSES)
        return {
            "items": items,
            "completedCount": sum(item["status"] in terminal for item in items),
            **control,
        }

    def clear_completed_queue(self) -> dict[str, Any]:
        placeholders = ",".join("?" for _ in TERMINAL_QUEUE_STATUSES)
        cursor = self.connection.execute(
            f"DELETE FROM join_queue_items WHERE status IN ({placeholders})",
            TERMINAL_QUEUE_STATUSES,
        )
        self.connection.commit()
        return {"cleared": cursor.rowcount, "remaining": self.list_queue()}

    @staticmethod
    def _public_queue(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "groupId": row["group_id"], "telegramGroupId": row["telegram_group_id"],
            "title": row["title"], "username": row["username"],
            "type": row["group_type"], "score": row["score"], "status": row["status"], "attempts": row["attempts"],
            "nextAttemptAt": row["next_attempt_at"], "errorCode": row["error_code"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        }

    def update_queue_item(self, item_id: str, status: str, *, error_code: str | None = None, next_attempt_at: str | None = None) -> dict[str, Any]:
        increment = 1 if status == "JOINING" else 0
        self.connection.execute(
            "UPDATE join_queue_items SET status=?, attempts=attempts+?, error_code=?, next_attempt_at=?, updated_at=? WHERE id=?",
            (status, increment, error_code, next_attempt_at, utc_now(), item_id),
        )
        self.connection.commit()
        return next(item for item in self.list_queue()["items"] if item["id"] == item_id)

    def remove_queue_item(self, item_id: str) -> bool:
        row = self.connection.execute(
            "SELECT group_id, status FROM join_queue_items WHERE id=?", (item_id,)
        ).fetchone()
        if row is None or row["status"] not in ACTIVE_QUEUE_STATUSES:
            return False
        self.connection.execute("DELETE FROM join_queue_items WHERE id=?", (item_id,))
        self.connection.execute(
            """UPDATE telegram_groups SET status='DISCOVERED', updated_at=?
               WHERE id=? AND status='QUEUED'""",
            (utc_now(), row["group_id"]),
        )
        self.connection.commit()
        return True

    def get_queue_control(self) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM queue_control WHERE id=1").fetchone()
        return {"paused": bool(row["paused"]), "reason": row["reason"], "resumeAt": row["resume_at"]}

    def set_queue_control(self, *, paused: bool, reason: str | None = None, resume_at: str | None = None) -> dict[str, Any]:
        self.connection.execute(
            "UPDATE queue_control SET paused=?, reason=?, resume_at=?, updated_at=? WHERE id=1",
            (int(paused), reason, resume_at, utc_now()),
        )
        self.connection.commit()
        return self.get_queue_control()

    def set_monitored(self, group_id: str, enabled: bool) -> dict[str, Any]:
        now = utc_now()
        self.connection.execute(
            """INSERT INTO monitored_groups(id, group_id, enabled, monitoring_started_at, updated_at) VALUES(?, ?, ?, ?, ?)
               ON CONFLICT(group_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at""",
            (str(uuid4()), group_id, int(enabled), now, now),
        )
        self.connection.commit()
        self.set_group_status(group_id, "MONITORING" if enabled else "JOINED")
        row = self.connection.execute(
            """SELECT m.*, g.title, g.username, g.telegram_group_id, g.status AS group_status,
                      COALESCE(o.folder_organized, 0) AS folder_organized,
                      COALESCE(o.archived, 0) AS organization_archived
               FROM monitored_groups m JOIN telegram_groups g ON g.id=m.group_id
               LEFT JOIN telegram_group_organization o ON o.group_id=m.group_id
               WHERE m.group_id=?""", (group_id,)
        ).fetchone()
        return self._public_monitored(row)

    def ensure_group_organization(self, group_id: str) -> dict[str, Any]:
        now = utc_now()
        self.connection.execute(
            """INSERT OR IGNORE INTO telegram_group_organization(
                 group_id, folder_organized, archived, updated_at
               ) VALUES(?, 0, 0, ?)""",
            (group_id, now),
        )
        self.connection.commit()
        row = self.connection.execute(
            "SELECT * FROM telegram_group_organization WHERE group_id=?", (group_id,)
        ).fetchone()
        return self._public_organization(row)

    @staticmethod
    def _public_organization(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "groupId": row["group_id"],
            "folderOrganized": bool(row["folder_organized"]),
            "archived": bool(row["archived"]),
            "errorCode": row["error_code"],
            "retryAfter": row["retry_after"],
            "updatedAt": row["updated_at"],
        }

    def update_group_organization(
        self,
        group_id: str,
        *,
        folder_organized: bool | object = _UNSET,
        archived: bool | object = _UNSET,
        error_code: str | None | object = _UNSET,
        retry_after: str | None | object = _UNSET,
    ) -> dict[str, Any]:
        self.ensure_group_organization(group_id)
        values: list[Any] = []
        assignments: list[str] = []
        for column, value in (
            ("folder_organized", folder_organized),
            ("archived", archived),
            ("error_code", error_code),
            ("retry_after", retry_after),
        ):
            if value is _UNSET:
                continue
            assignments.append(f"{column}=?")
            values.append(int(value) if column in {"folder_organized", "archived"} else value)
        assignments.append("updated_at=?")
        values.extend([utc_now(), group_id])
        self.connection.execute(
            f"UPDATE telegram_group_organization SET {', '.join(assignments)} WHERE group_id=?", values
        )
        self.connection.commit()
        row = self.connection.execute(
            "SELECT * FROM telegram_group_organization WHERE group_id=?", (group_id,)
        ).fetchone()
        return self._public_organization(row)

    def list_managed_joined_groups(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """SELECT DISTINCT g.* FROM telegram_groups g
               LEFT JOIN join_queue_items q ON q.group_id=g.id
               LEFT JOIN monitored_groups m ON m.group_id=g.id
               WHERE q.status='JOINED' OR (g.status='MONITORING' AND m.enabled=1)
               ORDER BY g.title"""
        ).fetchall()
        groups = []
        for row in rows:
            group = self._public_group(row)
            group["accessHash"] = row["access_hash"]
            groups.append(group)
        return groups

    def save_organization_folder(self, filter_id: int, filter_type: str, title: str) -> None:
        self.connection.execute(
            """UPDATE telegram_organization_state SET filter_id=?, filter_type=?, folder_title=?,
               folder_status='FOUND', error_code=NULL, updated_at=? WHERE id=1""",
            (int(filter_id), str(filter_type), str(title), utc_now()),
        )
        self.connection.commit()

    def set_organization_folder_error(self, error_code: str) -> None:
        self.connection.execute(
            "UPDATE telegram_organization_state SET folder_status='ERROR', error_code=?, updated_at=? WHERE id=1",
            (str(error_code), utc_now()),
        )
        self.connection.commit()

    def get_organization_folder(self) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT * FROM telegram_organization_state WHERE id=1").fetchone()
        if row is None:
            return None
        return {
            "filterId": row["filter_id"], "filterType": row["filter_type"],
            "folderTitle": row["folder_title"], "folderStatus": row["folder_status"],
            "errorCode": row["error_code"], "updatedAt": row["updated_at"],
        }

    def organization_summary(self) -> dict[str, Any]:
        folder = self.get_organization_folder() or {}
        counts = self.connection.execute(
            """SELECT COUNT(*) AS managed,
                      COALESCE(SUM(CASE WHEN o.folder_organized=1 AND o.archived=1 THEN 0 ELSE 1 END), 0) AS pending
               FROM telegram_groups g
               LEFT JOIN join_queue_items q ON q.group_id=g.id
               LEFT JOIN monitored_groups m ON m.group_id=g.id
               LEFT JOIN telegram_group_organization o ON o.group_id=g.id
               WHERE q.status='JOINED' OR (g.status='MONITORING' AND m.enabled=1)"""
        ).fetchone()
        return {
            "folderTitle": folder.get("folderTitle") or "парсер",
            "folderType": folder.get("filterType"),
            "folderStatus": folder.get("folderStatus") or "UNKNOWN",
            "managedGroups": int(counts["managed"]),
            "needsReconciliation": int(counts["pending"]),
            "errorCode": folder.get("errorCode"),
        }

    @staticmethod
    def _public_monitored(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "groupId": row["group_id"], "telegramGroupId": row["telegram_group_id"],
            "title": row["title"], "username": row["username"], "enabled": bool(row["enabled"]),
            "messagesToday": row["messages_today"], "candidatesToday": row["candidates_today"],
            "leadsToday": row["leads_today"], "lastMessageAt": row["last_message_at"],
            "messagesTotal": row["messages_total"], "candidatesTotal": row["candidates_total"],
            "leadsTotal": row["leads_total"], "monitoringStartedAt": row["monitoring_started_at"],
            "historyCursorAt": row["history_cursor_at"],
            "lastLeadAt": row["last_lead_at"], "lastError": row["last_error"], "updatedAt": row["updated_at"],
            "status": row["group_status"],
            "folderOrganized": bool(row["folder_organized"]),
            "archived": bool(row["organization_archived"]),
        }

    def list_monitored(self) -> dict[str, Any]:
        rows = self.connection.execute(
            """SELECT m.*, g.title, g.username, g.telegram_group_id, g.status AS group_status,
                      COALESCE(o.folder_organized, 0) AS folder_organized,
                      COALESCE(o.archived, 0) AS organization_archived
               FROM monitored_groups m JOIN telegram_groups g ON g.id=m.group_id
               LEFT JOIN telegram_group_organization o ON o.group_id=m.group_id ORDER BY g.title"""
        ).fetchall()
        return {"items": [self._public_monitored(row) for row in rows]}

    def list_monitored_private_groups(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """SELECT g.*, m.monitoring_started_at, m.history_cursor_at
               FROM telegram_groups g JOIN monitored_groups m ON m.group_id=g.id
               WHERE m.enabled=1 AND g.status='MONITORING' ORDER BY g.title"""
        ).fetchall()
        groups = []
        for row in rows:
            group = self._public_group(row)
            group["accessHash"] = row["access_hash"]
            group["monitoringStartedAt"] = row["monitoring_started_at"]
            group["historyCursorAt"] = row["history_cursor_at"]
            groups.append(group)
        return groups

    def is_monitored_telegram_id(self, telegram_group_id: str | int) -> bool:
        return self.connection.execute(
            """SELECT 1 FROM monitored_groups m JOIN telegram_groups g ON g.id=m.group_id
               WHERE g.telegram_group_id=? AND m.enabled=1 LIMIT 1""",
            (str(telegram_group_id),),
        ).fetchone() is not None

    def claim_processed_message(self, telegram_group_id: str | int, message_id: int, timestamp: str) -> bool:
        if int(message_id or 0) <= 0:
            return True
        cursor = self.connection.execute(
            """INSERT OR IGNORE INTO processed_messages(telegram_group_id, message_id, message_timestamp, processed_at)
               VALUES(?, ?, ?, ?)""",
            (str(telegram_group_id), int(message_id), str(timestamp), utc_now()),
        )
        self.connection.commit()
        return cursor.rowcount == 1

    @staticmethod
    def _qualification_revision_payload(row: sqlite3.Row) -> dict[str, Any]:
        payload = dict(row)
        for field in ("languages_json", "context_json", "signals_json", "ai_result_json"):
            value = payload.pop(field, None)
            public_name = {
                "languages_json": "languagesDetected",
                "context_json": "contextSegments",
                "signals_json": "matchedSignals",
                "ai_result_json": "aiResult",
            }[field]
            payload[public_name] = json.loads(value) if value else ([] if field != "ai_result_json" else None)
        payload["messageAuditId"] = payload.pop("message_audit_id")
        payload["processingTraceId"] = payload.pop("processing_trace_id")
        payload["contentType"] = payload.pop("content_type")
        payload["originalText"] = payload.pop("original_text")
        payload["normalizedText"] = payload.pop("normalized_text")
        payload["primaryLanguage"] = payload.pop("primary_language")
        payload["editTimestamp"] = payload.pop("edit_timestamp")
        payload["receivedAt"] = payload.pop("received_at")
        payload["processedAt"] = payload.pop("processed_at")
        payload["gateReason"] = payload.pop("gate_reason")
        payload["aiState"] = payload.pop("ai_state")
        payload["aiOutcome"] = payload.pop("ai_outcome")
        payload["decisionState"] = payload.pop("decision_state")
        payload["notificationState"] = payload.pop("notification_state")
        payload["feedbackState"] = payload.pop("feedback_state")
        payload["rawContentExpiresAt"] = payload.pop("raw_content_expires_at")
        payload["compactedAt"] = payload.pop("compacted_at")
        return payload

    def record_qualification_revision(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Create a revision only when this exact Telegram message actually changed.

        The unique identity is deliberately account + chat + Telegram message id.
        It never uses the body, author, company, or fuzzy content similarity.
        """
        account_scope = str(payload.get("accountScope") or "default")
        telegram_group_id = str(payload["telegramGroupId"])
        message_id = int(payload["messageId"])
        if message_id <= 0:
            raise ValueError("messageId must be a positive Telegram message id")
        received_at = str(payload.get("receivedTimestamp") or utc_now())
        now = utc_now()
        message_row = self.connection.execute(
            """SELECT * FROM qualification_message_audit
               WHERE account_scope=? AND telegram_group_id=? AND message_id=?""",
            (account_scope, telegram_group_id, message_id),
        ).fetchone()
        if message_row is None:
            message_audit_id = str(uuid4())
            self.connection.execute(
                """INSERT INTO qualification_message_audit(
                     id, account_scope, telegram_group_id, message_id, message_timestamp,
                     first_received_at, last_received_at, chat_title, chat_username, author_id,
                     author_username, author_name, source_message_url
                   ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (message_audit_id, account_scope, telegram_group_id, message_id,
                 str(payload.get("messageTimestamp") or received_at), received_at, received_at,
                 payload.get("chatTitle"), payload.get("chatUsername"), payload.get("authorId"),
                 payload.get("authorUsername"), payload.get("authorName"), payload.get("sourceMessageUrl")),
            )
        else:
            message_audit_id = message_row["id"]
            self.connection.execute(
                """UPDATE qualification_message_audit SET last_received_at=?, chat_title=COALESCE(?, chat_title),
                   chat_username=COALESCE(?, chat_username), author_id=COALESCE(?, author_id),
                   author_username=COALESCE(?, author_username), author_name=COALESCE(?, author_name),
                   source_message_url=COALESCE(?, source_message_url) WHERE id=?""",
                (received_at, payload.get("chatTitle"), payload.get("chatUsername"), payload.get("authorId"),
                 payload.get("authorUsername"), payload.get("authorName"), payload.get("sourceMessageUrl"), message_audit_id),
            )

        latest = self.connection.execute(
            "SELECT * FROM qualification_revisions WHERE message_audit_id=? ORDER BY revision DESC LIMIT 1",
            (message_audit_id,),
        ).fetchone()
        original_text = payload.get("originalText")
        normalized_text = payload.get("normalizedText")
        content_type = str(payload.get("contentType") or "text")
        edit_timestamp = payload.get("editTimestamp")
        if latest is not None and all((
            latest["original_text"] == original_text,
            latest["normalized_text"] == normalized_text,
            latest["content_type"] == content_type,
            latest["edit_timestamp"] == edit_timestamp,
        )):
            self.connection.commit()
            return self._qualification_revision_payload(latest)

        revision = int(latest["revision"] if latest else 0) + 1
        revision_id = str(uuid4())
        raw_expires_at = payload.get("rawContentExpiresAt") or (
            datetime.now(UTC) + timedelta(days=7)
        ).isoformat().replace("+00:00", "Z")
        self.connection.execute(
            """INSERT INTO qualification_revisions(
                 id, processing_trace_id, message_audit_id, revision, received_at, processed_at, edit_timestamp,
                 content_type, original_text, normalized_text, primary_language, languages_json,
                 context_json, signals_json, vocabulary_version, configuration_version, gate,
                 gate_reason, ai_state, ai_outcome, ai_result_json, decision_state,
                 notification_state, feedback_state, raw_content_expires_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (revision_id, payload.get("processingTraceId"), message_audit_id, revision, received_at, now, edit_timestamp, content_type,
             original_text, normalized_text, payload.get("primaryLanguage"),
             json.dumps(payload.get("languagesDetected") or [], ensure_ascii=False),
             json.dumps(payload.get("contextSegments") or [], ensure_ascii=False),
             json.dumps(payload.get("matchedSignals") or [], ensure_ascii=False),
             payload.get("vocabularyVersion"), payload.get("configurationVersion"),
             str(payload.get("gate") or "NO_CONTEXT_GATE"), str(payload.get("gateReason") or "UNSPECIFIED"),
             str(payload.get("aiState") or "AI_NOT_REQUIRED"), payload.get("aiOutcome"),
             json.dumps(payload.get("aiResult"), ensure_ascii=False) if payload.get("aiResult") is not None else None,
             str(payload.get("decisionState") or "PENDING"),
             str(payload.get("notificationState") or "NOT_REQUIRED"), payload.get("feedbackState"), raw_expires_at),
        )
        self.connection.commit()
        row = self.connection.execute("SELECT * FROM qualification_revisions WHERE id=?", (revision_id,)).fetchone()
        return self._qualification_revision_payload(row)

    def list_qualification_revisions(self, account_scope: str, telegram_group_id: str | int,
                                     message_id: int) -> dict[str, Any]:
        rows = self.connection.execute(
            """SELECT r.* FROM qualification_revisions r JOIN qualification_message_audit m ON m.id=r.message_audit_id
               WHERE m.account_scope=? AND m.telegram_group_id=? AND m.message_id=? ORDER BY r.revision""",
            (str(account_scope), str(telegram_group_id), int(message_id)),
        ).fetchall()
        return {"items": [self._qualification_revision_payload(row) for row in rows], "total": len(rows)}

    def list_qualification_history(self, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        filters = filters or {}
        clauses: list[str] = []
        params: list[Any] = []
        mapping = {
            "gate": "r.gate", "outcome": "r.ai_outcome", "aiState": "r.ai_state",
            "notificationState": "r.notification_state", "group": "m.telegram_group_id",
            "trace": "r.processing_trace_id",
        }
        for key, column in mapping.items():
            if filters.get(key):
                clauses.append(f"{column}=?")
                params.append(str(filters[key]))
        if filters.get("since"):
            clauses.append("r.received_at>=?")
            params.append(str(filters["since"]))
        if filters.get("text"):
            clauses.append("(r.original_text LIKE ? OR r.normalized_text LIKE ?)")
            term = f"%{str(filters['text'])[:200]}%"
            params.extend((term, term))
        if filters.get("potentialMissed"):
            clauses.append("r.gate='NO_CONTEXT_GATE' AND r.signals_json<>'[]'")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        limit = min(1000, max(1, int(filters.get("limit") or 200)))
        rows = self.connection.execute(
            f"""SELECT r.*, m.account_scope, m.telegram_group_id, m.message_id, m.message_timestamp,
                       m.chat_title, m.chat_username, m.author_id, m.author_username, m.author_name, m.source_message_url
                FROM qualification_revisions r JOIN qualification_message_audit m ON m.id=r.message_audit_id
                {where} ORDER BY r.received_at DESC, r.revision DESC LIMIT ?""", (*params, limit),
        ).fetchall()
        return {"items": [self._qualification_revision_payload(row) for row in rows], "total": len(rows)}

    def same_author_qualification_context(
        self, *, account_scope: str, telegram_group_id: str | int, author_id: str | None,
        before_timestamp: str, limit: int, window_seconds: int,
    ) -> list[dict[str, Any]]:
        """Return a bounded preceding same-author context, never a chat transcript."""
        if not author_id or limit <= 0:
            return []
        before = _parse_utc_timestamp(before_timestamp) or datetime.now(UTC)
        after = (before - timedelta(seconds=max(60, int(window_seconds)))).isoformat().replace("+00:00", "Z")
        rows = self.connection.execute(
            """SELECT r.id AS revision_id, r.original_text, r.content_type, m.message_id, m.author_id, m.message_timestamp
               FROM qualification_message_audit m
               JOIN qualification_revisions r ON r.message_audit_id=m.id
               WHERE m.account_scope=? AND m.telegram_group_id=? AND m.author_id=?
                 AND m.message_timestamp>=? AND m.message_timestamp<? AND r.original_text IS NOT NULL
                 AND r.revision=(SELECT MAX(r2.revision) FROM qualification_revisions r2 WHERE r2.message_audit_id=m.id)
               ORDER BY m.message_timestamp DESC LIMIT ?""",
            (str(account_scope), str(telegram_group_id), str(author_id), after,
             before.isoformat().replace("+00:00", "Z"), min(5, max(0, int(limit))),),
        ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def update_qualification_revision(
        self, revision_id: str, *, ai_state: str | None = None, ai_outcome: str | None = None,
        ai_result: dict[str, Any] | None | object = _UNSET, decision_state: str | None = None,
        notification_state: str | None = None, feedback_state: str | None = None,
        gate: str | None = None, gate_reason: str | None = None,
        matched_signals: list[dict[str, Any]] | None = None,
        vocabulary_version: str | None = None, configuration_version: str | None = None,
        primary_language: str | None = None, languages_detected: list[str] | None = None,
    ) -> dict[str, Any] | None:
        assignments: list[str] = ["processed_at=?"]
        values: list[Any] = [utc_now()]
        for column, value in (
            ("ai_state", ai_state), ("ai_outcome", ai_outcome), ("decision_state", decision_state),
            ("notification_state", notification_state), ("feedback_state", feedback_state),
            ("gate", gate), ("gate_reason", gate_reason), ("vocabulary_version", vocabulary_version),
            ("configuration_version", configuration_version), ("primary_language", primary_language),
        ):
            if value is not None:
                assignments.append(f"{column}=?")
                values.append(value)
        if ai_result is not _UNSET:
            assignments.append("ai_result_json=?")
            values.append(json.dumps(ai_result, ensure_ascii=False) if ai_result is not None else None)
        if matched_signals is not None:
            assignments.append("signals_json=?")
            values.append(json.dumps(matched_signals, ensure_ascii=False))
        if languages_detected is not None:
            assignments.append("languages_json=?")
            values.append(json.dumps(languages_detected, ensure_ascii=False))
        values.append(str(revision_id))
        self.connection.execute(f"UPDATE qualification_revisions SET {', '.join(assignments)} WHERE id=?", values)
        self.connection.commit()
        row = self.connection.execute("SELECT * FROM qualification_revisions WHERE id=?", (str(revision_id),)).fetchone()
        return self._qualification_revision_payload(row) if row else None

    def save_qualification_feedback(
        self, revision_id: str, verdict: str, *, corrected_category: str | None = None, reason: str | None = None,
    ) -> dict[str, Any] | None:
        """Keep immutable feedback history while exposing the latest verdict on a revision."""
        exists = self.connection.execute(
            "SELECT 1 FROM qualification_revisions WHERE id=?", (str(revision_id),)
        ).fetchone()
        if exists is None:
            return None
        feedback_id = str(uuid4())
        self.connection.execute(
            """INSERT INTO qualification_feedback(id, revision_id, verdict, corrected_category, reason, created_at)
               VALUES(?, ?, ?, ?, ?, ?)""",
            (feedback_id, str(revision_id), str(verdict), corrected_category, reason, utc_now()),
        )
        self.connection.execute(
            "UPDATE qualification_revisions SET feedback_state=?, processed_at=? WHERE id=?",
            (str(verdict), utc_now(), str(revision_id)),
        )
        self.connection.commit()
        return {
            "id": feedback_id, "revisionId": str(revision_id), "verdict": str(verdict),
            "correctedCategory": corrected_category, "reason": reason,
        }

    def next_qualification_ai_revision(self) -> dict[str, Any] | None:
        row = self.connection.execute(
            """SELECT r.*, m.account_scope, m.telegram_group_id, m.message_id, m.message_timestamp,
                      m.chat_title, m.chat_username, m.author_id, m.author_username, m.author_name,
                      m.source_message_url
               FROM qualification_revisions r JOIN qualification_message_audit m ON m.id=r.message_audit_id
               WHERE r.ai_state IN ('AI_PENDING', 'AI_RETRYABLE_FAILED')
                 AND (r.ai_state='AI_PENDING' OR COALESCE((
                   SELECT a.retry_after FROM qualification_ai_attempts a
                   WHERE a.revision_id=r.id ORDER BY a.attempt_number DESC LIMIT 1
                 ), '') <= ?)
               ORDER BY r.received_at, r.revision LIMIT 1"""
            , (utc_now(),)).fetchone()
        return self._qualification_revision_payload(row) if row else None

    def begin_qualification_ai_attempt(self, revision_id: str, *, provider: str, model: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT COALESCE(MAX(attempt_number), 0) AS maximum FROM qualification_ai_attempts WHERE revision_id=?",
            (str(revision_id),),
        ).fetchone()
        attempt_number = int(row["maximum"] or 0) + 1
        attempt_id = str(uuid4())
        now = utc_now()
        self.connection.execute(
            """INSERT INTO qualification_ai_attempts(
                 id, revision_id, attempt_number, state, provider, model, started_at
               ) VALUES(?, ?, ?, 'AI_RUNNING', ?, ?, ?)""",
            (attempt_id, str(revision_id), attempt_number, str(provider), str(model), now),
        )
        self.connection.execute(
            "UPDATE qualification_revisions SET ai_state='AI_RUNNING', processed_at=? WHERE id=?",
            (now, str(revision_id)),
        )
        self.connection.commit()
        return _row(self.connection.execute("SELECT * FROM qualification_ai_attempts WHERE id=?", (attempt_id,)).fetchone())

    def finish_qualification_ai_attempt(
        self, attempt_id: str, *, state: str, error_code: str | None = None, retry_after: str | None = None,
    ) -> dict[str, Any] | None:
        self.connection.execute(
            """UPDATE qualification_ai_attempts SET state=?, error_code=?, retry_after=?, completed_at=? WHERE id=?""",
            (str(state), error_code, retry_after, utc_now(), str(attempt_id)),
        )
        self.connection.commit()
        return _row(self.connection.execute("SELECT * FROM qualification_ai_attempts WHERE id=?", (str(attempt_id),)).fetchone())

    def ensure_qualification_notification(self, message_audit_id: str, revision_id: str) -> dict[str, Any]:
        existing = self.connection.execute(
            """SELECT * FROM qualification_notification_attempts
               WHERE message_audit_id=? ORDER BY attempt_number LIMIT 1""", (str(message_audit_id),)
        ).fetchone()
        if existing is not None:
            return _row(existing)
        now = utc_now()
        attempt_id = str(uuid4())
        logical_id = f"notification:{message_audit_id}"
        self.connection.execute(
            """INSERT INTO qualification_notification_attempts(
                 id, message_audit_id, revision_id, logical_notification_id, attempt_number, state, started_at
               ) VALUES(?, ?, ?, ?, 1, 'PENDING', ?)""",
            (attempt_id, str(message_audit_id), str(revision_id), logical_id, now),
        )
        self.connection.commit()
        return _row(self.connection.execute("SELECT * FROM qualification_notification_attempts WHERE id=?", (attempt_id,)).fetchone())

    def next_qualification_notification_attempt(self) -> dict[str, Any] | None:
        row = self.connection.execute(
            """SELECT n.*, m.account_scope, m.telegram_group_id, m.message_id
               FROM qualification_notification_attempts n
               JOIN qualification_message_audit m ON m.id=n.message_audit_id
               WHERE n.state IN ('PENDING', 'RETRYABLE_FAILED')
                 AND (n.retry_after IS NULL OR n.retry_after<=?)
                 AND n.attempt_number=(SELECT MAX(n2.attempt_number) FROM qualification_notification_attempts n2
                                       WHERE n2.message_audit_id=n.message_audit_id)
               ORDER BY n.started_at LIMIT 1""", (utc_now(),)
        ).fetchone()
        return _row(row)

    def update_qualification_notification_attempt(
        self, attempt_id: str, state: str, *, error_code: str | None = None,
        transport_message_id: str | int | None = None, retry_after: str | None = None,
    ) -> dict[str, Any] | None:
        completed_at = utc_now() if state in {"SENT", "FINAL_FAILED", "DELIVERY_UNKNOWN"} else None
        self.connection.execute(
            """UPDATE qualification_notification_attempts SET state=?, error_code=?, transport_message_id=?,
               retry_after=?, completed_at=? WHERE id=?""",
            (str(state), error_code, str(transport_message_id) if transport_message_id is not None else None,
             retry_after, completed_at, str(attempt_id)),
        )
        row = self.connection.execute(
            "SELECT * FROM qualification_notification_attempts WHERE id=?", (str(attempt_id),)
        ).fetchone()
        if row is not None:
            self.connection.execute(
                "UPDATE qualification_revisions SET notification_state=?, processed_at=? WHERE id=?",
                (str(state), utc_now(), row["revision_id"]),
            )
        self.connection.commit()
        return _row(row)

    def record_group_observation(self, telegram_group_id: str | int, author_id: str | None, classification: str, timestamp: str) -> dict[str, Any] | None:
        group_row = self.connection.execute(
            "SELECT id FROM telegram_groups WHERE telegram_group_id=?", (str(telegram_group_id),)
        ).fetchone()
        if group_row is None:
            return None
        group_id = group_row["id"]
        day = str(timestamp)[:10] if len(str(timestamp)) >= 10 else datetime.now(UTC).date().isoformat()
        seller = int(classification == "SELLER")
        spam = int(classification == "SPAM")
        self.connection.execute(
            """INSERT INTO group_daily_observations(group_id, day, messages, seller_messages, spam_messages)
               VALUES(?, ?, 1, ?, ?) ON CONFLICT(group_id, day) DO UPDATE SET
               messages=messages+1, seller_messages=seller_messages+excluded.seller_messages,
               spam_messages=spam_messages+excluded.spam_messages""",
            (group_id, day, seller, spam),
        )
        if author_id:
            author_hash = hashlib.sha256(f"{group_id}:{author_id}".encode("utf-8")).hexdigest()
            self.connection.execute(
                """INSERT INTO group_author_observations(group_id, author_hash, last_seen) VALUES(?, ?, ?)
                   ON CONFLICT(group_id, author_hash) DO UPDATE SET last_seen=excluded.last_seen""",
                (group_id, author_hash, timestamp),
            )
        cutoff = (datetime.now(UTC) - timedelta(days=7)).date().isoformat()
        totals = self.connection.execute(
            """SELECT COALESCE(SUM(messages),0), COALESCE(SUM(seller_messages),0), COALESCE(SUM(spam_messages),0)
               FROM group_daily_observations WHERE group_id=? AND day>=?""",
            (group_id, cutoff),
        ).fetchone()
        unique_authors = int(self.connection.execute(
            "SELECT COUNT(*) FROM group_author_observations WHERE group_id=? AND last_seen>=?",
            (group_id, f"{cutoff}T00:00:00Z"),
        ).fetchone()[0])
        messages = max(1, int(totals[0]))
        activity_score = min(100.0, messages / 7 * 10)
        seller_ratio = float(totals[1]) / messages
        spam_ratio = float(totals[2]) / messages
        self.connection.execute(
            """UPDATE telegram_groups SET activity_score=?, unique_authors=?, spam_ratio=?, seller_ratio=?,
               confidence='OBSERVED', updated_at=? WHERE id=?""",
            (activity_score, unique_authors, spam_ratio, seller_ratio, utc_now(), group_id),
        )
        self.connection.commit()
        return self.get_group(group_id)

    def record_monitored_metric(self, telegram_group_id: str, metric: str, timestamp: str) -> None:
        columns = {
            "message": ("messages_today", "messages_total", "last_message_at"),
            "candidate": ("candidates_today", "candidates_total", None),
            "lead": ("leads_today", "leads_total", "last_lead_at"),
        }
        if metric not in columns:
            return
        day = str(timestamp)[:10] if len(str(timestamp)) >= 10 else datetime.now(UTC).date().isoformat()
        self.connection.execute(
            """UPDATE monitored_groups SET messages_today=0, candidates_today=0, leads_today=0,
               metrics_day=?, updated_at=? WHERE group_id=(SELECT id FROM telegram_groups WHERE telegram_group_id=?)
               AND COALESCE(metrics_day, '')<>?""",
            (day, utc_now(), str(telegram_group_id), day),
        )
        count_column, total_column, time_column = columns[metric]
        sql = f"UPDATE monitored_groups SET {count_column}={count_column}+1, {total_column}={total_column}+1, updated_at=?"
        values: list[Any] = [utc_now()]
        if time_column:
            sql += f", {time_column}=?"
            values.append(timestamp)
        sql += " WHERE group_id=(SELECT id FROM telegram_groups WHERE telegram_group_id=?)"
        values.append(str(telegram_group_id))
        self.connection.execute(sql, values)
        self.connection.commit()

    def advance_monitored_history_cursor(self, group_id: str, until_at: str) -> None:
        """Advance only after a full Telegram history range was scanned for this group."""
        self.connection.execute(
            """UPDATE monitored_groups SET history_cursor_at=CASE
                   WHEN history_cursor_at IS NULL OR history_cursor_at < ? THEN ? ELSE history_cursor_at END,
                   updated_at=? WHERE group_id=?""",
            (str(until_at), str(until_at), utc_now(), str(group_id)),
        )
        self.connection.commit()

    def find_candidate(self, fingerprint: str) -> dict[str, Any] | None:
        return _row(self.connection.execute("SELECT * FROM message_candidates WHERE fingerprint=?", (fingerprint,)).fetchone())

    def save_candidate(self, candidate: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        candidate_id = str(candidate.get("id") or uuid4())
        self.connection.execute(
            """INSERT OR IGNORE INTO message_candidates(
                 id, telegram_group_id, message_id, author_id, author_username, author_name, message_text,
                 message_timestamp, language, fingerprint, status, fast_class, fast_score, created_at, updated_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (candidate_id, str(candidate["telegramGroupId"]), int(candidate["messageId"]), candidate.get("authorId"),
             candidate.get("authorUsername"), candidate.get("authorName"), str(candidate["messageText"]),
             candidate["messageTimestamp"], candidate.get("language"), candidate["fingerprint"], candidate["status"],
             candidate.get("fastClass"), candidate.get("fastScore"), now, now),
        )
        self.connection.commit()
        row = self.connection.execute(
            "SELECT * FROM message_candidates WHERE fingerprint=? OR (telegram_group_id=? AND message_id=?) LIMIT 1",
            (candidate["fingerprint"], str(candidate["telegramGroupId"]), int(candidate["messageId"])),
        ).fetchone()
        return _row(row)

    def save_lead(self, lead: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        lead_id = str(lead.get("id") or uuid4())
        self.connection.execute(
            """INSERT OR IGNORE INTO leads(
                 id, candidate_id, telegram_group_id, group_title, group_username, message_id, message_timestamp,
                 author_id, author_username, author_name, message_text, language, ai_class, score, confidence,
                 reason, detected_need, original_message_url, suggested_reply, notification_status, fingerprint,
                 created_at, updated_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (lead_id, lead.get("candidateId"), str(lead["telegramGroupId"]), lead.get("groupTitle"), lead.get("groupUsername"),
             int(lead["messageId"]), lead["messageTimestamp"], lead.get("authorId"), lead.get("authorUsername"),
             lead.get("authorName"), str(lead["messageText"]), lead.get("language"), lead["aiClass"], int(lead["score"]),
             float(lead["confidence"]), lead.get("reason"), lead.get("detectedNeed"), lead.get("originalMessageUrl"),
             lead.get("suggestedReply"), lead.get("notificationStatus") or "PENDING", lead["fingerprint"], now, now),
        )
        self.connection.commit()
        row = self.connection.execute("SELECT * FROM leads WHERE fingerprint=?", (lead["fingerprint"],)).fetchone()
        return _row(row)

    def next_ai_candidate(self) -> dict[str, Any] | None:
        row = self.connection.execute(
            """SELECT * FROM message_candidates WHERE status='AI_PENDING'
               AND (next_ai_attempt_at IS NULL OR next_ai_attempt_at <= ?) ORDER BY created_at LIMIT 1""", (utc_now(),)
        ).fetchone()
        return _row(row)

    def ai_queue_size(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM message_candidates WHERE status='AI_PENDING'").fetchone()[0])

    def cleanup_retention(self, days: int) -> int:
        cutoff = (datetime.now(UTC) - timedelta(days=max(1, int(days)))).isoformat().replace("+00:00", "Z")
        cursor = self.connection.execute(
            """DELETE FROM message_candidates
               WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM leads WHERE leads.candidate_id=message_candidates.id)""",
            (cutoff,),
        )
        # Short diagnostic retention deliberately covers all messages that were
        # deterministic no-context/negative decisions. Qualified, reviewed and
        # failed-AI records keep source text for the longer product retention.
        compacted = self.connection.execute(
            """UPDATE qualification_revisions SET original_text=NULL, normalized_text=NULL, compacted_at=?
               WHERE raw_content_expires_at<? AND compacted_at IS NULL
                 AND decision_state='FINAL' AND ai_state='AI_NOT_REQUIRED'""",
            (utc_now(), utc_now()),
        )
        observation_cutoff = (datetime.now(UTC) - timedelta(days=max(7, int(days)))).date().isoformat()
        self.connection.execute("DELETE FROM group_daily_observations WHERE day < ?", (observation_cutoff,))
        self.connection.execute("DELETE FROM group_author_observations WHERE last_seen < ?", (f"{observation_cutoff}T00:00:00Z",))
        # Receipts contain no message text and are the durable idempotency boundary for
        # catch-up scans. Expiring them would allow an old Telegram message to become a
        # candidate/lead for a second time after a later history reconciliation.
        self.connection.commit()
        return max(0, int(cursor.rowcount)) + max(0, int(compacted.rowcount))

    def update_candidate_ai(self, candidate_id: str, status: str, *, attempts: int | None = None, next_attempt_at: str | None = None) -> None:
        if attempts is None:
            self.connection.execute(
                "UPDATE message_candidates SET status=?, next_ai_attempt_at=?, updated_at=? WHERE id=?",
                (status, next_attempt_at, utc_now(), candidate_id),
            )
        else:
            self.connection.execute(
                "UPDATE message_candidates SET status=?, ai_attempts=?, next_ai_attempt_at=?, updated_at=? WHERE id=?",
                (status, attempts, next_attempt_at, utc_now(), candidate_id),
            )
        self.connection.commit()

    @staticmethod
    def _public_lead(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "telegramGroupId": row["telegram_group_id"], "groupTitle": row["group_title"],
            "groupUsername": row["group_username"], "messageId": row["message_id"], "messageTimestamp": row["message_timestamp"],
            "authorId": row["author_id"], "authorUsername": row["author_username"], "authorName": row["author_name"],
            "messageText": row["message_text"], "language": row["language"], "aiClass": row["ai_class"],
            "score": row["score"], "confidence": row["confidence"], "reason": row["reason"],
            "detectedNeed": row["detected_need"], "originalMessageUrl": row["original_message_url"],
            "suggestedReply": row["suggested_reply"], "notificationStatus": row["notification_status"],
            "feedbackStatus": row["feedback_status"], "ignored": bool(row["ignored"]),
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        }

    def get_lead(self, lead_id: str) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT * FROM leads WHERE id=?", (lead_id,)).fetchone()
        return self._public_lead(row) if row else None

    def list_leads(self, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        filters = filters or {}
        clauses = ["ignored=0"] if not filters.get("includeIgnored") else []
        params: list[Any] = []
        if filters.get("minimumScore") is not None:
            clauses.append("score>=?")
            params.append(int(filters["minimumScore"]))
        if filters.get("class"):
            clauses.append("ai_class=?")
            params.append(filters["class"])
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        limit = min(500, max(1, int(filters.get("limit") or 200)))
        offset = min(100_000, max(0, int(filters.get("offset") or 0)))
        total = int(self.connection.execute(f"SELECT COUNT(*) FROM leads {where}", params).fetchone()[0])
        rows = self.connection.execute(
            f"SELECT * FROM leads {where} ORDER BY score DESC, created_at DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        return {"items": [self._public_lead(row) for row in rows], "total": total}

    def has_recent_lead_for_author(self, author_id: str | None, since: str) -> bool:
        if not author_id:
            return False
        return self.connection.execute(
            "SELECT 1 FROM leads WHERE author_id=? AND created_at>=? LIMIT 1", (str(author_id), since)
        ).fetchone() is not None

    def ignore_author(self, author_id: str, reason: str = "user") -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO ignored_authors(author_id, reason, created_at) VALUES(?, ?, ?)",
            (str(author_id), reason, utc_now()),
        )
        self.connection.commit()

    def ignore_chat(self, telegram_group_id: str, reason: str = "user") -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO ignored_chats(telegram_group_id, reason, created_at) VALUES(?, ?, ?)",
            (str(telegram_group_id), reason, utc_now()),
        )
        self.connection.commit()

    def is_ignored_author(self, author_id: str | None) -> bool:
        return bool(author_id and self.connection.execute("SELECT 1 FROM ignored_authors WHERE author_id=?", (str(author_id),)).fetchone())

    def is_ignored_chat(self, telegram_group_id: str) -> bool:
        return self.connection.execute("SELECT 1 FROM ignored_chats WHERE telegram_group_id=?", (str(telegram_group_id),)).fetchone() is not None

    def save_feedback(self, lead_id: str, verdict: str, reason: str | None = None) -> dict[str, Any]:
        feedback_id = str(uuid4())
        self.connection.execute(
            "INSERT INTO lead_feedback(id, lead_id, verdict, reason, created_at) VALUES(?, ?, ?, ?, ?)",
            (feedback_id, lead_id, verdict, reason, utc_now()),
        )
        self.connection.execute("UPDATE leads SET feedback_status=?, updated_at=? WHERE id=?", (verdict, utc_now(), lead_id))
        self.connection.commit()
        return {"id": feedback_id, "leadId": lead_id, "verdict": verdict, "reason": reason}

    def ensure_notification_attempt(self, lead_id: str) -> dict[str, Any]:
        now = utc_now()
        attempt_id = str(uuid4())
        self.connection.execute(
            "INSERT OR IGNORE INTO notification_attempts(id, lead_id, status, created_at, updated_at) VALUES(?, ?, 'PENDING', ?, ?)",
            (attempt_id, lead_id, now, now),
        )
        self.connection.commit()
        return _row(self.connection.execute("SELECT * FROM notification_attempts WHERE lead_id=?", (lead_id,)).fetchone())

    def next_notification_attempt(self) -> dict[str, Any] | None:
        row = self.connection.execute(
            """SELECT n.*, l.id AS joined_lead_id FROM notification_attempts n JOIN leads l ON l.id=n.lead_id
               WHERE n.status IN ('PENDING', 'RETRYING', 'FAILED') AND n.attempts < 5
               AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= ?) ORDER BY n.created_at LIMIT 1""", (utc_now(),)
        ).fetchone()
        return _row(row)

    def update_notification_attempt(self, attempt_id: str, status: str, *, error_code: str | None = None, next_attempt_at: str | None = None) -> dict[str, Any]:
        self.connection.execute(
            "UPDATE notification_attempts SET status=?, attempts=attempts+1, error_code=?, next_attempt_at=?, updated_at=? WHERE id=?",
            (status, error_code, next_attempt_at, utc_now(), attempt_id),
        )
        row = self.connection.execute("SELECT * FROM notification_attempts WHERE id=?", (attempt_id,)).fetchone()
        self.connection.execute(
            "UPDATE leads SET notification_status=?, updated_at=? WHERE id=?", (status, utc_now(), row["lead_id"])
        )
        self.connection.commit()
        return _row(row)

    def metrics(self) -> dict[str, int]:
        today = datetime.now(UTC).date().isoformat()
        scalar = lambda sql, params=(): int(self.connection.execute(sql, params).fetchone()[0] or 0)
        return {
            "groupsDiscovered": scalar("SELECT COUNT(*) FROM telegram_groups"),
            "groupsJoined": scalar("SELECT COUNT(*) FROM telegram_groups WHERE status IN ('JOINED','MONITORING')"),
            "groupsMonitored": scalar("SELECT COUNT(*) FROM monitored_groups WHERE enabled=1"),
            "messagesProcessedToday": scalar("SELECT COALESCE(SUM(messages_today), 0) FROM monitored_groups WHERE metrics_day=?", (today,)),
            "candidateMessages": scalar("SELECT COUNT(*) FROM message_candidates"),
            "leadsToday": scalar("SELECT COUNT(*) FROM leads WHERE created_at>=?", (today,)),
            "hotLeads": scalar("SELECT COUNT(*) FROM leads WHERE created_at>=? AND score>=90", (today,)),
            "aiQueue": scalar("SELECT COUNT(*) FROM message_candidates WHERE status='AI_PENDING'"),
            "notificationFailures": scalar("SELECT COUNT(*) FROM notification_attempts WHERE status='FAILED'"),
        }

    def close(self) -> None:
        self.connection.close()
