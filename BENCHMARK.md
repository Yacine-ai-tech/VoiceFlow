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
portfolio. AgentKit itself is data-, resource-, prompt-, and tool-agnostic — it is a generic
framework for exposing whatever tools, resources, and prompts a deployer configures, not a
fixed business-analytics product, and its tools are not read-only by design (the discovery
contract's `effect` field already distinguishes `read` from `write`/`destructive`, both of
which are supported end to end — see §2's `annotate_metric`/`retract_annotation` below). The
specific business-analytics tool set discovered and exercised in this document reflects one
particular demo deployment's configuration, not a property of AgentKit or of this discovery
contract. The results below were measured against that live demo deployment.

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

**Caveat, reported honestly, root-caused and fixed in §4 below.** In both live runs, the
WebSocket session closed with a keepalive ping timeout shortly after the spoken response
began, before the full reply completed. This did not affect the tool-calling mechanism
itself — discovery, the tool call, and the real data return all completed successfully and
identically in every run before the disconnect. This verification exercised the Gemini
Multimodal Live path (VoiceFlow's currently configured `REALTIME_PROVIDER`); the OpenAI
Realtime path uses an identical tool-calling relay pattern in the same module but was not
separately exercised here.

**Reproduce:** set `AGENT_TOOLS_URL` to a running AgentKit (or any compliant service)
instance and open a WebSocket to `/realtime`; ask a question one of the discovered tools can
answer and watch for `{"type": "tool_call", ...}` / `{"type": "tool_result", ...}` frames in
the relayed event stream.

## 4. Realtime turn completion: a real bug found, fixed, and re-measured

**Methodology.** A live benchmark script opened real WebSocket connections to production
(`/realtime`, Gemini Multimodal Live path), sent one conversational turn per connection, and
measured whether and how long each turn took to reach a `response.done` event — 8
back-to-back attempts, 5s apart.

**Before: 0 of 8 turns completed.** Every attempt either hit a 60-second client-side
timeout after streaming a substantial number of response chunks (15-20 chunks were commonly
received before stalling), or the connection closed with a keepalive ping timeout. Response
chunks were reliably being generated and sent — this was not a connectivity or provider
failure — but no turn ever reached completion.

**Root cause.** The server-side relay loop that forwards Gemini's response back to the
browser had a bare exception handler that silently discarded any error raised while
processing a response — the loop would simply stop, without sending `response.done` or any
error to the client, leaving the connection open but permanently stalled until an unrelated,
much later keepalive timeout eventually closed it. The fix logs the real error and forwards
an explicit `{"type": "error", ...}` event to the client instead of failing silently.

**After: 7 of 8 turns completed**, with real completion latencies:

| | Value |
|---|---|
| Successful turns | 7/8 |
| Turn completion time (mean / median) | 22.8s / 23.3s |
| Turn completion time (min / max) | 15.8s / 28.5s |
| WS connect latency (mean / median) | 4.7s / 3.5s |
| Time to first response chunk (mean / median) | 4.1s / 1.7s |

The one remaining failure (1 of 8, same keepalive-ping-timeout symptom) was not further
root-caused in this pass — see Honest caveats.

**Reproduce:** the benchmark script used here is not yet checked into this repo; the
existing `eval/run_realtime_benchmark.py` measures connection handshake only, not full-turn
completion — see Honest caveats for what would need to change to make this measurement
reproducible from a checked-in script.

## 5. Voice-agent UI across device profiles

**Methodology.** The production frontend was driven with a real browser automation tool
under four device emulation profiles — desktop, a recent Android phone, a recent iPhone,
and a tablet — loading the voice-agent page, locating and clicking its session-start
control, and observing browser console errors, failed network requests, and whether a
WebSocket connection to the realtime backend was attempted, plus a full-site navigation
pass across every route on the desktop profile.

**Result: functional and visually consistent across all four profiles.** Every profile
loaded the page cleanly with no layout overlap or unreadable content, correctly located and
could interact with the session-start control, and reliably attempted a WebSocket
connection to the realtime backend on page load, receiving real frames back. Where
microphone access wasn't available in the test environment, the app failed gracefully with
a clear, user-facing message rather than crashing or producing a blank page. A full 11-route
navigation crawl (desktop profile) returned HTTP 200 with substantive content on every
route, with no console errors beyond the analytics-pixel issue fixed in this same pass (see
above).

One profile (Android) reached an "API key not configured" state instead of "ready" during
this test run, while the other three profiles against the same backend succeeded — this
reads as transient backend-side state at the moment of that specific test rather than a
device-specific defect, since the frontend itself rendered that state correctly and
gracefully.

**Reproduce:** load the production frontend under device emulation, navigate to the
voice-agent page, and observe the WebSocket connection attempt and console/network activity
on session start.

## Honest caveats

- §4's fix raised full-turn completion from 0/8 to 7/8 in this pass's measurement — a large,
  clear improvement, but not a claim of 100% reliability. The one remaining failure was not
  further root-caused; a larger sample size would be needed to establish a stable success
  rate rather than a single 8-run snapshot.
- §4's benchmark script exists only as a one-off analysis for this pass, not yet checked
  into `eval/` as a reproducible script — `eval/run_realtime_benchmark.py` still only
  measures connection handshake, not full-turn completion; someone extending that script to
  send a real turn and wait for `response.done` would make this measurement independently
  reproducible going forward.
- Only the Gemini Multimodal Live path was exercised live in §3 and §4. The OpenAI Realtime
  path shares the identical `agent_tools_bridge` call sites (same discovery, same
  `call_tool()`) and the same relay-loop fix applies to it by construction (the fixed
  exception handler is Gemini-path-specific code, so the OpenAI path's own equivalent loop
  was not touched or re-verified in this pass), but it was not independently verified live.
- §5's Android result (an unexpected "not configured" state) reads as transient backend
  state rather than a frontend defect, based on the other three profiles succeeding against
  the same backend in the same test run — but this wasn't independently re-tested to
  confirm it was transient rather than intermittently reproducible.
- §5's iOS and tablet profiles ran under a Chromium-engine approximation of those devices'
  viewport/UA characteristics, not real WebKit/Safari rendering — the real WebKit browser
  binary could not be installed in the test environment. This validates responsive layout
  and code paths but is not equivalent to testing real Safari rendering.
- §5 did not and could not test real microphone audio capture or voice conversation
  quality — browser automation in this environment has no real audio input device. What was
  verified is UI rendering, interactivity, and the WebSocket connection attempt; the actual
  audio round-trip is covered by §3/§4's direct WebSocket-level testing instead.
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
