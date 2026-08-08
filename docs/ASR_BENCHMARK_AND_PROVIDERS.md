# VoiceFlow ASR Provider Matrix & Benchmarking Guide

## Overview
VoiceFlow supports a multi-provider Speech-to-Text (STT) architecture supporting dynamic environment-driven priority ordering (`ASR_PROVIDER`) and per-request provider overrides (`provider`).

---

## Configuration via Environment Variables

Set `ASR_PROVIDER` to a comma-separated list of providers ordered by priority:

```bash
# Groq Primary with fallback chain
ASR_PROVIDER=groq,orchestrator,deepgram,assemblyai

# Orchestrator GPU Primary (WhisperX + PyAnnote)
ASR_PROVIDER=orchestrator,groq,deepgram,assemblyai

# Deepgram Nova-2 Primary
ASR_PROVIDER=deepgram,groq,orchestrator,assemblyai

# AssemblyAI Primary
ASR_PROVIDER=assemblyai,groq,orchestrator,deepgram
```

---

## Per-Request Override (API Benchmarking)

In `POST /transcribe` or `POST /pipeline`, pass `provider` to force a specific engine as #1 priority:

```json
POST /transcribe
{
  "audio_b64": "<base64>",
  "provider": "groq",
  "language": "en"
}
```

Available provider identifiers:
- `groq`: Groq LPU `whisper-large-v3` (<200ms latency)
- `orchestrator`: Orchestrator GPU Studio (`whisperx` + `pyannote.audio`)
- `deepgram`: Deepgram `nova-2`
- `assemblyai`: AssemblyAI Speech-to-Text
- `local`: Local PyTorch/CUDA WhisperX (local workstation mode)
