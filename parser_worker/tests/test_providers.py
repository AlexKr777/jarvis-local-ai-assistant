import io
import json
import urllib.error
import unittest
from unittest.mock import patch

from parser_worker.providers import (
    OpenRouterClassifier, ProviderError, ProviderHttpError, TelegramNotifier, format_notification,
)


def qualified_response(outcome="CLIENT_LEAD"):
    return {
        "outcome": outcome, "category": "WEBSITES", "requested_service": "website", "requested_role": None,
        "primary_language": "EN", "languages_detected": ["EN"], "confidence": 0.93,
        "reason": "Explicit request for a website.",
        "evidence": [{"quote": "Need a website", "segment": "CURRENT_MESSAGE"}],
        "project_summary": "Website request", "budget": None, "currency": None, "budget_min": None,
        "budget_max": None, "deadline": None, "project_duration": None, "employment_type": None,
        "contract_type": None, "work_mode": None, "location": None, "technologies": [], "company": None,
        "author_role": None, "contact_details": None,
    }


class Secrets:
    def __init__(self, **values):
        self.values = values

    def get(self, name):
        return self.values.get(name)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_openrouter_uses_strict_schema_and_validates_the_result(self):
        calls = []

        def post(url, headers, payload, timeout):
            calls.append((url, headers, payload, timeout))
            return {"choices": [{"message": {"content": json.dumps(qualified_response())}}]}

        provider = OpenRouterClassifier(
            {"aiModel": "test/model"}, Secrets(openrouter_key="openrouter-secret"), http_post=post
        )
        result = await provider.classify("Need a website", author_name="Ana", group_title="Founders")

        self.assertEqual(result["outcome"], "CLIENT_LEAD")
        payload = calls[0][2]
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertTrue(payload["response_format"]["json_schema"]["strict"])
        self.assertFalse(payload["response_format"]["json_schema"]["schema"]["additionalProperties"])
        evidence_schema = payload["response_format"]["json_schema"]["schema"]["properties"]["evidence"]["items"]
        self.assertEqual(evidence_schema["required"], ["quote", "segment"])
        self.assertFalse(evidence_schema["additionalProperties"])
        self.assertEqual(payload["provider"]["require_parameters"], True)
        self.assertEqual(payload["max_tokens"], 1200)
        self.assertIn("CLIENT_LEAD", payload["messages"][0]["content"])
        self.assertIn("qualification_context", payload["messages"][1]["content"])
        return
        self.assertIn(
            "Russian examples: 'ищу/нужен/нужна специалист' is BUYER; 'оказываю услуги/беру заказы' is SELLER.",
            payload["messages"][0]["content"],
        )
        self.assertNotIn("openrouter-secret", str(payload))

    async def test_openrouter_retries_explicit_unsupported_schema_once_in_strict_json_mode(self):
        calls = []
        valid = qualified_response()

        def post(url, headers, payload, timeout):
            calls.append(payload)
            if payload["response_format"]["type"] == "json_schema":
                raise ProviderHttpError(404, {"error": {
                    "message": "No endpoints found that can handle the requested parameters.", "code": 404,
                }})
            return {"choices": [{"message": {"content": json.dumps(valid)}}]}

        first = OpenRouterClassifier(
            {"aiModel": "test/schema-fallback-model"},
            Secrets(openrouter_key="openrouter-secret"), http_post=post,
        )
        second = OpenRouterClassifier(
            {"aiModel": "test/schema-fallback-model"},
            Secrets(openrouter_key="openrouter-secret"), http_post=post,
        )

        self.assertEqual((await first.classify("Need a Shopify store"))["outcome"], "CLIENT_LEAD")
        self.assertEqual((await second.classify("Need a Shopify store"))["outcome"], "CLIENT_LEAD")
        self.assertEqual([call["response_format"]["type"] for call in calls], [
            "json_schema", "json_object", "json_object",
        ])
        self.assertIn("requested_service", calls[1]["messages"][0]["content"])
        self.assertEqual(calls[1]["provider"]["require_parameters"], True)

    async def test_openrouter_retries_invalid_strict_output_once_with_json_object(self):
        calls = []

        def post(url, headers, payload, timeout):
            calls.append(payload)
            if payload["response_format"]["type"] == "json_schema":
                return {"choices": [{"message": {"content": '{"outcome": '}}]}
            return {"choices": [{"message": {"content": json.dumps(qualified_response())}}]}

        provider = OpenRouterClassifier(
            {"aiModel": "test/invalid-strict-output"},
            Secrets(openrouter_key="openrouter-secret"), http_post=post,
        )

        self.assertEqual((await provider.classify("Need a website"))["outcome"], "CLIENT_LEAD")
        self.assertEqual([call["response_format"]["type"] for call in calls], ["json_schema", "json_object"])

    async def test_openrouter_maps_expected_http_failures_to_sanitized_codes(self):
        cases = [
            (401, {"error": {"message": "User not found for openrouter-secret", "code": 401}},
             "OPENROUTER_API_KEY_INVALID", "OpenRouter API key is invalid or missing."),
            (404, {"error": {"message": "Model test/missing was not found", "code": 404}},
             "OPENROUTER_MODEL_NOT_FOUND", "The configured OpenRouter model was not found."),
            (402, {"error": {"message": "This request requires more credits", "code": 402}},
             "OPENROUTER_CREDITS_REQUIRED", "OpenRouter credits are insufficient for this classifier request."),
            (429, {"error": {"message": "Provider returned error", "code": 429}},
             "OPENROUTER_RATE_LIMITED", "OpenRouter rate limit reached. Try again shortly."),
            (503, {"error": {"message": "upstream diagnostic", "code": 503}},
             "OPENROUTER_PROVIDER_UNAVAILABLE", "The OpenRouter provider is temporarily unavailable."),
        ]
        for status, payload, code, message in cases:
            with self.subTest(code=code):
                def post(url, headers, request_payload, timeout, *, failure=ProviderHttpError(status, payload)):
                    raise failure

                provider = OpenRouterClassifier(
                    {"aiModel": f"test/{code.casefold()}"},
                    Secrets(openrouter_key="openrouter-secret"), http_post=post,
                )
                with self.assertRaises(ProviderError) as failure:
                    await provider.classify("Need a website")

                self.assertEqual(failure.exception.code, code)
                self.assertEqual(str(failure.exception), message)
                self.assertNotIn("openrouter-secret", str(failure.exception))
                self.assertNotIn("diagnostic", str(failure.exception))

    async def test_openrouter_reports_unsupported_schema_if_bounded_fallback_is_also_unsupported(self):
        calls = []

        def post(url, headers, payload, timeout):
            calls.append(payload["response_format"]["type"])
            raise ProviderHttpError(404, {"error": {
                "message": "No endpoints found that can handle the requested parameters.", "code": 404,
            }})

        provider = OpenRouterClassifier(
            {"aiModel": "test/no-structured-output"},
            Secrets(openrouter_key="openrouter-secret"), http_post=post,
        )
        with self.assertRaises(ProviderError) as failure:
            await provider.classify("Need a website")

        self.assertEqual(calls, ["json_schema", "json_object"])
        self.assertEqual(failure.exception.code, "OPENROUTER_STRUCTURED_OUTPUT_UNSUPPORTED")
        self.assertEqual(
            str(failure.exception),
            "The configured model does not support the required structured output.",
        )

    async def test_openrouter_maps_network_failure_without_exposing_diagnostics(self):
        def post(url, headers, payload, timeout):
            raise ProviderError("socket diagnostic", code="PROVIDER_UNAVAILABLE")

        provider = OpenRouterClassifier(
            {"aiModel": "test/network"}, Secrets(openrouter_key="openrouter-secret"), http_post=post,
        )
        with self.assertRaises(ProviderError) as failure:
            await provider.classify("Need a website")

        self.assertEqual(failure.exception.code, "OPENROUTER_UNREACHABLE")
        self.assertEqual(str(failure.exception), "OpenRouter could not be reached.")
        self.assertNotIn("diagnostic", str(failure.exception))

    async def test_openrouter_rejects_malformed_json_and_schema_violations(self):
        invalid_contents = [
            "not-json",
            json.dumps({
                "class": "BUYER", "lead_score": "91", "confidence": 0.93,
                "reason": "Explicit request", "detected_need": "website",
                "language": "en", "suggested_reply": "Hello",
            }),
            json.dumps({
                "class": "BUYER", "lead_score": 91, "confidence": 0.93,
                "reason": "Explicit request", "detected_need": "website", "language": "en",
            }),
            json.dumps({
                "class": "buyer", "lead_score": 91, "confidence": 0.93,
                "reason": "Explicit request", "detected_need": "website",
                "language": "en", "suggested_reply": "Hello",
            }),
            json.dumps({
                "class": "BUYER", "lead_score": 91, "confidence": 0.93,
                "reason": "r" * 501, "detected_need": "website",
                "language": "en", "suggested_reply": "Hello",
            }),
            json.dumps({
                "class": "BUYER", "lead_score": 91, "confidence": 0.93,
                "reason": "Explicit request", "detected_need": "n" * 301,
                "language": "en", "suggested_reply": "Hello",
            }),
            json.dumps({
                "class": "BUYER", "lead_score": 91, "confidence": 0.93,
                "reason": "Explicit request", "detected_need": "website",
                "language": "l" * 25, "suggested_reply": "Hello",
            }),
            json.dumps({
                "class": "BUYER", "lead_score": 91, "confidence": 0.93,
                "reason": "Explicit request", "detected_need": "website",
                "language": "en", "suggested_reply": "s" * 1201,
            }),
        ]
        for index, content in enumerate(invalid_contents):
            with self.subTest(index=index):
                def post(url, headers, payload, timeout, *, value=content):
                    return {"choices": [{"message": {"content": value}}]}

                provider = OpenRouterClassifier(
                    {"aiModel": f"test/invalid-{index}"},
                    Secrets(openrouter_key="openrouter-secret"), http_post=post,
                )
                with self.assertRaises(ProviderError) as failure:
                    await provider.classify("Need a website")
                self.assertEqual(failure.exception.code, "OPENROUTER_INVALID_CLASSIFICATION")
                self.assertEqual(
                    str(failure.exception),
                    "AI responded, but the classifier output did not match the required schema.",
                )

    async def test_openrouter_reports_each_missing_configuration_value(self):
        with self.assertRaises(ProviderError) as missing_key:
            await OpenRouterClassifier({"aiModel": "test/model"}, Secrets()).classify("Need a website")
        self.assertEqual(missing_key.exception.code, "OPENROUTER_API_KEY_NOT_CONFIGURED")
        self.assertEqual(str(missing_key.exception), "OpenRouter API key is invalid or missing.")

        with self.assertRaises(ProviderError) as missing_model:
            await OpenRouterClassifier({}, Secrets(openrouter_key="secret")).classify("Need a website")
        self.assertEqual(missing_model.exception.code, "OPENROUTER_MODEL_NOT_CONFIGURED")
        self.assertEqual(str(missing_model.exception), "Configure an OpenRouter model first.")

    async def test_openrouter_test_returns_only_safe_validated_result_metadata(self):
        def post(url, headers, payload, timeout):
            return {"choices": [{"message": {"content": json.dumps(qualified_response())}}]}

        provider = OpenRouterClassifier(
            {"aiModel": "test/result"}, Secrets(openrouter_key="openrouter-secret"), http_post=post,
        )
        result = await provider.test()

        self.assertEqual(set(result), {"connected", "model", "outcome", "schemaValidated", "latencyMs"})
        self.assertEqual(result["outcome"], "CLIENT_LEAD")
        self.assertTrue(result["schemaValidated"])
        self.assertGreaterEqual(result["latencyMs"], 0)
        self.assertNotIn("openrouter-secret", str(result))

    async def test_openrouter_preserves_http_failure_instead_of_parsing_it_as_a_classification(self):
        body = io.BytesIO(json.dumps({
            "error": {"message": "Unauthorized: openrouter-secret"},
        }).encode("utf-8"))
        response = urllib.error.HTTPError(
            "https://openrouter.ai/api/v1/chat/completions", 401, "Unauthorized", {}, body,
        )
        provider = OpenRouterClassifier(
            {"aiModel": "test/model"}, Secrets(openrouter_key="openrouter-secret")
        )

        with patch("parser_worker.providers.urllib.request.urlopen", side_effect=response):
            with self.assertRaises(ProviderError) as failure:
                await provider.classify("Need a website")

        self.assertEqual(getattr(failure.exception, "code", None), "OPENROUTER_API_KEY_INVALID")
        self.assertEqual(str(failure.exception), "OpenRouter API key is invalid or missing.")
        self.assertNotIn("openrouter-secret", str(failure.exception))

    async def test_notification_targets_only_configured_destination_and_adds_valid_original_link(self):
        calls = []

        def post(url, headers, payload, timeout):
            calls.append((url, payload))
            return {"ok": True, "result": {"message_id": 88, "username": "jarvis_bot"}}

        notifier = TelegramNotifier(
            Secrets(bot_token="bot-secret", destination_id="main-account"), http_post=post
        )
        result = await notifier.send_lead({
            "score": 94, "detectedNeed": "Website + booking", "groupTitle": "Restaurant Owners",
            "authorUsername": "buyer", "messageText": "Can anyone recommend a developer?",
            "reason": "Explicit buyer intent", "originalMessageUrl": "https://t.me/owners/42",
        })

        self.assertEqual(result["messageId"], 88)
        self.assertEqual(calls[0][1]["chat_id"], "main-account")
        self.assertNotEqual(calls[0][1]["chat_id"], "buyer")
        self.assertEqual(calls[0][1]["reply_markup"]["inline_keyboard"][0][0]["url"], "https://t.me/owners/42")
        self.assertNotIn("bot-secret", str(calls[0][1]))

    async def test_notification_maps_invalid_token_without_exposing_it(self):
        def post(url, headers, payload, timeout):
            return {"ok": False, "error_code": 401, "description": "Unauthorized"}

        notifier = TelegramNotifier(
            Secrets(bot_token="secret-invalid-token", destination_id="100"), http_post=post
        )
        with self.assertRaises(ProviderError) as failure:
            await notifier.test()

        self.assertEqual(getattr(failure.exception, "code", None), "BOT_TOKEN_INVALID")
        self.assertEqual(str(failure.exception), "Bot token is invalid.")
        self.assertNotIn("secret-invalid-token", str(failure.exception))

    async def test_notification_maps_actual_http_401_response(self):
        body = io.BytesIO(json.dumps({
            "ok": False, "error_code": 401, "description": "Unauthorized",
        }).encode("utf-8"))
        response = urllib.error.HTTPError(
            "https://api.telegram.org/redacted", 401, "Unauthorized", {}, body,
        )
        notifier = TelegramNotifier(Secrets(bot_token="bot-secret", destination_id="100"))

        with patch("parser_worker.providers.urllib.request.urlopen", side_effect=response):
            with self.assertRaises(ProviderError) as failure:
                await notifier.test()

        self.assertEqual(getattr(failure.exception, "code", None), "BOT_TOKEN_INVALID")
        self.assertEqual(str(failure.exception), "Bot token is invalid.")

    async def test_notification_maps_http_401_even_when_error_body_is_not_json(self):
        response = urllib.error.HTTPError(
            "https://api.telegram.org/redacted", 401, "Unauthorized", {}, io.BytesIO(b"not-json"),
        )
        notifier = TelegramNotifier(Secrets(bot_token="bot-secret", destination_id="100"))

        with patch("parser_worker.providers.urllib.request.urlopen", side_effect=response):
            with self.assertRaises(ProviderError) as failure:
                await notifier.test()

        self.assertEqual(getattr(failure.exception, "code", None), "BOT_TOKEN_INVALID")
        self.assertEqual(str(failure.exception), "Bot token is invalid.")

    async def test_notification_maps_missing_destination_chat(self):
        def post(url, headers, payload, timeout):
            if url.endswith("/getMe"):
                return {"ok": True, "result": {"username": "jarvis_bot"}}
            return {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"}

        notifier = TelegramNotifier(
            Secrets(bot_token="bot-secret", destination_id="missing-chat"), http_post=post
        )
        with self.assertRaises(ProviderError) as failure:
            await notifier.test()

        self.assertEqual(getattr(failure.exception, "code", None), "DESTINATION_NOT_FOUND")
        self.assertEqual(
            str(failure.exception),
            "Destination chat was not found. Start the bot from your main account and verify the destination ID.",
        )

    async def test_notification_maps_network_failure_to_temporary_unavailability(self):
        def post(url, headers, payload, timeout):
            raise urllib.error.URLError("offline")

        notifier = TelegramNotifier(
            Secrets(bot_token="bot-secret", destination_id="100"), http_post=post
        )
        with self.assertRaises(ProviderError) as failure:
            await notifier.test()

        self.assertEqual(getattr(failure.exception, "code", None), "TELEGRAM_API_UNAVAILABLE")
        self.assertEqual(str(failure.exception), "Telegram Bot API is temporarily unavailable.")

    def test_notification_formatter_is_bounded_and_contains_human_context(self):
        text = format_notification({
            "score": 72, "detectedNeed": "API integration", "groupTitle": "Founders",
            "authorName": "Ivan", "messageText": "x" * 5000, "reason": "Buyer asks for help",
        })
        self.assertIn("WARM LEAD", text)
        self.assertIn("API integration", text)
        self.assertLessEqual(len(text), 3900)


if __name__ == "__main__":
    unittest.main()
