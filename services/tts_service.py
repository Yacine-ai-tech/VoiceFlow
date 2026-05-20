"""
Text-to-Speech — Production-grade TTS using edge-tts.

Replaces gTTS with Microsoft Edge neural voices:
- Natural, human-like speech
- Bilingual: English + French
- Fast generation (streaming capable)
- No API key required
- Multiple voice options per language

Voices used:
  EN: en-US-AriaNeural (female), en-US-GuyNeural (male)
  FR: fr-FR-DeniseNeural (female), fr-FR-HenriNeural (male)
"""
from __future__ import annotations

import asyncio
import io
import tempfile
from typing import Optional

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


async def generate_speech(
    text: str,
    language: str = "en",
    voice_gender: str = "default",
    rate: str = "+0%",
    volume: str = "+0%",
) -> bytes:
    """
    Generate speech audio from text using edge-tts.
    
    Args:
        text: Text to convert to speech
        language: 'en' or 'fr'
        voice_gender: 'male', 'female', or 'default'
        rate: Speech rate adjustment (e.g. '+10%', '-10%')
        volume: Volume adjustment (e.g. '+10%', '-10%')
    
    Returns:
        MP3 audio bytes
    """
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
