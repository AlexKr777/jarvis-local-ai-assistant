from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import statistics
import sys
from time import perf_counter
from typing import Any, Callable
import wave


class CorpusError(ValueError):
    pass


@dataclass(frozen=True)
class Candidate:
    name: str
    engine: str
    model: str
    device: str
    compute_type: str


CANDIDATES = {
    "current": Candidate("current", "faster-whisper", "small", "cpu", "int8"),
    "turbo": Candidate("turbo", "faster-whisper", "turbo", "cuda", "float16"),
    "large-v3": Candidate("large-v3", "faster-whisper", "large-v3", "cuda", "float16"),
    "gigaam-v3-rnnt": Candidate("gigaam-v3-rnnt", "gigaam", "v3_e2e_rnnt", "cuda", "float16"),
}


def normalize_text(value: str) -> str:
    return " ".join(re.findall(r"[a-zа-яё0-9]+", value.casefold(), flags=re.IGNORECASE))


def edit_distance(left: list[str], right: list[str]) -> int:
    previous = list(range(len(right) + 1))
    for row, left_item in enumerate(left, start=1):
        current = [row]
        for column, right_item in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (left_item != right_item),
            ))
        previous = current
    return previous[-1]


def detect_intent(text: str) -> str:
    normalized = normalize_text(text)
    words = set(normalized.split())
    if any(phrase in normalized for phrase in ("не делай", "do not", "don t")) or words.intersection({"нет", "отмени", "cancel", "no"}):
        return "approval-decline"
    if words.intersection({"подтверждаю", "разрешаю", "да", "окей", "yes", "confirm", "allow", "okay"}):
        return "approval-accept"
    if ("биткоин" in normalized or "bitcoin" in words) and ("график" in normalized or "chart" in words):
        return "bitcoin-chart"
    if "загруз" in normalized or "download" in normalized:
        return "downloads"
    if "новост" in normalized or "latest news" in normalized or "найди" in normalized or "find" in words or "search" in words:
        return "search"
    if ("создай" in normalized or "create" in words) and ("папк" in normalized or "folder" in words):
        return "create-folder"
    if "браузер" in normalized or "browser" in words:
        return "open-browser"
    if "погод" in normalized or "weather" in words:
        return "weather"
    return "unknown"


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * fraction)))
    return round(ordered[index], 2)


def load_corpus(manifest_path: Path) -> list[dict[str, Any]]:
    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise CorpusError("The voice benchmark manifest is unavailable or invalid.") from error
    samples = document.get("samples") if isinstance(document, dict) else None
    if not isinstance(samples, list):
        raise CorpusError("20 real human WAV recordings are required; the sample list is invalid.")
    ids: set[str] = set()
    counts = {"ru": 0, "en": 0}
    resolved: list[dict[str, Any]] = []
    missing: list[str] = []
    base = manifest_path.parent.resolve()
    for raw in samples:
        if not isinstance(raw, dict):
            raise CorpusError("20 real human WAV recordings are required; one sample is invalid.")
        sample_id = raw.get("id")
        language = raw.get("language")
        reference = raw.get("reference")
        intent = raw.get("intent")
        relative_audio = raw.get("audio")
        if (
            not isinstance(sample_id, str) or not sample_id
            or sample_id in ids
            or language not in counts
            or raw.get("source") != "human-microphone"
            or not isinstance(reference, str) or not reference.strip()
            or not isinstance(intent, str) or not intent
            or not isinstance(relative_audio, str) or not relative_audio.lower().endswith(".wav")
        ):
            raise CorpusError("20 real human WAV recordings are required; sample metadata is invalid.")
        audio_path = (base / relative_audio).resolve()
        try:
            audio_path.relative_to(base)
        except ValueError as error:
            raise CorpusError("20 real human WAV recordings are required; audio paths must stay inside the corpus directory.") from error
        ids.add(sample_id)
        counts[language] += 1
        if not audio_path.is_file():
            missing.append(sample_id)
        resolved.append({**raw, "audioPath": str(audio_path)})
    if len(resolved) < 20 or counts["ru"] < 10 or counts["en"] < 10 or missing:
        suffix = f" Missing: {', '.join(missing)}." if missing else ""
        raise CorpusError(f"20 real human WAV recordings are required (at least 10 RU and 10 EN).{suffix}")
    for sample in resolved:
        try:
            with wave.open(sample["audioPath"], "rb") as recording:
                duration = recording.getnframes() / max(1, recording.getframerate())
                if recording.getnchannels() < 1 or recording.getsampwidth() < 1 or not 0.25 <= duration <= 25:
                    raise CorpusError(f"Recording {sample['id']} must be a 0.25-25 second PCM WAV.")
                sample["audioDurationMs"] = round(duration * 1000)
        except (wave.Error, OSError) as error:
            raise CorpusError(f"Recording {sample['id']} is not a readable PCM WAV.") from error
    return resolved


def score_candidate(candidate: Candidate, samples: list[dict[str, Any]], transcribe: Callable[[dict[str, Any]], str], model_load_ms: float) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    word_errors = 0
    word_total = 0
    char_errors = 0
    char_total = 0
    intents_correct = 0
    for sample in samples:
        started = perf_counter()
        hypothesis = str(transcribe(sample)).strip()
        latency_ms = round((perf_counter() - started) * 1000, 2)
        reference_words = normalize_text(sample["reference"]).split()
        hypothesis_words = normalize_text(hypothesis).split()
        reference_chars = list(normalize_text(sample["reference"]).replace(" ", ""))
        hypothesis_chars = list(normalize_text(hypothesis).replace(" ", ""))
        word_errors += edit_distance(reference_words, hypothesis_words)
        word_total += len(reference_words)
        char_errors += edit_distance(reference_chars, hypothesis_chars)
        char_total += len(reference_chars)
        detected_intent = detect_intent(hypothesis)
        intent_correct = detected_intent == sample["intent"]
        intents_correct += int(intent_correct)
        rows.append({
            "id": sample["id"],
            "language": sample["language"],
            "latencyMs": latency_ms,
            "reference": sample["reference"],
            "hypothesis": hypothesis,
            "expectedIntent": sample["intent"],
            "detectedIntent": detected_intent,
            "intentCorrect": intent_correct,
        })
    latencies = [row["latencyMs"] for row in rows]
    warm_latencies = latencies[1:]
    return {
        "status": "ok",
        "name": candidate.name,
        "engine": candidate.engine,
        "model": candidate.model,
        "device": candidate.device,
        "computeType": candidate.compute_type,
        "coverage": round(len(rows) / len(samples), 4),
        "modelLoadMs": round(model_load_ms, 2),
        "coldFirstRequestMs": latencies[0],
        "coldTotalMs": round(model_load_ms + latencies[0], 2),
        "warmMeanMs": round(statistics.fmean(warm_latencies), 2) if warm_latencies else None,
        "warmP50Ms": percentile(warm_latencies, 0.5),
        "warmP95Ms": percentile(warm_latencies, 0.95),
        "wer": round(word_errors / max(1, word_total), 4),
        "cer": round(char_errors / max(1, char_total), 4),
        "intentAccuracy": round(intents_correct / max(1, len(rows)), 4),
        "samples": rows,
    }


def run_faster_whisper(candidate: Candidate, samples: list[dict[str, Any]], model_root: Path, allow_downloads: bool) -> dict[str, Any]:
    from faster_whisper import WhisperModel

    started = perf_counter()
    model = WhisperModel(
        candidate.model,
        device=candidate.device,
        compute_type=candidate.compute_type,
        download_root=str(model_root),
        local_files_only=not allow_downloads,
    )
    model_load_ms = (perf_counter() - started) * 1000

    def transcribe(sample: dict[str, Any]) -> str:
        segments, _ = model.transcribe(sample["audioPath"], vad_filter=True)
        return " ".join(segment.text.strip() for segment in segments if segment.text.strip())

    return score_candidate(candidate, samples, transcribe, model_load_ms)


def run_gigaam(candidate: Candidate, samples: list[dict[str, Any]], allow_downloads: bool) -> dict[str, Any]:
    if not allow_downloads:
        raise RuntimeError("GigaAM benchmark is opt-in because its package and model are not part of the JARVIS runtime.")
    import gigaam

    russian_samples = [sample for sample in samples if sample["language"] == "ru"]
    started = perf_counter()
    model = gigaam.load_model(candidate.model)
    model_load_ms = (perf_counter() - started) * 1000

    def transcribe(sample: dict[str, Any]) -> str:
        result = model.transcribe(sample["audioPath"])
        return result if isinstance(result, str) else str(getattr(result, "text", result))

    result = score_candidate(candidate, russian_samples, transcribe, model_load_ms)
    result["coverage"] = round(len(russian_samples) / len(samples), 4)
    result["note"] = "GigaAM v3 RNNT is evaluated on RU only; it cannot win the bilingual production comparison."
    return result


def markdown_report(report: dict[str, Any]) -> str:
    lines = [
        "# JARVIS Voice Recognition V2 benchmark",
        "",
        f"Generated: {report['generatedAt']}",
        "",
        "| Candidate | Coverage | Cold total | Warm p50 | Warm p95 | WER | CER | Intent accuracy | Status |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for result in report["results"]:
        if result["status"] != "ok":
            lines.append(f"| {result['name']} | — | — | — | — | — | — | — | {result['status']} |")
            continue
        lines.append(
            f"| {result['name']} | {result['coverage']:.0%} | {result['coldTotalMs']:.2f} ms | "
            f"{result['warmP50Ms']:.2f} ms | {result['warmP95Ms']:.2f} ms | {result['wer']:.2%} | "
            f"{result['cer']:.2%} | {result['intentAccuracy']:.2%} | ok |"
        )
    lines.extend(["", f"Recommended bilingual candidate: {report.get('winner') or 'none'}", ""])
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark local JARVIS ASR on real physical-PTT recordings.")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--candidate", action="append", choices=sorted(CANDIDATES))
    parser.add_argument("--allow-downloads", action="store_true", help="Allow model downloads. Off by default.")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--model-root", type=Path, default=Path("data/models"))
    parser.add_argument("--output", type=Path, default=Path("output/voice-benchmark"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        samples = load_corpus(args.manifest.resolve())
    except CorpusError as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.validate_only:
        print(f"Validated {len(samples)} real human WAV recordings.")
        return 0

    names = args.candidate or ["current", "turbo", "large-v3", "gigaam-v3-rnnt"]
    results: list[dict[str, Any]] = []
    for name in names:
        candidate = CANDIDATES[name]
        try:
            if candidate.engine == "faster-whisper":
                result = run_faster_whisper(candidate, samples, args.model_root.resolve(), args.allow_downloads)
            else:
                result = run_gigaam(candidate, samples, args.allow_downloads)
        except Exception as error:
            result = {
                "status": "unavailable",
                "name": candidate.name,
                "engine": candidate.engine,
                "model": candidate.model,
                "device": candidate.device,
                "computeType": candidate.compute_type,
                "reason": f"{type(error).__name__}: {error}",
            }
        results.append(result)

    eligible = [result for result in results if result.get("status") == "ok" and result.get("coverage") == 1]
    eligible.sort(key=lambda result: (-result["intentAccuracy"], result["wer"], result["warmP95Ms"]))
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "corpus": str(args.manifest.resolve()),
        "sampleCount": len(samples),
        "downloadsAllowed": args.allow_downloads,
        "winner": eligible[0]["name"] if eligible else None,
        "rankingRule": "full bilingual coverage, then intent accuracy desc, WER asc, warm p95 asc",
        "results": results,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = args.output / f"benchmark-{stamp}.json"
    markdown_path = args.output / f"benchmark-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(markdown_report(report), encoding="utf-8")
    print(json.dumps({"json": str(json_path), "markdown": str(markdown_path), "winner": report["winner"]}, ensure_ascii=False))
    return 0 if eligible else 3


if __name__ == "__main__":
    raise SystemExit(main())
