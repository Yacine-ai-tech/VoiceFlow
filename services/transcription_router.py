"""
TranscriptionRouter — Route audio → provider (local whisperx | Groq | Deepgram | AssemblyAI).

Provider is selected per-call OR via TRANSCRIPTION_PROVIDER env var.
Falls back to local whisperx if no API keys are configured.
"""
from __future__ import annotations

import importlib.util
import os
from typing import Any, Dict, Optional

from core.config import settings
from core.logger import get_logger
from services.whisperx_service import WhisperXService

log = get_logger(__name__)


_whisperx = WhisperXService()

# WhisperX is an optional heavy dependency. On slim cloud images (e.g. the 512 MB
# Render tier) it isn't installed, so the local path can only return a stub. Detect
# this once so transcribe() can transparently fall back to a configured cloud STT.
_WHISPERX_AVAILABLE = importlib.util.find_spec("whisperx") is not None


def _norm_lang(language: Optional[str]) -> Optional[str]:
    """'auto'/empty -> None (let the model auto-detect); otherwise the 2-letter code."""
    if not language or language.lower() == "auto":
        return None
    return language[:2].lower()


async def transcribe(
    audio_bytes: bytes,
    provider: Optional[str] = None,
    language: str = "auto",
    diarize: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio via the chosen provider.

    Providers: LOCAL_WHISPERX | GROQ_WHISPER | DEEPGRAM | ASSEMBLYAI.
    ``language`` is a 2-letter code (e.g. 'en', 'fr') or 'auto' to detect it.
    """
    provider = (provider or os.getenv("TRANSCRIPTION_PROVIDER", "DEEPGRAM")).upper()
    lang = _norm_lang(language)

    if provider == "GROQ_WHISPER" and settings.GROQ_API_KEY:
        return await _via_groq(audio_bytes, lang)
    if provider == "DEEPGRAM" and settings.DEEPGRAM_API_KEY:
        return await _via_deepgram(audio_bytes)
    if provider == "ASSEMBLYAI" and settings.ASSEMBLYAI_API_KEY:
        return await _via_assemblyai(audio_bytes)

    # Default path: local WhisperX. If it's installed (local/dev), use it. Otherwise
    # (slim cloud image) auto-fall back to the first configured cloud STT so the
    # composite endpoints (/pipeline, /meeting/process, /call/analyze) and the default
    # /transcribe still produce a real transcript in production instead of a stub.
    if _WHISPERX_AVAILABLE:
        return _whisperx.transcribe(audio_bytes, language=lang, diarize=diarize)
    if settings.GROQ_API_KEY:
        log.info("WhisperX unavailable — falling back to Groq Whisper")
        return await _via_groq(audio_bytes, lang)
    if settings.DEEPGRAM_API_KEY:
        log.info("WhisperX unavailable — falling back to Deepgram")
        return await _via_deepgram(audio_bytes)
    if settings.ASSEMBLYAI_API_KEY:
        log.info("WhisperX unavailable — falling back to AssemblyAI")
        return await _via_assemblyai(audio_bytes)
    # Nothing available — return the WhisperX stub (carries a clear error message).
    return _whisperx.transcribe(audio_bytes, language=lang, diarize=diarize)


async def _via_groq(audio_bytes: bytes, language: Optional[str] = None) -> Dict[str, Any]:
    try:
        from groq import Groq  # type: ignore
        client = Groq(api_key=settings.GROQ_API_KEY)
        import io
        kwargs: Dict[str, Any] = {
            "file": ("audio.webm", io.BytesIO(audio_bytes)),
            "model": "whisper-large-v3-turbo",
        }
        if language:  # omit for auto-detect (Groq detects when language is unset)
            kwargs["language"] = language
        result = client.audio.transcriptions.create(**kwargs)
        return {
            "text": result.text, "method": "groq_whisper", "diarized": False,
            "language": language or "auto",
        }
    except Exception as e:
        log.exception("groq transcription failed: %s", e)
        return {"text": "", "method": "groq_whisper", "error": str(e)}


async def _via_deepgram(audio_bytes: bytes) -> Dict[str, Any]:
    try:
        from deepgram import DeepgramClient, PrerecordedOptions  # type: ignore
        dg = DeepgramClient(api_key=settings.DEEPGRAM_API_KEY)
        options = PrerecordedOptions(model="nova-2", smart_format=True)
        result = dg.listen.rest.v("1").transcribe_file({"buffer": audio_bytes}, options)
        text = result["results"]["channels"][0]["alternatives"][0]["transcript"]
        return {"text": text, "method": "deepgram", "diarized": False}
    except Exception as e:
        log.exception("deepgram transcription failed: %s", e)
        return {"text": "", "method": "deepgram", "error": str(e)}


async def _via_assemblyai(audio_bytes: bytes) -> Dict[str, Any]:
    try:
        import assemblyai as aai  # type: ignore
        aai.settings.api_key = settings.ASSEMBLYAI_API_KEY
        transcript = aai.Transcriber().transcribe(audio_bytes)
        return {"text": transcript.text or "", "method": "assemblyai", "diarized": False}
    except Exception as e:
        log.exception("assemblyai transcription failed: %s", e)
        return {"text": "", "method": "assemblyai", "error": str(e)}
