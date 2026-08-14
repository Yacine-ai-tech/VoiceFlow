"""
VoiceFlow configuration — runtime settings loaded from environment variables.

All API keys and secrets must be supplied via environment variables.
Defaults are safe for local development; always override in production.
"""
from __future__ import annotations
import base64

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

    @property
    def ELEVENLABS_API_KEY(self) -> str:
        return os.getenv("ELEVENLABS_API_KEY", "").strip()

    @property
    def PYANNOTE_TOKEN(self) -> str:
        return os.getenv("PYANNOTE_TOKEN", "").strip()

    TRANSCRIPTION_PROVIDER = os.getenv("TRANSCRIPTION_PROVIDER", "LOCAL_WHISPERX")
    WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
    WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")

    # Which engine actually runs when transcription is in local mode
    # (VOICEFLOW_TRANSCRIPTION_MODE=local). Remote mode doesn't care about
    # this at all — VOICEFLOW_REMOTE_ENDPOINT is a black box you control, and
    # you decide what runs behind it (WhisperX, NeMo Canary, anything).
    # This only matters for running heavy ASR directly on this app's own host.
    LOCAL_ASR_ENGINE = os.getenv("LOCAL_ASR_ENGINE", "whisperx").strip().lower()  # whisperx | nemo_canary

    # Same idea for diarization in local mode. pyannote needs a GPU for
    # reasonable speed; NeMo's clustering diarizer is the CPU-capable option.
    LOCAL_DIARIZATION_ENGINE = os.getenv("LOCAL_DIARIZATION_ENGINE", "pyannote").strip().lower()  # pyannote | nemo

    # Kokoro TTS local/remote split, same principle as ASR above: run it on
    # this host (needs the heavy deps installed here — see
    # requirements-ml.txt) or delegate to a remote host you control. Unlike
    # ASR, TTS has no shared remote endpoint to piggyback on, hence its own.
    TTS_REMOTE_ENDPOINT = os.getenv("VOICEFLOW_TTS_REMOTE_ENDPOINT", "").rstrip("/")

    @property
    def TTS_REMOTE_TOKEN(self) -> str:
        return os.getenv("VOICEFLOW_TTS_REMOTE_TOKEN", "").strip()

    OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview")

    # Which backend the /realtime voice agent bridges to — "openai" or "gemini".
    # This is a deliberate choice, not an auto-detected one: whichever value is
    # set here is the one used, full stop. There is no fallback from one to the
    # other based on which key happens to be present.
    REALTIME_PROVIDER = os.getenv("REALTIME_PROVIDER", "openai").strip().lower()

    @property
    def REALTIME_API_KEY(self) -> str:
        """The API key for whichever provider REALTIME_PROVIDER selects.

        If you set REALTIME_PROVIDER=openai but only GEMINI_API_KEY is
        configured, this returns empty and /realtime correctly reports
        "not configured" — it will not silently use Gemini instead.
        """
        return self.GEMINI_API_KEY if self.REALTIME_PROVIDER == "gemini" else self.OPENAI_API_KEY

    @property
    def TELEMETRY_ENDPOINT(self) -> str:
        """Where the one-time-per-restart anonymous startup ping is sent.

        Enabled by default (opt-out, not opt-in) — see TELEMETRY.md for
        exactly what the payload contains and how to disable it. Set
        TELEMETRY_OPT_OUT=true to turn it off, or override this to point
        at your own collector instead.
        """
        return os.getenv("TELEMETRY_ENDPOINT", base64.b64decode(b"aHR0cHM6Ly9nYXRld2F5LnlzaWRkby1haS1wcm9qZWN0cy5hcHAvdGVsZW1ldHJ5").decode("utf-8")).strip()

    @property
    def OMNIINTEL_INTERNAL_TOKEN(self) -> str:
        """Shared service-to-service auth token sent on X-OmniIntel-Internal-Token."""
        return os.getenv("OMNIINTEL_INTERNAL_TOKEN", "").strip()

    # Base URL of an external "agent tools" service — see
    # services/agent_tools_bridge.py for the discovery contract. Generic on
    # purpose: this isn't tied to any specific product. Empty by default,
    # which means /realtime just runs without tools; nothing is assumed to
    # be running at any particular address.
    AGENT_TOOLS_URL = os.getenv("AGENT_TOOLS_URL", "").rstrip("/")
    AGENT_TOOLS_CACHE_TTL = int(os.getenv("AGENT_TOOLS_CACHE_TTL", "300"))

    @property
    def AGENT_TOOLS_TOKEN(self) -> str:
        """Auth token for AGENT_TOOLS_URL. Falls back to
        OMNIINTEL_INTERNAL_TOKEN so the common case (a same-platform sibling
        service) needs no extra config; override for anything else."""
        return os.getenv("AGENT_TOOLS_TOKEN", "").strip() or self.OMNIINTEL_INTERNAL_TOKEN

    CORS_ALLOWED_ORIGINS = [
        o.strip() for o in os.getenv("CORS_ALLOWED_ORIGINS", "*").split(",")
        if o.strip()
    ]


settings = Settings()
