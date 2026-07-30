"""
VoiceFlow Transcription Adapter
================================
Unified adapter for speech-to-text that replaces the scattered provider checks
in transcription_router.py.

Two modes:
  local   — WhisperX on the local machine (needs ≥ 4GB RAM + ffmpeg).
  remote  — Forward to a remote ASR endpoint.

Remote provider chain:
  1. Orchestrator Studio /whisper     [VOICEFLOW_REMOTE_ENDPOINT] — WhisperX on Lightning AI
  2. Groq Whisper                      [GROQ_API_KEY]
  3. Deepgram                          [DEEPGRAM_API_KEY]
  4. AssemblyAI                        [ASSEMBLYAI_API_KEY]
  5. None → empty transcript with error info

Env vars:
  VOICEFLOW_TRANSCRIPTION_MODE=local|remote  (default: remote if VOICEFLOW_REMOTE_ENDPOINT set)
  VOICEFLOW_REMOTE_ENDPOINT=                  (Orchestrator tunnel URL)
  VOICEFLOW_REMOTE_TOKEN=                     (bearer token for Orchestrator /whisper)
  ASR_PROVIDER=orchestrator|groq|deepgram|assemblyai  (remote mode priority)
  WHISPER_MODEL=base                          (for local or orchestrator mode)
  WHISPER_DEVICE=cpu
  GROQ_API_KEY=
  DEEPGRAM_API_KEY=
  ASSEMBLYAI_API_KEY=
  VOICEFLOW_ASR_TIMEOUT=60
"""
from __future__ import annotations

import base64
import json as _json
import logging
import os
import urllib.request
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)


def _remote_endpoint() -> str:
    return (os.getenv("VOICEFLOW_REMOTE_ENDPOINT", "")
            or os.getenv("ORCHESTRATOR_URL", "")  # legacy
            or "").strip().rstrip("/")


def _remote_token() -> str:
    return (os.getenv("VOICEFLOW_REMOTE_TOKEN", "")
            or os.getenv("INFERENCE_TOKEN", "")).strip()


def _use_local() -> bool:
    mode = os.getenv("VOICEFLOW_TRANSCRIPTION_MODE", "").strip().lower()
    if mode == "local":
        return True
    if mode == "remote":
        return False
    # Auto: local if whisperx is installed and no remote endpoint
    try:
        import whisperx  # type: ignore  # noqa
        return not _remote_endpoint()
    except ImportError:
        return False


def _error_result(msg: str) -> Dict[str, Any]:
    return {"text": "", "language": "unknown", "segments": [], "method": "error", "error": msg}


# ─── Orchestrator /whisper ────────────────────────────────────────────────────

def _orchestrator_whisper(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
) -> Optional[Dict[str, Any]]:
    url = _remote_endpoint()
    if not url:
        return None
    ep = url.lower()
    if "groq.com" in ep or "deepgram.com" in ep or "assemblyai.com" in ep:
        return None  # not an orchestrator endpoint
    timeout = int(os.getenv("VOICEFLOW_ASR_TIMEOUT", "120"))
    try:
        audio_b64 = base64.b64encode(audio_bytes).decode()
        payload: Dict[str, Any] = {"audio_b64": audio_b64, "diarize": diarize}
        if language:
            payload["language"] = language
        h = {"Content-Type": "application/json"}
        tk = _remote_token()
        if tk:
            h["Authorization"] = f"Bearer {tk}"
        req = urllib.request.Request(url + "/whisper", data=_json.dumps(payload).encode(), headers=h)
        resp = _json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        resp.setdefault("method", "orchestrator-whisperx")
        return resp
    except Exception as e:
        log.warning("orchestrator /whisper failed: %s", e)
        return None


# ─── Groq Whisper ─────────────────────────────────────────────────────────────

async def _groq_whisper(audio_bytes: bytes, language: Optional[str] = None) -> Optional[Dict[str, Any]]:
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        return None
    try:
        import io
        from groq import Groq  # type: ignore
        client = Groq(api_key=key)
        kwargs: Dict[str, Any] = {
            "file": ("audio.wav", io.BytesIO(audio_bytes)),
            "model": "whisper-large-v3",
            "response_format": "verbose_json",
        }
        if language and language != "auto":
            kwargs["language"] = language
        result = client.audio.transcriptions.create(**kwargs)
        return {
            "text": result.text,
            "language": getattr(result, "language", language or "unknown"),
            "segments": getattr(result, "segments", []) or [],
            "method": "groq-whisper",
            "diarized": False,
        }
    except Exception as e:
        log.warning("groq whisper failed: %s", e)
        return None


# ─── Deepgram ─────────────────────────────────────────────────────────────────

async def _deepgram_whisper(audio_bytes: bytes) -> Optional[Dict[str, Any]]:
    key = os.getenv("DEEPGRAM_API_KEY", "").strip()
    if not key:
        return None
    try:
        from deepgram import DeepgramClient, PrerecordedOptions  # type: ignore
        dg = DeepgramClient(key)
        options = PrerecordedOptions(model="nova-2", smart_format=True)
        import asyncio
        loop = asyncio.get_event_loop()
        import io
        resp = await loop.run_in_executor(
            None,
            lambda: dg.listen.prerecorded.v("1").transcribe_file(
                {"buffer": io.BytesIO(audio_bytes), "mimetype": "audio/wav"}, options
            ),
        )
        transcript = resp["results"]["channels"][0]["alternatives"][0]
        return {
            "text": transcript.get("transcript", ""),
            "language": "unknown",
            "segments": [],
            "method": "deepgram-nova2",
            "diarized": False,
        }
    except Exception as e:
        log.warning("deepgram whisper failed: %s", e)
        return None


# ─── AssemblyAI ───────────────────────────────────────────────────────────────

async def _assemblyai_whisper(audio_bytes: bytes) -> Optional[Dict[str, Any]]:
    key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()
    if not key:
        return None
    try:
        import assemblyai as aai  # type: ignore
        aai.settings.api_key = key
        config = aai.TranscriptionConfig(speaker_labels=True)
        import asyncio, io
        loop = asyncio.get_event_loop()
        t = await loop.run_in_executor(
            None,
            lambda: aai.Transcriber().transcribe(io.BytesIO(audio_bytes), config=config),
        )
        return {
            "text": t.text or "",
            "language": "unknown",
            "segments": [],
            "method": "assemblyai",
            "diarized": False,
        }
    except Exception as e:
        log.warning("assemblyai whisper failed: %s", e)
        return None


# ─── Local WhisperX ───────────────────────────────────────────────────────────

def _local_whisper(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
) -> Optional[Dict[str, Any]]:
    try:
        import whisperx  # type: ignore
        import tempfile, os as _os
        model_size = _os.getenv("WHISPER_MODEL", "base")
        device = _os.getenv("WHISPER_DEVICE", "cpu")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            tmp = f.name
        try:
            model = whisperx.load_model(model_size, device=device, compute_type="int8")
            audio = whisperx.load_audio(tmp)
            result = model.transcribe(audio, language=language)
            segments = result.get("segments", [])
            text = " ".join(s.get("text", "").strip() for s in segments).strip()
            return {
                "text": text,
                "language": result.get("language", "unknown"),
                "segments": segments,
                "method": f"local-whisperx-{model_size}",
                "diarized": False,
            }
        finally:
            try:
                _os.remove(tmp)
            except Exception:
                pass
    except ImportError:
        return None
    except Exception as e:
        log.warning("local whisperx failed: %s", e)
        return None


# ─── Public API ───────────────────────────────────────────────────────────────

async def transcribe(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio using the configured mode and fallback chain.

    Args:
        audio_bytes: Raw audio (mp3, wav, m4a, ogg, etc.)
        language: 2-letter code ('en', 'fr') or None for auto-detect.
        diarize: Speaker diarization (only supported by orchestrator mode).

    Returns:
        {text, language, segments, method, diarized}
    """
    lang = (language or "").strip().lower() or None
    if lang == "auto":
        lang = None

    if _use_local():
        result = _local_whisper(audio_bytes, lang, diarize)
        if result:
            return result
        # Fall through to remote if local fails

    # Remote chain based on ASR_PROVIDER priority
    priority = [p.strip() for p in
                os.getenv("ASR_PROVIDER", "orchestrator,groq,deepgram,assemblyai").split(",")
                if p.strip()]

    for provider in priority:
        result = None
        if provider == "orchestrator":
            result = _orchestrator_whisper(audio_bytes, lang, diarize)
        elif provider == "groq":
            result = await _groq_whisper(audio_bytes, lang)
        elif provider == "deepgram":
            result = await _deepgram_whisper(audio_bytes)
        elif provider == "assemblyai":
            result = await _assemblyai_whisper(audio_bytes)
        if result and result.get("text") is not None:
            return result

    # All remote providers failed — try local as last resort
    if not _use_local():
        result = _local_whisper(audio_bytes, lang, diarize)
        if result:
            log.info("All remote ASR providers failed — used local WhisperX as last resort")
            return result

    return _error_result("all_providers_failed")
