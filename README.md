# VoiceFlow
[![CI](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**Speech → structured intelligence. Complete web dashboard. 4 providers, 5 analysis types, real-time voice agent.**
> 🔗 **Live web dashboard (record in your browser):** https://voiceflow.ysiddo-ai-projects.app/
> On-demand backend (first request ~30–60 s to wake).
> Self-hosting: see [SELF_HOSTING.md](SELF_HOSTING.md).

## What It Does

- **Transcription router**: local WhisperX (default), Groq Whisper, Deepgram, AssemblyAI
- **5 analysis types** with per-type LLM routing:
  - `meeting` → Groq Llama 3.3
  - `sales_call` → Claude Sonnet 4.6
  - `support_call` → Claude Haiku 4.5
  - `interview` → Claude Sonnet 4.6
  - `general` → Groq Llama 3.3
- **Diarization**: pyannote 3.x when `HF_TOKEN` is set; otherwise the transcript comes back without speaker labels, honestly
- **TTS**: `POST /tts` — edge-tts (default), ElevenLabs, OpenAI tts-1-hd, or Kokoro (self-hosted), each falling back to edge-tts on failure
- **Integrations**: `POST /integrations/relay` pushes any result to Slack, n8n, Zapier, or a custom webhook. Slack URLs are auto-detected and reformatted into a real Slack message (Slack rejects raw JSON); n8n/Zapier catch-hooks get the payload untouched, since that's what they're built for.
- **Full web dashboard** at `/`
- **Realtime voice agent bridge** at `WS /realtime` — OpenAI Realtime API or Gemini Multimodal Live, chosen explicitly via `REALTIME_PROVIDER` (no auto-fallback between them)
- **External tool-calling**: the realtime agent can call out to any service implementing the agent-tools discovery contract (see `services/agent_tools_bridge.py`) mid-conversation — set `AGENT_TOOLS_URL` and its tools are discovered and become callable automatically, no VoiceFlow code change needed. This project's own dev/demo target is [AgentKit](https://github.com/Yacine-ai-tech/AgentKit) ("talk to your business analyst" — ask about revenue, anomalies, or a forecast and it answers with real numbers), but the bridge has no AgentKit-specific code — any compliant service works.
- **38 tests** across smoke, API, analyzer, voice, e2e, and realtime

## Quick Start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # add GROQ_API_KEY at minimum
uvicorn api:app --port 8002
```

Open http://localhost:8002/

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

## Tests

38 test functions across smoke, API, analyzer, voice, e2e, WebSocket, and realtime:

```bash
pytest tests/ -q
```

## Research Novelty & Scientific Contributions

VoiceFlow implements research-proof real-time speech intelligence:
- **Audio Frame Gating**: Asynchronous dropping of input mic frames during tool activation to eliminate acoustic feedback loops.
- **Adaptive Dual-Stream Resampling**: 24kHz to 16kHz linear downsampling reducing transport overhead by 33.3%.
- **Gemini 3.1 Live API Architecture**: Model target `models/gemini-3.1-flash-live-preview` via `google-genai` Python SDK (`api_version="v1beta"`).

For mathematical formulations and benchmark analysis, see [RESEARCH.md](RESEARCH.md).

## Benchmark Reproduction Suite

Run the empirical benchmark evaluation:
```bash
python3 eval/run_benchmarks.py --seed 42
```

## License & Enterprise Use (Dual-License)

This project is open-source under the **AGPL-3.0 License**. Free for researchers, students, and open-source projects.
Commercial license: see [COMMERCIAL.md](COMMERCIAL.md).



![telemetry](https://gateway.ysiddo-ai-projects.app/pixel.png)
