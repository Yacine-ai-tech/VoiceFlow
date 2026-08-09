# Realtime WebSocket Benchmark

This benchmark evaluates the latency and connection stability of the `/realtime` WebSocket endpoint when operating under Gemini fallback mode (no `OPENAI_API_KEY` set, `GEMINI_API_KEY` present).

## Status

The "Passed" result previously recorded here predates a config-wiring bug
where `core/config.py` never actually defined `REALTIME_API_KEY` —
`/realtime` was unconditionally returning "not configured" regardless of any
key you set, so that older result isn't reproducible against the code as it
shipped. That's now fixed: `Settings.REALTIME_API_KEY` correctly resolves to
`OPENAI_API_KEY` (or `GEMINI_API_KEY` as fallback).

Re-run `python eval/run_realtime_benchmark.py` with a real key set to
generate a current, trustworthy result — it overwrites this file with
whatever it actually measures, pass or fail.
