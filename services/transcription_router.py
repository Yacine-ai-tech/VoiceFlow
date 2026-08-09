"""
TranscriptionRouter — thin wrapper around services.transcription_adapter.

All provider selection and fallback logic lives in transcription_adapter.py.
Pass `provider` to force a specific engine to the front of the fallback chain
(or, with `strict=True`, to use *only* that engine); leave `provider` unset
to use the environment-configured default order.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from services.transcription_adapter import transcribe as _adapter_transcribe


async def transcribe(
    audio_bytes: bytes,
    provider: Optional[str] = None,
    language: str = "auto",
    diarize: bool = False,
    strict: bool = False,
) -> Dict[str, Any]:
    """Transcribe audio via the unified transcription adapter."""
    return await _adapter_transcribe(
        audio_bytes=audio_bytes,
        provider=provider,
        language=language,
        diarize=diarize,
        strict=strict,
    )
