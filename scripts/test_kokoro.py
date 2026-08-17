#!/usr/bin/env python3
"""
Manual smoke check for the Kokoro TTS provider (local or delegated to
VOICEFLOW_TTS_REMOTE_ENDPOINT, per whichever is configured in .env). Not
part of the pytest suite (see tests/ for that); this is for a quick manual
check that provider="kokoro" actually produces audio.

Usage: python3 scripts/test_kokoro.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from services.tts_service import generate_speech


async def main():
    audio = await generate_speech("Hello from kokoro", language="en", voice_gender="default", provider="kokoro")
    if audio:
        print("Generated audio of length", len(audio))
    else:
        print("Failed to generate audio")


if __name__ == "__main__":
    asyncio.run(main())
