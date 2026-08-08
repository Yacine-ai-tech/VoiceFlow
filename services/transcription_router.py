"""
TranscriptionRouter — thin wrapper around services.transcription_adapter.

All provider routing and environment-driven STT logic lives in
services/transcription_adapter.py.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from services.transcription_adapter import transcribe as _adapter_transcribe


async def transcribe(
    audio_bytes: bytes,
    provider: Optional[str] = None,
    language: str = "auto",
    diarize: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio via unified transcription_adapter.
    The provider argument is ignored as transcription selection is environment-driven.
    """
    return await _adapter_transcribe(
        audio_bytes=audio_bytes,
        language=language,
        diarize=diarize,
    )
