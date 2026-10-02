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
    # LiteLLM "<provider>/<model>" prefix — routes on ANTHROPIC_API_KEY directly.
    # Override via env if you're fronting these with your own OpenAI-compatible gateway.
    LLM_REASONING = os.getenv("LLM_REASONING", "anthropic/claude-sonnet-4-6")
    LLM_JUDGE = os.getenv("LLM_JUDGE", "anthropic/claude-haiku-4-5")
    # Fallback models — set ONLY in VPS .env when the primary provider key is unavailable.
    # Leave empty to preserve primary behaviour for all cloners with valid keys.
    LLM_REASONING_FALLBACK = os.getenv("LLM_REASONING_FALLBACK", "")
    LLM_JUDGE_FALLBACK = os.getenv("LLM_JUDGE_FALLBACK", "")

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
    def OPENAI_REALTIME_API_KEY(self) -> str:
        """A real OpenAI platform key for Realtime.

        OPENAI_API_KEY may intentionally point at an OpenAI-compatible proxy
        when OPENAI_BASE_URL is set for LLM routing. That proxy is not a
        Realtime/WebRTC credential, so don't treat it as one.
        """
        explicit = os.getenv("OPENAI_REALTIME_API_KEY", "").strip()
        if explicit:
            return explicit
        realtime = os.getenv("REALTIME_API_KEY", "").strip()
        if realtime and self.REALTIME_PROVIDER == "openai":
            return realtime
        if os.getenv("OPENAI_BASE_URL", "").strip():
            return ""
        return self.OPENAI_API_KEY

    @property
    def GEMINI_API_KEY(self) -> str:
        return os.getenv("GEMINI_API_KEY", "").strip() or (os.getenv("REALTIME_API_KEY", "").strip() if self.REALTIME_PROVIDER == "gemini" else "")

    @property
    def GEMINI_API_KEYS(self) -> list[str]:
        keys: list[str] = []
        for k in ["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_API_KEY_4", "REALTIME_API_KEY"]:
            val = os.getenv(k, "").strip()
            if val and val not in keys:
                keys.append(val)
        return keys

    @property
    def PYANNOTE_TOKEN(self) -> str:
        return os.getenv("PYANNOTE_TOKEN", "").strip() or os.getenv("HF_TOKEN", "").strip()

    @property
    def HF_TOKEN(self) -> str:
        return os.getenv("HF_TOKEN", "").strip() or self.PYANNOTE_TOKEN

    @property
    def PYANNOTE_MODEL(self) -> str:
        return os.getenv("PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1").strip()

    @property
    def DEEPGRAM_MODEL(self) -> str:
        return os.getenv("DEEPGRAM_MODEL", "nova-3").strip()

    @property
    def GROQ_WHISPER_MODEL(self) -> str:
        return os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo").strip()

    @property
    def ASSEMBLYAI_SPEECH_MODEL(self) -> str:
        return os.getenv("ASSEMBLYAI_SPEECH_MODEL", "best").strip()

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

    # Dynamic env-driven Edge TTS defaults
    @property
    def EDGE_TTS_VOICE_EN_FEMALE(self) -> str:
        return os.getenv("EDGE_TTS_VOICE_EN_FEMALE", "en-US-AriaNeural").strip()

    @property
    def EDGE_TTS_VOICE_EN_MALE(self) -> str:
        return os.getenv("EDGE_TTS_VOICE_EN_MALE", "en-US-GuyNeural").strip()

    @property
    def EDGE_TTS_VOICE_FR_FEMALE(self) -> str:
        return os.getenv("EDGE_TTS_VOICE_FR_FEMALE", "fr-FR-DeniseNeural").strip()

    @property
    def EDGE_TTS_VOICE_FR_MALE(self) -> str:
        return os.getenv("EDGE_TTS_VOICE_FR_MALE", "fr-FR-HenriNeural").strip()

    @property
    def EDGE_TTS_DEFAULT_RATE(self) -> str:
        return os.getenv("EDGE_TTS_DEFAULT_RATE", "+0%").strip()

    @property
    def EDGE_TTS_DEFAULT_VOLUME(self) -> str:
        return os.getenv("EDGE_TTS_DEFAULT_VOLUME", "+0%").strip()

    # Dynamic env-driven ElevenLabs defaults
    @property
    def ELEVENLABS_BASE_URL(self) -> str:
        return os.getenv("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io/v1").rstrip("/")

    @property
    def ELEVENLABS_DEFAULT_VOICE_FEMALE(self) -> str:
        return os.getenv("ELEVENLABS_DEFAULT_VOICE_FEMALE", "EXAVITQu4vr4xnSDxMaL").strip()

    @property
    def ELEVENLABS_DEFAULT_VOICE_MALE(self) -> str:
        return os.getenv("ELEVENLABS_DEFAULT_VOICE_MALE", "onwK4e9ZLuTAKqWW03F9").strip()

    @property
    def ELEVENLABS_MODEL_ID(self) -> str:
        return os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip()

    @property
    def ELEVENLABS_STABILITY(self) -> float:
        try:
            return float(os.getenv("ELEVENLABS_STABILITY", "0.5"))
        except ValueError:
            return 0.5

    @property
    def ELEVENLABS_SIMILARITY_BOOST(self) -> float:
        try:
            return float(os.getenv("ELEVENLABS_SIMILARITY_BOOST", "0.5"))
        except ValueError:
            return 0.5

    @property
    def ELEVENLABS_TIMEOUT_SECONDS(self) -> float:
        try:
            return float(os.getenv("ELEVENLABS_TIMEOUT_SECONDS", "30.0"))
        except ValueError:
            return 30.0

    # Dynamic env-driven Kokoro defaults
    @property
    def KOKORO_REPO_ID(self) -> str:
        return os.getenv("KOKORO_REPO_ID", "hexgrad/Kokoro-82M").strip()

    @property
    def KOKORO_MODEL_PATH(self) -> str:
        return os.getenv("KOKORO_MODEL_PATH", "").strip()

    @property
    def KOKORO_LANG_CODE(self) -> str:
        return os.getenv("KOKORO_LANG_CODE", "a").strip()

    @property
    def KOKORO_VOICE_FEMALE(self) -> str:
        return os.getenv("KOKORO_VOICE_FEMALE", "af_heart").strip()

    @property
    def KOKORO_VOICE_MALE(self) -> str:
        return os.getenv("KOKORO_VOICE_MALE", "am_michael").strip()

    @property
    def KOKORO_VOICE_DEFAULT(self) -> str:
        return os.getenv("KOKORO_VOICE_DEFAULT", self.KOKORO_VOICE_FEMALE).strip()

    @property
    def KOKORO_SAMPLE_RATE(self) -> int:
        try:
            return int(os.getenv("KOKORO_SAMPLE_RATE", "24000"))
        except ValueError:
            return 24000

    # Dynamic env-driven OpenAI TTS defaults
    @property
    def OPENAI_TTS_MODEL(self) -> str:
        return os.getenv("OPENAI_TTS_MODEL", "tts-1-hd").strip()

    @property
    def OPENAI_TTS_VOICE_FEMALE(self) -> str:
        return os.getenv("OPENAI_TTS_VOICE_FEMALE", "nova").strip()

    @property
    def OPENAI_TTS_VOICE_MALE(self) -> str:
        return os.getenv("OPENAI_TTS_VOICE_MALE", "onyx").strip()

    @property
    def OPENAI_TTS_VOICE_DEFAULT(self) -> str:
        return os.getenv("OPENAI_TTS_VOICE_DEFAULT", "alloy").strip()

    @property
    def OPENAI_TTS_RESPONSE_FORMAT(self) -> str:
        return os.getenv("OPENAI_TTS_RESPONSE_FORMAT", "mp3").strip()

    # Dynamic env-driven TTS general defaults
    @property
    def TTS_DEFAULT_PROVIDER(self) -> str:
        return os.getenv("TTS_PROVIDER", os.getenv("TTS_DEFAULT_PROVIDER", "edge")).strip().lower()

    @property
    def TTS_REMOTE_TIMEOUT(self) -> float:
        try:
            return float(os.getenv("TTS_REMOTE_TIMEOUT", "30.0"))
        except ValueError:
            return 30.0

    @property
    def TTS_REMOTE_RETRIES(self) -> int:
        try:
            return int(os.getenv("TTS_REMOTE_RETRIES", "4"))
        except ValueError:
            return 4

    OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1")
    OPENAI_REALTIME_VOICE = os.getenv("OPENAI_REALTIME_VOICE", "marin")

    # Which backend the /realtime voice agent bridges to — "openai" or "gemini".
    # This is a deliberate choice, not an auto-detected one: whichever value is
    # set here is the one used, full stop. There is no fallback from one to the
    # other based on which key happens to be present.
    REALTIME_PROVIDER = os.getenv("REALTIME_PROVIDER", "openai").strip().lower()

    @property
    def REALTIME_API_KEY(self) -> str:
        """The API key for whichever provider REALTIME_PROVIDER selects.

        If REALTIME_API_KEY is explicitly configured in environment, it is used
        directly. Otherwise, falls back to the matching provider key (GEMINI_API_KEY
        for gemini, OPENAI_API_KEY for openai).
        """
        explicit = os.getenv("REALTIME_API_KEY", "").strip()
        if explicit:
            return explicit
        return self.GEMINI_API_KEY if self.REALTIME_PROVIDER == "gemini" else self.OPENAI_REALTIME_API_KEY

    @property
    def TELEMETRY_ENDPOINT(self) -> str:
        """Where the anonymous startup ping and periodic usage snapshot are sent
        (see README.md's Telemetry section for the exact payloads). Defaults to the project
        gateway URL — disable entirely with TELEMETRY_OPT_OUT=true or DO_NOT_TRACK=1.
        """
        return os.getenv("TELEMETRY_ENDPOINT", os.environ.get("TELEMETRY_URL", "https://gateway.ysiddo-ai-projects.app/telemetry")).strip()

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
    AGENT_TOOLS_CALL_BUDGET_SECONDS = float(os.getenv("AGENT_TOOLS_CALL_BUDGET_SECONDS", "2.0"))
    AGENT_TOOLS_RESULT_CACHE_TTL = int(os.getenv("AGENT_TOOLS_RESULT_CACHE_TTL", "30"))

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
