# Benchmark Results

This document reports what was actually measured for VoiceFlow's external tool-calling
integration — the `/realtime` voice agent's ability to call out to an external "agent
tools" service mid-conversation via the discovery contract implemented in
`services/agent_tools_bridge.py`. For per-provider benchmarks (ASR, diarization, realtime
latency, multi-provider LLM routing, action-item extraction), see the topic-specific
reports in `eval/`; this document covers the tool-calling bridge specifically, since it
did not previously have a live-measured report of its own.

## 1. The discovery contract

`AGENT_TOOLS_URL` points the realtime voice agent at any service implementing a small,
generic discovery contract:

```
GET  {AGENT_TOOLS_URL}/api/tools
  -> {"tools": [...], "resources": [...], "prompts": [...]}

GET/POST {AGENT_TOOLS_URL}{tool.endpoint}   # per-tool call, GET for read, POST for write/destructive
GET  {AGENT_TOOLS_URL}/api/resources?uri=...
GET  {AGENT_TOOLS_URL}/api/prompts/{name}
```

VoiceFlow's own code carries no product-specific logic — swapping `AGENT_TOOLS_URL` swaps
providers with no code change. Its own dev/demo reference implementation of this contract
is [AgentKit](https://github.com/Yacine-ai-tech/AgentKit), a separate project in the same
portfolio that exposes a set of business-analytics tools over this exact contract. The
results below were measured against AgentKit's live production deployment.

## 2. Live tool discovery

**Methodology.** With `AGENT_TOOLS_URL` pointed at AgentKit's production deployment, a
`GET /api/tools` discovery call was made using the exact same code path VoiceFlow's
`/realtime` handler calls at connect time (`agent_tools_bridge.discover_all()`).

**Result: 9 tools discovered, 0 resources, 0 prompts.**

| Tool | Effect | Endpoint |
|---|---|---|
| `query_kpis` | read | `/api/kpis` |
| `get_company_health` | read | `/api/health-score` |
| `detect_kpi_anomalies` | read | `/api/anomalies` |
| `forecast_metric` | read | `/api/forecast` |
| `list_available_metrics` | read | `/api/metrics` |
| `get_executive_summary` | read | `/api/summary` |
| `list_annotations` | read | `/api/packs/annotations/list_annotations` |
| `annotate_metric` | write | `/api/packs/annotations/annotate_metric` |
| `retract_annotation` | destructive | `/api/packs/annotations/retract_annotation` |

All 9 tools translated cleanly into both realtime model shapes VoiceFlow supports (OpenAI
Realtime function-calling format and Gemini's `FunctionDeclaration` format) with no
translation errors. The contract's `resources` and `prompts` channels are supported by
VoiceFlow's bridge but currently unused by AgentKit's implementation (both return empty).

## 3. Live end-to-end voice-agent verification

**Methodology.** Two independent checks were run against VoiceFlow's live production
deployment, after pointing it at AgentKit's live production deployment:

1. **Direct bridge verification** — calling `agent_tools_bridge`'s discovery and
   tool-execution functions (the exact functions `/realtime` calls) against the configured
   production values, independent of any voice model's behavior.
2. **Full live voice-agent session** — a real WebSocket connection to the production
   `/realtime` endpoint (currently configured to VoiceFlow's Gemini Multimodal Live path),
   sending a text turn — *"What is our current company health score? Please give me the
   specific number."* — and observing the events the server relayed back.

**Result: the tool-calling round trip works, live, with real data.**

The direct bridge check returned real, richly detailed data — for example
`get_executive_summary` returned a live health score, component breakdown, and current KPI
values (e.g. ARR of $37,964,237.72 for the most recent period) — clearly not placeholder or
mocked output.

The full voice-agent session confirmed the same mechanism end-to-end through the actual
realtime relay: the model received the discovered tools at connect time, decided on its own
to call `get_company_health` in response to the question, and the bridge returned AgentKit's
real live result:

```
score: 0.0, interpretation: "Critical"
components: growth -94.46, margin 99.58, cash_score 14.05, efficiency 60.0
```

The model began verbalizing a response grounded in that real result (the captured transcript
begins *"Our current..."*) before the session closed. This was reproducible across repeated
runs: the tool discovery, the model's decision to call the tool, and the real data returned
were consistent every time.

**Caveat, reported honestly.** In both live runs, the WebSocket session closed with a
keepalive ping timeout shortly after the spoken response began, before the full reply
completed. This did not affect the tool-calling mechanism itself — discovery, the tool call,
and the real data return all completed successfully and identically in every run before the
disconnect — but it means the *full* spoken answer was not observed end-to-end in this
verification pass. This verification exercised the Gemini Multimodal Live path (VoiceFlow's
currently configured `REALTIME_PROVIDER`); the OpenAI Realtime path uses an identical
tool-calling relay pattern in the same module but was not separately exercised here.

**Reproduce:** set `AGENT_TOOLS_URL` to a running AgentKit (or any compliant service)
instance and open a WebSocket to `/realtime`; ask a question one of the discovered tools can
answer and watch for `{"type": "tool_call", ...}` / `{"type": "tool_result", ...}` frames in
the relayed event stream.

## Honest caveats

- This is a single integration's tool-calling mechanism, not a benchmark of voice quality,
  latency, or conversational accuracy — see `eval/REALTIME_BENCHMARK.md` for the (currently
  unpopulated) latency/stability benchmark for the `/realtime` endpoint itself.
- The full spoken reply was not observed completing end-to-end in this verification pass
  (see the caveat in §3) — what's confirmed is that discovery, the model's tool-call
  decision, and the real data round trip all work correctly and reproducibly; the very last
  leg (a complete, uninterrupted spoken answer) was not.
- Only the Gemini Multimodal Live path was exercised live in this pass. The OpenAI Realtime
  path shares the identical `agent_tools_bridge` call sites (same discovery, same
  `call_tool()`), so the same mechanism applies there by construction, but it was not
  independently verified live in this pass.
- AgentKit's `resources` and `prompts` discovery channels are implemented by VoiceFlow's
  bridge but were not exercised here, since AgentKit's current deployment doesn't populate
  either.
- These results reflect AgentKit's demo dataset at the time of measurement — the specific
  figures (health score, ARR, etc.) will change as that dataset changes; what's being
  verified is that the mechanism returns AgentKit's real, current values, not that any
  particular value is fixed.

## Further reading

- [`README.md`](README.md) — feature overview and quick start.
- [`RESEARCH.md`](RESEARCH.md) — design notes for VoiceFlow's other components.
- `services/agent_tools_bridge.py` — the discovery contract's full implementation and docs.
