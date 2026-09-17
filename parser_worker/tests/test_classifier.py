import json
import unittest
from pathlib import Path

from parser_worker.classifier import (
    build_message_url,
    classify_fast,
    compute_group_score,
    detect_language,
    message_fingerprint,
    normalize_text,
)


class ClassifierTests(unittest.TestCase):
    def test_language_detection_supports_discovery_metadata(self):
        self.assertEqual(detect_language("SaaS founders"), "en")
        self.assertEqual(detect_language("Основатели стартапов"), "ru")
        self.assertEqual(detect_language("SaaS стартапы"), "mixed")

    def test_fixture_covers_buyer_seller_and_near_miss_classes(self):
        fixture = Path(__file__).parent / "fixtures" / "lead_messages.json"
        cases = json.loads(fixture.read_text(encoding="utf-8"))

        self.assertGreaterEqual(sum(case["expected"] == "BUYER" for case in cases), 20)
        self.assertGreaterEqual(sum(case["expected"] == "SELLER" for case in cases), 20)
        for case in cases:
            with self.subTest(text=case["text"]):
                self.assertEqual(classify_fast(case["text"])["class"], case["expected"])

    def test_normalization_is_stable_for_case_spacing_and_unicode(self):
        self.assertEqual(normalize_text("  НУЖЕН\n Telegram\tБОТ!  "), "нужен telegram бот!")

    def test_fingerprint_deduplicates_formatting_but_isolates_chat_and_author(self):
        first = message_fingerprint("Need   a Website", chat_id="1", author_id="2")
        second = message_fingerprint("need a website", chat_id="1", author_id="2")
        other_author = message_fingerprint("need a website", chat_id="1", author_id="3")
        self.assertEqual(first, second)
        self.assertNotEqual(first, other_author)

    def test_group_score_uses_relevance_type_activity_and_spam_not_members_alone(self):
        quality = compute_group_score({
            "title": "SaaS Founders Community",
            "username": "saas_founders",
            "type": "supergroup",
            "members": 4200,
            "language": "en",
            "activity_score": 82,
            "unique_authors": 45,
            "spam_ratio": 0.04,
            "seller_ratio": 0.08,
        }, query="saas founders")
        huge_spam = compute_group_score({
            "title": "Ads dump",
            "username": "ads_dump",
            "type": "channel",
            "members": 300000,
            "language": "en",
            "activity_score": 90,
            "unique_authors": 1,
            "spam_ratio": 0.92,
            "seller_ratio": 0.85,
        }, query="saas founders")

        self.assertGreaterEqual(quality["score"], 75)
        self.assertLess(huge_spam["score"], quality["score"])
        self.assertEqual(quality["confidence"], "OBSERVED")

    def test_message_url_is_only_created_for_a_valid_public_username(self):
        self.assertEqual(build_message_url("valid_group", 42), "https://t.me/valid_group/42")
        self.assertIsNone(build_message_url(None, 42))
        self.assertIsNone(build_message_url("bad/name", 42))
        self.assertIsNone(build_message_url("valid_group", 0))


if __name__ == "__main__":
    unittest.main()
