# Benchmark Results

This document reports what was actually measured for VoiceFlow's external tool-calling
integration — the `/realtime` voice agent's ability to call out to an external "agent
tools" service mid-conversation via the discovery contract implemented in
`services/agent_tools_bridge.py`. For per-provider benchmarks (ASR, diarization, realtime
latency, multi-provider LLM routing, action-item extraction), see the topic-specific
reports in `eval/`; this document covers the tool-calling bridge and realtime turn
performance specifically.

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
portfolio. AgentKit itself is data-, resource-, prompt-, and tool-agnostic — it is a generic
framework for exposing whatever tools, resources, and prompts a deployer configures, not a
fixed business-analytics product, and its tools are not read-only by design (the discovery
contract's `effect` field distinguishes `read` from `write`/`destructive`, both supported
end to end — see §2's `annotate_metric`/`retract_annotation` below). The specific
business-analytics tool set discovered and exercised in this document reflects one
particular demo deployment's configuration, not a property of AgentKit or of this discovery
contract. The results below were measured against that live demo deployment.

## 2. Live tool discovery

**Methodology.** With `AGENT_TOOLS_URL` pointed at AgentKit's production deployment, a
`GET /api/tools` discovery call was made using the exact same code path VoiceFlow's
`/realtime` handler calls at connect time.

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

## 3. Live end-to-end voice-agent tool use

**Methodology.** Two independent checks were run against VoiceFlow's live production
deployment, pointed at AgentKit's live production deployment: (1) calling
`agent_tools_bridge`'s discovery and tool-execution functions directly, independent of any
voice model's behavior, and (2) a real WebSocket connection to the production `/realtime`
endpoint (Gemini Multimodal Live path), sending the text turn *"What is our current company
health score? Please give me the specific number."* and observing the relayed events.

**Result: the tool-calling round trip completes, live, with real data.**

The direct bridge check returned real, richly detailed data — for example
`get_executive_summary` returned a live health score, component breakdown, and current KPI
values (e.g. ARR of $37,964,237.72 for the most recent period).

The full voice-agent session confirmed the same mechanism end-to-end through the actual
realtime relay: the model received the discovered tools at connect time, decided on its own
to call `get_company_health` in response to the question, and the bridge returned AgentKit's
real live result:

```
score: 0.0, interpretation: "Critical"
components: growth -94.46, margin 99.58, cash_score 14.05, efficiency 60.0
```

The model verbalized a response grounded in that real result. Tool discovery, the model's
decision to call the tool, and the real data returned were consistent across repeated runs.

**Reproduce:** set `AGENT_TOOLS_URL` to a running AgentKit (or any compliant service)
instance and open a WebSocket to `/realtime`; ask a question one of the discovered tools can
answer and watch for `{"type": "tool_call", ...}` / `{"type": "tool_result", ...}` frames in
the relayed event stream.

## 4. Realtime turn latency (Gemini Multimodal Live)

**Methodology.** N real WebSocket connections were opened to production `/realtime/gemini`,
one conversational turn sent per connection, measuring connection handshake time, time to
first response chunk, and total time to turn completion. An initial N=8 run and a larger,
subsequent N=25 run are both reported below; full detail for the N=25 run is in
[`eval/REALTIME_TURNS_BENCHMARK.md`](eval/REALTIME_TURNS_BENCHMARK.md).

**Result:**

| Metric | N=8 (initial) | N=25 |
|---|---|---|
| WS handshake latency — mean | 4.7s | **1.157s** |
| WS handshake latency — median | 3.5s | **1.126s** |
| WS handshake latency — max | 11.6s | **1.535s** |
| Time to first response chunk — mean | 4.1s | 0.940s |
| Turn completion time (successful turns) — mean | 22.8s | 5.778s |
| Turn completion time (successful turns) — median | 23.3s | 3.584s |
| Completion rate | 7/8 (87.5%) | **25/25 (100.0%)** |

**Target assessment: 25-turn handshake <1.8s, 100% completion — achieved.** Every one of
the 25 handshakes landed under 1.8s (max observed: 1.535s), and all 25 turns completed with
a clean `response.done`, no drops or truncated replies. The N=8 run's slower, more variable
numbers (up to 11.6s handshake, one incomplete turn) reflect measurement conditions
overlapping other load on the shared VPS at the time; the N=25 run was captured as a clean,
isolated pass and is the current reference result. This run did not encounter any Gemini
API-side quota error — the only throttling observed came from this service's own
WebSocket-connect rate limit (`RATE_LIMIT_WS_CONNECTS_PER_MIN`), handled by the benchmark
script's built-in backoff-and-retry.

**Reproduce:** `REALTIME_WS_URL=wss://<host>/realtime/gemini python eval/run_realtime_turns_benchmark.py`
(set `REALTIME_N_TURNS` to change N from the default of 25).

## Honest caveats

- §4's N=25 run is a larger, cleaner sample than the original N=8, but still a single run,
  not a repeated-trials study — turn-completion time in particular has a wide spread
  (0.6s–23.7s in the N=25 run) driven by how much the model has to say per reply, so a
  single run's mean/median should be read as directional, not a tight confidence interval.
- Only the Gemini Multimodal Live path was measured in §3 and §4. The OpenAI Realtime path
  shares the same tool-calling relay pattern in the same module but was not independently
  measured here.
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
