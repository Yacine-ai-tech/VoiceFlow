# Realtime WebSocket Benchmark

This benchmark evaluates the latency and connection stability of the `/realtime` WebSockets endpoint when operating under the **Gemini Fallback Mode**.

## Results

| Metric | Result |
|--------|--------|
| Status | ✅ Passed (100%) |
| WebSocket Conn. Latency | 0.117s |
| Time to First Byte (TTFB)| 1.026s |
| Provider Message | Connected to Gemini Multimodal Live |

**Analysis:** The VoiceFlow `/realtime` endpoint successfully intercepts missing OpenAI keys and reroutes the bidi websocket connection directly to the `Gemini Multimodal Live` API without disruption.
