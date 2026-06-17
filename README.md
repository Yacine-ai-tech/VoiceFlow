# VoiceFlow

[![CI](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Speech → structured intelligence. Browser-recording demo. 4 providers, 5 analysis types, real-time voice agent.**

## What It Does

- **Transcription router**: local WhisperX (default), Groq Whisper, Deepgram, AssemblyAI
- **5 analysis types** with per-type LLM routing:
  - `meeting` → Groq Llama 3.3
  - `sales_call` → Claude Sonnet 4.6
  - `support_call` → Claude Haiku 4.5
  - `interview` → Claude Sonnet 4.6
  - `general` → Groq Llama 3.3
- **Diarization fallback chain**: pyannote 3.x → NeMo → no-diarization
- **Browser-recording demo** at `/demo`
- **OpenAI Realtime API bridge** at `WS /realtime`

## Quick Start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # add GROQ_API_KEY at minimum
uvicorn api:app --port 8002
```

Open http://localhost:8002/demo

## Architecture

```
            ┌──────────┐
            │  Audio   │
            └────┬─────┘
                 ▼
   ┌─────────────────────────┐
   │  TranscriptionRouter    │ ← provider (local | groq | deepgram | assemblyai)
   └────┬────────────────────┘
        ▼
   ┌─────────────────────────┐
   │   MeetingAnalyzer       │ ← analysis_type (meeting | sales_call | …)
   │   (multi-LLM via tier)  │
   └────┬────────────────────┘
        ▼
        Structured JSON
```

## Use Cases

| Analysis        | Model           | Output                                       |
|-----------------|-----------------|----------------------------------------------|
| Meeting notes   | Groq Llama 3.3  | action_items, decisions, next_steps          |
| Sales call CRM  | Claude Sonnet   | pain_points, objections, deal_stage          |
| Support QA      | Claude Haiku    | severity, escalation, follow_ups             |
| Interview       | Claude Sonnet   | strengths, gaps, recommendation              |

## License

MIT
