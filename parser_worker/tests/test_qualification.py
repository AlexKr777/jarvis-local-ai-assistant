import unittest
import json
from pathlib import Path

from parser_worker.qualification import (
    ContextSegment,
    build_qualification_route,
    default_qualification_settings,
    normalize_for_matching,
)


class QualificationRoutingTests(unittest.TestCase):
    def setUp(self):
        self.settings = default_qualification_settings()

    def route(self, current_text, *context):
        return build_qualification_route(
            [ContextSegment(kind="CURRENT_MESSAGE", text=current_text, author_relation="CURRENT_AUTHOR"), *context],
            self.settings,
        )

    def test_romanian_diacritics_match_without_changing_the_original_text(self):
        route = self.route("Căutăm un dezvoltator backend pentru un site web.")

        self.assertEqual(normalize_for_matching("Căutăm"), "cautam")
        self.assertEqual(route.gate, "STRONG_CONTEXT_GATE")
        self.assertIn("BACKEND", route.categories)

    def test_word_boundaries_do_not_match_bot_inside_an_unrelated_russian_word(self):
        route = self.route("Мы работаем с оплатой счетов, нужен совет бухгалтеру.")

        self.assertEqual(route.gate, "NO_CONTEXT_GATE")
        self.assertNotIn("TELEGRAM", route.categories)

    def test_explicit_request_for_enabled_service_reaches_strong_gate(self):
        route = self.route("Нужен разработчик сделать сайт для компании.")

        self.assertEqual(route.gate, "STRONG_CONTEXT_GATE")
        self.assertIn("WEBSITES", route.categories)

    def test_project_and_availability_reach_weak_gate_without_canonical_buyer_phrase(self):
        route = self.route("Есть Django проект. Кто свободен на пару недель?")

        self.assertEqual(route.gate, "WEAK_SEMANTIC_GATE")
        self.assertEqual(route.reason, "PROJECT_AVAILABILITY_WITH_ENABLED_DOMAIN")

    def test_reply_context_can_supply_the_service_for_a_current_execution_request(self):
        route = self.route(
            "Кто сможет это взять?",
            ContextSegment(
                kind="REPLIED_TO_MESSAGE",
                text="Нужно собрать Telegram Mini App и CRM integration.",
                author_relation="OTHER_AUTHOR",
            ),
        )

        self.assertEqual(route.gate, "STRONG_CONTEXT_GATE")
        self.assertIn("TELEGRAM", route.categories)

    def test_unrelated_low_specificity_engineering_vacancy_is_not_eligible(self):
        route = self.route("Hiring C++ embedded software engineer.")

        self.assertEqual(route.gate, "NO_CONTEXT_GATE")
        self.assertEqual(route.reason, "NO_ENABLED_SERVICE")

    def test_low_specificity_role_with_enabled_domain_reaches_ai(self):
        route = self.route("Hiring software engineer for our Django SaaS backend.")

        self.assertEqual(route.gate, "STRONG_CONTEXT_GATE")
        self.assertIn("BACKEND", route.categories)

    def test_isolated_technology_does_not_reach_ai(self):
        route = self.route("Django.")

        self.assertEqual(route.gate, "NO_CONTEXT_GATE")
        self.assertEqual(route.reason, "ISOLATED_TECHNOLOGY")

    def test_clear_self_advertising_is_rejected_without_calling_ai(self):
        route = self.route("I build websites and Telegram bots. DM me for a quote.")

        self.assertEqual(route.gate, "NEGATIVE_GATE")
        self.assertEqual(route.reason, "CLEAR_SELLER_AD")

    def test_usdt_exchange_and_payment_account_trade_are_rejected_before_ai(self):
        route = self.route(
            "We need a lot of USDT for INR. Buy USDT at 135 INR. "
            "Gaming accounts for PAYIN, mixed funds and prepaid USDT accepted. "
            "Visit our website for rates."
        )

        self.assertEqual(route.gate, "NEGATIVE_GATE")
        self.assertEqual(route.reason, "CLEAR_UNSAFE_FINANCIAL_EXCHANGE")

    def test_long_message_cannot_combine_distant_need_and_website_into_a_lead(self):
        route = self.route("Need USDT now. " + ("rate information " * 30) + "website")

        self.assertEqual(route.gate, "NO_CONTEXT_GATE")
        self.assertEqual(route.reason, "ISOLATED_TECHNOLOGY")

    def test_expanded_multilingual_vocabulary_routes_realistic_role_and_bot_requests(self):
        cases = [
            ("Ищем фронтендера React для редизайна сайта, бюджет есть.", "FULL_STACK"),
            ("Looking to hire a backend dev for a GraphQL API integration.", "BACKEND"),
            ("Căutăm pe cineva pentru un bot de Telegram, buget disponibil.", "TELEGRAM"),
        ]
        for text, category in cases:
            with self.subTest(text=text):
                route = self.route(text)
                self.assertEqual(route.gate, "STRONG_CONTEXT_GATE")
                self.assertIn(category, route.categories)

    def test_expanded_vocabulary_still_requires_bounded_request_context(self):
        for text in ("frontend developer", "Telegram bot", "integrare API"):
            with self.subTest(text=text):
                self.assertEqual(self.route(text).gate, "NO_CONTEXT_GATE")

    def test_golden_multilingual_routing_cases_keep_known_leads_and_noise_separate(self):
        fixture = Path(__file__).parent / "fixtures" / "multilingual_qualification.json"
        cases = json.loads(fixture.read_text(encoding="utf-8"))

        for case in cases:
            with self.subTest(case=case["name"]):
                route = self.route(case["text"])
                self.assertEqual(route.gate, case["expected_gate"])
                self.assertEqual(route.reason, case["expected_reason"])


if __name__ == "__main__":
    unittest.main()
