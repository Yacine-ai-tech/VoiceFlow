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

## Results (run 2026-08-27)

| Scenario | Provider | Transcribe | Analyze | Est. cost | Status |
|----------|----------|-----------|---------|-----------|--------|
| **fast** | groq-whisper → `groq/openai/gpt-oss-120b` | **2.00 s** | **1.45 s** | ~$0.020/min | ✅ PASS |
| **accurate** | deepgram-nova3 → `LLM_REASONING` | **2.35 s** | **11.30 s** | ~$0.050/min | ✅ PASS |
| **streaming** | assemblyai → `LLM_REASONING` | **6.12 s** | **1.83 s** | ~$0.030/min | ✅ PASS |
| cheap | local WhisperX → `LLM_DEFAULT` | — | — | ~$0.000/min | ❌ FAIL (`provider_failed:local`) |

> **Fixes that unblocked `accurate`/`streaming` since the previous run.** Two real, separate
> issues were found and fixed while getting this run to a genuine pass, not just a config change:
> 1. `LLM_REASONING`'s calls were routing through an inference-proxy account credential that
>    turned out to be the wrong one of two similarly-purposed Lightning AI credentials for this
>    specific endpoint — corrected to the right one.
> 2. Once auth was fixed, both scenarios still failed with a `400` from the proxy
>    (`messages.1.user.content: Field required`) because the test audio is a synthetic tone with
>    no speech — Deepgram/AssemblyAI correctly transcribe that as an **empty string**, and this
>    particular proxy rejects a literal empty `user` message content outright (unlike a direct
>    OpenAI-compatible endpoint, which generally accepts it). Fixed in
>    `services/meeting_analyzer.py`: an empty/whitespace-only transcript is now sent as the
>    honest placeholder `"[no speech detected in this audio]"` instead of `""`, so the request is
>    well-formed. Also hardened `services/transcription_adapter.py`'s Deepgram/AssemblyAI paths,
>    which used `dict.get(key, "")` — that only substitutes the default when the *key is
>    absent*, not when the API returns the key with an explicit `null` value (which both
>    providers can do for near-silent audio); switched to `dict.get(key) or ""` so a `null`
>    transcript can't reach the analysis call as `None` either.
>
> **`cheap`** — The local WhisperX runner (`provider_failed:local`) is not installed in this
> environment. The `cheap` scenario requires a local GPU or CPU WhisperX installation (see
> `README.md`); it is not a cloud-API scenario, and the failure has nothing to do with the fixes
> above.

## Sample output (first scenario that passed)

Scenario: `fast` (provider: `groq-whisper`, model: `groq/openai/gpt-oss-120b`)

Transcript: `' .'`
