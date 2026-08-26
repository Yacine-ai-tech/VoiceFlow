# VoiceFlow — Scenario Comparison Benchmark

Reproducible: `python eval/run_scenario_benchmark.py [--file audio.wav] [--scenarios fast,accurate,cheap,streaming]`

## What this measures

Real, strictly-pinned (no fallback substitution) latency and success/failure
for each named scenario against live provider APIs. Cost is a public
list-price *estimate*, not measured. This does **not** measure downstream
task accuracy — whether the extracted action items were actually correct —
that requires grading against a labeled reference set (see [`ACTION_ITEM_BENCHMARK.md`](ACTION_ITEM_BENCHMARK.md)).

Only scenarios whose provider had a working API key at run time will show
PASS — a FAIL row is the system correctly refusing to substitute a different
provider than the one the scenario asked for, not a bug.

## Results (run 2026-08-26)

| Scenario | Provider | Transcribe | Analyze | Est. cost | Status |
|---|---|---|---|---|---|
| **fast** | groq-whisper → `groq/openai/gpt-oss-120b` | **3.37 s** | **1.16 s** | ~$0.020/min | ✅ PASS |
| accurate | deepgram-nova3 → `LLM_REASONING` | 2.23 s | — | ~$0.050/min | ⚠️ partial (see note) |
| cheap | local WhisperX → `LLM_DEFAULT` | — | — | ~$0.000/min | ❌ FAIL (`provider_failed:local`) |
| streaming | assemblyai → `LLM_REASONING` | 7.72 s | — | ~$0.030/min | ⚠️ partial (see note) |

> **Notes on partial results.**
>
> **`accurate` / `streaming`** — The ASR step completed successfully (Deepgram 2.2 s, AssemblyAI 7.7 s).
> The analysis step failed with a 400 from the `LLM_REASONING` tier
> (`openai/anthropic/claude-sonnet-4-6` routed through the OpenAI-compatible inference proxy):
> the proxy does not accept the Anthropic message schema that LiteLLM sends for this model alias
> at the current API version. The transcription providers themselves are functional — this is an
> inference proxy compatibility issue on the analysis tier, not a Deepgram or AssemblyAI failure.
> Switching `LLM_REASONING` to a directly-callable provider (e.g. `groq/openai/gpt-oss-120b` or
> `anthropic/claude-sonnet-4-6` with a direct Anthropic key) would resolve it.
>
> **`cheap`** — The local WhisperX runner (`provider_failed:local`) is not installed in this
> environment. The `cheap` scenario requires a local GPU or CPU WhisperX installation
> (see `README.md`); it is not a cloud-API scenario.

## Transcription-only latency (ASR stage, all configured providers)

| Provider | Latency | Notes |
|---|---|---|
| Groq Whisper | 3.37 s | 2s tone clip |
| Deepgram Nova-3 | 2.23 s | 2s tone clip |
| AssemblyAI | 7.72 s | 2s tone clip; higher latency typical for AssemblyAI async flow |

## Sample output (`fast` scenario, full pipeline)

Scenario: `fast` (provider: `groq-whisper`, model: `groq/openai/gpt-oss-120b`)

Transcript: `' .'` (expected — input was a sine-wave tone, not speech)
