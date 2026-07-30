"""
TranscriptionRouter — delegates to the new transcription_adapter.

This file is kept as a backward-compatible shim. All provider logic now lives
in services/transcription_adapter.py. Set VOICEFLOW_TRANSCRIPTION_MODE and
ASR_PROVIDER env vars to control behavior.

Legacy env var TRANSCRIPTION_PROVIDER is still respected:
  LOCAL_WHISPERX → VOICEFLOW_TRANSCRIPTION_MODE=local
  GROQ_WHISPER   → ASR_PROVIDER=groq
  DEEPGRAM       → ASR_PROVIDER=deepgram
  ASSEMBLYAI     → ASR_PROVIDER=assemblyai
"""
from __future__ import annotations

import os
import importlib.util
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
    Transcribe audio via unified adapter using ASR_PROVIDER priorities or explicit provider parameter.
    """
    from services.transcription_adapter import transcribe as _adapter_transcribe
    
    # If caller specifies explicit provider, map aliases
    p_norm = (provider or "").strip().lower()
    if p_norm in ("groq", "groq_whisper", "groq-whisper"):
        res = await _via_groq(audio_bytes, _norm_lang(language))
        if res and res.get("text"):
            return res
    elif p_norm in ("deepgram", "deepgram_nova2", "deepgram-nova2"):
        res = await _via_deepgram(audio_bytes)
        if res and res.get("text"):
            return res
    elif p_norm in ("assemblyai", "assembly_ai"):
        res = await _via_assemblyai(audio_bytes)
        if res and res.get("text"):
            return res
    elif p_norm in ("orchestrator", "remote"):
        from services.transcription_adapter import _orchestrator_whisper
        res = _orchestrator_whisper(audio_bytes, _norm_lang(language), diarize)
        if res and res.get("text"):
            return res

    # Unified dynamic priority chain (ASR_PROVIDER env var + automatic fallback)
    return await _adapter_transcribe(audio_bytes, language=_norm_lang(language), diarize=diarize)


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
