# VoiceFlow — Scenario Comparison Benchmark

Reproducible: `python eval/run_scenario_benchmark.py [--file audio.wav] [--scenarios fast,accurate,cheap,streaming]`

## What this measures

Real, strictly-pinned (no fallback substitution) latency and success/failure
for each named scenario against live provider APIs. Cost is a public
list-price *estimate*, not measured. This does **not** measure downstream
task accuracy — whether the extracted action items were actually correct —
that requires grading against a labeled reference set, which is a natural
next step (compare against `WER_BENCHMARK.md`'s methodology) but isn't
fabricated here.

Only scenarios whose provider had a working API key at run time will show
PASS — a FAIL row is the system correctly refusing to substitute a different
provider than the one the scenario asked for, not a bug.

## Results (this run)

| Scenario | Provider | Transcribe | Analyze | Est. cost | Status |
|----------|----------|-----------|---------|-----------|--------|
| fast | groq | 1.491s | 0.775s | ~$0.020/min | PASS |
| accurate | deepgram | 0.0s | — | ~$0.050/min | FAIL (provider_failed:deepgram) |

## Sample output (first scenario that passed)

Scenario: `fast` (provider: `groq-whisper`, model: `groq/llama-3.3-70b-versatile` at the time
of this run — Groq deprecated that model for free/developer-tier accounts in mid-2026; the
`fast` scenario's `LLM_DEFAULT` is now `groq/openai/gpt-oss-120b`, see `services/scenarios.py`)

Transcript: `' .'`
