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


# ─── Deepgram REST ────────────────────────────────────────────────────────────

async def _deepgram_whisper(audio_bytes: bytes) -> Optional[Dict[str, Any]]:
    key = os.getenv("DEEPGRAM_API_KEY", "").strip()
    if not key:
        return None
    try:
        req = urllib.request.Request(
            "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
            data=audio_bytes,
            headers={
                "Authorization": f"Token {key}",
                "Content-Type": "audio/wav"
            }
        )
        resp = _json.loads(urllib.request.urlopen(req, timeout=30).read())
        results = resp.get("results", {}).get("channels", [{}])[0].get("alternatives", [{}])[0]
        return {
            "text": results.get("transcript", ""),
            "language": "en",
            "segments": results.get("paragraphs", {}).get("paragraphs", []),
            "method": "deepgram-nova2",
            "diarized": False,
        }
    except Exception as e:
        log.warning("deepgram rest failed: %s", e)
        return None


# ─── AssemblyAI REST ──────────────────────────────────────────────────────────

async def _assemblyai_whisper(audio_bytes: bytes) -> Optional[Dict[str, Any]]:
    key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()
    if not key:
        return None
    try:
        # Step 1: Upload audio
        up_req = urllib.request.Request(
            "https://api.assemblyai.com/v2/upload",
            data=audio_bytes,
            headers={"Authorization": key}
        )
        up_res = _json.loads(urllib.request.urlopen(up_req, timeout=30).read())
        audio_url = up_res.get("upload_url")
        if not audio_url:
            return None

        # Step 2: Request transcription
        tx_req = urllib.request.Request(
            "https://api.assemblyai.com/v2/transcript",
            data=_json.dumps({"audio_url": audio_url, "speaker_labels": True}).encode(),
            headers={"Authorization": key, "Content-Type": "application/json"}
        )
        tx_res = _json.loads(urllib.request.urlopen(tx_req, timeout=30).read())
        tx_id = tx_res.get("id")

        # Step 3: Poll for completion (max 15 sec)
        for _ in range(15):
            import time
            time.sleep(1)
            poll_req = urllib.request.Request(
                f"https://api.assemblyai.com/v2/transcript/{tx_id}",
                headers={"Authorization": key}
            )
            poll_res = _json.loads(urllib.request.urlopen(poll_req, timeout=10).read())
            status = poll_res.get("status")
            if status == "completed":
                return {
                    "text": poll_res.get("text", ""),
                    "language": poll_res.get("language_code", "en"),
                    "segments": poll_res.get("utterances", []),
                    "method": "assemblyai",
                    "diarized": True,
                }
            elif status == "error":
                break
        return None
    except Exception as e:
        log.warning("assemblyai rest failed: %s", e)
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
