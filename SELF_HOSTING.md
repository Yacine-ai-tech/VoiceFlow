# VoiceFlow — Self-Hosting Guide

VoiceFlow is designed to be easily deployable in both standard cloud environments and air-gapped, on-premises systems. 

## 1. Deployment via Docker
The standard deployment relies on the provided `Dockerfile`. It builds a lightweight image capable of running the API server and all extraction pipelines.

```bash
docker build -t voiceflow-api .
docker run -p 8002:8002 --env-file .env voiceflow-api
```

## 2. Hardware Acceleration (GPU)
For local WhisperX or NeMo Canary transcription, or pyannote/NeMo diarization, an NVIDIA GPU is highly recommended to achieve real-time factors (RTF) < 1.0. Set `WHISPER_DEVICE=cuda` and ensure the container has access to NVIDIA runtimes:

```bash
docker run --gpus all -p 8002:8002 --env-file .env voiceflow-api
```

**Don't have GPU hardware on this host?** That's the normal case — set
`VOICEFLOW_TRANSCRIPTION_MODE=remote` and `VOICEFLOW_REMOTE_ENDPOINT` to
delegate to a host you do control, instead of installing any of
`requirements-ml.txt` here at all. Same idea for TTS via
`VOICEFLOW_TTS_REMOTE_ENDPOINT`. See `docs/ASR_PROVIDERS.md` for the full
local-vs-remote decision guide.

## 3. External API Configurations
If you opt for cloud-based providers instead of local execution, ensure the following keys are provided in your `.env` file:
- **Cloud transcription**: `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, or `ASSEMBLYAI_API_KEY`. Order them with `ASR_PROVIDER` (comma-separated priority list).
- **Your own remote inference endpoint**: `VOICEFLOW_REMOTE_ENDPOINT` (+ `VOICEFLOW_REMOTE_TOKEN` if it requires auth) — a black box you control; run WhisperX, NeMo Canary, or anything else behind it.
- **Local engine choice** (only relevant in local mode): `LOCAL_ASR_ENGINE=whisperx|nemo_canary`, `LOCAL_DIARIZATION_ENGINE=pyannote|nemo`. NeMo options need `nemo_toolkit[asr]` (commented out by default in `requirements-ml.txt` — it's a large, GPU-oriented dependency; uncomment deliberately).
- **Premium/alternate TTS**: `ELEVENLABS_API_KEY` (voice quality + cloning) or `OPENAI_API_KEY` (tts-1-hd). `provider=kokoro` runs locally by default (`pip install -r requirements-ml.txt`, no key, ~300MB model) or delegates to `VOICEFLOW_TTS_REMOTE_ENDPOINT` if set.
- **OpenAI / Gemini (Realtime Bridge)**: set `REALTIME_PROVIDER` to `openai` or `gemini` — that is the provider used, with no automatic fallback to the other. Set the matching key (`OPENAI_API_KEY` or `GEMINI_API_KEY`).
- **External agent tools for the voice agent**: `AGENT_TOOLS_URL` pointing at any service implementing the discovery contract in `services/agent_tools_bridge.py` (unset by default — no tools, voice-only). If that service enforces its own internal-token auth, set `AGENT_TOOLS_TOKEN` to the matching value (falls back to `AGENTKIT_INTERNAL_TOKEN`/`INTERNAL_TOKEN` if unset — separate from this project's own `VOICEFLOW_INTERNAL_TOKEN`, which gates VoiceFlow's own endpoints, not calls it makes outward).
