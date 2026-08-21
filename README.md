# VoiceFlow
[![CI](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**Speech → structured intelligence. Complete web dashboard. 4 providers, 5 analysis types, real-time voice agent.**
> **Live web dashboard (record in your browser):** https://voiceflow.ysiddo-ai-projects.app/
> On-demand backend (first request ~30–60 s to wake).
> Self-hosting: see [SELF_HOSTING.md](SELF_HOSTING.md).

## What It Does

- **Transcription router**: local WhisperX (default), Groq Whisper, Deepgram, AssemblyAI
- **5 analysis types** with per-type LLM routing:
  - `meeting` → Groq (openai/gpt-oss-120b)
  - `sales_call` → Claude Sonnet 4.6
  - `support_call` → Claude Haiku 4.5
  - `interview` → Claude Sonnet 4.6
  - `general` → Groq (openai/gpt-oss-120b)
- **Diarization**: pyannote 3.x when `HF_TOKEN` is set; otherwise the transcript comes back without speaker labels, honestly
- **TTS**: `POST /tts` — edge-tts (default), ElevenLabs, OpenAI tts-1-hd, or Kokoro (self-hosted), each falling back to edge-tts on failure
- **Integrations**: `POST /integrations/relay` pushes any result to Slack, n8n, Zapier, or a custom webhook. Slack URLs are auto-detected and reformatted into a real Slack message (Slack rejects raw JSON); n8n/Zapier catch-hooks get the payload untouched, since that's what they're built for.
- **Full web dashboard** at `/`
- **Session usage analytics** at `GET /analytics`, scoped to the caller's own session — in-memory by default, durable across restarts when `POSTGRES_URL` is set (see `core/db.py`)
- **Realtime voice agent bridge** at `WS /realtime` — OpenAI Realtime API or Gemini Multimodal Live, chosen explicitly via `REALTIME_PROVIDER` (no auto-fallback between them)
- **External tool-calling**: the realtime agent can call out to any service implementing the agent-tools discovery contract (see `services/agent_tools_bridge.py`) mid-conversation — set `AGENT_TOOLS_URL` and its tools are discovered and become callable automatically, no VoiceFlow code change needed. This project's own dev/demo target is [AgentKit](https://github.com/Yacine-ai-tech/AgentKit) ("talk to your business analyst" — ask about revenue, anomalies, or a forecast and it answers with real numbers), but the bridge has no AgentKit-specific code — any compliant service works.
- **32 tests** across smoke, API, analyzer, voice, e2e, WebSocket, and realtime

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
| Meeting notes   | Groq (gpt-oss-120b)  | action_items, decisions, next_steps          |
| Sales call CRM  | Claude Sonnet   | pain_points, objections, deal_stage          |
| Support QA      | Claude Haiku    | severity, escalation, follow_ups             |
| Interview       | Claude Sonnet   | strengths, gaps, recommendation              |

## Tests

32 test functions across smoke, API, analyzer, voice, e2e, WebSocket, and realtime:

```bash
pytest tests/ -q
```

## Security & Reliability

- **Per-IP rate limiting** on every non-static request and WebSocket connection attempt (`RATE_LIMIT_HTTP_PER_MIN`, `RATE_LIMIT_WS_CONNECTS_PER_MIN`) — this product has no user-account system, so this is the realistic abuse mitigation for its paid upstream providers.
- **SSRF guard on `POST /integrations/relay`**: the destination URL must resolve to a real public address — loopback, private, link-local, and reserved ranges are rejected before the server ever fetches it.
- **Optional shared-secret gate** (`X-VoiceFlow-Internal-Token` header for HTTP, `?token=` query param for the two WebSocket routes) behind `REQUIRE_INTERNAL_TOKEN=true` — off by default, but actually enforced on both WS routes when turned on, not just HTTP.
- **Bounded LLM analysis calls** (`LLM_ANALYSIS_TIMEOUT_SECONDS`, default 60s) — a slow or rate-limited provider returns an honest timeout error instead of hanging the request.
- **Non-blocking transcription**: every ASR provider call runs off the main event loop (`asyncio.to_thread`), so one slow transcription can't stall other concurrent requests on this single-worker deployment.

## Research Notes

The `WS /realtime` bridge (OpenAI Realtime API or Gemini Multimodal Live,
chosen via `REALTIME_PROVIDER`) does two specific things worth knowing
about: server-side 24kHz→16kHz PCM downsampling for the Gemini path, and
gating microphone input while a tool call is in flight (so speaker output
bleeding into the mic doesn't get misread as a user interruption). See
[RESEARCH.md](RESEARCH.md) for how and why, the math behind the
downsampling ratio, an honest literature check against 2026 ASR/diarization/
realtime-voice benchmarks, and where VoiceFlow's own real measured numbers
stand relative to them.

## Benchmark Suite

Real, reproducible benchmarks — each script measures exactly what its
matching `.md` report describes, against live provider APIs where
applicable, with no synthetic or fabricated numbers:

```bash
python3 eval/run_wer_benchmark.py --n 20 --model base    # ASR word error rate (LibriSpeech)
python3 eval/run_multi_provider_benchmark.py             # cross-provider ASR latency/success
python3 eval/run_scenario_benchmark.py                   # named-scenario latency/success
python3 eval/run_realtime_benchmark.py                   # realtime WS connection/latency
python3 eval/run_action_item_benchmark.py                # full TTS→ASR→LLM action-item extraction
python3 eval/run_benchmarks.py                           # realtime audio downsampling latency
```

Results land in `eval/*.md` and are served live by `GET /benchmarks` — see
[SCENARIO_BENCHMARK.md](eval/SCENARIO_BENCHMARK.md),
[REALTIME_BENCHMARK.md](eval/REALTIME_BENCHMARK.md),
[WER_BENCHMARK.md](eval/WER_BENCHMARK.md),
[MULTI_PROVIDER_BENCHMARK.md](eval/MULTI_PROVIDER_BENCHMARK.md), and
[ACTION_ITEM_BENCHMARK.md](eval/ACTION_ITEM_BENCHMARK.md).

## License & Enterprise Use (Dual-License)

This project is open-source under the **AGPL-3.0 License**. Free for researchers, students, and open-source projects.
Commercial license: see [COMMERCIAL.md](COMMERCIAL.md).

## Telemetry

Running the app sends two anonymous pings if `TELEMETRY_ENDPOINT`/`TELEMETRY_URL` is
configured: a startup ping and a periodic aggregate usage snapshot. Setting
`TELEMETRY_OPT_OUT=true` disables both. Neither includes user data — see `.env.example` for the exact
payload shape. This README also carries a tracking-pixel image below, which loads
whenever this page is viewed with remote images enabled (e.g. on GitHub) — that one is
independent of the app and isn't affected by any env var.

![telemetry](https://gateway.ysiddo-ai-projects.app/pixel.png)
