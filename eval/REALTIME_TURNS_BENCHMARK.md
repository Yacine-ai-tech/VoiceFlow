# N-Turn Realtime Benchmark (Gemini Multimodal Live)

Extends section 4 of `BENCHMARK.md` (originally N=8) to N=25: one WebSocket
connection and one conversational text turn per iteration against `/realtime/gemini`,
matching that section's own methodology exactly.

## Results (N=25)

| Metric | Mean | Median | Min | Max |
|---|---|---|---|---|
| WS handshake latency (to `provider_ready`) | 1.157s | 1.126s | 1.018s | 1.535s |
| Turn completion time (successful turns) | 5.778s | 3.584s | 0.593s | 23.692s |

**Completion rate: 25/25 (100.0%)**

**Reproduce:** `REALTIME_WS_URL=wss://<host>/realtime/gemini python eval/run_realtime_turns_benchmark.py`
