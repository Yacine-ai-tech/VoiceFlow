# VoiceFlow — Multi-Provider ASR Latency Benchmark

Reproducible: `python eval/run_multi_provider_benchmark.py`

## What this measures
Real round-trip latency and success rate against each provider's live API,
using a short generated tone (not a ground-truth transcript). It does **not**
measure Word Error Rate — that requires a reference transcript to score
against. For WER against real speech (LibriSpeech `test-clean`), see
[`WER_BENCHMARK.md`](WER_BENCHMARK.md), which is scored with `jiwer` against
actual reference text.

## Status

The numbers previously committed here were not measurements — the script
that generated them transcribed literal placeholder bytes and computed
WER/CER from a synthetic formula rather than real accuracy, while claiming a
LibriSpeech-based result. That has been fixed (see `run_multi_provider_benchmark.py`):
the script now only reports what it actually measures — latency and success
rate against real API calls — and no longer fabricates accuracy numbers.

No results are published here yet. Run the script yourself with
`OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` set for whichever
providers you want to compare — it writes real, dated results to this file.
