from __future__ import annotations

import json
from pathlib import Path
import sys
from time import perf_counter, time
from typing import Any


def require_text(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required.")
    return value


class WarmWhisperWorker:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.signature: tuple[str, str, str, str] | None = None
        self.last_load_ms = 0

    def _ensure_model(self, request: dict[str, Any]) -> tuple[Any, bool]:
        model_path = require_text(request, "modelPath")
        model_name = require_text(request, "model")
        device = require_text(request, "device")
        compute_type = require_text(request, "computeType")
        Path(model_path).mkdir(parents=True, exist_ok=True)
        signature = (model_path, model_name, device, compute_type)
        if self.model is not None and self.signature == signature:
            return self.model, True

        from faster_whisper import WhisperModel

        started = perf_counter()
        self.model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
            download_root=model_path,
        )
        self.last_load_ms = round((perf_counter() - started) * 1000)
        self.signature = signature
        return self.model, False

    def transcribe(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = require_text(request, "id")
        audio_path = require_text(request, "audioPath")
        if not Path(audio_path).is_file():
            raise ValueError("audioPath must identify an existing file.")

        model, warm = self._ensure_model(request)
        asr_started_at_unix_ms = round(time() * 1000)
        started = perf_counter()
        segments, info = model.transcribe(audio_path, vad_filter=True)
        parts = [segment.text.strip() for segment in segments if segment.text.strip()]
        asr_ms = round((perf_counter() - started) * 1000)
        return {
            "id": request_id,
            "text": " ".join(parts).strip(),
            "durationMs": round(info.duration * 1000),
            "language": info.language,
            "timings": {
                "modelLoadMs": 0 if warm else self.last_load_ms,
                "asrMs": asr_ms,
                "warm": warm,
                "asrStartedAtUnixMs": asr_started_at_unix_ms,
                "transcriptReadyAtUnixMs": round(time() * 1000),
            },
        }


def write_response(response: dict[str, Any]) -> None:
    print(json.dumps(response, ensure_ascii=False), flush=True)


def main() -> None:
    worker = WarmWhisperWorker()
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id: str | None = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Request must be a JSON object.")
            raw_id = request.get("id")
            request_id = raw_id if isinstance(raw_id, str) else None
            write_response(worker.transcribe(request))
        except Exception:
            write_response({"id": request_id, "error": "Local speech transcription failed."})


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    main()
