"""
NeMo Canary — NVIDIA's research-SOTA transcription model, an "advanced"
local ASR option alongside WhisperX.

Selected via LOCAL_ASR_ENGINE=nemo_canary (default is whisperx — see
core/config.py). This only matters in local mode; remote mode delegates to
whatever VOICEFLOW_REMOTE_ENDPOINT runs, which could already be Canary.

GPU strongly recommended. Needs `pip install nemo_toolkit[asr]` — heavy
(PyTorch Lightning, Hydra, datasets, librosa) and not installed by default;
requirements-ml.txt documents it as an opt-in extra, same as whisperx/kokoro.
On CPU this will run but slowly enough that it's a research/benchmarking
tool, not something to point production traffic at — that's exactly why
it's config-selectable rather than a default.

Same honesty contract as every other service here: if nemo_toolkit isn't
installed, or the model fails to load, this returns a clear error — never a
fabricated transcript, never a silently-wrong result.
"""
from __future__ import annotations

import tempfile
from typing import Any, Dict, Optional

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

try:
    import nemo.collections.asr as _nemo_asr  # type: ignore
    _NEMO = True
except ImportError:
    _NEMO = False
    log.warning("nemo_toolkit not installed — NeMoCanaryService stub mode "
               "(pip install nemo_toolkit[asr] to enable; see requirements-ml.txt)")

# nvidia/canary-180m-flash is the lightest published Canary checkpoint —
# canary-1b is more accurate but ~5x the size/compute. Override for a
# specific checkpoint via NEMO_CANARY_MODEL.
DEFAULT_CANARY_MODEL = "nvidia/canary-180m-flash"


class NeMoCanaryService:
    """Loads once, cached across calls — Canary is a multi-GB checkpoint."""

    def __init__(self, model_name: Optional[str] = None):
        import os
        self.model_name = model_name or os.getenv("NEMO_CANARY_MODEL", DEFAULT_CANARY_MODEL)
        self._model = None

    def _ensure_loaded(self):
        if not _NEMO:
            return
        if self._model is None:
            log.info("Loading NeMo Canary model: %s (this can take a while on first run)", self.model_name)
            self._model = _nemo_asr.models.EncDecMultiTaskModel.from_pretrained(self.model_name)

    def transcribe(self, audio_bytes: bytes, language: Optional[str] = None) -> Dict[str, Any]:
        """
        Args:
            audio_bytes: Raw audio (mp3, wav, m4a, ...).
            language: 2-letter code Canary supports (en, de, es, fr) or None
                to let Canary auto-detect where its multitask config allows it.

        Returns:
            {text, language, segments, method, diarized}. `diarized` is
            always False — Canary is transcription-only, pair it with
            LOCAL_DIARIZATION_ENGINE for speaker labels.
        """
        if not _NEMO:
            return {"text": "", "language": "unknown", "segments": [], "method": "stub",
                    "error": "nemo_not_installed", "diarized": False}

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            path = f.name
        try:
            self._ensure_loaded()
            kwargs: Dict[str, Any] = {"audio": [path], "batch_size": 1}
            if language:
                kwargs["source_lang"] = language
                kwargs["target_lang"] = language
            result = self._model.transcribe(**kwargs)  # type: ignore
            # NeMo's transcribe() returns a list of Hypothesis-like objects
            # (or plain strings on older versions) — normalize both shapes.
            text = ""
            if result:
                first = result[0]
                text = getattr(first, "text", None) or (first if isinstance(first, str) else "")
            return {
                "text": text.strip(),
                "language": language or "auto",
                "segments": [],
                "method": f"nemo-canary-{self.model_name.split('/')[-1]}",
                "diarized": False,
            }
        except Exception as e:
            log.warning("NeMo Canary transcription failed: %s", e)
            return {"text": "", "language": "unknown", "segments": [], "method": "error",
                    "error": str(e), "diarized": False}
        finally:
            import os as _os
            try:
                _os.unlink(path)
            except Exception:
                pass
