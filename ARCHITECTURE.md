# VoiceFlow Architecture

How VoiceFlow turns speech into transcripts, structured analysis, synthesised speech and a live
voice agent. This page complements [`README.md`](README.md) (what it is and how to run it),
[`RESEARCH.md`](RESEARCH.md) (the reasoning behind the design) and
[`BENCHMARK.md`](BENCHMARK.md) (measured results). An interactive version is in the app under
**Architecture**.

## 1. System overview

```
 audio ──▶ transcription chain ──▶ analysis (routed LLMs) ──▶ records · analytics · relay
 (file, stream,   remote → Groq →         meeting · sales · support ·
  microphone)     Deepgram → AssemblyAI   interview · general
                  → local WhisperX
 text ───▶ text-to-speech (edge · ElevenLabs · OpenAI · Kokoro, edge as fallback)
 microphone ⇄ /realtime bridge (OpenAI Realtime or Gemini Live) ⇄ optional agent tools
```

## 2. Components

| Component | Role |
|---|---|
| Transcription adapter | one interface over a remote host, Groq, Deepgram, AssemblyAI and local WhisperX / NeMo Canary; optional speaker diarization |
| Meeting analyzer | transcript → summary, action items, decisions, sentiment per analysis type, with tiered models |
| Scenarios | named, pinned provider+model combinations with no fallback, for reproducible comparison |
| Text-to-speech | four providers behind one interface; voice cloning; edge voices as the universal fallback |
| Realtime bridge | WebSocket bridge to OpenAI Realtime or Gemini Live with server-side audio resampling |
| Agent-tools bridge | discovers tools from an operator-configured service and lets the voice agent call them |
| Relay | forwards results to external URLs behind an SSRF guard |
| Persistence | optional Postgres for session counters and voice records; in-memory otherwise |
| Key pool | rotates provider keys, parking a rate-limited key until its retry window ends |

## 3. Transcription

Providers are tried in the configured order; a failure falls through to the next. With diarization
requested, providers with native speaker separation are preferred. Local WhisperX serves as the
first choice in local mode and as a last resort otherwise (it can be disabled on small hosts).
In strict mode (used by named scenarios) only the requested provider runs, so a benchmark never
measures a substitute. An exhausted chain returns an explicit error, never an invented transcript.

The speech model is loaded in the background at start-up; `/ready` reports `warming_up` until it
is exercised.

## 4. Analysis

Each analysis type maps to a model tier (default, reasoning, judge). Authentication, billing or
quota failures retry once on a configured fallback model. Long transcripts are truncated and the
response says so. Prompts carry a language directive so French audio yields French output.

## 5. Real-time voice agent

Audio frames flow browser → bridge → provider and back. Input is resampled server-side where the
provider requires it. If an agent-tools service is configured, its tools are declared to the model
and executed within a per-call time budget, with a short result cache; destinations supplied by the
caller are refused so service credentials are never forwarded to arbitrary hosts.

## 6. Design decisions

| Decision | Reason |
|---|---|
| Provider chain, not a single vendor | any ASR/TTS provider can fail or hit limits; the pipeline keeps answering |
| Strict mode for scenarios | comparable trials need the provider to be a controlled variable |
| Edge TTS as universal fallback | speech output should never fail because a premium provider did |
| Everything off the event loop | blocking audio and model calls must not stall other sessions |
| Per-IP limits and SSRF guard | the product has no accounts; abuse of paid upstream APIs must still be bounded |
| Persistence optional | the service runs with no database; durable history is opt-in |

## 7. Interfaces

| Route | Purpose |
|---|---|
| `POST /transcribe`, `/transcribe-json` | speech to text |
| `POST /analyze`, `/analyze/custom`, `/pipeline` | analysis; transcribe + analyze |
| `POST /tts`, `GET /tts/voices`, `POST /tts/voices/clone` | speech synthesis and voices |
| `WS /stream`, `WS /realtime[/gemini\|/openai]` | streaming transcription; voice agent |
| `GET /records`, `GET /analytics`, `GET /scenarios`, `GET /benchmarks` | history and metadata |
| `POST /integrations/relay`, `POST /meeting/process`, `POST /call/analyze` | integrations and call analysis |
| `GET /health`, `GET /ready` | liveness; readiness (speech model loaded) |

## 8. Configuration

Everything is environment-driven; [`.env.example`](.env.example) lists every variable with its
purpose. Groups: LLM tiers and fallbacks, transcription (providers, models, local engine), TTS
(providers, voices), realtime (provider, models), agent tools, limits, access, telemetry.

## 9. Privacy

An optional startup ping and periodic usage snapshot carry only counts, version and a random
installation id; disable them with `TELEMETRY_OPT_OUT=true` or `DO_NOT_TRACK=1`. Audio,
transcripts and keys are never part of telemetry.
