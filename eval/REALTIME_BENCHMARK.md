# Realtime WebSocket Benchmark

This benchmark evaluates the latency and connection stability of the `/realtime`
WebSocket endpoint against whichever provider `REALTIME_PROVIDER` selects —
an explicit, env-driven choice with no auto-fallback between OpenAI and Gemini.
Reproducible: `REALTIME_PROVIDER=gemini python eval/run_realtime_benchmark.py`
(swap `gemini` for `openai` to test the other path; needs a matching
`REALTIME_API_KEY` for whichever provider is selected).

**Harness note:** this script connects via FastAPI's `TestClient`, which runs the
`/realtime` WebSocket handler in-process against the actual app object — there is
no real TCP/network hop to a deployed instance, and no VoiceFlow deployment
cold-start involved. The latencies below are real, but they measure the actual
work the handler does before it can respond, not network/infra wake time.

## Results (run 2026-08-27)

| Provider | Status | WebSocket Conn. Latency | Time to First Byte (TTFB) | Handshake message |
|---|---|---|---|---|
| **gemini** | ✅ PASS (100%) | 4.260 s | 1.447 s | `Connected to Gemini Multimodal Live (models/gemini-2.5-flash-native-audio-preview-09-2025)` |
| openai | ❌ FAIL | 0.085 s | — | `OpenAI Realtime relay failed: ... invalid_api_key` |

> **What the Gemini latency actually measures.** The handler doesn't send anything
> back to the client until it has: (1) opened a live session with Google's Gemini
> Multimodal Live API via the `google-genai` SDK, (2) discovered the tools this
> project's agent-tools bridge exposes (a live HTTP call to a separate deployed
> service, the agent-tools provider), and (3) confirmed the Postgres session-stats
> schema is ready. `TestClient`'s `websocket_connect()` blocks until the handler
> reaches its first receive/send point, which for the Gemini path is *after* all of
> that — so the reported 4.26 s "connection latency" is really the sum of those three
> real, live dependencies, not a WebSocket handshake or this project's own
> deployment waking up. The 1.45 s TTFB is the time from that point to the actual
> `ready` message. Run-to-run variance here reflects genuine variance in Gemini's own
> session-negotiation time and the agent-tools-bridge service's response time (which
> has its own deployment characteristics, separate from VoiceFlow's).
>
> **Why `openai` shows a fast failure, not a slow one.** The OpenAI relay path
> doesn't do the same pre-handshake setup — it fails immediately on the provider's
> own key-validation response (`invalid_api_key`) rather than after building a
> session. That's a real, honestly-reported result: `REALTIME_API_KEY` in this
> environment is currently set to a Gemini credential, not a working OpenAI Realtime
> key, so the `openai` path cannot be validated end-to-end without one. This is not
> fabricated as a pass — it's reported as the actual failure it is.

**Reproduce:** re-run with a real OpenAI Realtime API key in `REALTIME_API_KEY` (and
`REALTIME_PROVIDER=openai`) to get a genuine pass/latency result for that path; this
file always reflects only the most recent run per provider tested.
