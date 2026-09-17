from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from typing import Any


DEFAULT_INTENT_PHRASES = (
    "looking for", "need", "need someone", "can anyone", "does anyone know", "recommend",
    "looking to hire", "who can", "want to build", "need help with", "looking for somebody",
    "can someone", "ищу", "нужен", "нужна", "нужно", "кто может", "кто умеет", "посоветуйте",
    "порекомендуйте", "хочу сделать", "хотим сделать", "нужно сделать", "нужно разработать",
    "кто возьмётся", "ищем того",
)

DEFAULT_SERVICE_PHRASES = (
    "website", "landing page", "web app", "developer", "telegram bot", "telegram mini app",
    "ecommerce", "shopify", "frontend", "backend", "dashboard", "admin panel", "mvp", "api",
    "integration", "payment integration", "crm", "booking",
    "сайт", "лендинг", "интернет-магазин", "разработчик", "программист", "бот", "telegram бот",
    "mini app", "веб-приложен", "админка", "crm", "api", "интеграция", "mvp", "backend",
    "frontend", "оплат",
)

SELLER_PHRASES = (
    "i'm a developer", "i am a developer", "full-stack developer available", "available for work",
    "available for projects", "offering services", "offering shopify", "my portfolio", "my services",
    "hire me", "message me for prices", "web developer here", "i build landing", "i can make your",
    "our agency offers", "i am available", "ready to help", "contact me for", "dm me",
    "я разработчик", "я программист", "предлагаю услуги", "мои услуги", "моё портфолио",
    "готов взять проект", "пишите в лс", "пишите в личку", "обращайтесь", "делаю лендинги",
    "оказываем услуги", "свободен для новых", "разрабатываю сайты", "возьму заказ",
)

JOB_SEEKER_PHRASES = (
    "looking for work", "seeking a backend position", "seeking a frontend position", "my cv",
    "open to work", "ищу работу", "рассмотрю вакансии", "рассматриваю предложения о работе",
)

HIRING_MARKERS = (
    "full-time", "full time", "permanent role", "salaried", "salary", "join our company",
    "in-house", "в штат", "полная занятость", "в команду", "вакансия", "оклад",
)

HIRING_INTENT = ("we are hiring", "we're hiring", "looking for", "ищем", "вакансия", "join our company")

SPAM_PHRASES = (
    "passive income", "guaranteed income", "airdrop", "seed phrase", "buy followers",
    "1000%", "без риска", "заработок без опыта", "высокий доход", "крипто схема",
)

DISCUSSION_PREFIXES = (
    "what ", "which ", "interesting ", "как думаете", "какой ", "кто-нибудь пробовал",
    "shopify or ",
)

USERNAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def _contains_any(text: str, phrases: tuple[str, ...] | list[str]) -> list[str]:
    return [phrase for phrase in phrases if normalize_text(phrase) in text]


def _language(text: str) -> str:
    cyrillic = len(re.findall(r"[а-яё]", text, re.IGNORECASE))
    latin = len(re.findall(r"[a-z]", text, re.IGNORECASE))
    if cyrillic and latin:
        return "mixed"
    return "ru" if cyrillic else "en" if latin else "unknown"


def detect_language(value: str) -> str:
    return _language(normalize_text(value))


def classify_fast(
    value: str,
    *,
    intent_phrases: tuple[str, ...] | list[str] = DEFAULT_INTENT_PHRASES,
    service_phrases: tuple[str, ...] | list[str] = DEFAULT_SERVICE_PHRASES,
    negative_phrases: tuple[str, ...] | list[str] = SELLER_PHRASES,
) -> dict[str, Any]:
    text = normalize_text(value)
    language = _language(text)
    service_matches = _contains_any(text, service_phrases)
    intent_matches = _contains_any(text, intent_phrases)

    if not text:
        label = "UNKNOWN"
        reason = "Empty message"
    elif _contains_any(text, SPAM_PHRASES) or re.search(r"https?://\S+", text) and _contains_any(text, ("cheap", "free", "доход")):
        label = "SPAM"
        reason = "Spam or scam signal"
    elif _contains_any(text, HIRING_MARKERS) and _contains_any(text, HIRING_INTENT):
        label = "HIRING"
        reason = "Employment or permanent-role intent"
    elif _contains_any(text, JOB_SEEKER_PHRASES):
        label = "JOB_SEEKER"
        reason = "Author is seeking employment"
    elif _contains_any(text, tuple(negative_phrases)):
        label = "SELLER"
        reason = "Author is offering development services"
    elif service_matches and intent_matches:
        label = "BUYER"
        reason = "Service need and buyer intent both detected"
    elif service_matches and (text.endswith("?") or any(text.startswith(prefix) for prefix in DISCUSSION_PREFIXES)):
        label = "DISCUSSION"
        reason = "Topic discussion without buyer intent"
    elif service_matches:
        label = "DISCUSSION"
        reason = "Development topic without buyer intent"
    else:
        label = "UNKNOWN"
        reason = "No lead intent detected"

    eligible = label == "BUYER"
    score = 0
    if eligible:
        score = 58 + min(18, len(intent_matches) * 8) + min(14, len(service_matches) * 5)
        if _contains_any(text, ("paid", "budget", "оплата", "срочно", "this week", "готов платить")):
            score += 10
        score = min(100, score)

    return {
        "class": label,
        "eligible": eligible,
        "score": score,
        "confidence": 0.92 if label in {"SELLER", "HIRING", "JOB_SEEKER", "SPAM"} else 0.78 if eligible else 0.55,
        "reason": reason,
        "language": language,
        "intentMatches": intent_matches,
        "serviceMatches": service_matches,
        "detectedNeed": ", ".join(service_matches[:4]),
    }


def message_fingerprint(value: str, *, chat_id: str | int, author_id: str | int) -> str:
    material = f"{chat_id}\x1f{author_id}\x1f{normalize_text(value)}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _query_relevance(group: dict[str, Any], query: str) -> float:
    haystack = normalize_text(f"{group.get('title', '')} {group.get('username', '')}")
    words = [word for word in normalize_text(query).split() if len(word) >= 2]
    if not words:
        return 0.0
    return sum(word in haystack for word in words) / len(words)


def compute_group_score(group: dict[str, Any], *, query: str = "") -> dict[str, Any]:
    group_type = str(group.get("type") or "").lower()
    members = max(0, int(group.get("members") or 0))
    activity = group.get("activity_score")
    authors = group.get("unique_authors")
    spam_ratio = group.get("spam_ratio")
    seller_ratio = group.get("seller_ratio")
    observed = any(value is not None for value in (activity, authors, spam_ratio, seller_ratio))

    score = 0.0
    signals: list[str] = []
    if group_type == "supergroup":
        score += 20
        signals.append("supergroup")
    elif group_type == "group":
        score += 17
        signals.append("group")
    elif group_type == "channel":
        score += 2
        signals.append("broadcast_channel")

    relevance = _query_relevance(group, query)
    score += 25 * relevance
    if relevance:
        signals.append("query_relevance")

    if members:
        score += min(15, max(3, math.log10(max(10, members)) * 3.8))
        signals.append("useful_member_count")
    if str(group.get("language") or "").lower() in {"en", "ru", "mixed"}:
        score += 5
    if activity is not None:
        score += min(15, max(0, float(activity)) * 0.15)
    if authors is not None:
        score += min(10, math.log2(max(1, int(authors))) * 1.8)
    if spam_ratio is not None:
        score += 5 * (1 - min(1, max(0, float(spam_ratio))))
        score -= 25 * max(0, float(spam_ratio) - 0.35)
    if seller_ratio is not None:
        score += 5 * (1 - min(1, max(0, float(seller_ratio))))
        score -= 20 * max(0, float(seller_ratio) - 0.30)

    return {
        "score": int(round(min(100, max(0, score)))),
        "confidence": "OBSERVED" if observed else "PRELIMINARY",
        "signals": signals,
    }


def build_message_url(username: str | None, message_id: int | str) -> str | None:
    clean = str(username or "").lstrip("@").strip()
    try:
        numeric_id = int(message_id)
    except (TypeError, ValueError):
        return None
    if numeric_id <= 0 or not USERNAME_PATTERN.fullmatch(clean):
        return None
    return f"https://t.me/{clean}/{numeric_id}"
