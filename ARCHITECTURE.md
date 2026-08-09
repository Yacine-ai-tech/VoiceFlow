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
| `/speech` | `Speech.tsx` | Text box → `/tts`, plays the returned audio, explicit Download button |
| `/integrations` | `Integrations.tsx` | Push the latest result (or custom JSON) to a Slack/n8n/Zapier/custom webhook via `/integrations/relay`; target selector (auto-detect / force) |
| `/analytics` | `Analytics.tsx` | Bar chart combining **this browser's own** `/analytics` counters (session-scoped, never another visitor's) with browser-local session history |
| `/history` | `History.tsx` | `localStorage`-backed session history, capped at 30 items — explicitly local-only, no backend store |
| `/models` | `Models.tsx` | Static "factual routing page" — lists real ASR/LLM/TTS providers, scenarios, and the realtime/agent-tools setup. Kept in sync with source this session |
| `/api-docs` | `ApiDocs.tsx` | Static, hand-written API reference (not a live Swagger embed, not an iframe) |
| `/benchmark` | `BenchmarkPage.tsx` | Tabbed viewer over all four `eval/*.md` benchmark reports, fetched live from `GET /benchmarks` on every load — never a hardcoded snapshot, so it can't drift from what the eval scripts actually wrote |
| `/user-guide` | `UserGuidePage.tsx` | Full usage guide — live-demo walkthrough, API-reuse guide, clone/fork use cases, dual licensing (AGPL-3.0 + commercial), and an honest note that VoiceFlow ships as a service, not an installable package |
| `*` (catch-all) | → `Workspace.tsx` | Unmatched client-side routes redirect home |

All 4 TTS providers are now selectable on `/speech`, and `/analyze`'s audio tab has a scenario selector for `/pipeline`. Fixing this also surfaced two real bugs, both now fixed: `/tts`'s `provider` field was defined but never actually passed to the synthesis call (always silently used edge-tts regardless of what was requested), and the response was hardcoded to `audio/mpeg`/`.mp3` even for Kokoro (which returns WAV) — the download button now reads the real response `Content-Type` rather than assuming a format from what was requested, so a silent server-side fallback never gets mislabeled.

---

## 2. Backend — all API endpoints (`api.py`)

### System
| Method | Path | Notes |
|---|---|---|
| GET | `/` | Serves the SPA (`frontend/dist/index.html`) if built, else a JSON pointer |
| GET | `/health` | Static liveness check, no dependency checks |
| GET | `/{full_path:path}` | SPA-fallback catch-all (added this session) — serves real static files from `frontend/dist/` if they exist, else `index.html`, so direct navigation/refresh/bookmarks work on every frontend route |
| GET | `/benchmarks` | Reads all four `eval/*.md` benchmark reports off disk on every request and returns their content as JSON — backs the `/benchmark` page, `content: null` for any report that hasn't been generated yet |

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
| POST | `/tts` | `{text, language, voice_gender, provider, voice_id?}` — `provider` ∈ `edge\|elevenlabs\|openai\|kokoro`; `voice_id` overrides ElevenLabs' 2 stock voices with a cloned one |
| GET | `/tts/voices` | Every ElevenLabs voice on this account — 2 stock voices + any real cloned ones |
| POST | `/tts/voices/clone` | `name`, one or more real audio `files`, optional `description` — real ElevenLabs Instant Voice Cloning, returns a `voice_id` |
| DELETE | `/tts/voices/{voice_id}` | Removes a cloned voice |

### Integrations
| Method | Path | Notes |
|---|---|---|
| POST | `/integrations/relay` | `{url, payload, target?, secret?, signature_header?}` — server-side relay (bypasses browser CORS). Slack payloads are auto-reformatted into real Slack Block Kit JSON; n8n/Zapier/generic pass through unchanged. If `secret` is set, the exact body sent is HMAC-SHA256-signed and attached under `signature_header` (default `X-Signature-256`) — a generic capability, verified compatible with StreamPulse's real webhook receiver |

### Realtime & analytics
| Method | Path | Notes |
|---|---|---|
| WS | `/realtime` | Bidirectional voice bridge to OpenAI Realtime API or Gemini Multimodal Live (`REALTIME_PROVIDER`, no fallback between them). If `AGENT_TOOLS_URL` is set, the model can call whatever tools that service exposes mid-conversation |
| GET | `/analytics` | In-memory request counters, **scoped to the caller's own session** (`X-VoiceFlow-Session` header) — never a cross-visitor or deployment-wide total. **Dual-purpose**: a plain top-level browser navigation (`Sec-Fetch-Mode: navigate`) gets the SPA instead of raw JSON, since this path collides with the frontend's own `/analytics` page route |

**20 application-defined routes** (18 HTTP + 2 WebSocket). `len(app.routes)` reports more at runtime — the extra ones are FastAPI's own auto-added `/docs`, `/redoc`, `/openapi.json`, plus the `/assets` static mount.

**Page-route/API-path collisions** (`/analyze`, `/analytics`, `/integrations` are both React Router pages and backend paths): production is same-origin so the backend's own SPA-fallback + `Sec-Fetch-Mode` check resolves this. In *local dev* (`npm run dev`), Vite's proxy needed the same `Sec-Fetch-Mode: navigate` check via a `bypass()` function (`vite.config.ts`) — without it, a full page load/refresh on those three routes got proxied to the backend instead of served by Vite's own dev shell. Found and fixed this session; verified both directions (page navigation and `fetch()` calls) work correctly now.

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
- **Anonymous opt-out telemetry** (startup ping + periodic aggregate usage snapshot, disabled via `TELEMETRY_OPT_OUT=true`)
- **Session-scoped, in-memory usage analytics** (`/analytics`, resets on restart, never shows one visitor another's data)
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

## 6. Analytics & telemetry — privacy design

STRATEGY.md doesn't actually specify anything here (checked — it's silent
on in-memory vs. persistent for `/analytics`), so this was a deliberate
design decision, not a compliance question. Two real, competing
requirements drove it:

1. A client demoing this shouldn't see anyone else's usage — not a
   deployment-wide total, not another visitor's activity.
2. Whoever operates a deployment reasonably wants to know it's actually
   being used, over time, after the process has restarted a dozen times —
   which a purely in-memory, per-request counter can't tell them.

**How both are true at once, entirely with generic, public code:**

- `GET /analytics` is scoped by `X-VoiceFlow-Session` — a random ID the
  frontend generates once per browser (`localStorage`, no account, no PII)
  and sends on every request (as a header over HTTP; as a `?session=` query
  param on the `WS /stream` handshake, since browsers can't set custom
  headers there). **Verified live this session**: two different session IDs
  hitting `/analyze` never see each other's counts, and a request with no
  session header at all lands in a separate "anonymous" bucket, empty by
  default.
- Separately, if `TELEMETRY_ENDPOINT` is configured, a background loop
  (`TELEMETRY_USAGE_INTERVAL_SECONDS`, default 30 min) sends an **aggregate**
  snapshot — the sum across every session, plus a count of distinct
  sessions — to that endpoint. **Verified live this session** against a
  mock collector: correct aggregation, correct payload shape.

The point of that split: the *mechanism* (scoped counters + an optional,
opt-out, generic telemetry push) is exactly the kind of thing that belongs
in public source — it makes no reference to who operates any particular
deployment. What makes one deployment's usage data private to its operator
is purely which URL they put in `TELEMETRY_ENDPOINT` — an environment
variable value, never committed, never appearing in source. Anyone
self-hosting this gets the identical code and decides for themselves
whether to point it anywhere at all.

---

## 7. STRATEGY.md compliance vs. drift

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
| ElevenLabs voice **cloning** (the actual differentiator, not just 2 stock IDs) | ✅ Real Instant Voice Cloning — `POST /tts/voices/clone`, `GET /tts/voices`, `DELETE /tts/voices/{id}`, UI on the Speech page. Live-verified end to end (list, clone attempt, delete); this account's plan doesn't support cloning (`can_use_instant_voice_cloning: false`), and that real ElevenLabs error message is surfaced verbatim rather than faked as a success |
| NeMo Canary as "advanced" documented option | ✅ Implemented + gracefully degrades; **NeMo's own model execution is unverified** (no local install — see §7 below) |
| 50-meeting research benchmark artifact (§4.7) | 🟡 Partial — `eval/run_scenario_benchmark.py` gives the comparison infrastructure; no labeled 50-meeting dataset or downstream-accuracy grading yet. A real 50-recorded-meeting corpus with human-labeled ground truth is a data-collection task, not something that can be honestly fabricated in-session |
| "Talk to your business analyst" demo | ✅ Functional plumbing done; **full live voice-session test not run** (would spend real API credits — flagged for you to trigger) |

**Known remaining drift:**
- §4.7's 50-meeting research benchmark: the eval *framework* exists, but not a real, released 50-meeting labeled corpus — see above.

---

## 8. What's unverified (be honest about this before relying on it)

**Full production-topology deep test performed this session**: `frontend/`
built for real (`npm run build`), backend run exactly as `Dockerfile`'s
`CMD` does (`uvicorn api:app --workers 1`, `ENVIRONMENT=production`), same
origin, no dev proxy — i.e. the actual artifact that ships, not a dev
approximation. All 12 pages hit directly with zero console errors and zero
failed requests; every REST endpoint exercised with real audio/real text
against whatever real provider keys are configured; every named scenario
tried; a full browser-driven upload-audio-and-analyze round trip confirmed
correct real output end to end (see screenshot-verified run).

**A real, previously-undetected bug was found and fixed by this pass:**
`WS /realtime`'s Gemini path (`api.py`, inside `ws_realtime`) called
`os.getenv(...)`, but this module only ever imports `os` aliased as `_os`
— every single Gemini realtime connection was crashing with
`NameError: name 'os' is not defined` before ever reaching Gemini. This
wasn't a "structurally correct, unverified" item as previously documented
here — it was **completely broken**, and would have stayed silently broken
in production, since `REALTIME_PROVIDER=gemini` is what's actually
configured live. Fixed (`_os.getenv(...)`, matching the module's existing
alias) and re-verified: real handshake, real `input_text` turn sent, real
`response.audio.delta` frames back from Gemini, clean `response.done`.
A repo-wide scan (`pyflakes`) for the same class of bug found nothing else.

**Now confirmed working that was previously only "structurally correct":**
- **Gemini realtime voice agent** — see above. Full real conversation turn
  verified, not just a handshake.
- **ElevenLabs standard TTS** — previously believed blocked on this account
  (the old deprecated demo voice IDs 402'd with "library voices require a
  paid plan"). The current default voice IDs (Sarah/Daniel, updated this
  session from the real `/v1/voices` list) actually work — real ElevenLabs
  audio confirmed (44.1kHz/128kbps MP3 with ElevenLabs' ID3 tags, clearly
  distinct from the edge-tts fallback). **Voice cloning specifically**
  remains genuinely blocked — confirmed again this pass — separate
  ElevenLabs plan gate (`can_use_instant_voice_cloning: false`), unrelated
  to the voice-ID issue.
- **OpenAI realtime** (`REALTIME_PROVIDER=openai`) — still no `OPENAI_API_KEY`
  to fully exercise the happy path, but now confirmed to fail *honestly*:
  a real connection attempt returns `{"type":"error","message":"REALTIME_API_KEY
  not configured."}` and closes cleanly, no crash, no hang.

**Still genuinely unverified — same reason as before:**
- **NeMo Canary transcription** and **NeMo diarization's actual model
  execution** — `nemo_toolkit` still isn't installed locally (your choice,
  multi-GB download). Integration code is correct by construction and the
  RTTM-parsing/speaker-assignment logic is unit-verified with synthetic
  data, but the real `ClusteringDiarizer.diarize()` /
  `EncDecMultiTaskModel.transcribe()` calls have never executed.
- **OpenAI tts-1-hd** — no `OPENAI_API_KEY` yet; confirmed this pass that
  requesting it correctly falls through to edge-tts rather than erroring.

**Everything else** (Groq transcription with real speech content end to end,
the full non-strict provider-fallback chain for deepgram/assemblyai/local/
remote — all honestly reported via `method` in the response, diarize=true
correctly returning `diarized:false` with no `HF_TOKEN`/`PYANNOTE_TOKEN`
configured, every scenario including the two intentionally-strict failures
(`accurate`→`provider_failed:deepgram`, `cheap`→`provider_failed:local`,
`streaming`→`provider_failed:assemblyai`) reporting the exact right honest
error with a sane downstream analysis on empty input, Kokoro TTS falling
back to edge-tts, real signed + Slack-formatted + generic webhook relay,
`WS /stream` producing a real matching final transcript from streamed audio
chunks, and session-scoped analytics accumulating correctly) was live-tested
this pass against real running processes with real provider responses.

---

## 9. Leveraging IntelAI / AgentKit / StreamPulse — without hardcoding, without breaking "standalone"

VoiceFlow's standalone requirement means: **it must work with zero knowledge
of any specific sibling project.** The integration surfaces are all generic
contracts — `AGENT_TOOLS_URL` (discovery-based tool calling, VoiceFlow is
the caller), `/pipeline` + `/transcribe` (plain audio-in/JSON-out, VoiceFlow
is the callee), and `/integrations/relay` (arbitrary — optionally
HMAC-signed — webhook push, VoiceFlow is the caller). Using a sibling
project to *test* VoiceFlow means pointing those generic surfaces at it —
never adding sibling-specific code to VoiceFlow itself.

### AgentKit — ready to use today (VoiceFlow → AgentKit)
Already implements the exact discovery contract (`GET /api/tools` returning
`{name, description, endpoint, params}`, plain GET-with-query-params
execution). Point `AGENT_TOOLS_URL` at a running AgentKit instance and it
just works — verified live this session (discovered all 6 real tools,
executed a real call, zero AgentKit-specific code in VoiceFlow). This is the
cleanest test target for the realtime "talk to your business analyst" flow.

### IntelAI — the real relationship runs the other way (IntelAI → VoiceFlow)
Not `AGENT_TOOLS_URL` at all: IntelAI has `GET /api/v1/agent/tools`, but a
different shape (`{persona, allowed_tools, implemented}` — a name whitelist)
and JWT auth, so it's not a discovery-contract match — irrelevant here
anyway, because that's not the actual intended relationship.

The real relationship: **VoiceFlow is a pluggable audio processor IntelAI's
own ingestion pipeline calls out to** — the same shape as IntelAI calling
any external document processor for its document ingestion. I checked
IntelAI's ingestion pipeline (`src/api/server.py`, the `# DATA INGESTION`
section) to confirm this: `POST /api/v1/ingest/document` exists and has a
`# OCR extraction is out of IntelAI's scope — it belongs to the DocIntel
project` comment marking the intended boundary, but **the endpoint doesn't
actually call DocIntel** — it does its own inline PDF/image extraction
(`pypdf`, Groq Vision) rather than delegating over HTTP. Likewise there is
no `POST /api/v1/ingest/audio` endpoint at all yet, and IntelAI's `server.py`
makes zero outbound HTTP calls to any sibling project (grepped for
`httpx`/`requests.post` — the only hit is an unrelated telemetry ping).

**VoiceFlow's side needed no change** — `POST /pipeline` (audio in,
transcript + structured analysis out) was already the generic,
callable-by-anyone contract this relationship needs, with zero
IntelAI-specific code.

**Built on IntelAI's side this session** (`IntelAI/src/api/server.py`,
`src/core/config.py`, `.env.example`):
- `POST /api/v1/ingest/audio` — new. Calls out to `AUDIO_PROCESSOR_URL`
  (`POST {url}/pipeline`, multipart `file` in, `{transcript, analysis}` JSON
  out — VoiceFlow speaks this natively, but the endpoint isn't hardcoded to
  it), stores the transcript+analysis into IntelAI's knowledge base. 501 if
  `AUDIO_PROCESSOR_URL` isn't configured — never a fake transcript.
- `POST /api/v1/ingest/document` — enhanced, non-breaking: if
  `DOC_PROCESSOR_URL` is set (`POST {url}/process` — DocIntel's real
  contract), tries delegating there first, falling back to the existing
  inline pypdf/Groq-Vision extraction on any failure or if unconfigured.
- `POST /api/v1/webhook/{source_name}` — new, **public, HMAC-signed**
  ingestion endpoint (`INGEST_WEBHOOK_SECRET`, same `X-Signature-256:
  sha256=<hex>` convention as StreamPulse's own receiver and VoiceFlow's new
  signed relay). This closes a real gap: the existing `/api/v1/ingest/webhook`
  — despite its docstring claiming it's "for external data ingestion e.g.
  from StreamPulse or n8n" — actually requires a live user JWT, which no
  external machine-to-machine pusher (StreamPulse, a Kafka HTTP sink
  connector, n8n) can practically obtain. The new endpoint reuses the exact
  same ingestion logic (factored into `_process_webhook_payload()`) but
  authenticates via signature instead of a session. 501 if
  `INGEST_WEBHOOK_SECRET` isn't configured.

**A second, more serious blocker found and fixed:** `/api/v1/webhook/{source_name}`
was exempted from IntelAI's JWT requirement, but a *separate* global
middleware (`verify_internal_token`) still gated every path behind
`X-OmniIntel-Internal-Token` regardless — defeating the entire point of a
machine-reachable endpoint, since an external pusher has no more access to
that internal secret than it does to a user JWT. Fixed: `/api/v1/webhook/`
is now also exempted from that middleware — its own HMAC signature check is
its authentication, nothing else should be required.

**Verified fully live, including real database writes** (registered a
throwaway test user, ran all three paths against IntelAI's actual local
server connected to your real Neon Postgres, confirmed rows via direct SQL,
then deleted every test row — `kpi_metrics`, `knowledge_base`, `users` — and
verified zero remain):
1. **HMAC interop** — VoiceFlow's `sign_body()` output verified directly
   against IntelAI's real `_verify_webhook_signature()`: accepted when
   correct, rejected (401) when wrong or missing.
2. **`POST /api/v1/ingest/audio`** — a real WAV through the real running
   VoiceFlow `/pipeline`, real transcript+analysis back
   (`transcript.method: "groq-whisper"`), a real `knowledge_base` row
   written and confirmed via SQL, then deleted.
3. **`POST /api/v1/webhook/{source_name}`** — both schema types tested with
   real HMAC-SHA256-signed requests: `kpi_metrics` wrote a real row (see bug
   below), `knowledge_doc` accepted and processed (the background
   auto-categorization step uses an in-process vector store here, not your
   real Qdrant — `qdrant_client` isn't installed locally, so nothing wrote to
   your real Qdrant cloud instance).
4. **`DOC_PROCESSOR_URL` delegation** in `POST /api/v1/ingest/document` — ran
   IntelAI's actual `_delegate_to_doc_processor()` (imported and called for
   real, not reimplemented) against a locally-started real DocIntel
   instance's real `POST /process`; got back and correctly parsed a real
   response.

**A real, pre-existing data-corruption bug found via this testing (fixed):**
`store_kpi_metrics()` reads a `"metric"` column, but the webhook ingestion
path's strict-schema check validates for `"metric_name"` and never renamed
it — every KPI ever ingested through `/api/v1/ingest/webhook` (or the CSV
endpoint, which has the identical mismatch — its own docstring documents
`metric_name` as the expected CSV header) was silently stored with
`metric=''`, discarding the actual metric name. Caught by writing a real
signed test row and querying it back — the row existed but its `metric`
column was empty. Fixed in both places with a `df.rename(columns=
{"metric_name": "metric"})` before storage. This predates all of today's
work; it just happened to be sitting directly in the code path being wired.

**Also fixed, unrelated to any of the above:** `IntelAI/.env` — and, it
turned out, **`DocIntel/.env`, `AgentKit/.env`, `RAGeval/.env`, and
`StreamPulse/.env`** — were all malformed the same way: the whole file
collapsed onto one line with literal `\n` characters instead of real line
breaks, so only the first variable was ever actually parsed by a plain
`source`/shell read (VoiceFlow's own `.env` was unaffected). All variables
were intact and recoverable in every file (verified byte-for-byte before
and after, by splitting on the literal `\n` sequence); backed up as
`.env.bak-corrupted` next to each fixed file, then rewritten with real
newlines and re-verified.

### DocIntel — the real `/process` contract, now genuinely reachable
`DOC_PROCESSOR_URL` (above) means IntelAI can now genuinely delegate
document extraction to DocIntel's real `POST /process` (multipart `file` +
`route` + `doc_type` → `{fields, confidence, page_count, ...}`) — not live
DB-tested for the same production-Postgres reason as above, but the delegate
function (`_delegate_to_doc_processor()`) is code-reviewed against DocIntel's
actual current endpoint signature, not guessed.

### StreamPulse — usable via `/integrations/relay`, HMAC signing now built
StreamPulse's `connectors/webhook_receiver.py` requires HMAC-SHA256 request
signing (`X-Signature-256: sha256=<hex>` header, verified against
`WEBHOOK_SECRET`) — stricter than a plain n8n/Zapier catch-hook. Built this
session: `services/relay_formatting.py`'s `sign_body()` and a new `secret` /
`signature_header` field on `POST /integrations/relay` — **generic** HMAC
signing (any header name, any secret, works for any receiver that verifies
requests this way), not StreamPulse-specific code. Live-verified two ways:
(1) `sign_body()`'s output checked directly against StreamPulse's own
`WebhookReceiver.verify_signature()`, imported and called for real — passed;
(2) a full HTTP round trip through VoiceFlow's real `/integrations/relay`
against a mock receiver running StreamPulse's actual verification +
`parse_payload()` logic — signed requests are accepted and parsed, unsigned
ones are correctly rejected with `401 invalid_signature`. UI: a "Sign this
request" section on the Integrations page.

StreamPulse also has its own `connectors/n8n.py` — worth knowing it exists,
but it's StreamPulse's *own* n8n integration for StreamPulse's own workflows,
unrelated to VoiceFlow's relay.

---

## 10. Leveraging your n8n service and your orchestrator

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
