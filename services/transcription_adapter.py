"""
VoiceFlow Transcription Adapter
================================
Generic adapter for speech-to-text supporting:
1. Local mode (WhisperX on local machine)
2. Remote mode:
   - Hugging Face Inference API (if 'huggingface.co' in settings.TRANSCRIPTION_ENDPOINT)
   - OpenAI-compatible API (using the openai python package)
"""
from __future__ import annotations

import json
import logging
import os
import urllib.request
from typing import Any, Dict, Optional

from core.config import settings

log = logging.getLogger(__name__)


def _local_whisper(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio locally using WhisperX.
    """
    try:
        import tempfile
        import whisperx  # type: ignore

        model_size = getattr(settings, "WHISPER_MODEL", "base")
        device = getattr(settings, "WHISPER_DEVICE", "cpu")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        try:
            model = whisperx.load_model(model_size, device=device, compute_type="int8")
            audio = whisperx.load_audio(tmp_path)
            result = model.transcribe(audio, language=language)
            segments = result.get("segments", [])
            text = " ".join(s.get("text", "").strip() for s in segments if isinstance(s, dict)).strip()
            return {
                "text": text,
                "language": result.get("language", language or "unknown"),
                "segments": segments if isinstance(segments, list) else [],
                "method": f"local-whisperx-{model_size}",
                "diarized": False,
            }
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
    except ImportError:
        log.warning("whisperx module not available for local transcription mode")
        return {
            "text": "",
            "language": language or "unknown",
            "segments": [],
            "method": "local-whisper-unavailable",
            "diarized": False,
            "error": "whisperx module not installed",
        }
    except Exception as e:
        log.warning("Local whisper transcription failed: %s", e)
        return {
            "text": "",
            "language": language or "unknown",
            "segments": [],
            "method": "local-whisper-error",
            "diarized": False,
            "error": str(e),
        }


def _remote_huggingface(
    audio_bytes: bytes,
    endpoint: str,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Transcribe audio via Hugging Face Inference API (raw audio bytes POST).
    """
    headers = {"Content-Type": "audio/wav"}
    token = getattr(settings, "TRANSCRIPTION_TOKEN", "") or getattr(settings, "HF_TOKEN", "")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        req = urllib.request.Request(endpoint, data=audio_bytes, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp_body = resp.read().decode("utf-8")
            data = json.loads(resp_body)

            text = ""
            segments = []
            if isinstance(data, dict):
                text = data.get("text", "")
                segments = data.get("segments", data.get("chunks", []))
            elif isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
                text = data[0].get("text", "")
                segments = data[0].get("segments", data[0].get("chunks", []))

            return {
                "text": text,
                "language": language or "unknown",
                "segments": segments if isinstance(segments, list) else [],
                "method": "huggingface-remote",
                "diarized": False,
            }
    except Exception as e:
        log.warning("HuggingFace remote transcription failed: %s", e)
        return {
            "text": "",
            "language": language or "unknown",
            "segments": [],
            "method": "huggingface-remote-error",
            "diarized": False,
            "error": str(e),
        }


def _remote_openai(
    audio_bytes: bytes,
    endpoint: str,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Transcribe audio via OpenAI-compatible endpoint using the openai python package.
    """
    try:
        from openai import OpenAI
    except ImportError:
        log.error("openai package not installed")
        return {
            "text": "",
            "language": language or "unknown",
            "segments": [],
            "method": "openai-remote-error",
            "diarized": False,
            "error": "openai package not installed",
        }

    token = getattr(settings, "TRANSCRIPTION_TOKEN", "") or getattr(settings, "OPENAI_API_KEY", "") or "not-set"
    model = getattr(settings, "WHISPER_MODEL", "base")

    try:
        client = OpenAI(base_url=endpoint, api_key=token)
        create_kwargs: Dict[str, Any] = {
            "file": ("audio.wav", audio_bytes),
            "model": model,
            "response_format": "verbose_json",
        }
        if language and language.lower() != "auto":
            create_kwargs["language"] = language

        result = client.audio.transcriptions.create(**create_kwargs)

        text = getattr(result, "text", "") or ""
        resp_lang = getattr(result, "language", None) or language or "unknown"
        raw_segments = getattr(result, "segments", []) or []

        formatted_segments = []
        for s in raw_segments:
            if hasattr(s, "model_dump"):
                formatted_segments.append(s.model_dump())
            elif hasattr(s, "dict"):
                formatted_segments.append(s.dict())
            elif isinstance(s, dict):
                formatted_segments.append(s)
            else:
                formatted_segments.append(str(s))

        return {
            "text": text,
            "language": resp_lang,
            "segments": formatted_segments,
            "method": f"openai-remote-{model}",
            "diarized": False,
        }
    except Exception as e:
        log.warning("OpenAI-compatible remote transcription failed: %s", e)
        return {
            "text": "",
            "language": language or "unknown",
            "segments": [],
            "method": "openai-remote-error",
            "diarized": False,
            "error": str(e),
        }


async def transcribe(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio via local WhisperX or generic remote endpoint (HF or OpenAI-compatible).

    Args:
        audio_bytes: Raw audio bytes (wav, mp3, webm, etc.)
        language: Optional language code ('en', 'fr', etc.) or None for auto.
        diarize: Speaker diarization flag.

    Returns:
        Standard dict: { "text": "...", "language": "...", "segments": [], "method": "...", "diarized": False }
    """
    mode = (getattr(settings, "TRANSCRIPTION_MODE", "") or "local").strip().lower()

    if mode == "local":
        return _local_whisper(audio_bytes, language=language, diarize=diarize)

    if mode == "remote":
        endpoint = (getattr(settings, "TRANSCRIPTION_ENDPOINT", "") or "").strip()
        if not endpoint:
            log.warning("TRANSCRIPTION_MODE is 'remote' but TRANSCRIPTION_ENDPOINT is not set")
            return {
                "text": "",
                "language": language or "unknown",
                "segments": [],
                "method": "remote-missing-endpoint",
                "diarized": False,
                "error": "TRANSCRIPTION_ENDPOINT not configured",
            }

        if "huggingface.co" in endpoint.lower():
            return _remote_huggingface(audio_bytes, endpoint, language=language)
        else:
            return _remote_openai(audio_bytes, endpoint, language=language)

    # Fallback to local if unknown mode
    log.warning("Unknown TRANSCRIPTION_MODE '%s', falling back to local", mode)
    return _local_whisper(audio_bytes, language=language, diarize=diarize)
