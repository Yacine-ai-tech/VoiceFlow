"""
TranscriptionRouter — Route audio → provider (local whisperx | Groq | Deepgram | AssemblyAI).

Provider is selected per-call OR via TRANSCRIPTION_PROVIDER env var.
Falls back to local whisperx if no API keys are configured.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from core.config import settings
from core.logger import get_logger
from services.whisperx_service import WhisperXService

log = get_logger(__name__)


_whisperx = WhisperXService()


async def transcribe(
    audio_bytes: bytes,
    provider: Optional[str] = None,
    diarize: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio via the chosen provider.

    Providers: LOCAL_WHISPERX | GROQ_WHISPER | DEEPGRAM | ASSEMBLYAI.
    """
    provider = (provider or os.getenv("TRANSCRIPTION_PROVIDER", "LOCAL_WHISPERX")).upper()

    if provider == "GROQ_WHISPER" and settings.GROQ_API_KEY:
        return await _via_groq(audio_bytes)
    if provider == "DEEPGRAM" and settings.DEEPGRAM_API_KEY:
        return await _via_deepgram(audio_bytes)
    if provider == "ASSEMBLYAI" and settings.ASSEMBLYAI_API_KEY:
        return await _via_assemblyai(audio_bytes)

    # default: local whisperx
    return _whisperx.transcribe(audio_bytes, diarize=diarize)


async def _via_groq(audio_bytes: bytes) -> Dict[str, Any]:
    try:
        from groq import Groq  # type: ignore
        client = Groq(api_key=settings.GROQ_API_KEY)
        import io
        result = client.audio.transcriptions.create(
            file=("audio.wav", io.BytesIO(audio_bytes)),
            model="whisper-large-v3-turbo",
        )
        return {"text": result.text, "method": "groq_whisper", "diarized": False}
    except Exception as e:
        log.exception("groq transcription failed: %s", e)
        return {"text": "", "method": "groq_whisper", "error": str(e)}


async def _via_deepgram(audio_bytes: bytes) -> Dict[str, Any]:
    try:
        from deepgram import DeepgramClient  # type: ignore
        dg = DeepgramClient(api_key=settings.DEEPGRAM_API_KEY)
        result = dg.listen.rest.v("1").transcribe_file({"buffer": audio_bytes})
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
