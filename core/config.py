"""
VoiceFlow configuration — runtime settings loaded from environment variables.

All API keys and secrets must be supplied via environment variables.
Defaults are safe for local development; always override in production.
"""
from __future__ import annotations

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

BASE_DIR = Path(__file__).resolve().parent.parent
LOGS_DIR = BASE_DIR / "logs"
UPLOADS_DIR = BASE_DIR / "uploads"
LOGS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


class Settings:
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
    LOG_FORMAT = os.getenv("LOG_FORMAT", "%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    LOGS_DIR = str(LOGS_DIR)

    LLM_DEFAULT = os.getenv("LLM_DEFAULT", "groq/llama-3.3-70b-versatile")
    LLM_REASONING = os.getenv("LLM_REASONING", "anthropic/claude-sonnet-4-6")
    LLM_JUDGE = os.getenv("LLM_JUDGE", "anthropic/claude-haiku-4-5")

    @property
    def GROQ_API_KEY(self) -> str:
        return os.getenv("GROQ_API_KEY", "").strip()

    @property
    def ANTHROPIC_API_KEY(self) -> str:
        return os.getenv("ANTHROPIC_API_KEY", "").strip()

    @property
    def OPENAI_API_KEY(self) -> str:
        return os.getenv("OPENAI_API_KEY", "").strip()

    @property
    def GEMINI_API_KEY(self) -> str:
        return os.getenv("GEMINI_API_KEY", "").strip()

    @property
    def HF_TOKEN(self) -> str:
        return os.getenv("HF_TOKEN", "").strip()

    @property
    def DEEPGRAM_API_KEY(self) -> str:
        return os.getenv("DEEPGRAM_API_KEY", "").strip()

    @property
    def ASSEMBLYAI_API_KEY(self) -> str:
        return os.getenv("ASSEMBLYAI_API_KEY", "").strip()

    TRANSCRIPTION_PROVIDER = os.getenv("TRANSCRIPTION_PROVIDER", "LOCAL_WHISPERX")
    TRANSCRIPTION_MODE = os.getenv("TRANSCRIPTION_MODE", "local")
    TRANSCRIPTION_ENDPOINT = os.getenv("TRANSCRIPTION_ENDPOINT", "")
    TRANSCRIPTION_TOKEN = os.getenv("TRANSCRIPTION_TOKEN", "")
    WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
    WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")

    @property
    def REALTIME_PROVIDER(self) -> str:
        return os.getenv("REALTIME_PROVIDER", "openai").strip()

    @property
    def REALTIME_API_KEY(self) -> str:
        return os.getenv("REALTIME_API_KEY", "").strip()

    CORS_ALLOWED_ORIGINS = [
        o.strip() for o in os.getenv("CORS_ALLOWED_ORIGINS", "*").split(",")
        if o.strip()
    ]

    # Dedicated Neon Postgres for VoiceFlow (session logs, transcription history)
    POSTGRES_URL: str = os.getenv("POSTGRES_URL", "")


settings = Settings()


def _validate_keys():
    keys = [
        getattr(settings, "GROQ_API_KEY", ""),
        getattr(settings, "ANTHROPIC_API_KEY", ""),
        getattr(settings, "OPENAI_API_KEY", ""),
        getattr(settings, "GEMINI_API_KEY", "")
    ]
    valid_keys = [k for k in keys if k]
    if len(valid_keys) < 2:
        import warnings
        warnings.warn("VoiceFlow requires at least 2 LLM API keys (GROQ, ANTHROPIC, OPENAI, GEMINI) for robust routing.")

_validate_keys()
