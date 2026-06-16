"""
voice_service — convenience transcription helpers (per EXECUTION_PLAN Phase 4, Day 63).

Thin, **import-safe** wrappers over the transcription router (which lazy-loads the local
WhisperX/faster-whisper model on first call and routes to Groq/Deepgram/AssemblyAI when keys
are set). Importing this module never loads a model — safe for tests, CI, and `api.py`.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional

from core.logger import get_logger
from services.transcription_router import transcribe as _route

log = get_logger(__name__)


async def transcribe_audio(
    audio_bytes: bytes,
    language: str = "auto",
    provider: Optional[str] = None,
    diarize: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio → {text, language, latency_seconds, method, segments, diarized}.

    `provider` selects LOCAL_WHISPERX (default) | GROQ_WHISPER | DEEPGRAM | ASSEMBLYAI; the
    router falls back to local when a provider's key is missing.
    """
    t0 = time.time()
    result = await _route(audio_bytes, provider=provider, diarize=diarize)
    if isinstance(result, dict):
        result.setdefault("latency_seconds", round(time.time() - t0, 3))
        result.setdefault("segments", [])
    return result


async def detect_language(audio_bytes: bytes) -> str:
    """Detect the spoken language code (e.g. 'en', 'fr'); 'unknown' if unavailable."""
    result = await _route(audio_bytes)
    return result.get("language", "unknown") if isinstance(result, dict) else "unknown"
