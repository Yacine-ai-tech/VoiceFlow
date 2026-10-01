"""
Text-to-Speech — four providers, one interface.

  edge      Microsoft Edge neural voices — default, no API key, EN/FR.
  elevenlabs Premium quality + real voice cloning — ELEVENLABS_API_KEY.
             list_elevenlabs_voices() / clone_elevenlabs_voice() /
             delete_elevenlabs_voice() manage cloned voices; pass the
             resulting voice_id to generate_speech() to use one.
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
from typing import Optional

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)


def get_edge_voices() -> dict[str, dict[str, str]]:
    """Dynamic Edge-TTS voice mapping driven by environment variables."""
    en_female = settings.EDGE_TTS_VOICE_EN_FEMALE
    en_male = settings.EDGE_TTS_VOICE_EN_MALE
    fr_female = settings.EDGE_TTS_VOICE_FR_FEMALE
    fr_male = settings.EDGE_TTS_VOICE_FR_MALE
    return {
        "en": {
            "female": en_female,
            "male": en_male,
            "default": en_female,
        },
        "fr": {
            "female": fr_female,
            "male": fr_male,
            "default": fr_female,
        },
    }


class _DynamicVoicesMapping(dict):
    """Dynamic voice mapping that always resolves voices from environment/settings."""

    def __getitem__(self, key: str):
        voices = get_edge_voices()
        return voices.get(key, voices["en"])

    def get(self, key: str, default=None):
        voices = get_edge_voices()
        return voices.get(key, default or voices["en"])

    def __contains__(self, key: object) -> bool:
        return key in get_edge_voices()

    def items(self):
        return get_edge_voices().items()

    def values(self):
        return get_edge_voices().values()

    def keys(self):
        return get_edge_voices().keys()


# Voice mapping — dynamically reflects environment variables
VOICES = _DynamicVoicesMapping()


def get_kokoro_voices() -> dict[str, str]:
    """Dynamic Kokoro voice mapping driven by environment variables."""
    female = settings.KOKORO_VOICE_FEMALE
    male = settings.KOKORO_VOICE_MALE
    default_voice = settings.KOKORO_VOICE_DEFAULT
    return {"female": female, "male": male, "default": default_voice}


class _DynamicKokoroVoicesMapping(dict):
    """Dynamic Kokoro voice mapping resolved from environment/settings."""

    def __getitem__(self, key: str):
        voices = get_kokoro_voices()
        return voices.get(key, voices["default"])

    def get(self, key: str, default=None):
        voices = get_kokoro_voices()
        return voices.get(key, default or voices["default"])

    def __contains__(self, key: object) -> bool:
        return key in get_kokoro_voices()

    def items(self):
        return get_kokoro_voices().items()

    def values(self):
        return get_kokoro_voices().values()

    def keys(self):
        return get_kokoro_voices().keys()


_KOKORO_VOICES = _DynamicKokoroVoicesMapping()

_kokoro_pipeline = None  # lazy-loaded, cached across calls.


async def _generate_elevenlabs(text: str, language: str, voice_gender: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    if not settings.ELEVENLABS_API_KEY:
        return None
    try:
        import httpx
        default_voice = (
            settings.ELEVENLABS_DEFAULT_VOICE_FEMALE
            if voice_gender == "female"
            else settings.ELEVENLABS_DEFAULT_VOICE_MALE
        )
        el_voice = voice_id or default_voice
        base_url = settings.ELEVENLABS_BASE_URL
        url = f"{base_url}/text-to-speech/{el_voice}"
        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": settings.ELEVENLABS_API_KEY,
        }
        data = {
            "text": text,
            "model_id": settings.ELEVENLABS_MODEL_ID,
            "voice_settings": {
                "stability": settings.ELEVENLABS_STABILITY,
                "similarity_boost": settings.ELEVENLABS_SIMILARITY_BOOST,
            },
        }
        timeout = settings.ELEVENLABS_TIMEOUT_SECONDS
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=data, headers=headers)
            resp.raise_for_status()
            audio_bytes = resp.content
            log.info("TTS (ElevenLabs) generated: %d bytes", len(audio_bytes))
            return audio_bytes
    except Exception as e:
        log.warning("ElevenLabs TTS failed, falling back to edge-tts: %s", e)
        return None


async def list_elevenlabs_voices() -> list:
    """Every voice on this ElevenLabs account — stock voices plus cloned ones."""
    if not settings.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY not configured")
    import httpx
    base_url = settings.ELEVENLABS_BASE_URL
    timeout = settings.ELEVENLABS_TIMEOUT_SECONDS
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(
            f"{base_url}/voices",
            headers={"xi-api-key": settings.ELEVENLABS_API_KEY},
        )
        resp.raise_for_status()
        data = resp.json()
    return [
        {
            "voice_id": v.get("voice_id"),
            "name": v.get("name"),
            "category": v.get("category"),  # "premade" | "cloned" | ...
            "description": v.get("description"),
        }
        for v in data.get("voices", [])
    ]


async def clone_elevenlabs_voice(name: str, samples: list[bytes], description: str = "") -> dict:
    """Instant Voice Cloning — upload real audio samples of a voice."""
    if not settings.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY not configured")
    if not samples:
        raise RuntimeError("at least one audio sample is required")
    import httpx
    files = [("files", (f"sample_{i}.wav", s, "audio/wav")) for i, s in enumerate(samples)]
    data = {"name": name}
    if description:
        data["description"] = description
    base_url = settings.ELEVENLABS_BASE_URL
    timeout = settings.ELEVENLABS_TIMEOUT_SECONDS * 2
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base_url}/voices/add",
            headers={"xi-api-key": settings.ELEVENLABS_API_KEY},
            data=data,
            files=files,
        )
        if resp.status_code >= 400:
            detail = resp.text
            try:
                detail = resp.json().get("detail", detail)
            except Exception:
                pass
            raise RuntimeError(f"ElevenLabs voice clone failed ({resp.status_code}): {detail}")
        result = resp.json()
    log.info("ElevenLabs voice cloned: %s -> %s", name, result.get("voice_id"))
    return {"voice_id": result.get("voice_id"), "name": name}


async def delete_elevenlabs_voice(voice_id: str) -> None:
    if not settings.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY not configured")
    import httpx
    base_url = settings.ELEVENLABS_BASE_URL
    timeout = settings.ELEVENLABS_TIMEOUT_SECONDS
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.delete(
            f"{base_url}/voices/{voice_id}",
            headers={"xi-api-key": settings.ELEVENLABS_API_KEY},
        )
        resp.raise_for_status()


async def _generate_openai(text: str, voice_gender: str) -> Optional[bytes]:
    if not settings.OPENAI_API_KEY:
        return None
    try:
        from openai import AsyncOpenAI
        base_url = os.getenv("OPENAI_BASE_URL", "").strip() or None
        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY, base_url=base_url)
        voice = (
            settings.OPENAI_TTS_VOICE_FEMALE
            if voice_gender == "female"
            else (settings.OPENAI_TTS_VOICE_MALE if voice_gender == "male" else settings.OPENAI_TTS_VOICE_DEFAULT)
        )
        model = settings.OPENAI_TTS_MODEL
        response_format = settings.OPENAI_TTS_RESPONSE_FORMAT
        resp = await client.audio.speech.create(
            model=model, voice=voice, input=text, response_format=response_format,
        )
        audio_bytes = await resp.aread()
        log.info("TTS (OpenAI %s) generated: %d bytes", model, len(audio_bytes))
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
            _kokoro_pipeline = KPipeline(
                lang_code=settings.KOKORO_LANG_CODE,
                repo_id=settings.KOKORO_REPO_ID,
            )
        voice = _KOKORO_VOICES.get(voice_gender, _KOKORO_VOICES["default"])
        chunks = []
        for _, _, audio in _kokoro_pipeline(text, voice=voice):
            chunks.append(audio)
        if not chunks:
            return None
        full_audio = np.concatenate(chunks)
        buf = io.BytesIO()
        sample_rate = settings.KOKORO_SAMPLE_RATE
        sf.write(buf, full_audio, sample_rate, format="WAV")
        return buf.getvalue()
    except ImportError as e:
        log.warning("kokoro not installed (%s) — falling back to edge-tts. "
                    "Install with: pip install kokoro soundfile", e)
        return None
    except Exception as e:
        log.warning("Kokoro TTS failed, falling back to edge-tts: %s", e)
        return None


async def _post_with_retries(client, url: str, json_body: dict, headers: dict, attempts: Optional[int] = None):
    if attempts is None:
        attempts = settings.TTS_REMOTE_RETRIES
    last_exc = None
    for i in range(attempts):
        try:
            resp = await client.post(url, json=json_body, headers=headers)
            resp.raise_for_status()
            return resp
        except Exception as e:
            last_exc = e
            if i < attempts - 1:
                await asyncio.sleep(2 * (i + 1))
    raise last_exc


async def _generate_kokoro_remote(text: str, voice_gender: str) -> Optional[bytes]:
    if not settings.TTS_REMOTE_ENDPOINT:
        return None
    import httpx
    headers = {}
    if settings.TTS_REMOTE_TOKEN:
        headers["Authorization"] = f"Bearer {settings.TTS_REMOTE_TOKEN}"

    endpoint = settings.TTS_REMOTE_ENDPOINT
    timeout = settings.TTS_REMOTE_TIMEOUT
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await _post_with_retries(
                client, f"{endpoint}/tts/kokoro",
                {"text": text, "voice_gender": voice_gender}, headers,
            )
            audio_bytes = resp.content
            log.info("TTS (Kokoro, remote /tts/kokoro) generated: %d bytes", len(audio_bytes))
            return audio_bytes
    except Exception as e:
        log.info("Remote /tts/kokoro not available after retries (%s), trying /api/inference/tts", e)

    try:
        import base64
        voice = _KOKORO_VOICES.get(voice_gender, _KOKORO_VOICES["default"])
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await _post_with_retries(
                client, f"{endpoint}/api/inference/tts",
                {"text": text, "voice": voice}, headers,
            )
            data = resp.json()
            if "audio_b64" not in data:
                raise RuntimeError(f"no audio_b64 in response: {data}")
            audio_bytes = base64.b64decode(data["audio_b64"])
            log.info("TTS (Kokoro, remote /api/inference/tts, voice=%s) generated: %d bytes", data.get("voice"), len(audio_bytes))
            return audio_bytes
    except Exception as e:
        log.warning("Remote Kokoro TTS failed on both contracts after retries, falling back to local/edge-tts: %s", e)
        return None


async def _generate_kokoro(text: str, language: str, voice_gender: str) -> Optional[bytes]:
    if language.startswith("fr"):
        return None  # no French checkpoint in default Kokoro release — fall back

    # 1. Primary: Run local on-host Kokoro synthesis directly
    try:
        audio = await asyncio.to_thread(_generate_kokoro_sync, text, voice_gender)
        if audio:
            return audio
    except Exception as e:
        log.warning("Local Kokoro synthesis failed: %s", e)

    # 2. Secondary fallback: remote endpoint only if explicitly configured
    if settings.TTS_REMOTE_ENDPOINT:
        audio = await _generate_kokoro_remote(text, voice_gender)
        if audio:
            return audio

    return None


async def generate_speech(
    text: str,
    language: str = "en",
    voice_gender: str = "default",
    rate: Optional[str] = None,
    volume: Optional[str] = None,
    provider: Optional[str] = None,
    voice_id: Optional[str] = None,
) -> bytes:
    """
    Generate speech audio from text via the selected provider, falling back
    to edge-tts on any failure.
    """
    p = (provider or settings.TTS_DEFAULT_PROVIDER or "edge").strip().lower()

    if p == "elevenlabs":
        audio = await _generate_elevenlabs(text, language, voice_gender, voice_id)
        if audio:
            return audio
    elif p == "openai":
        audio = await _generate_openai(text, voice_gender)
        if audio:
            return audio
    elif p == "kokoro":
        audio = await _generate_kokoro(text, language, voice_gender)
        if audio:
            return audio

    # fallback to edge-tts
    try:
        import edge_tts

        rate_val = rate if rate is not None else settings.EDGE_TTS_DEFAULT_RATE
        volume_val = volume if volume is not None else settings.EDGE_TTS_DEFAULT_VOLUME

        lang = language[:2].lower() if language else "en"
        voice_map = VOICES.get(lang, VOICES["en"])
        voice = voice_map.get(voice_gender, voice_map["default"])

        communicate = edge_tts.Communicate(
            text=text,
            voice=voice,
            rate=rate_val,
            volume=volume_val,
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


async def generate_speech_with_meta(
    text: str,
    language: str = "en",
    voice_gender: str = "default",
    rate: Optional[str] = None,
    volume: Optional[str] = None,
    provider: Optional[str] = None,
    voice_id: Optional[str] = None,
) -> tuple[bytes, str]:
    """Generate speech and return a tuple of (audio_bytes, actual_provider_used)."""
    p = (provider or settings.TTS_DEFAULT_PROVIDER or "edge").strip().lower()
    if p == "elevenlabs":
        audio = await _generate_elevenlabs(text, language, voice_gender, voice_id)
        if audio:
            return audio, "elevenlabs"
    elif p == "openai":
        audio = await _generate_openai(text, voice_gender)
        if audio:
            return audio, "openai"
    elif p == "kokoro":
        audio = await _generate_kokoro(text, language, voice_gender)
        if audio:
            return audio, "kokoro"
    audio = await generate_speech(text, language, voice_gender, rate, volume, provider="edge")
    return audio, "edge"


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
