# Realtime WebSocket Benchmark

This benchmark evaluates the latency and connection stability of the `/realtime`
WebSocket endpoint — the bidirectional voice-agent bridge to either the OpenAI
Realtime API or the Gemini Multimodal Live API.

## Status

`REALTIME_PROVIDER` (`openai` by default, or `gemini`) is an explicit, env-driven
choice — there is no auto-fallback between providers. If the key for the
selected provider is missing, `/realtime` reports `"REALTIME_API_KEY not
configured."` and closes; it never silently uses the other provider's key even
if one happens to be set.

No trustworthy latency numbers are recorded here yet. Re-run
`python eval/run_realtime_benchmark.py` with `REALTIME_PROVIDER` and the
matching API key set to generate a current, real result — it overwrites this
file with whatever it actually measures, pass or fail.
