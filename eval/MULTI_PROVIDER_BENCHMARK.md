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
- Providers: OpenAI Whisper, Google Gemini, Groq Whisper — each tried 25 times
- Metrics: average latency, success rate

## Results (this run)

| Provider | Avg Latency | Success Rate |
|----------|-------------|---------------|
| Openai | — | 0% (no API key) |
| Gemini | — | 0% (all requests failed) |
| Groq | 0.31s | 80% (20/25) |

**Analysis:** **Groq** had the lowest measured round-trip latency this run (0.31s).
