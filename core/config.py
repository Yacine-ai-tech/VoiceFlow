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

    # groq/llama-3.3-70b-versatile was Groq's free/developer-tier default here
    # until Groq deprecated it (2026-06-17); confirmed live via a real API call
    # returning model_not_found. openai/gpt-oss-120b is Groq's own recommended
    # replacement and was verified live to produce clean, directly-parseable
    # JSON with the existing prompt/parsing logic — unlike the other
    # recommended alternative (qwen3.6-27b), which emits an unstoppable
    # <think> reasoning block that broke JSON parsing even at 1500 tokens.
    LLM_DEFAULT = os.getenv("LLM_DEFAULT", "groq/openai/gpt-oss-120b")
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
    def PYANNOTE_TOKEN(self) -> str:
        return os.getenv("PYANNOTE_TOKEN", "").strip()

    @property
    def DEEPGRAM_API_KEY(self) -> str:
        return os.getenv("DEEPGRAM_API_KEY", "").strip()

    @property
    def ASSEMBLYAI_API_KEY(self) -> str:
        return os.getenv("ASSEMBLYAI_API_KEY", "").strip()

    @property
    def ELEVENLABS_API_KEY(self) -> str:
        return os.getenv("ELEVENLABS_API_KEY", "").strip()

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
        """Where the anonymous startup ping and periodic usage snapshot are sent
        (see README.md's Telemetry section for the exact payloads). Blank by
        default — no-op unless this or TELEMETRY_URL is set. Both the startup
        ping and the periodic usage snapshot are skipped entirely when
        TELEMETRY_OPT_OUT=true.
        """
        return os.getenv("TELEMETRY_ENDPOINT", os.environ.get("TELEMETRY_URL", "")).strip()

    @property
    def INTERNAL_TOKEN(self) -> str:
        """Optional shared service-to-service auth token for internal deployments.
        Set AGENTKIT_INTERNAL_TOKEN (or INTERNAL_TOKEN) in the environment.
        Only needed when AGENT_TOOLS_URL points at a deployment with
        REQUIRE_INTERNAL_TOKEN=true.
        """
        return (
            os.getenv("AGENTKIT_INTERNAL_TOKEN", "")
            or os.getenv("INTERNAL_TOKEN", "")
        ).strip()

    # Base URL of an external "agent tools" service — see
    # services/agent_tools_bridge.py for the discovery contract. Generic on
    # purpose: this isn't tied to any specific product. Empty by default,
    # which means /realtime just runs without tools; nothing is assumed to
    # be running at any particular address.
    AGENT_TOOLS_URL = os.getenv("AGENT_TOOLS_URL", "").rstrip("/")
    AGENT_TOOLS_CACHE_TTL = int(os.getenv("AGENT_TOOLS_CACHE_TTL", "300"))

    @property
    def AGENT_TOOLS_TOKEN(self) -> str:
        """Auth token for AGENT_TOOLS_URL — sent as X-AgentKit-Internal-Token
        when REQUIRE_INTERNAL_TOKEN=true is set on the downstream service.
        Falls back to INTERNAL_TOKEN so deployments that share a common secret
        need no extra config; override AGENT_TOOLS_TOKEN for anything else."""
        return os.getenv("AGENT_TOOLS_TOKEN", "").strip() or self.INTERNAL_TOKEN

    CORS_ALLOWED_ORIGINS = [
        o.strip() for o in os.getenv("CORS_ALLOWED_ORIGINS", "*").split(",")
        if o.strip()
    ]

    # Optional Postgres persistence for session analytics (see core/db.py) —
    # same role this setting plays in the other 5 public projects in this
    # portfolio. Unset by default: with no POSTGRES_URL, analytics stay
    # exactly as before (in-memory, reset on restart) — nothing about this
    # is required to run VoiceFlow.
    POSTGRES_URL = os.getenv("POSTGRES_URL", "").strip()


settings = Settings()
