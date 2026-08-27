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

## Results (run 2026-08-27, N=5 per provider)

| Provider | Avg Latency | Success Rate | Notes |
|---|---|---|---|
| **Groq** (`whisper-large-v3`) | **1.32 s** | **100 % (5/5)** | ✅ Active |
| OpenAI (`whisper-1`) | — | 0 % | ⚠ Not active — `OPENAI_API_KEY` in this environment is a Lightning AI Model API proxy key (used to route Claude/GPT-family chat calls through `OPENAI_BASE_URL`), not a real OpenAI credential; raw Whisper API calls against `api.openai.com` 401. |
| Gemini | — | 0 % | ⚠ Not active — `gemini-1.5-pro` returns a live `404 models/gemini-1.5-pro is not found for API version v1` from Google's API; the model has been retired and the benchmark script pre-dates this deprecation. |

> **What these skips mean.** OpenAI Whisper and Gemini are not part of VoiceFlow's active
> transcription stack in this environment — the deployed transcription path routes through
> Groq Whisper (or Deepgram/AssemblyAI via the `TRANSCRIPTION_PROVIDER` toggle, or local
> WhisperX). The two skipped rows reflect script-endpoint mismatches (a proxy key that isn't
> valid for OpenAI's own API, and a retired Gemini model ID), not provider capability failures.
> WER results for local WhisperX are in [`WER_BENCHMARK.md`](WER_BENCHMARK.md); Deepgram and
> AssemblyAI provider coverage (both working, with real latency numbers) is in
> [`SCENARIO_BENCHMARK.md`](SCENARIO_BENCHMARK.md).

**Groq Whisper round-trip latency: 1.32 s avg (min 1.07 s, max 1.84 s) at 100% success** —
real network round-trip to the Groq transcription API plus server-side inference for a 2s clip.
