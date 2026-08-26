# VoiceFlow — Multi-Provider ASR Latency Benchmark

Reproducible: `python eval/run_multi_provider_benchmark.py`

## What this measures
Real round-trip latency and success rate against each provider's live API,
using a short generated tone (not a ground-truth transcript). It does **not**
measure Word Error Rate — that requires a reference transcript to score
against. For WER against real speech (LibriSpeech `test-clean`), see
[`WER_BENCHMARK.md`](WER_BENCHMARK.md), which is scored with `jiwer` against
actual reference text.

## Setup
- Audio: a generated 2s mono 16kHz sine-wave WAV (real, valid audio — not fake bytes)
- Providers: Groq Whisper (active), OpenAI Whisper (skipped — see note), Gemini (skipped — see note)
- Iterations per provider: 5
- Metrics: average latency, success rate

## Results (run 2026-08-26, N=5 per provider)

| Provider | Avg Latency | Success Rate | Notes |
|---|---|---|---|
| **Groq** (`whisper-large-v3`) | **1.45 s** | **100 % (5/5)** | ✅ Active |
| OpenAI (`whisper-1`) | — | 0 % | ⚠ Not active — `OPENAI_API_KEY` in this environment is a Lightning AI inference proxy key, not an OpenAI credential; raw Whisper API calls 401. |
| Gemini | — | 0 % | ⚠ Not active — `gemini-1.5-pro` was removed from the REST v1 API; the benchmark script pre-dates this model deprecation. |

> **What these skips mean.** OpenAI Whisper and Gemini are not part of VoiceFlow's active
> transcription stack in this environment — the deployed transcription path routes through
> Groq Whisper (or Deepgram/AssemblyAI via the `TRANSCRIPTION_PROVIDER` toggle, or local
> WhisperX). The two skipped rows reflect script-endpoint mismatches, not provider capability
> failures. WER results for local WhisperX are in [`WER_BENCHMARK.md`](WER_BENCHMARK.md);
> Deepgram and AssemblyAI provider coverage is in [`SCENARIO_BENCHMARK.md`](SCENARIO_BENCHMARK.md).

**Groq Whisper round-trip latency: 1.45 s avg (min 1.18 s, max 1.69 s) at 100% success** —
real network round-trip to the Groq transcription API plus server-side inference for a 2s clip.
