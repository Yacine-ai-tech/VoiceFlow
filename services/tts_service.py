"""
Text-to-Speech — four providers, one interface.

  edge      Microsoft Edge neural voices — default, no API key, EN/FR.
  elevenlabs Premium quality + voice cloning — ELEVENLABS_API_KEY.
  openai    tts-1-hd — reliable HD voice — OPENAI_API_KEY.
  kokoro    Open-source, expressive, self-hosted — no API key, needs the
            `kokoro` package + model weights installed locally.

Voices used (edge-tts):
  EN: en-US-AriaNeural (female), en-US-GuyNeural (male)
  FR: fr-FR-DeniseNeural (female), fr-FR-HenriNeural (male)

Every non-default provider falls back to edge-tts if it fails for any
reason (missing key, package not installed, network error) — /tts never
just errors out because a premium provider had a bad day.
"""
from __future__ import annotations

import asyncio
import io
import os
import tempfile
from typing import Optional

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

# Voice mapping
VOICES = {
    "en": {
        "female": "en-US-AriaNeural",
        "male": "en-US-GuyNeural",
        "default": "en-US-AriaNeural",
    },
    "fr": {
        "female": "fr-FR-DeniseNeural",
        "male": "fr-FR-HenriNeural",
        "default": "fr-FR-DeniseNeural",
    },
}

# Kokoro ships American-English voices by default; af_heart/am_michael are
# its recommended female/male picks. Kokoro doesn't have French voices as
# of the public checkpoint this targets — falls back to edge-tts for fr.
_KOKORO_VOICES = {"female": "af_heart", "male": "am_michael", "default": "af_heart"}

_kokoro_pipeline = None  # lazy-loaded, cached across calls — the model is ~300MB


async def _generate_elevenlabs(text: str, language: str, voice_gender: str) -> Optional[bytes]:
    if not settings.ELEVENLABS_API_KEY:
        return None
    try:
        import httpx
        el_voice = "21m00Tcm4TlvDq8ikWAM" if voice_gender == "female" else "TxGEqnHWrfWFTfGW9XjX"
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{el_voice}"
        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": settings.ELEVENLABS_API_KEY,
        }
        data = {
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.5},
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=data, headers=headers)
            resp.raise_for_status()
            audio_bytes = resp.content
            log.info("TTS (ElevenLabs) generated: %d bytes", len(audio_bytes))
            return audio_bytes
    except Exception as e:
        log.warning("ElevenLabs TTS failed, falling back to edge-tts: %s", e)
        return None


async def _generate_openai(text: str, voice_gender: str) -> Optional[bytes]:
    if not settings.OPENAI_API_KEY:
        return None
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        voice = "nova" if voice_gender == "female" else "onyx" if voice_gender == "male" else "alloy"
        resp = await client.audio.speech.create(
            model="tts-1-hd", voice=voice, input=text, response_format="mp3",
        )
        audio_bytes = await resp.aread()
        log.info("TTS (OpenAI tts-1-hd) generated: %d bytes", len(audio_bytes))
        return audio_bytes
    except ImportError:
        log.warning("openai package not installed — falling back to edge-tts")
        return None
    except Exception as e:
        log.warning("OpenAI TTS failed, falling back to edge-tts: %s", e)
        return None


def _generate_kokoro_sync(text: str, voice_gender: str) -> Optional[bytes]:
    """Runs Kokoro's (synchronous, CPU/GPU-bound) pipeline. Called via a
    thread so it doesn't block the event loop."""
    global _kokoro_pipeline
    try:
        import numpy as np
        import soundfile as sf
        if _kokoro_pipeline is None:
            from kokoro import KPipeline
            _kokoro_pipeline = KPipeline(lang_code="a")  # American English
        voice = _KOKORO_VOICES.get(voice_gender, _KOKORO_VOICES["default"])
        chunks = []
        for _, _, audio in _kokoro_pipeline(text, voice=voice):
            chunks.append(audio)
        if not chunks:
            return None
        full_audio = np.concatenate(chunks)
        buf = io.BytesIO()
        sf.write(buf, full_audio, 24000, format="WAV")
        return buf.getvalue()
    except ImportError as e:
        log.warning("kokoro not installed (%s) — falling back to edge-tts. "
                    "Install with: pip install kokoro soundfile", e)
        return None
    except Exception as e:
        log.warning("Kokoro TTS failed, falling back to edge-tts: %s", e)
        return None


async def _generate_kokoro_remote(text: str, voice_gender: str) -> Optional[bytes]:
    """Delegate Kokoro synthesis to a remote host instead of running it here
    — same principle as VOICEFLOW_REMOTE_ENDPOINT for ASR: run the heavy
    model on a host you choose, keep this app's own host lightweight."""
    if not settings.TTS_REMOTE_ENDPOINT:
        return None
    try:
        import httpx
        headers = {}
        if settings.TTS_REMOTE_TOKEN:
            headers["Authorization"] = f"Bearer {settings.TTS_REMOTE_TOKEN}"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.TTS_REMOTE_ENDPOINT}/tts/kokoro",
                json={"text": text, "voice_gender": voice_gender},
                headers=headers,
            )
            resp.raise_for_status()
            audio_bytes = resp.content
            log.info("TTS (Kokoro, remote) generated: %d bytes", len(audio_bytes))
            return audio_bytes
    except Exception as e:
        log.warning("Remote Kokoro TTS failed, falling back to local/edge-tts: %s", e)
        return None


async def _generate_kokoro(text: str, language: str, voice_gender: str) -> Optional[bytes]:
    if language.startswith("fr"):
        return None  # no French checkpoint in the default Kokoro release — fall back

    if settings.TTS_REMOTE_ENDPOINT:
        audio = await _generate_kokoro_remote(text, voice_gender)
        if audio:
            return audio
        # Remote failed — fall through and try running it locally instead,
        # in case this host happens to have it installed too.

    return await asyncio.to_thread(_generate_kokoro_sync, text, voice_gender)


async def generate_speech(
    text: str,
    language: str = "en",
    voice_gender: str = "default",
    rate: str = "+0%",
    volume: str = "+0%",
    provider: str = "edge",
) -> bytes:
    """
    Generate speech audio from text via the selected provider, falling back
    to edge-tts on any failure.

    Args:
        text: Text to convert to speech
        language: 'en' or 'fr'
        voice_gender: 'male', 'female', or 'default'
        rate: Speech rate adjustment (e.g. '+10%', '-10%') — edge-tts only
        volume: Volume adjustment (e.g. '+10%', '-10%') — edge-tts only
        provider: 'edge' (default), 'elevenlabs', 'openai', or 'kokoro'

    Returns:
        MP3 audio bytes (WAV for kokoro)
    """
    provider = (provider or "edge").strip().lower()

    if provider == "elevenlabs":
        audio = await _generate_elevenlabs(text, language, voice_gender)
        if audio:
            return audio
    elif provider == "openai":
        audio = await _generate_openai(text, voice_gender)
        if audio:
            return audio
    elif provider == "kokoro":
        audio = await _generate_kokoro(text, language, voice_gender)
        if audio:
            return audio

    # fallback to edge-tts
    try:
        import edge_tts

        lang = language[:2].lower() if language else "en"
        voice_map = VOICES.get(lang, VOICES["en"])
        voice = voice_map.get(voice_gender, voice_map["default"])

        communicate = edge_tts.Communicate(
            text=text,
            voice=voice,
            rate=rate,
            volume=volume,
        )

        # Collect audio bytes
        audio_data = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data.write(chunk["data"])

        audio_bytes = audio_data.getvalue()
        log.info("TTS generated: %d bytes, voice=%s, text_len=%d", len(audio_bytes), voice, len(text))
        return audio_bytes

    except ImportError:
        log.error("edge-tts not installed. Install with: pip install edge-tts")
        raise RuntimeError("edge-tts not installed")
    except Exception as e:
        log.error("TTS generation failed: %s", e)
        raise


def generate_speech_sync(
    text: str,
    language: str = "en",
    voice_gender: str = "default",
) -> bytes:
    """Synchronous wrapper for generate_speech."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # We're in an async context, create a new loop in a thread
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(
                    asyncio.run,
                    generate_speech(text, language, voice_gender)
                )
                return future.result(timeout=30)
        else:
            return loop.run_until_complete(
                generate_speech(text, language, voice_gender)
            )
    except RuntimeError:
        return asyncio.run(generate_speech(text, language, voice_gender))


async def list_voices(language: str = "en") -> list:
    """List available voices for a language."""
    try:
        import edge_tts
        voices = await edge_tts.list_voices()
        lang_prefix = f"{language[:2]}-" if language else "en-"
        return [
            {
                "name": v["ShortName"],
                "gender": v["Gender"],
                "locale": v["Locale"],
            }
            for v in voices
            if v["ShortName"].startswith(lang_prefix)
        ]
    except Exception as e:
        log.error("Failed to list voices: %s", e)
        return []
