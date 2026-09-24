# VoiceFlow

[![CI](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**Speech to structured intelligence.** A full web dashboard over four transcription
providers, five per-type analysis routes, and a real-time voice agent with external
tool-calling.

**Live demo (record in your browser):** https://voiceflow.ysiddo-ai-projects.app/ — the
backend runs on demand; the first request after idle may take up to a minute. Self-hosting
instructions: [SELF_HOSTING.md](SELF_HOSTING.md).

## What It Does

- **Transcription router**: local WhisperX (default), Groq Whisper, Deepgram, or AssemblyAI.
- **Five analysis types**, each routed to its own model:
  - `meeting` → Groq (`gpt-oss-120b`)
  - `sales_call` → Claude Sonnet 4.6
  - `support_call` → Claude Haiku 4.5
  - `interview` → Claude Sonnet 4.6
  - `general` → Groq (`gpt-oss-120b`)
- **Diarization**: pyannote 3.x when `PYANNOTE_TOKEN` is set; without it, the transcript is
  returned without speaker labels rather than a fabricated result.
- **Text-to-speech**: `POST /tts` — edge-tts (default), ElevenLabs, OpenAI tts-1-hd, or
  self-hosted Kokoro, each falling back to edge-tts on failure.
- **Integrations**: `POST /integrations/relay` pushes a result to Slack, n8n, Zapier, or a
  custom webhook. Slack destinations are detected and reformatted into a valid Slack message;
  n8n and Zapier catch-hooks receive the payload unmodified.
- **Full web dashboard** at `/`.
- **Session usage analytics** at `GET /analytics`, scoped to the caller's own session —
  in-memory by default, durable across restarts when `POSTGRES_URL` is set.
- **Real-time voice agent bridge** at `WS /realtime` — OpenAI Realtime API or Gemini
  Multimodal Live, selected explicitly via `REALTIME_PROVIDER`.
- **External tool-calling**: the real-time agent can call any service implementing the
  agent-tools discovery contract (see `services/agent_tools_bridge.py`) mid-conversation.
  Setting `AGENT_TOOLS_URL` makes that service's tools discoverable and callable with no
  VoiceFlow code change. The reference implementation used in this project's own demo is
  [AgentKit](https://github.com/Yacine-ai-tech/AgentKit) ("talk to your business analyst" —
  ask about revenue, anomalies, or a forecast), but the bridge carries no AgentKit-specific
  code; any compliant service works.
- **32 tests** across smoke, API, analyzer, voice, end-to-end, WebSocket, and real-time paths.

## Quick Start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # add GROQ_API_KEY at minimum
uvicorn api:app --port 8002
```

Then open http://localhost:8002/.

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
   │   MeetingAnalyzer       │ ← analysis type (meeting | sales_call | …)
   │   (multi-LLM by tier)   │
   └────┬────────────────────┘
        ▼
        Structured JSON
```

## Use Cases

| Analysis | Model | Output |
|----------|-------|--------|
| Meeting notes | Groq (`gpt-oss-120b`) | Action items, decisions, next steps |
| Sales call CRM | Claude Sonnet | Pain points, objections, deal stage |
| Support QA | Claude Haiku | Severity, escalation, follow-ups |
| Interview | Claude Sonnet | Strengths, gaps, recommendation |

## Tests

32 test functions across smoke, API, analyzer, voice, end-to-end, WebSocket, and real-time
paths:

```bash
pytest tests/ -q
```

## Security and Reliability

- **Per-IP rate limiting** on every non-static request and WebSocket connection attempt
  (`RATE_LIMIT_HTTP_PER_MIN`, `RATE_LIMIT_WS_CONNECTS_PER_MIN`) — the primary abuse mitigation
  for a product with no user-account system.
- **SSRF guard on `POST /integrations/relay`**: the destination URL must resolve to a public
  address; loopback, private, link-local, and reserved ranges are rejected before the server
  fetches it.
- **Optional shared-secret gate** (`X-VoiceFlow-Internal-Token` for HTTP, `?token=` for the
  two WebSocket routes) behind `REQUIRE_INTERNAL_TOKEN=true` — off by default, enforced on
  both WebSocket routes when enabled.
- **Bounded LLM analysis calls** (`LLM_ANALYSIS_TIMEOUT_SECONDS`, default 60s) — a slow or
  rate-limited provider returns a timeout error rather than hanging the request.
- **Non-blocking transcription**: every ASR provider call runs off the main event loop, so a
  slow transcription cannot stall other concurrent requests.

## Research

The `WS /realtime` bridge performs server-side 24kHz→16kHz PCM downsampling for the Gemini
path, and gates microphone input while a tool call is in flight so speaker output does not get
misread as a user interruption. [RESEARCH.md](RESEARCH.md) covers the reasoning, the
downsampling math, a literature check against 2026 ASR/diarization/real-time-voice benchmarks,
and how VoiceFlow's own measured numbers compare.

## Benchmark Suite

Each script measures exactly what its matching report describes, against live provider APIs:

```bash
python3 eval/run_wer_benchmark.py --n 20 --model base    # ASR word error rate (LibriSpeech)
python3 eval/run_multi_provider_benchmark.py             # cross-provider ASR latency/success
python3 eval/run_scenario_benchmark.py                   # named-scenario latency/success
python3 eval/run_realtime_benchmark.py                   # real-time WS connection/latency (single turn)
python3 eval/run_realtime_turns_benchmark.py              # real-time WS handshake/completion across N turns
python3 eval/run_action_item_benchmark.py                # full TTS→ASR→LLM action-item extraction
python3 eval/run_benchmarks.py                           # real-time audio downsampling latency
```

Results are served live by `GET /benchmarks` and reported in
[SCENARIO_BENCHMARK.md](eval/SCENARIO_BENCHMARK.md),
[REALTIME_BENCHMARK.md](eval/REALTIME_BENCHMARK.md),
[WER_BENCHMARK.md](eval/WER_BENCHMARK.md),
[MULTI_PROVIDER_BENCHMARK.md](eval/MULTI_PROVIDER_BENCHMARK.md), and
[ACTION_ITEM_BENCHMARK.md](eval/ACTION_ITEM_BENCHMARK.md).

## License

Open-source under the AGPL-3.0 License, free for researchers, students, and open-source
projects. A commercial license is available for closed-source or enterprise use — see
[COMMERCIAL.md](COMMERCIAL.md).

## Telemetry

Running the app sends two anonymous pings if `TELEMETRY_ENDPOINT`/`TELEMETRY_URL` is
configured: a startup ping and a periodic aggregate usage snapshot. `TELEMETRY_OPT_OUT=true`
disables both. Neither includes user data — see `.env.example` for the exact payload shape.
This README also carries a tracking-pixel image below, independent of the app and unaffected
by any environment variable.

![telemetry](https://gateway.ysiddo-ai-projects.app/pixel.png)
