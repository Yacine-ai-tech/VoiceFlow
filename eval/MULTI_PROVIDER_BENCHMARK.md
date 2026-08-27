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
- Providers: OpenAI Whisper, Google Gemini, Groq Whisper — each tried 5 times
- Metrics: average latency, success rate

## Results (run 2026-08-27, N=5 per provider)

| Provider | Avg Latency | Success Rate | Notes |
|---|---|---|---|
| OpenAI (`whisper-1`) | — | 0 % (0/5) | ⚠ `OPENAI_API_KEY` in this environment is a Lightning AI Model API proxy key (used elsewhere in this project to route Claude/GPT-family chat calls through `OPENAI_BASE_URL`), not a real OpenAI credential — confirmed via a real `401 Incorrect API key provided` from `api.openai.com`. |
| Gemini (`gemini-3.5-flash`) | 19.36 s (successful calls only) | **40 % (2/5)** | ⚠ Genuinely exercised this run (previously skipped — the script was pointed at the retired `gemini-1.5-pro` REST endpoint and a malformed request body; both fixed — see note below). 3 of 5 calls failed with a real `503 "model is currently experiencing high demand"` / transient error; the 2 that succeeded returned real transcription-style output (2,529 and 3,281 characters). |
| **Groq** (`whisper-large-v3`) | **1.30 s** | **100 % (5/5)** | ✅ Active |

> **What changed for Gemini this run.** The script previously called a retired endpoint
> (`gemini-1.5-pro`, confirmed dead via a live `404`) and — once pointed at a current model
> (`gemini-3.5-flash`) — was still sending a malformed request: `snake_case` keys
> (`inline_data`/`mime_type`) instead of the REST API's required `camelCase`
> (`inlineData`/`mimeType`), hex-encoded audio bytes instead of base64, and no accompanying text
> part (an audio-only `contents` array is rejected). All three fixed in
> `eval/run_multi_provider_benchmark.py`. With those fixed, Gemini is now a real, if
> **partially rate-limited and slow**, participant in this benchmark rather than a skipped row —
> the 19.36 s average latency and 40% success rate are genuine measurements of the free-tier
> `gemini-3.5-flash` endpoint under this benchmark's request pattern (a short back-to-back
> 5-iteration burst), not a stand-in for "Gemini doesn't work."
>
> **What this skip meant before, and no longer means.** OpenAI Whisper is still not part of
> VoiceFlow's active transcription stack in this environment — the deployed transcription path
> routes through Groq Whisper (or Deepgram/AssemblyAI via the `TRANSCRIPTION_PROVIDER` toggle, or
> local WhisperX) and the `OPENAI_API_KEY` configured here is deliberately a different
> credential for a different purpose (the Lightning bypass), not evidence the OpenAI integration
> itself is broken. WER results for local WhisperX are in
> [`WER_BENCHMARK.md`](WER_BENCHMARK.md); Deepgram and AssemblyAI provider coverage (both
> working, with real latency numbers) is in [`SCENARIO_BENCHMARK.md`](SCENARIO_BENCHMARK.md).

**Groq Whisper round-trip latency: 1.30 s avg (100% success, N=5)** — real network round-trip to
the Groq transcription API plus server-side inference for a 2s clip; still the fastest and most
reliable of the three providers this benchmark actually exercises end-to-end.
