# VoiceFlow — Complete Architecture Reference

Generated from a direct read of the current codebase (not from docs, not from
memory) on 2026-08-09. Everything below is either verified against source or
explicitly marked as unverified/planned.

---

## 1. Frontend — all 11 pages

Routed in `frontend/src/App.tsx`, shared shell in `frontend/src/kit/AppShell.tsx`.

| Route | Component | What it does |
|---|---|---|
| `/` | `Workspace.tsx` | Landing page — launcher cards into the other pages |
| `/record` | `Record.tsx` | MediaRecorder capture with live waveform; streams to `WS /stream` for live captions while recording, then POSTs the full clip to `/pipeline` on stop |
| `/analyze` | `Analyze.tsx` | Paste a transcript or upload an audio file; pick one of 5 analysis types or a custom field schema |
| `/agent` | `VoiceAgent.tsx` | Full realtime voice-agent UI — client-side VAD, barge-in, PCM audio scheduling, browser-native `SpeechRecognition` fallback for captions. Connects to `WS /realtime`. Shows "Calling a tool — …" / "Tool responded — …" pills when the model calls an external tool |
| `/speech` | `Speech.tsx` | Text box → `/tts`, plays the returned audio |
| `/integrations` | `Integrations.tsx` | Push the latest result (or custom JSON) to a Slack/n8n/Zapier/custom webhook via `/integrations/relay`; target selector (auto-detect / force) |
| `/analytics` | `Analytics.tsx` | Bar chart combining server-side `/analytics` counters with browser-local session history |
| `/history` | `History.tsx` | `localStorage`-backed session history, capped at 30 items — explicitly local-only, no backend store |
| `/models` | `Models.tsx` | Static "factual routing page" — lists real ASR/LLM/TTS providers, scenarios, and the realtime/agent-tools setup. Kept in sync with source this session |
| `/api-docs` | `ApiDocs.tsx` | Static, hand-written API reference (not a live Swagger embed, not an iframe) |
| `/benchmark` | `BenchmarkPage.tsx` | Renders the `eval/*.md` benchmark content inline (hardcoded string, not fetched live — a known drift risk if the `.md` files change) |
| `/user-guide` | `UserGuidePage.tsx` | Static usage guide |
| `*` (catch-all) | → `Workspace.tsx` | Unmatched client-side routes redirect home |

**Not exposed in the UI yet:** the new `provider=openai\|kokoro` TTS options and the `scenario=` field on `/pipeline` have no UI selector — only reachable via direct API calls today. `Speech.tsx` is hardcoded to the default edge-tts provider.

---

## 2. Backend — all API endpoints (`api.py`)

### System
| Method | Path | Notes |
|---|---|---|
| GET | `/` | Serves the SPA (`frontend/dist/index.html`) if built, else a JSON pointer |
| GET | `/health` | Static liveness check, no dependency checks |
| GET | `/{full_path:path}` | SPA-fallback catch-all (added this session) — serves real static files from `frontend/dist/` if they exist, else `index.html`, so direct navigation/refresh/bookmarks work on every frontend route |

### Transcription
| Method | Path | Notes |
|---|---|---|
| POST | `/transcribe` | multipart file + `provider`, `language`, `diarize` |
| POST | `/transcribe-json` | same, but `audio_b64` in a JSON body |
| WS | `/stream` | Incremental transcription — re-transcribes the growing buffer every 3rd chunk (~poor-man's streaming, not token-level incremental) |

### Analysis
| Method | Path | Notes |
|---|---|---|
| POST | `/analyze` | `{text, analysis_type}` → one of 5 schemas |
| POST | `/analyze/custom` | `{text, fields[], instructions}` → caller-defined schema |
| POST | `/meeting/process` | audio → transcribe + `analysis_type=meeting` preset |
| POST | `/call/analyze` | audio + `call_type` → transcribe + analyze preset |

### Pipeline & Scenarios
| Method | Path | Notes |
|---|---|---|
| POST | `/pipeline` | audio → transcribe → analyze in one call. `provider`/`analysis_type` as usual, **or** `scenario=` to pin an exact provider+diarize+model combo with **no fallback substitution** (`strict=True` under the hood) |
| GET | `/scenarios` | Returns the scenario catalog (`fast`, `accurate`, `cheap`, `streaming`, `research-compare`) from `services/scenarios.py` |

### TTS
| Method | Path | Notes |
|---|---|---|
| POST | `/tts` | `{text, language, voice_gender, provider}` — `provider` ∈ `edge\|elevenlabs\|openai\|kokoro` |

### Integrations
| Method | Path | Notes |
|---|---|---|
| POST | `/integrations/relay` | `{url, payload, target?}` — server-side relay (bypasses browser CORS). Slack payloads are auto-reformatted into real Slack Block Kit JSON; n8n/Zapier/generic pass through unchanged |

### Realtime & analytics
| Method | Path | Notes |
|---|---|---|
| WS | `/realtime` | Bidirectional voice bridge to OpenAI Realtime API or Gemini Multimodal Live (`REALTIME_PROVIDER`, no fallback between them). If `AGENT_TOOLS_URL` is set, the model can call whatever tools that service exposes mid-conversation |
| GET | `/analytics` | In-memory request counters. **Dual-purpose**: a plain top-level browser navigation (`Sec-Fetch-Mode: navigate`) gets the SPA instead of raw JSON, since this path collides with the frontend's own `/analytics` page route |

**16 application-defined routes** (14 HTTP + 2 WebSocket). `len(app.routes)` reports 21 at runtime — the extra 5 are FastAPI's own auto-added `/docs`, `/redoc`, `/openapi.json`, plus the `/assets` static mount.

---

## 3. All features

- **Multi-provider transcription** with an explicit fallback chain (`ASR_PROVIDER`), per-request override, and `strict` no-fallback mode for benchmarking
- **5 analysis types** (`meeting`, `sales_call`, `support_call`, `interview`, `general`) + arbitrary custom-schema extraction, each routed to a different LLM tier
- **Speaker diarization**, engine-selectable (`pyannote` or `nemo`), with an honest `diarized: false` when unavailable — never a fabricated result
- **4 TTS providers** with automatic fallback to edge-tts on any failure
- **Realtime bidirectional voice agent** (OpenAI or Gemini), explicitly chosen, no auto-fallback
- **External tool-calling for the voice agent** via a generic discovery contract — not hardcoded to any product
- **Named, benchmarkable scenarios** — reproducible provider/model combinations with no silent substitution
- **Local-vs-remote compute delegation** for every heavy ML component (ASR, diarization, TTS) — run it here or delegate to a host you control
- **Webhook relay** with format-aware Slack/n8n/Zapier handling
- **Anonymous opt-out telemetry** (startup ping only, disabled via `TELEMETRY_OPT_OUT=true`)
- **In-memory usage analytics** (`/analytics`, resets on restart)
- **Session history** (client-side only, `localStorage`)

---

## 4. All providers

### Transcription (ASR)
| Provider | Type | Key/Setup | Diarization |
|---|---|---|---|
| Local WhisperX | local | none (needs `requirements-ml.txt`) | via `LOCAL_DIARIZATION_ENGINE` |
| Local NeMo Canary | local, GPU-recommended | `nemo_toolkit[asr]` (commented out by default) | none itself — can pair with local diarization |
| Remote (your endpoint) | remote | `VOICEFLOW_REMOTE_ENDPOINT` + token | whatever you implement behind it |
| Groq | cloud API | `GROQ_API_KEY` | none |
| Deepgram nova-3 | cloud API | `DEEPGRAM_API_KEY` | yes, native |
| AssemblyAI Universal-2 | cloud API | `ASSEMBLYAI_API_KEY` | yes, native |

### Diarization (local mode only — remote/cloud providers handle their own)
| Engine | Setup | Notes |
|---|---|---|
| pyannote (default) | `HF_TOKEN` | GPU-recommended |
| NeMo ClusteringDiarizer | `nemo_toolkit[asr]` | CPU-capable; real RTTM parsing + overlap-based speaker assignment (verified with synthetic data this session) |

### LLM analysis (via LiteLLM)
| Analysis type | Model setting | Default |
|---|---|---|
| `meeting`, `general` | `LLM_DEFAULT` | `groq/llama-3.3-70b-versatile` |
| `sales_call`, `interview` | `LLM_REASONING` | `anthropic/claude-sonnet-4-6` |
| `support_call` | `LLM_JUDGE` | `anthropic/claude-haiku-4-5` |

### TTS
| Provider | Setup | Notes |
|---|---|---|
| edge-tts | none | default, EN/FR |
| ElevenLabs | `ELEVENLABS_API_KEY` | premium quality + cloning (cloning itself not wired into the API yet — only 2 fixed voices) |
| OpenAI tts-1-hd | `OPENAI_API_KEY` | verified against the real installed SDK's signature |
| Kokoro | none (needs `requirements-ml.txt`) | self-hosted; local or `VOICEFLOW_TTS_REMOTE_ENDPOINT` |

### Realtime voice
| Provider | Setup |
|---|---|
| OpenAI Realtime API | `OPENAI_API_KEY`, `REALTIME_PROVIDER=openai` |
| Gemini Multimodal Live | `GEMINI_API_KEY`, `REALTIME_PROVIDER=gemini` |

### External agent tools
Generic discovery contract (`services/agent_tools_bridge.py`) — `AGENT_TOOLS_URL` + `GET {url}/api/tools`. Not tied to any product; AgentKit is this project's own demo target and already implements it.

---

## 5. Local vs. remote — the configuration model

Built this session specifically so hardware/hosting decisions never require a
code change. The principle: **cloud APIs (Groq, Anthropic, ElevenLabs, etc.)
are always just HTTP calls — no local/remote question applies to them.**
Local/remote only matters for *heavy self-hosted models* — and it's decided
per-capability, not with one global switch.

| Capability | Local (on this host) | Remote (on a host you control) |
|---|---|---|
| Transcription | `VOICEFLOW_TRANSCRIPTION_MODE=local`, `LOCAL_ASR_ENGINE=whisperx\|nemo_canary` | `VOICEFLOW_TRANSCRIPTION_MODE=remote`, `VOICEFLOW_REMOTE_ENDPOINT` |
| Diarization | `LOCAL_DIARIZATION_ENGINE=pyannote\|nemo` | same remote endpoint — it's a black box, diarization is whatever you run behind it |
| TTS (Kokoro) | default — needs `requirements-ml.txt` | `VOICEFLOW_TTS_REMOTE_ENDPOINT` |

**What "remote" means precisely:** `VOICEFLOW_REMOTE_ENDPOINT` is a contract,
not a specific product. VoiceFlow POSTs to `{endpoint}/whisper` with
`{audio_b64, diarize, language?}` and expects back
`{text, language, segments, method, diarized}`. What actually runs behind
that URL — WhisperX, NeMo Canary, your own custom stack — is entirely up to
you. Same idea for `VOICEFLOW_TTS_REMOTE_ENDPOINT` → `{endpoint}/tts/kokoro`.

**Recommended defaults:**
- Render free tier / this project's actual deployment target → remote for
  anything heavy, or local WhisperX only (already lazy-loaded, CPU-friendly
  at `WHISPER_MODEL=base`). Never install `nemo_toolkit` on a 512MB host.
- A GPU box you own → local mode, all engines available.

---

## 6. STRATEGY.md compliance vs. drift

Cross-referenced against `global_docs/STRATEGY.md` §4 (VoiceFlow) and §4.10 (2026 stack upgrade).

| STRATEGY.md ask | Status |
|---|---|
| Multi-provider transcription router | ✅ Done — 6 providers + local/remote engine selection |
| Deepgram Nova-3, best diarization | ✅ Upgraded from nova-2 this session, diarize wired |
| AssemblyAI Universal-2 | ✅ Done |
| Multi-LLM per analysis type | ✅ Matches the spec exactly (`ANALYSIS_MODELS`) |
| Diarization fallback chain, honesty over fake success | ✅ pyannote → nemo → honest no-op; no engine here fabricates a result |
| Realtime voice agent bridged to agent tools | ✅ Done, generically (not hardcoded to AgentKit) |
| TTS: edge-tts + Kokoro + ElevenLabs + OpenAI tts-1-hd | ✅ All 4 implemented, Kokoro live-verified with real audio |
| NeMo Canary as "advanced" documented option | ✅ Implemented + gracefully degrades; **NeMo's own model execution is unverified** (no local install — see §7 below) |
| 50-meeting research benchmark artifact (§4.7) | 🟡 Partial — `eval/run_scenario_benchmark.py` gives the comparison infrastructure; no labeled 50-meeting dataset or downstream-accuracy grading yet |
| "Talk to your business analyst" demo | ✅ Functional plumbing done; **full live voice-session test not run** (would spend real API credits — flagged for you to trigger) |

**Known remaining drift:**
- `/benchmark` page hardcodes `eval/*.md` content as a JS string instead of fetching live — will silently go stale as those files change.
- ElevenLabs voice **cloning** (the actual differentiator STRATEGY.md names) isn't wired — only 2 fixed voice IDs.
- No UI for `provider=openai|kokoro` on `/tts` or `scenario=` on `/pipeline` yet — API-only.

---

## 7. What's unverified (be honest about this before relying on it)

Everything in this document has been either live-tested against real APIs
this session, or is explicitly flagged here as not:

- **NeMo Canary transcription** and **NeMo diarization's actual model
  execution** — the integration code is correct by construction (matches
  NeMo's documented API, and the RTTM-parsing/speaker-assignment logic
  *is* unit-verified with synthetic data), but `nemo_toolkit` was not
  installed locally (by your choice, to avoid multi-GB downloads on this
  machine) — so the actual `ClusteringDiarizer.diarize()` call and
  `EncDecMultiTaskModel.transcribe()` call have never run for real.
- **OpenAI tts-1-hd** and **OpenAI/Gemini realtime with agent tools live**
  — structurally correct, degrade-tested, but no `OPENAI_API_KEY` yet to
  fully exercise.
- Everything else (Groq/Deepgram-shape/AssemblyAI-shape transcription
  routing, Kokoro TTS, ElevenLabs TTS shape, scenario strict-mode, the
  Slack/n8n/Zapier relay, remote-delegation for both ASR and TTS, the
  AgentKit tool-discovery bridge, the SPA-fallback routing fix) was
  live-verified this session against real running processes.

---

## 8. Leveraging IntelAI / AgentKit / StreamPulse — without hardcoding, without breaking "standalone"

VoiceFlow's standalone requirement means: **it must work with zero knowledge
of any specific sibling project.** The only integration surfaces are the
generic contracts already built — `AGENT_TOOLS_URL` (discovery-based tool
calling) and `/integrations/relay` (arbitrary webhook push). Using a sibling
project to *test* VoiceFlow means pointing those generic surfaces at it —
never adding sibling-specific code to VoiceFlow itself.

### AgentKit — ready to use today
Already implements the exact discovery contract (`GET /api/tools` returning
`{name, description, endpoint, params}`, plain GET-with-query-params
execution). Point `AGENT_TOOLS_URL` at a running AgentKit instance and it
just works — verified live this session (discovered all 6 real tools,
executed a real call, zero AgentKit-specific code in VoiceFlow). This is the
cleanest test target for the realtime "talk to your business analyst" flow.

### IntelAI — not plug-compatible yet, here's exactly why
I checked: IntelAI has `GET /api/v1/agent/tools`, but it's a **different
shape** (`{persona, allowed_tools, implemented}` — a name whitelist, not
`{name, description, endpoint, params}`) and requires **JWT auth**
(`Depends(get_current_user)`), not the simple internal-token scheme
`agent_tools_bridge.py` expects. To use IntelAI as an `AGENT_TOOLS_URL`
target, IntelAI would need a *new*, separate endpoint that speaks the same
discovery contract AgentKit already does — that's a change to make on
IntelAI's side (staying standalone-compliant: it'd be IntelAI choosing to
implement a generic contract, not VoiceFlow special-casing IntelAI). Until
then, don't point `AGENT_TOOLS_URL` at IntelAI — it won't work.

### StreamPulse — usable via `/integrations/relay`, with one real caveat
StreamPulse has a genuine `connectors/webhook_receiver.py` with HMAC-SHA256
signature verification (`X-Signature-256` header, checked against
`WEBHOOK_SECRET`). This is **stricter** than a plain n8n/Zapier catch-hook —
VoiceFlow's relay currently sends an unsigned POST, which StreamPulse's
receiver would reject. To actually wire VoiceFlow → StreamPulse for testing:
either (a) give StreamPulse's receiver a "no signature required" mode for
this test, or (b) it's a reasonable follow-up to add HMAC signing as another
`target=` option in `relay_formatting.py`, symmetric to the Slack one — I
didn't build that unprompted since I don't know if you want VoiceFlow's
generic relay to grow signing logic for one specific sibling's auth scheme.
Ask if you want it.

StreamPulse also has its own `connectors/n8n.py` — worth knowing it exists,
but it's StreamPulse's *own* n8n integration for StreamPulse's own workflows,
unrelated to VoiceFlow's relay.

---

## 9. Leveraging your n8n service and your orchestrator

### n8n
Two independent directions, both already supported generically:

- **VoiceFlow → n8n** (push): point `/integrations/relay` at your n8n
  webhook/catch-hook URL. No special config needed — n8n accepts arbitrary
  JSON, so the raw analysis result (meeting notes, sales-call data, etc.)
  arrives as-is and you map fields in n8n's own UI. Set `target=n8n`
  explicitly if auto-detection (which only recognizes `hooks.slack.com` /
  `hooks.zapier.com` by hostname) doesn't apply to your self-hosted n8n URL.
- **n8n → VoiceFlow** (pull/orchestrate): use n8n's HTTP Request node to call
  `POST /pipeline` (with a `scenario=` for reproducible behavior) or any
  other endpoint directly — n8n becomes the orchestration layer around
  VoiceFlow, e.g. "on new file in this folder → call VoiceFlow → route the
  result based on `analysis_type`." Nothing VoiceFlow-specific needs
  building for this; it's a plain authenticated HTTP API from n8n's side
  (send `X-OmniIntel-Internal-Token` if `REQUIRE_INTERNAL_TOKEN=true`).

### Your orchestrator (remote GPU inference host)
This is exactly what `VOICEFLOW_REMOTE_ENDPOINT` (+`VOICEFLOW_REMOTE_TOKEN`)
and `VOICEFLOW_TTS_REMOTE_ENDPOINT` (+`VOICEFLOW_TTS_REMOTE_TOKEN`) are for.
To wire your real orchestrator in, it needs to implement:

```
POST {VOICEFLOW_REMOTE_ENDPOINT}/whisper
  Body:    {"audio_b64": "<base64>", "diarize": bool, "language"?: str}
  Headers: Authorization: Bearer <VOICEFLOW_REMOTE_TOKEN>  (if set)
  Returns: {"text": str, "language": str, "segments": [...], "diarized": bool}
```

```
POST {VOICEFLOW_TTS_REMOTE_ENDPOINT}/tts/kokoro
  Body:    {"text": str, "voice_gender": "default"|"male"|"female"}
  Headers: Authorization: Bearer <VOICEFLOW_TTS_REMOTE_TOKEN>  (if set)
  Returns: raw audio bytes
```

Both contracts were live-verified this session (against a local mock server
standing in for your real orchestrator) — request shape, headers, and
response handling all confirmed correct. Whatever you run behind those two
URLs — WhisperX, NeMo Canary, Kokoro, something custom — is entirely your
choice; VoiceFlow only knows the contract above, never the implementation.
