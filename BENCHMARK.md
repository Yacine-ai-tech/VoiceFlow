# Benchmark Results

This document reports VoiceFlow's external tool-calling integration — the `/realtime` voice
agent's ability to call an external "agent tools" service mid-conversation, via the discovery
contract implemented in `services/agent_tools_bridge.py`. For per-provider benchmarks (ASR,
diarization, real-time latency, multi-provider LLM routing, action-item extraction), see the
topic-specific reports in `eval/`; this document covers the tool-calling bridge and real-time
turn performance specifically.

## 1. The Discovery Contract

`AGENT_TOOLS_URL` points the real-time voice agent at any service implementing a small,
generic discovery contract:

```
GET  {AGENT_TOOLS_URL}/api/tools
  -> {"tools": [...], "resources": [...], "prompts": [...]}

GET/POST {AGENT_TOOLS_URL}{tool.endpoint}   # per-tool call; GET for read, POST for write/destructive
GET  {AGENT_TOOLS_URL}/api/resources?uri=...
GET  {AGENT_TOOLS_URL}/api/prompts/{name}
```

VoiceFlow's own code carries no product-specific logic — changing `AGENT_TOOLS_URL` swaps
providers with no code change. The reference implementation of this contract is
[AgentKit](https://github.com/Yacine-ai-tech/AgentKit), a separate project in the same
portfolio. AgentKit is itself data-, resource-, prompt-, and tool-agnostic — a generic
framework for exposing whatever tools, resources, and prompts a deployer configures, with
tools that are not read-only by design (the discovery contract's `effect` field distinguishes
`read` from `write`/`destructive`, both supported end to end — see §2). The specific tool set
discovered and exercised below reflects one demo deployment's configuration, not a property
of AgentKit or of the discovery contract itself.

## 2. Live Tool Discovery

**Methodology.** With `AGENT_TOOLS_URL` pointed at AgentKit's production deployment, a
`GET /api/tools` discovery call was made using the same code path VoiceFlow's `/realtime`
handler calls at connect time.

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

All 9 tools translated cleanly into both real-time model shapes VoiceFlow supports (OpenAI
Realtime function-calling format and Gemini's `FunctionDeclaration` format), with no
translation errors. The contract's `resources` and `prompts` channels are supported by
VoiceFlow's bridge but currently unused by AgentKit's implementation, which returns empty
lists for both.

## 3. Live End-to-End Voice-Agent Tool Use

**Methodology.** Two checks were run against VoiceFlow's live production deployment, pointed
at AgentKit's live production deployment: calling `agent_tools_bridge`'s discovery and
tool-execution functions directly, independent of any voice model's behavior; and a real
WebSocket connection to the production `/realtime` endpoint (Gemini Multimodal Live path),
sending the turn "What is our current company health score? Please give me the specific
number" and observing the relayed events.

**Result: the tool-calling round trip completes, live, with real data.**

The direct bridge check returned real, detailed data — for example, `get_executive_summary`
returned a live health score, component breakdown, and current KPI values (an ARR of
$37,964,237.72 for the most recent period).

The full voice-agent session confirmed the same mechanism end to end through the actual
real-time relay: the model received the discovered tools at connect time, decided on its own
to call `get_company_health` in response to the question, and the bridge returned AgentKit's
live result:

```
score: 0.0, interpretation: "Critical"
components: growth -94.46, margin 99.58, cash_score 14.05, efficiency 60.0
```

The model verbalized a response grounded in that result. Tool discovery, the model's decision
to call the tool, and the data returned were consistent across repeated runs.

**Reproduce:** set `AGENT_TOOLS_URL` to a running AgentKit (or any compliant service) instance
and open a WebSocket to `/realtime`; ask a question one of the discovered tools can answer and
watch for `{"type": "tool_call", ...}` / `{"type": "tool_result", ...}` frames in the relayed
event stream.

## 4. Real-Time Turn Latency (Gemini Multimodal Live)

**Methodology.** Real WebSocket connections were opened to production `/realtime/gemini`, one
conversational turn sent per connection, measuring connection handshake time, time to first
response chunk, and total time to turn completion. Full detail:
[`eval/REALTIME_TURNS_BENCHMARK.md`](eval/REALTIME_TURNS_BENCHMARK.md).

**Result (N=25):**

| Metric | Result |
|---|---|
| WS handshake latency — mean | 1.157s |
| WS handshake latency — median | 1.126s |
| WS handshake latency — max | 1.535s |
| Time to first response chunk — mean | 0.940s |
| Turn completion time (successful turns) — mean | 5.778s |
| Turn completion time (successful turns) — median | 3.584s |
| Completion rate | 25/25 (100.0%) |

Every one of the 25 handshakes completed under 1.8s, and all 25 turns completed with a clean
`response.done`, with no drops or truncated replies. This run encountered no Gemini API-side
quota error; the only throttling observed came from this service's own WebSocket-connect rate
limit, handled by the benchmark script's built-in backoff and retry.

**Reproduce:** `REALTIME_WS_URL=wss://<host>/realtime/gemini python eval/run_realtime_turns_benchmark.py`
(set `REALTIME_N_TURNS` to change N from the default of 25).

## Limitations

- This is a single N=25 run, not a repeated-trials study — turn-completion time has a wide
  spread (0.6s–23.7s) driven by how much the model has to say per reply, so the mean and
  median above should be read as directional rather than a tight confidence interval.
- Only the Gemini Multimodal Live path was measured in §3 and §4. The OpenAI Realtime path
  shares the same tool-calling relay pattern in the same module but was not independently
  measured here.
- AgentKit's `resources` and `prompts` discovery channels are implemented by VoiceFlow's
  bridge but were not exercised here, since AgentKit's current deployment does not populate
  either.
- These results reflect AgentKit's demo dataset at the time of measurement — the specific
  figures (health score, ARR, and similar) will change as that dataset changes. What is being
  verified is that the mechanism returns AgentKit's real, current values, not that any
  particular value is fixed.

## Further Reading

- [`README.md`](README.md) — feature overview and quick start
- [`RESEARCH.md`](RESEARCH.md) — design notes for VoiceFlow's other components
- `services/agent_tools_bridge.py` — the discovery contract's full implementation
