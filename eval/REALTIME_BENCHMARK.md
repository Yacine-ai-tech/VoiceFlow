# Realtime WebSocket Benchmark

This benchmark evaluates the latency and connection stability of the `/realtime`
WebSocket endpoint against whichever provider `REALTIME_PROVIDER` selects —
an explicit, env-driven choice with no auto-fallback between OpenAI and Gemini.

## Results (REALTIME_PROVIDER=gemini, run 2026-08-26)

| Metric | Result |
|--------|--------|
| Status | ✅ Passed (100%) |
| WebSocket Conn. Latency | 9.379 s |
| Time to First Byte (TTFB) | 1.426 s |
| Handshake message | Connected to Gemini Multimodal Live (`models/gemini-2.5-flash-native-audio-preview-09-2025`) |

> **Deployment context.** The WebSocket connection latency (9.4 s) reflects the server's
> auto-sleep behaviour — the constrained single-instance deployment wakes on first connection
> after an idle period. The TTFB (1.426 s) is the time from an already-open WebSocket to the
> first `ready` message from Gemini, and is the more meaningful latency for steady-state
> (already-warm) operation. In a warm, low-contention state (see `BENCHMARK.md §4`) P50
> connection latency is 3.5 s.

**Note:** this run only exercises the `gemini` path. Re-run with
`REALTIME_PROVIDER=openai` and its matching key to measure the OpenAI Realtime path.
This file always reflects only the most recent run.
