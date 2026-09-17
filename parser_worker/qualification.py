"""Deterministic, auditable routing before AI lead qualification.

This module deliberately does not make a final commercial decision.  It only
answers whether a bounded set of Telegram text/context supplies enough
evidence to send a message to the schema-validated AI classifier.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable


VOCABULARY_VERSION = "2026-09-01.3"
CONFIGURATION_VERSION = "2026-09-01.1"


@dataclass(frozen=True)
class ContextSegment:
    """A clearly-labelled, bounded piece of conversational evidence."""

    kind: str
    text: str
    author_relation: str
    chat_id: str | None = None
    message_id: int | None = None
    author_id: str | None = None


@dataclass(frozen=True)
class VocabularyEntry:
    signal_type: str
    canonical_concept: str
    category: str | None
    language: str
    variant: str
    specificity: str = "HIGH_SPECIFICITY"
    match_mode: str = "whole_word"


@dataclass(frozen=True)
class Signal:
    signal_type: str
    canonical_concept: str
    category: str | None
    language: str
    specificity: str
    matched_text: str
    start: int
    end: int
    context_kind: str
    context_message_id: int | None


@dataclass(frozen=True)
class QualificationRoute:
    gate: str
    reason: str
    categories: tuple[str, ...]
    primary_language: str
    languages_detected: tuple[str, ...]
    signals: tuple[Signal, ...]
    vocabulary_version: str
    configuration_version: str


def normalize_for_matching(value: str | None) -> str:
    """Return a matching-only representation; callers retain original text."""
    value = unicodedata.normalize("NFKC", value or "").casefold()
    value = value.replace("ё", "е")
    value = "".join(
        character
        for character in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(character)
    )
    value = re.sub(r"[‐‑‒–—―_-]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def default_qualification_settings() -> dict:
    """Versioned qualification defaults; persistence exposes these as settings."""
    return {
        "vocabularyVersion": VOCABULARY_VERSION,
        "configurationVersion": CONFIGURATION_VERSION,
        "enabledCategories": (
            "WEBSITES",
            "WEB_APPLICATIONS",
            "BACKEND",
            "FULL_STACK",
            "API_INTEGRATIONS",
            "TELEGRAM",
            "AUTOMATION",
            "ADMIN_TOOLS",
            "PAYMENTS_COMMERCE",
        ),
        "maxSignalDistanceChars": 240,
        "maxContextWindowChars": 360,
        "sameAuthorContextMessageLimit": 2,
        "sameAuthorContextTimeWindowSeconds": 1200,
    }


def _entries(signal_type: str, concept: str, category: str | None, language: str,
             variants: Iterable[str], specificity: str = "HIGH_SPECIFICITY") -> list[VocabularyEntry]:
    return [VocabularyEntry(signal_type, concept, category, language, phrase, specificity) for phrase in variants]


def default_vocabulary() -> tuple[VocabularyEntry, ...]:
    entries: list[VocabularyEntry] = []

    entries += _entries("buyer_intent", "DIRECT_SEARCH", None, "RU", ["ищу", "ищем", "нужен", "нужна", "нужны", "нужно", "требуется", "нужен подрядчик", "нужен исполнитель"])
    entries += _entries("buyer_intent", "DIRECT_SEARCH", None, "EN", ["need", "looking for", "need someone", "need a", "need an", "contractor needed", "freelancer needed"])
    entries += _entries("buyer_intent", "DIRECT_SEARCH", None, "RO", ["caut", "cautam", "am nevoie de", "ne trebuie", "avem nevoie de"])
    entries += _entries("execution", "EXECUTION_REQUEST", None, "RU", ["кто сделает", "кто сможет", "кто может", "кто возьмется", "надо реализовать", "нужно собрать"])
    entries += _entries("execution", "EXECUTION_REQUEST", None, "EN", ["who can build", "who can make", "who can take this", "can anyone build", "can someone build", "need to implement"])
    entries += _entries("execution", "EXECUTION_REQUEST", None, "RO", ["cine poate face", "cine se poate ocupa", "trebuie realizat"])
    entries += _entries("recommendation", "RECOMMENDATION", None, "RU", ["посоветуйте", "порекомендуйте", "кто знает человека"])
    entries += _entries("recommendation", "RECOMMENDATION", None, "EN", ["recommend a developer", "any recommendations", "recommend someone"])
    entries += _entries("recommendation", "RECOMMENDATION", None, "RO", ["recomandati un dezvoltator", "recomandati pe cineva"])
    entries += _entries("employer_intent", "HIRING", None, "RU", ["вакансия", "в штат", "ищем в команду", "нанимаем"])
    entries += _entries("employer_intent", "HIRING", None, "EN", ["we are hiring", "hiring", "job opening", "join our team", "recruiting"])
    entries += _entries("employer_intent", "HIRING", None, "RO", ["angajam", "post vacant", "pozitie deschisa", "loc de munca"])
    entries += _entries("project_context", "PROJECT", None, "RU", ["есть проект", "есть задача", "оплачиваемый проект", "кто свободен", "на пару недель"])
    entries += _entries("project_context", "PROJECT", None, "EN", ["have a project", "project available", "paid project", "anyone available", "available next week"])
    entries += _entries("project_context", "PROJECT", None, "RO", ["am un proiect", "avem un proiect", "proiect platit", "cine este disponibil"])
    entries += _entries("negative", "SELLER_AD", None, "EN", ["i build", "our agency offers", "my portfolio", "available for projects", "dm me for", "dm me if you need", "my services include"])
    entries += _entries("negative", "SELLER_AD", None, "RU", ["делаю сайты", "предлагаю услуги", "мое портфолио", "готов взять проект", "пишите в личку"])
    entries += _entries("negative", "JOB_SEEKER", None, "EN", ["looking for work", "my cv", "open to work", "seeking a position"])
    entries += _entries("negative", "JOB_SEEKER", None, "RU", ["ищу работу", "рассмотрю вакансии", "мое резюме"])
    entries += _entries("negative", "SPAM", None, "EN", ["guaranteed passive income", "airdrop", "seed phrase"])
    # These are commercial exchange/account-trading messages, not requests
    # for legitimate software work. Keep the phrases contextual so a normal
    # request to integrate a cryptocurrency payment method is still eligible.
    entries += _entries("negative", "UNSAFE_FINANCIAL_EXCHANGE", None, "EN", [
        "buy usdt", "sell usdt", "usdt to inr", "inr to usdt", "prepaid usdt",
        "mixed funds", "fraudulent fund", "hacker fund", "gaming accounts for payin",
        "bank accounts for payin", "bank card merchants",
    ])
    entries += _entries("negative", "SPAM", None, "RU", ["заработок без опыта", "крипто схема"])

    entries += _entries("service", "WEBSITES", "WEBSITES", "RU", ["сайт", "веб сайт", "лендинг", "интернет магазин"])
    entries += _entries("service", "WEBSITES", "WEBSITES", "EN", ["website", "web site", "landing page", "online store", "ecommerce website"])
    entries += _entries("service", "WEBSITES", "WEBSITES", "RO", ["site", "site web", "pagina web", "landing page", "magazin online"])
    entries += _entries("service", "WEB_APPLICATIONS", "WEB_APPLICATIONS", "RU", ["веб приложение", "личный кабинет", "платформа", "саас", "mvp"])
    entries += _entries("service", "WEB_APPLICATIONS", "WEB_APPLICATIONS", "EN", ["web app", "web application", "client portal", "platform", "saas", "mvp"])
    entries += _entries("service", "WEB_APPLICATIONS", "WEB_APPLICATIONS", "RO", ["aplicatie web", "platforma web", "portal client", "saas", "mvp"])
    entries += _entries("service", "BACKEND", "BACKEND", "RU", ["бэкенд", "бэкендер", "django", "fastapi", "python разработчик", "бэкенд разработчик"])
    entries += _entries("service", "BACKEND", "BACKEND", "EN", ["backend", "backend developer", "python developer", "django developer", "fastapi", "server side development"])
    entries += _entries("service", "BACKEND", "BACKEND", "RO", ["backend", "dezvoltator backend", "programator python", "django", "fastapi"])
    entries += _entries("service", "FULL_STACK", "FULL_STACK", "RU", ["фулстек", "фулстек разработчик", "веб разработчик"])
    entries += _entries("service", "FULL_STACK", "FULL_STACK", "EN", ["full stack", "fullstack", "full stack developer", "web developer"])
    entries += _entries("service", "FULL_STACK", "FULL_STACK", "RO", ["full stack", "dezvoltator full stack", "dezvoltator web"])
    entries += _entries("service", "API_INTEGRATIONS", "API_INTEGRATIONS", "RU", ["интеграция", "интеграция crm", "api", "webhook"])
    entries += _entries("service", "API_INTEGRATIONS", "API_INTEGRATIONS", "EN", ["api integration", "crm integration", "third party integration", "webhook integration"])
    entries += _entries("service", "API_INTEGRATIONS", "API_INTEGRATIONS", "RO", ["integrare api", "integrare crm", "webhook"])
    entries += _entries("service", "TELEGRAM", "TELEGRAM", "RU", ["telegram бот", "телеграм бот", "тг бот", "бот в telegram", "чат бот", "mini app", "мини приложение telegram"])
    entries += _entries("service", "TELEGRAM", "TELEGRAM", "EN", ["telegram bot", "tg bot", "bot for telegram", "telegram chatbot", "telegram mini app", "mini app"])
    entries += _entries("service", "TELEGRAM", "TELEGRAM", "RO", ["bot telegram", "bot pe telegram", "chatbot telegram", "mini aplicatie telegram"])
    entries += _entries("service", "AUTOMATION", "AUTOMATION", "RU", ["автоматизация", "автоматизация crm", "парсер"])
    entries += _entries("service", "AUTOMATION", "AUTOMATION", "EN", ["automation", "business automation", "workflow automation", "parser", "legitimate scraper"])
    entries += _entries("service", "AUTOMATION", "AUTOMATION", "RO", ["automatizare", "automatizare crm", "flux de lucru", "parser"])
    entries += _entries("service", "ADMIN_TOOLS", "ADMIN_TOOLS", "RU", ["админка", "админ панель", "дашборд", "внутренний инструмент"])
    entries += _entries("service", "ADMIN_TOOLS", "ADMIN_TOOLS", "EN", ["admin panel", "dashboard", "internal tool", "backoffice", "crm interface"])
    entries += _entries("service", "ADMIN_TOOLS", "ADMIN_TOOLS", "RO", ["panou de administrare", "dashboard", "instrument intern", "backoffice"])
    entries += _entries("service", "PAYMENTS_COMMERCE", "PAYMENTS_COMMERCE", "RU", ["интеграция оплаты", "платежная система", "чекаут", "подписки"])
    entries += _entries("service", "PAYMENTS_COMMERCE", "PAYMENTS_COMMERCE", "EN", ["payment integration", "payment gateway", "checkout", "subscription billing", "stripe integration", "ecommerce integration"])
    entries += _entries("service", "PAYMENTS_COMMERCE", "PAYMENTS_COMMERCE", "RO", ["integrare plati", "gateway de plata", "checkout", "abonamente"])
    entries += _entries("role", "GENERIC_ENGINEER", "FULL_STACK", "RU", ["разработчик", "программист"], "LOW_SPECIFICITY")
    entries += _entries("role", "GENERIC_ENGINEER", "FULL_STACK", "EN", ["developer", "programmer", "software developer", "software engineer"], "LOW_SPECIFICITY")
    entries += _entries("role", "GENERIC_ENGINEER", "FULL_STACK", "RO", ["dezvoltator", "programator", "inginer software"], "LOW_SPECIFICITY")
    # Expanded practical vocabulary.  These are structured signals, never a
    # standalone notification list: a service still needs bounded request,
    # hiring, execution, recommendation, or project evidence before AI runs.
    entries += _entries("buyer_intent", "DIRECT_SEARCH", None, "RU", ["ищем специалиста", "ищем исполнителя", "ищем человека", "ищем фронтендера", "ищем бэкендера", "ищем react разработчика", "нужен специалист", "нужна команда", "нужна помощь", "кто готов взяться", "кто готов сделать", "нужен фрилансер", "нужно разработать", "нужно сделать", "хочу сделать", "хотим сделать", "нужен разработчик", "нужен программист"])
    entries += _entries("buyer_intent", "DIRECT_SEARCH", None, "EN", ["looking to hire", "looking for somebody", "looking for a developer", "need help with", "need a developer", "need an engineer", "can anyone", "can someone", "does anyone know", "who can", "want to build", "want to create", "we need help", "seeking a contractor"])
    entries += _entries("buyer_intent", "DIRECT_SEARCH", None, "RO", ["caut un dezvoltator", "cautam un dezvoltator", "cautam pe cineva", "avem nevoie de ajutor", "ne trebuie un programator", "cine ma poate ajuta", "cine ne poate ajuta", "recomandati un programator"])
    entries += _entries("execution", "EXECUTION_REQUEST", None, "RU", ["кто напишет", "кто разработает", "кто реализует", "кто сможет собрать", "надо сделать", "надо разработать", "надо запустить", "нужно внедрить", "нужно настроить"])
    entries += _entries("execution", "EXECUTION_REQUEST", None, "EN", ["who can develop", "who can implement", "who can create", "can anyone make", "can someone develop", "need to build", "need to develop", "need to create", "need to launch", "help us build"])
    entries += _entries("execution", "EXECUTION_REQUEST", None, "RO", ["cine poate dezvolta", "cine poate implementa", "cine poate crea", "trebuie facut", "trebuie dezvoltat", "avem nevoie sa construim"])
    entries += _entries("employer_intent", "HIRING", None, "RU", ["открыта вакансия", "ищем разработчика", "ищем программиста", "нужен в команду", "требуется разработчик", "ищем на проект", "ищем в штат", "нанимаем разработчика"])
    entries += _entries("employer_intent", "HIRING", None, "EN", ["we're hiring", "hiring a developer", "hiring a contractor", "developer wanted", "developer needed", "contract position", "paid role", "remote role", "join the team"])
    entries += _entries("employer_intent", "HIRING", None, "RO", ["angajam un dezvoltator", "cautam dezvoltator", "post pentru dezvoltator", "pozitie remote", "colaborare platita", "contract de munca"])
    entries += _entries("project_context", "PROJECT", None, "RU", ["есть бюджет", "бюджет", "оплата", "оплатим", "срок", "дедлайн", "срочный проект", "проект на месяц", "проект на неделю", "техническое задание", "тз"])
    entries += _entries("project_context", "PROJECT", None, "EN", ["budget", "paid work", "we will pay", "deadline", "timeframe", "urgent project", "short term project", "long term project", "scope of work", "project brief", "specification"])
    entries += _entries("project_context", "PROJECT", None, "RO", ["buget", "platim", "proiect remunerat", "termen limita", "urgent", "pe termen scurt", "pe termen lung", "specificatie", "cerinte"])
    entries += _entries("negative", "SELLER_AD", None, "EN", ["i am a developer", "i'm a developer", "i offer", "we offer", "hire me", "for hire", "my agency", "contact me for", "my rates", "portfolio link"])
    entries += _entries("negative", "SELLER_AD", None, "RO", ["ofer servicii", "sunt dezvoltator", "angajati ma", "portofoliul meu", "scrieti mi in privat"])
    entries += _entries("negative", "JOB_SEEKER", None, "RO", ["caut de lucru", "caut un loc de munca", "sunt disponibil pentru lucru", "cv ul meu", "sunt in cautarea unui job"])
    entries += _entries("service", "WEBSITES", "WEBSITES", "RU", ["сайт визитка", "корпоративный сайт", "редизайн сайта", "доработка сайта", "интернет магазин", "вебсайт", "лендос", "ленд"])
    entries += _entries("service", "WEBSITES", "WEBSITES", "EN", ["corporate website", "business website", "website redesign", "website development", "webshop", "e commerce site", "landing", "landing site"])
    entries += _entries("service", "WEBSITES", "WEBSITES", "RO", ["pagina de prezentare", "site de companie", "refacere site", "dezvoltare site", "magazin ecommerce"])
    entries += _entries("service", "WEB_APPLICATIONS", "WEB_APPLICATIONS", "RU", ["веб приложение", "онлайн платформа", "crm система", "кабинет клиента", "сервис", "маркетплейс"])
    entries += _entries("service", "WEB_APPLICATIONS", "WEB_APPLICATIONS", "EN", ["online platform", "customer portal", "member portal", "crm system", "marketplace", "dashboard app", "startup mvp"])
    entries += _entries("service", "WEB_APPLICATIONS", "WEB_APPLICATIONS", "RO", ["aplicatie online", "platforma online", "portal pentru clienti", "sistem crm", "marketplace", "tablou de bord"])
    entries += _entries("service", "BACKEND", "BACKEND", "RU", ["бэкенд разработчик", "бекенд", "бекендер", "бекенд разработчик", "python разработчик", "питон разработчик", "django разработчик", "fastapi разработчик", "node js разработчик", "golang разработчик", "серверная часть"])
    entries += _entries("service", "BACKEND", "BACKEND", "EN", ["backend dev", "backend engineer", "python dev", "django dev", "fastapi developer", "node developer", "node js developer", "golang developer", "go developer", "server side", "rest api developer", "graphql developer"])
    entries += _entries("service", "BACKEND", "BACKEND", "RO", ["backend developer", "developer backend", "programator backend", "dezvoltator python", "developer django", "developer fastapi", "node js developer", "partea de server"])
    entries += _entries("service", "FULL_STACK", "FULL_STACK", "RU", ["фуллстек", "full stack разработчик", "веб разработчик", "web разработчик", "фронтенд разработчик", "фронтендер", "фронтендера", "frontend разработчик", "react разработчик", "next js разработчик", "vue разработчик"])
    entries += _entries("service", "FULL_STACK", "FULL_STACK", "EN", ["fullstack developer", "web dev", "frontend developer", "front end developer", "frontend dev", "react developer", "next js developer", "nextjs developer", "vue developer", "javascript developer", "typescript developer"])
    entries += _entries("service", "FULL_STACK", "FULL_STACK", "RO", ["frontend developer", "dezvoltator frontend", "developer web", "programator web", "dezvoltator react", "dezvoltator javascript"])
    entries += _entries("service", "API_INTEGRATIONS", "API_INTEGRATIONS", "RU", ["интеграция api", "апи интеграция", "интеграция с crm", "интеграция с 1с", "интеграция платежей", "rest api", "graphql", "вебхук", "подключить api"])
    entries += _entries("service", "API_INTEGRATIONS", "API_INTEGRATIONS", "EN", ["api", "rest api", "graphql", "webhook", "integration developer", "connect api", "zapier integration", "make integration", "hubspot integration", "salesforce integration"])
    entries += _entries("service", "API_INTEGRATIONS", "API_INTEGRATIONS", "RO", ["integrare cu crm", "integrare plati", "rest api", "graphql", "conectare api", "integrare webhook"])
    entries += _entries("service", "TELEGRAM", "TELEGRAM", "RU", ["телеграм бот", "telegram bot", "тг бот", "tg bot", "бот для телеграм", "бот в тг", "бот в телеграм", "тгшный бот", "телеграм мини апп", "mini app telegram", "телеграм мини приложение", "telegram web app"])
    entries += _entries("service", "TELEGRAM", "TELEGRAM", "EN", ["telegrambot", "telegram bot developer", "tg bot developer", "telegram automation", "telegram miniapp", "tg mini app", "telegram webapp", "telegram web app"])
    entries += _entries("service", "TELEGRAM", "TELEGRAM", "RO", ["bot de telegram", "bot tg", "bot pentru telegram", "dezvoltator telegram", "mini app telegram", "aplicatie telegram"])
    return tuple(entries)


def _phrase_pattern(phrase: str) -> re.Pattern[str]:
    return re.compile(r"(?<!\w)" + re.escape(normalize_for_matching(phrase)) + r"(?!\w)")


def extract_signals(segments: Iterable[ContextSegment], vocabulary: Iterable[VocabularyEntry] | None = None) -> tuple[Signal, ...]:
    vocabulary = tuple(vocabulary or default_vocabulary())
    signals: list[Signal] = []
    for segment in segments:
        normalized = normalize_for_matching(segment.text)
        for entry in vocabulary:
            for match in _phrase_pattern(entry.variant).finditer(normalized):
                signals.append(Signal(
                    signal_type=entry.signal_type,
                    canonical_concept=entry.canonical_concept,
                    category=entry.category,
                    language=entry.language,
                    specificity=entry.specificity,
                    matched_text=match.group(0),
                    start=match.start(),
                    end=match.end(),
                    context_kind=segment.kind,
                    context_message_id=segment.message_id,
                ))
    return tuple(signals)


def _languages(signals: Iterable[Signal]) -> tuple[str, tuple[str, ...]]:
    detected = tuple(dict.fromkeys(signal.language for signal in signals if signal.language != "LANGUAGE_NEUTRAL"))
    return (detected[0] if detected else "UNKNOWN", detected)


def _signals_are_contextually_linked(first: Signal, second: Signal, max_distance: int) -> bool:
    """Only combine evidence that belongs to one bounded conversational unit."""
    if first.context_kind == second.context_kind and first.context_message_id == second.context_message_id:
        distance = max(first.start, second.start) - min(first.end, second.end)
        return distance <= max_distance
    permitted_contexts = {"CURRENT_MESSAGE", "REPLIED_TO_MESSAGE", "SAME_AUTHOR_PREVIOUS_MESSAGE"}
    return first.context_kind in permitted_contexts and second.context_kind in permitted_contexts


def build_qualification_route(segments: Iterable[ContextSegment], settings: dict | None = None) -> QualificationRoute:
    """Apply only deterministic gates; the caller sends strong/weak routes to AI."""
    settings = settings or default_qualification_settings()
    signals = extract_signals(segments)
    primary_language, languages = _languages(signals)
    enabled = set(settings["enabledCategories"])
    high_services = [
        signal for signal in signals
        if signal.category in enabled and signal.specificity == "HIGH_SPECIFICITY"
    ]
    categories = tuple(dict.fromkeys(signal.category for signal in high_services if signal.category))
    negative_current = [signal for signal in signals if signal.signal_type == "negative" and signal.context_kind == "CURRENT_MESSAGE"]
    signal_types = {signal.signal_type for signal in signals}
    direct_signals = [signal for signal in signals if signal.signal_type in {"buyer_intent", "employer_intent", "execution", "recommendation"}]
    # A generic word such as "need" inside "DM me if you need a website" is
    # part of an advert, not buyer intent. It must not cancel that clear route.
    direct_signals = [
        signal for signal in direct_signals
        if not any(
            negative.context_kind == signal.context_kind and negative.start < signal.end and signal.start < negative.end
            for negative in negative_current
        )
    ]
    direct_service_linked = any(
        _signals_are_contextually_linked(intent, service, settings["maxSignalDistanceChars"])
        for intent in direct_signals for service in high_services
    )
    project_service_linked = any(
        _signals_are_contextually_linked(project, service, settings["maxSignalDistanceChars"])
        for project in signals if project.signal_type == "project_context"
        for service in high_services
    )
    blocking_negative = next(
        (
            signal for signal in negative_current
            if signal.canonical_concept in {"SPAM", "UNSAFE_FINANCIAL_EXCHANGE"}
        ),
        None,
    )
    has_direct_intent = bool(direct_signals)
    has_project_context = "project_context" in signal_types

    if blocking_negative:
        gate, reason = "NEGATIVE_GATE", f"CLEAR_{blocking_negative.canonical_concept}"
    elif negative_current and not (direct_service_linked or project_service_linked):
        gate, reason = "NEGATIVE_GATE", f"CLEAR_{negative_current[0].canonical_concept}"
    elif high_services and direct_service_linked:
        gate, reason = "STRONG_CONTEXT_GATE", "INTENT_WITH_ENABLED_DOMAIN"
    elif high_services and project_service_linked:
        gate, reason = "WEAK_SEMANTIC_GATE", "PROJECT_AVAILABILITY_WITH_ENABLED_DOMAIN"
    elif high_services:
        gate, reason = "NO_CONTEXT_GATE", "ISOLATED_TECHNOLOGY"
    elif any(signal.signal_type == "role" and signal.specificity == "LOW_SPECIFICITY" for signal in signals):
        gate, reason = "NO_CONTEXT_GATE", "NO_ENABLED_SERVICE"
    elif has_direct_intent or has_project_context:
        gate, reason = "NO_CONTEXT_GATE", "NO_ENABLED_SERVICE"
    else:
        gate, reason = "NO_CONTEXT_GATE", "NO_INTENT"

    return QualificationRoute(
        gate=gate,
        reason=reason,
        categories=categories,
        primary_language=primary_language,
        languages_detected=languages,
        signals=signals,
        vocabulary_version=settings["vocabularyVersion"],
        configuration_version=settings["configurationVersion"],
    )
