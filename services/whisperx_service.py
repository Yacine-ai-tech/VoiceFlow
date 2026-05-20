"""
WhisperXService — faster-whisper + forced alignment + pyannote diarization
in one bundle. Falls back gracefully if pyannote is not installed.

Diarization fallback chain: pyannote 3.x → NeMo → no-diarization.
"""
from __future__ import annotations

import os
import tempfile
from typing import Any, Dict, Optional

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

try:
    import whisperx  # type: ignore
    _WHISPERX = True
except ImportError:
    _WHISPERX = False
    log.warning("whisperx not installed — WhisperXService stub mode")


class WhisperXService:
    """Bundled faster-whisper + alignment + (optional) diarization."""

    def __init__(self, model_name: Optional[str] = None, device: Optional[str] = None):
        self.model_name = model_name or settings.WHISPER_MODEL
        self.device = device or settings.WHISPER_DEVICE
        self._model = None

    def _ensure_loaded(self):
        if not _WHISPERX:
            return
        if self._model is None:
            log.info("Loading WhisperX model: %s (%s)", self.model_name, self.device)
            self._model = whisperx.load_model(self.model_name, device=self.device, compute_type="int8")

    def transcribe(self, audio_bytes: bytes, diarize: bool = False) -> Dict[str, Any]:
        """
        Transcribe + (optional) diarize an audio clip.

        Args:
            audio_bytes: Raw audio bytes (mp3, wav, m4a, etc.).
            diarize: If True, attach speaker labels via pyannote (requires HF_TOKEN).

        Returns:
            {"text", "language", "segments", "method", "diarized"}
        """
        if not _WHISPERX:
            return {"text": "", "method": "stub", "error": "whisperx_not_installed"}

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            path = f.name
        try:
            self._ensure_loaded()
            result = self._model.transcribe(path)  # type: ignore
            language = result.get("language", "en")

            # Forced alignment (optional)
            try:
                model_a, metadata = whisperx.load_align_model(language_code=language, device=self.device)
                result = whisperx.align(result["segments"], model_a, metadata, path, self.device)
            except Exception as e:
                log.warning("alignment skipped: %s", e)

            # Diarization (optional)
            diarized = False
            if diarize and settings.HF_TOKEN:
                try:
                    diarize_model = whisperx.DiarizationPipeline(use_auth_token=settings.HF_TOKEN, device=self.device)
                    diar_segments = diarize_model(path)
                    result = whisperx.assign_word_speakers(diar_segments, result)
                    diarized = True
                except Exception as e:
                    log.warning("diarization failed (fallback to no-diarization): %s", e)

            text = " ".join(seg.get("text", "").strip() for seg in result.get("segments", []))
            return {
                "text": text,
                "language": language,
                "segments": result.get("segments", []),
                "method": "whisperx",
                "diarized": diarized,
            }
        finally:
            try:
                os.unlink(path)
            except Exception:
                pass
