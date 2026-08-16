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

_kokoro_pipeline = None  # lazy-loaded, cached across calls. The Kokoro checkpoint
# itself is ~300MB, but pip-installing this feature (requirements-ml.txt) also
# pulls in PyTorch/CUDA, which is a multi-GB dependency chain on its own — don't
# assume ~300MB covers the whole install.


async def _generate_elevenlabs(text: str, language: str, voice_gender: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    if not settings.ELEVENLABS_API_KEY:
        return None
    try:
        import httpx
        # Sarah / Daniel — current ElevenLabs premade voices, verified live
        # against the real /v1/voices list (the old Rachel/Josh IDs some
        # docs still reference no longer resolve on current accounts).
        # Note: ElevenLabs requires a paid plan to use *any* premade/library
        # voice via the API at all — on a free-tier account this call 402s
        # regardless of which voice_id is used, and generate_speech() falls
        # back to edge-tts, same as any other ElevenLabs failure.
        el_voice = voice_id or ("EXAVITQu4vr4xnSDxMaL" if voice_gender == "female" else "onwK4e9ZLuTAKqWW03F9")
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


async def list_elevenlabs_voices() -> list:
    """Every voice on this ElevenLabs account — the 2 stock voices
    /tts falls back to plus any cloned ones. Raises RuntimeError with the
    real reason (no key, bad key, API error) rather than returning an
    empty list that could be mistaken for "no voices exist"."""
    if not settings.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY not configured")
    import httpx
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            "https://api.elevenlabs.io/v1/voices",
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
    """Instant Voice Cloning — upload one or more real audio samples of a
    voice and get back a usable voice_id for /tts's provider=elevenlabs.
    This is ElevenLabs' actual differentiating feature, not
    just picking between two stock voices. Raises RuntimeError (with
    ElevenLabs' real error message) on failure — a plan that doesn't
    support cloning, too few/short samples, etc. are never silently
    swallowed into a fake success."""
    if not settings.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY not configured")
    if not samples:
        raise RuntimeError("at least one audio sample is required")
    import httpx
    files = [("files", (f"sample_{i}.wav", s, "audio/wav")) for i, s in enumerate(samples)]
    data = {"name": name}
    if description:
        data["description"] = description
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.elevenlabs.io/v1/voices/add",
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
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            f"https://api.elevenlabs.io/v1/voices/{voice_id}",
            headers={"xi-api-key": settings.ELEVENLABS_API_KEY},
        )
        resp.raise_for_status()


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


async def _post_with_retries(client, url: str, json_body: dict, headers: dict, attempts: int = 4):
    """A self-hosted remote inference backend that scales its compute down
    to zero when idle (a common, cost-effective pattern for GPU-backed
    endpoints) can return a transient failure on the first request after a
    period of inactivity, while it wakes back up in the background — the
    wake itself is normally non-blocking, so that first request doesn't
    wait for it and can legitimately fail. A cold wake-up can take up to a
    minute or two depending on the backend, which is too long for a single
    HTTP request to block on for what should be a fast TTS call.

    This retry loop is deliberately bounded and does not try to wait out a
    full cold start — it only catches the tail end of a wake-up already in
    progress from a recent previous request. On a fully cold backend, this
    still correctly falls through to edge-tts on the first call (expected,
    not a bug) while the remote backend keeps warming up independently of
    this loop, so a follow-up call shortly after tends to succeed."""
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
    """Delegate Kokoro synthesis to a remote host instead of running it here
    — same principle as VOICEFLOW_REMOTE_ENDPOINT for ASR: run the heavy
    model on a host you choose, keep this app's own host lightweight.

    Two contracts are tried, each with a bounded retry (see
    _post_with_retries — it rides out a wake-up already in progress, not a
    full cold start; see that docstring for why), since real Kokoro-serving
    hosts speak either:
      1. {endpoint}/tts/kokoro — {"text","voice_gender"} in, raw audio bytes
         back. The originally-documented contract; tried first for anyone
         who built a remote exactly to that spec.
      2. {endpoint}/api/inference/tts — {"text","voice"} in (Kokoro's own
         voice IDs, not a gender string), {"audio_b64","voice","sample_rate"}
         JSON back. Same /api/inference/* convention as the /whisper and
         /nemo ASR routes — a shape some self-hosted inference backends use.
    """
    if not settings.TTS_REMOTE_ENDPOINT:
        return None
    import httpx
    headers = {}
    if settings.TTS_REMOTE_TOKEN:
        headers["Authorization"] = f"Bearer {settings.TTS_REMOTE_TOKEN}"

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await _post_with_retries(
                client, f"{settings.TTS_REMOTE_ENDPOINT}/tts/kokoro",
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
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await _post_with_retries(
                client, f"{settings.TTS_REMOTE_ENDPOINT}/api/inference/tts",
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
    voice_id: Optional[str] = None,
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
        voice_id: ElevenLabs voice ID override — a cloned voice from
            clone_elevenlabs_voice(), or any other voice ID on the account.
            Ignored by every other provider. Falls back to the two stock
            gender-mapped voices when not given.

    Returns:
        MP3 audio bytes (WAV for kokoro)
    """
    provider = (provider or "edge").strip().lower()

    if provider == "elevenlabs":
        audio = await _generate_elevenlabs(text, language, voice_gender, voice_id)
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
