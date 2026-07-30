"""Slim VoiceFlow configuration."""
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
    WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
    WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")

    CORS_ALLOWED_ORIGINS = [
        o.strip() for o in os.getenv("CORS_ALLOWED_ORIGINS", "*").split(",")
        if o.strip()
    ]


settings = Settings()


# --- OPENAI TO GEMINI FALLBACK LOGIC ---
def _apply_gemini_fallback():
    openai_key = getattr(settings, "OPENAI_API_KEY", "") or os.getenv("OPENAI_API_KEY", "")
    gemini_key = getattr(settings, "GEMINI_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
    
    if not openai_key and gemini_key:
        def fallback(model_str):
            if model_str and ("openai" in model_str.lower() or "gpt-" in model_str.lower()):
                return "gemini/gemini-1.5-flash"
            return model_str
            
        for attr in dir(settings):
            if attr.startswith("LLM_") and isinstance(getattr(settings, attr), str):
                setattr(settings, attr, fallback(getattr(settings, attr)))
        
        if hasattr(settings, "JUDGE_MODELS") and isinstance(settings.JUDGE_MODELS, list):
            settings.JUDGE_MODELS = [fallback(m) for m in settings.JUDGE_MODELS]

_apply_gemini_fallback()
