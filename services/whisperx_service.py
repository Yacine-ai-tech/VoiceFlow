"""
WhisperXService — faster-whisper + forced alignment + diarization in one
bundle. Falls back gracefully if its dependencies aren't installed.

Diarization backend is chosen by LOCAL_DIARIZATION_ENGINE (core/config.py):
  pyannote (default) — needs HF_TOKEN (HuggingFace auth for the model
    download) and is GPU-recommended for reasonable speed.
  nemo — NVIDIA NeMo's ClusteringDiarizer, the CPU-capable option.
    Needs `pip install nemo_toolkit[asr]` (heavy — see
    requirements-ml.txt). Runs a real VAD + speaker-embedding + clustering
    pipeline and parses its RTTM output into word/segment speaker labels —
    this replaced an earlier version of this file that had a stub here
    which claimed success without ever assigning speakers; that's gone.

Either way: if the selected engine isn't installed, its token is missing, or
it fails for any reason, the transcript still comes back — just without
speaker labels. `diarized` in the response always tells the truth about
which one happened. No engine here ever fabricates a diarization result.
"""
from __future__ import annotations

import os
import tempfile
from typing import Any, Dict, List, Optional

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

try:
    import whisperx  # type: ignore
    _WHISPERX = True
except ImportError:
    _WHISPERX = False
    log.warning("whisperx not installed — WhisperXService stub mode")

try:
    import nemo.collections.asr as _nemo_asr  # type: ignore
    from omegaconf import OmegaConf as _OmegaConf  # type: ignore
    _NEMO_DIARIZATION = True
except ImportError:
    _NEMO_DIARIZATION = False


# ─── NeMo diarization — real implementation, not a stub ───────────────────────

def _parse_rttm(path: str) -> List[Dict[str, Any]]:
    """RTTM is the standard diarization output format:
    SPEAKER <uri> <channel> <start> <duration> <NA> <NA> <speaker> <NA> <NA>
    """
    segments = []
    with open(path) as f:
        for line in f:
            parts = line.split()
            if len(parts) < 8 or parts[0] != "SPEAKER":
                continue
            start = float(parts[3])
            duration = float(parts[4])
            segments.append({"start": start, "end": start + duration, "speaker": parts[7]})
    return segments


def _assign_speakers_by_overlap(segments: List[Dict[str, Any]], diar_segments: List[Dict[str, Any]]) -> None:
    """Mutates `segments` in place, adding a "speaker" key to each segment
    (and each word within it, if word-level timestamps are present) based on
    which diarization segment overlaps it most."""
    def speaker_for(t0: float, t1: float) -> Optional[str]:
        best_speaker, best_overlap = None, 0.0
        for d in diar_segments:
            overlap = max(0.0, min(t1, d["end"]) - max(t0, d["start"]))
            if overlap > best_overlap:
                best_overlap, best_speaker = overlap, d["speaker"]
        return best_speaker

    for seg in segments:
        seg["speaker"] = speaker_for(seg.get("start", 0.0), seg.get("end", 0.0))
        for w in (seg.get("words") or []):
            if "start" in w and "end" in w:
                w["speaker"] = speaker_for(w["start"], w["end"])


def _nemo_diarize(audio_path: str) -> Optional[List[Dict[str, Any]]]:
    """Runs NeMo's ClusteringDiarizer (VAD -> speaker embeddings -> clustering)
    on a single audio file and returns parsed RTTM segments, or None if
    NeMo isn't installed or the pipeline fails for any reason."""
    if not _NEMO_DIARIZATION:
        log.info("nemo_toolkit not installed — skipping NeMo diarization "
                 "(pip install nemo_toolkit[asr] to enable; see requirements-ml.txt)")
        return None
    try:
        import json
        import uuid
        work_dir = tempfile.mkdtemp(prefix="nemo_diarize_")
        uri = f"clip_{uuid.uuid4().hex[:8]}"
        manifest_path = os.path.join(work_dir, "manifest.json")
        with open(manifest_path, "w") as f:
            f.write(json.dumps({
                "audio_filepath": audio_path, "offset": 0, "duration": None,
                "label": "infer", "text": "-", "num_speakers": None,
                "rttm_filepath": None, "uem_filepath": None, "uniq_id": uri,
            }) + "\n")

        cfg = _OmegaConf.create({
            "diarizer": {
                "manifest_filepath": manifest_path,
                "out_dir": work_dir,
                "oracle_vad": False,
                "collar": 0.25,
                "ignore_overlap": True,
                "vad": {
                    "model_path": "vad_multilingual_marblenet",
                    "parameters": {"onset": 0.5, "offset": 0.3, "pad_offset": -0.05},
                },
                "speaker_embeddings": {
                    "model_path": "titanet_large",
                    "parameters": {"window_length_in_sec": 1.5, "shift_length_in_sec": 0.75,
                                   "multiscale_weights": [1], "save_embeddings": False},
                },
                "clustering": {
                    "parameters": {"oracle_num_speakers": False, "max_num_speakers": 8,
                                   "enhanced_count_thresh": 80, "max_rp_threshold": 0.25,
                                   "sparse_search_volume": 30},
                },
            }
        })
        diarizer = _nemo_asr.models.ClusteringDiarizer(cfg=cfg.diarizer)
        diarizer.diarize()

        rttm_path = os.path.join(work_dir, "pred_rttms", f"{uri}.rttm")
        if not os.path.exists(rttm_path):
            log.warning("NeMo diarization produced no RTTM output at %s", rttm_path)
            return None
        return _parse_rttm(rttm_path)
    except Exception as e:
        log.warning("NeMo diarization failed: %s", e)
        return None


def diarize_only(audio_bytes: bytes, transcription: Dict[str, Any]) -> Dict[str, Any]:
    """Attach speaker labels to an already-transcribed result — for engines
    (like NeMo Canary) that don't diarize themselves. Uses whichever
    LOCAL_DIARIZATION_ENGINE is configured. Returns `transcription`
    unmodified (diarized stays False) if diarization isn't available."""
    segments = transcription.get("segments") or []
    if not segments:
        return transcription

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(audio_bytes)
        path = f.name
    try:
        diar_segments = _run_diarization(path)
        if diar_segments is None:
            return transcription
        _assign_speakers_by_overlap(segments, diar_segments)
        transcription["diarized"] = True
        return transcription
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


def _run_diarization(audio_path: str) -> Optional[List[Dict[str, Any]]]:
    """Dispatches to whichever LOCAL_DIARIZATION_ENGINE is configured.
    pyannote needs whisperx's DiarizationPipeline wrapper + HF_TOKEN; nemo
    needs nemo_toolkit. Returns None (never raises) if unavailable/failed."""
    engine = settings.LOCAL_DIARIZATION_ENGINE
    if engine == "nemo":
        return _nemo_diarize(audio_path)

    # pyannote, via whisperx's wrapper
    if not (_WHISPERX and settings.HF_TOKEN):
        return None
    try:
        diarize_model = whisperx.DiarizationPipeline(use_auth_token=settings.HF_TOKEN, device="cpu")
        raw = diarize_model(audio_path)
        # whisperx's DiarizationPipeline returns a pyannote-style DataFrame;
        # normalize to our {start, end, speaker} shape for the shared assigner.
        return [{"start": float(r.start), "end": float(r.end), "speaker": str(r.speaker)}
                for r in raw.itertuples()]
    except Exception as e:
        log.warning("pyannote diarization failed: %s", e)
        return None


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

    def transcribe(
        self, audio_bytes: bytes, language: Optional[str] = None, diarize: bool = False
    ) -> Dict[str, Any]:
        """
        Transcribe + (optional) diarize an audio clip.

        Args:
            audio_bytes: Raw audio bytes (mp3, wav, m4a, etc.).
            language: 2-letter code (e.g. 'en', 'fr') to force the language, or None to
                auto-detect it (Whisper detects the spoken language from the audio).
            diarize: If True, attach speaker labels via LOCAL_DIARIZATION_ENGINE
                (pyannote, needs HF_TOKEN; or nemo, needs nemo_toolkit).

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
            # language=None lets Whisper auto-detect; a concrete code forces it.
            result = self._model.transcribe(path, language=language)  # type: ignore
            language = result.get("language", language or "en")

            # Forced alignment (optional)
            try:
                model_a, metadata = whisperx.load_align_model(language_code=language, device=self.device)
                result = whisperx.align(result["segments"], model_a, metadata, path, self.device)
            except Exception as e:
                log.warning("alignment skipped: %s", e)

            diarized = False
            if diarize:
                diar_segments = _run_diarization(path)
                if diar_segments is not None:
                    _assign_speakers_by_overlap(result.get("segments", []), diar_segments)
                    diarized = True
                else:
                    log.info("diarization unavailable (%s engine, key/package missing, or it failed) "
                             "— returning transcript without speaker labels",
                             settings.LOCAL_DIARIZATION_ENGINE)

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
                log.exception("Unexpected error")
                pass
