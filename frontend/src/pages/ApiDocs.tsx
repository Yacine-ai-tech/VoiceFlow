import { useState } from "react";
import { Terminal, Copy, Check, Code2, Globe, Shield, Zap, BookOpen } from "lucide-react";

// Same resolution order as lib/api.ts's request client: an explicit VITE_API_BASE_URL
// (for split frontend/backend deployments) wins, otherwise fall back to the current
// origin (same-origin deployments, e.g. the Docker single-container setup) — so the
// copy-paste examples always match wherever this page is actually being served from,
// author's deployment or any self-hoster's, instead of a hardcoded URL.
const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");
const WS_BASE = BASE_URL.replace(/^http/, "ws");

type Endpoint = {
  method: "GET" | "POST" | "DELETE" | "WS";
  path: string;
  category: string;
  auth: "public" | "token";
  desc: string;
  reqLabel?: string;
  reqBody?: string;
  resLabel?: string;
  resBody?: string;
  note?: string;
};

const ENDPOINTS: Endpoint[] = [
  // ── System ──────────────────────────────────────────────────────────────
  {
    method: "GET", path: "/", category: "System", auth: "public",
    desc: "Serves the VoiceFlow web app (SPA index.html) when a built frontend bundle is present on the server; otherwise returns a small JSON pointer to /docs. Excluded from the OpenAPI schema.",
    resBody: `{"service":"voiceflow","docs":"/docs"}`,
    note: "Not gated by the internal-token check — always reachable.",
  },
  {
    method: "GET", path: "/health", category: "System", auth: "public",
    desc: "Liveness/readiness check used by the deployment platform's health check and the frontend's connection banner. Not subject to the per-IP rate limit, unlike every other endpoint.",
    resBody: `{"status":"ok","service":"voiceflow","version":"0.1.0"}`,
  },
  {
    method: "GET", path: "/analytics", category: "System", auth: "public",
    desc: "This visitor's own usage counters — never anyone else's, never a deployment-wide total. Scoped by the X-VoiceFlow-Session header (a random ID the frontend generates once per browser and keeps in localStorage; no account, no PII). Real, in-memory counters — not a database — reset on every server restart/redeploy.",
    resBody: `{
  "counters": {"analyze:meeting": 3, "pipeline": 1, "relay": 2},
  "total_analyses": 3,
  "stream_sessions": 0,
  "relays": 2,
  "by_mode": {"meeting": 3}
}`,
    note: "A caller that sends no X-VoiceFlow-Session header (direct curl/API use) shares one \"anonymous\" bucket. This path doubles as the Analytics page's own route — a real browser navigation here (refresh, typed URL) gets the app shell back instead of JSON; only fetch()/XHR calls get this JSON response (disambiguated server-side via the Sec-Fetch-Mode header).",
  },
  {
    method: "GET", path: "/scenarios", category: "System", auth: "public",
    desc: "Lists the named scenarios selectable via POST /pipeline's scenario field — each one pins an exact transcription provider, diarize flag, and analysis model with no fallback substitution, for reproducible benchmarking.",
    resBody: `{
  "fast":       {"description": "...", "transcription_provider": "groq", "diarize": false, "analysis_model_setting": "LLM_DEFAULT", "est_cost_per_min_usd": 0.0, "notes": "..."},
  "accurate":   {"description": "...", "transcription_provider": "deepgram", "diarize": true, "analysis_model_setting": "LLM_REASONING", "est_cost_per_min_usd": 0.0, "notes": "..."},
  "cheap":      {"description": "...", "transcription_provider": "local", "diarize": true, "analysis_model_setting": "LLM_DEFAULT", "est_cost_per_min_usd": 0.0, "notes": "..."},
  "streaming":  {"description": "...", "transcription_provider": "assemblyai", "diarize": true, "analysis_model_setting": "LLM_JUDGE", "est_cost_per_min_usd": 0.0, "notes": "..."},
  "research-compare": {"description": "benchmark-only — no fixed provider", "transcription_provider": "", "diarize": false, "analysis_model_setting": "LLM_DEFAULT", "est_cost_per_min_usd": 0.0, "notes": "..."}
}`,
    note: "See services/scenarios.py for the source of truth and eval/run_scenario_benchmark.py for the CLI harness that compares them head-to-head on the same audio file.",
  },

  // ── Transcription ───────────────────────────────────────────────────────
  {
    method: "POST", path: "/transcribe", category: "Transcription", auth: "token",
    desc: "Transcribe an uploaded audio file (mp3, wav, webm, m4a, ...). Runs through the same provider router as every other transcription endpoint.",
    reqLabel: "multipart/form-data",
    reqBody: `file:      <audio binary>                 required
provider:  local | remote | groq |
           deepgram | assemblyai            optional
           ("orchestrator" accepted as a
            compat alias for "remote";
            LOCAL_WHISPERX, GROQ_WHISPER,
            DEEPGRAM_NOVA2 etc. also accepted)
language:  "en" | "fr" | ... | "auto"        default "auto"
diarize:   true | false                      default false`,
    resBody: `{
  "text": "Hello, this is a test recording.",
  "language": "en",
  "segments": [{"start": 0.0, "end": 2.4, "text": "Hello, this is a test recording."}],
  "method": "whisperx",
  "diarized": false
}`,
    note: "Provider chain: if `provider` is omitted, the router uses local mode first when VOICEFLOW_TRANSCRIPTION_MODE=local (or no remote endpoint is configured); otherwise it walks the remote chain in ASR_PROVIDER order — remote → groq → deepgram → assemblyai — where \"remote\" means your own VOICEFLOW_REMOTE_ENDPOINT, a black-box HTTP contract, not a specific engine. If every provider in the chosen path fails, local transcription is tried once more as a last resort before returning {\"method\":\"error\",\"error\":\"all_providers_failed\"}. Local mode itself is engine-selectable via LOCAL_ASR_ENGINE (whisperx, the default, or nemo_canary — nvidia/canary-180m-flash, a research-grade alternative). `diarize` attaches real speaker labels — pyannote or NeMo's clustering diarizer depending on LOCAL_DIARIZATION_ENGINE — only when the engine and its credentials (HF_TOKEN/PYANNOTE_TOKEN for pyannote) are available; the transcript always comes back either way, `diarized` in the response tells you the truth about whether labels were actually attached, never a fabricated true.",
  },
  {
    method: "POST", path: "/transcribe-json", category: "Transcription", auth: "token",
    desc: "Same transcription pipeline as POST /transcribe, but for callers that can't do multipart uploads — audio is sent base64-encoded inside a JSON body instead of a file part.",
    reqLabel: "application/json",
    reqBody: `{
  "audio_b64": "<base64-encoded audio bytes>",
  "provider": "groq",
  "language": "en",
  "diarize": false
}`,
    resBody: `{
  "text": "Hello, this is a test recording.",
  "language": "en",
  "segments": [{"start": 0.0, "end": 2.4, "text": "..."}],
  "method": "groq-whisper",
  "diarized": false
}`,
  },

  // ── Text-to-Speech ──────────────────────────────────────────────────────
  {
    method: "POST", path: "/tts", category: "Text-to-Speech", auth: "token",
    desc: "Synthesize speech from text. Returns raw audio bytes, not JSON — Content-Type tells you the real format actually used.",
    reqLabel: "application/json",
    reqBody: `{
  "text": "Hello from VoiceFlow",
  "language": "en",
  "voice_gender": "female",
  "provider": "edge",   // edge | elevenlabs | openai | kokoro
  "voice_id": null       // ElevenLabs only — a cloned voice_id from POST /tts/voices/clone
}`,
    resLabel: "audio/mpeg or audio/wav (binary)",
    resBody: `<binary audio stream>
Content-Type: audio/wav              (kokoro, when it actually ran)
Content-Disposition: inline; filename="speech.wav"

Content-Type: audio/mpeg             (edge / elevenlabs / openai,
Content-Disposition: inline; filename="speech.mp3"    or any fallback)`,
    note: "Four providers: edge-tts (Microsoft Edge neural voices — the default, no API key needed, EN + FR), ElevenLabs (premium + real voice cloning, needs ELEVENLABS_API_KEY), OpenAI tts-1-hd (needs OPENAI_API_KEY), and Kokoro (open-source, self-hosted — runs locally or delegates to VOICEFLOW_TTS_REMOTE_ENDPOINT, no API key). Any provider failure — missing key, model not installed, remote unreachable, insufficient ElevenLabs plan — falls back to edge-tts automatically, never a hard error. Only Kokoro returns WAV; the response's real Content-Type is always the source of truth, since a requested provider can silently fall back — never assume the format from what you asked for. Edge voices: en-US-AriaNeural/GuyNeural (EN female/male), fr-FR-DeniseNeural/HenriNeural (FR female/male). 400 if text is blank, 501 if edge-tts isn't installed.",
  },
  {
    method: "GET", path: "/tts/voices", category: "Text-to-Speech", auth: "public",
    desc: "Every ElevenLabs voice on this account — the 2 stock voices /tts falls back to, plus any you've cloned via POST /tts/voices/clone.",
    resBody: `{
  "voices": [
    {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah - Mature, Reassuring, Confident", "category": "premade", "description": "..."},
    {"voice_id": "abc123...", "name": "My cloned voice", "category": "cloned", "description": ""}
  ]
}`,
    note: "If ELEVENLABS_API_KEY isn't configured, returns {\"voices\": [], \"error\": \"ELEVENLABS_API_KEY not configured\"} — an empty list is never silently confused with \"this account has no voices\".",
  },
  {
    method: "POST", path: "/tts/voices/clone", category: "Text-to-Speech", auth: "token",
    desc: "Real ElevenLabs Instant Voice Cloning — upload one or more real audio samples of a voice, get back a voice_id usable via /tts's voice_id field. This is the actual ElevenLabs differentiator, not just picking between 2 stock voices.",
    reqLabel: "multipart/form-data",
    reqBody: `name:         "My cloned voice"           required
files:        <one or more audio samples>  required
description:  "..."                        optional`,
    resBody: `{"voice_id": "abc123...", "name": "My cloned voice"}`,
    note: "Requires an ElevenLabs plan that supports Instant Voice Cloning (account-level: can_use_instant_voice_cloning). On a plan that doesn't, ElevenLabs' own error is surfaced verbatim as a 400 — e.g. \"Your subscription does not include instant voice cloning. Please upgrade your plan.\" — never faked as a success.",
  },
  {
    method: "DELETE", path: "/tts/voices/{voice_id}", category: "Text-to-Speech", auth: "token",
    desc: "Deletes a cloned voice.",
    resBody: `{"ok": true, "voice_id": "abc123..."}`,
  },

  // ── Analysis ────────────────────────────────────────────────────────────
  {
    method: "POST", path: "/analyze", category: "Analysis", auth: "token",
    desc: "Extract structured intelligence from a transcript via one of five analysis types, each routed to a specific LLM.",
    reqLabel: "application/json",
    reqBody: `{
  "text": "Team discussed the Q3 roadmap and agreed to ship the export feature by Friday...",
  "analysis_type": "meeting"
}`,
    resBody: `{
  "meeting_summary": "...",
  "duration_minutes": 32,
  "participants_mentioned": ["Alice", "Bob"],
  "decisions": ["Ship export feature by Friday"],
  "action_items": [{"owner": "Alice", "action": "Send proposal", "due": "2026-08-15", "priority": "high"}],
  "key_numbers": [],
  "open_questions": [],
  "next_steps": [],
  "sentiment": "positive",
  "topics_covered": ["roadmap", "export feature"]
}`,
    note: "analysis_type → model: meeting & general → LLM_DEFAULT (groq/openai/gpt-oss-120b); sales_call & interview → LLM_REASONING (anthropic/claude-sonnet-4-6); support_call → LLM_JUDGE (anthropic/claude-haiku-4-5). Each type returns a different JSON schema (sales_call adds objections/buying_signals/likelihood_to_close; support_call adds severity/escalation_needed; interview adds candidate_name/recommendation). Unrecognized types fall back to the \"general\" prompt/schema. Transcripts over 12,000 characters are truncated before analysis, and the response then includes \"truncated\": true and \"original_length\" so that's never silent. The LLM call itself is bounded (LLM_ANALYSIS_TIMEOUT_SECONDS, default 60s) — a slow/rate-limited provider returns {\"error\":\"analysis_timed_out_after_60s\"} instead of hanging. On other failure: {\"error\":\"litellm_not_installed\"} if the litellm package is missing, {\"error\":\"non_json_response\",\"raw\":...} if the model didn't return valid JSON.",
  },
  {
    method: "POST", path: "/analyze/custom", category: "Analysis", auth: "token",
    desc: "Extract a caller-defined schema instead of one of the five built-in types — you name the fields, VoiceFlow extracts them.",
    reqLabel: "application/json",
    reqBody: `{
  "text": "Customer called about a billing discrepancy on invoice #4021...",
  "fields": ["customer_name", "product", "issue_category"],
  "instructions": "Keep each value under 5 words"
}`,
    resBody: `{
  "customer_name": "...",
  "product": "...",
  "issue_category": "billing"
}`,
    note: "Always uses LLM_REASONING (anthropic/claude-sonnet-4-6), regardless of analysis_type conventions elsewhere. Returns exactly the requested keys (null for anything absent). 400 if fields is empty.",
  },

  // ── Composite Pipelines ─────────────────────────────────────────────────
  {
    method: "POST", path: "/pipeline", category: "Composite Pipelines", auth: "token",
    desc: "Transcribe + analyze in a single call — the most common integration path.",
    reqLabel: "multipart/form-data",
    reqBody: `file:            <audio binary>          required
analysis_type:   meeting | sales_call |
                 support_call | interview |
                 general                  default "meeting"
provider:        local | groq | ...       default "LOCAL_WHISPERX"
                 (ignored when scenario is set)
language:        "en" | ... | "auto"      default "auto"
scenario:        fast | accurate | cheap |
                 streaming                optional — see GET /scenarios`,
    resBody: `{
  "transcript": {"text": "...", "language": "en", "segments": [...], "method": "whisperx"},
  "analysis": {"meeting_summary": "...", "action_items": [...]},
  "analysis_type": "meeting",
  "scenario": null
}`,
    note: "When `scenario` is given, it overrides `provider` entirely and pins the exact transcription provider, diarize flag, and analysis model from services/scenarios.py, run in strict mode — a failure is reported honestly ({\"method\":\"error\",\"error\":\"provider_failed:...\"}) instead of silently substituting a different provider than the one the scenario promises. 400 unknown_scenario for an unrecognized name.",
  },
  {
    method: "POST", path: "/meeting/process", category: "Composite Pipelines", auth: "token",
    desc: "Convenience endpoint hard-wired to the meeting analysis type — transcribe + meeting-notes extraction. Uses the default transcription provider chain (no provider param).",
    reqLabel: "multipart/form-data",
    reqBody: `file: <audio binary>   required`,
    resBody: `{
  "transcript": {"text": "...", "language": "en", "segments": [...]},
  "meeting_notes": {"meeting_summary": "...", "action_items": [...], "decisions": [...]}
}`,
  },
  {
    method: "POST", path: "/call/analyze", category: "Composite Pipelines", auth: "token",
    desc: "Convenience endpoint for phone/call recordings — transcribe + call analysis, with call_type selecting the analysis schema (reuses the /analyze prompts, e.g. sales_call or support_call).",
    reqLabel: "multipart/form-data",
    reqBody: `file:       <audio binary>              required
call_type:  sales_call | support_call |
            meeting | interview | general  default "sales_call"`,
    resBody: `{
  "transcript": {"text": "...", "language": "en", "segments": [...]},
  "call_analysis": {"call_summary": "...", "objections": [...], "likelihood_to_close": 0.6},
  "call_type": "sales_call"
}`,
  },

  // ── Integrations ────────────────────────────────────────────────────────
  {
    method: "POST", path: "/integrations/relay", category: "Integrations", auth: "token",
    desc: "Posts structured VoiceFlow output (an analysis, a transcript, anything) to any external webhook — Slack, Zapier, n8n, a signature-verified receiver of your own, or any other endpoint. Exists because a browser can't POST cross-origin to arbitrary third-party URLs; the server does it on the client's behalf.",
    reqLabel: "application/json",
    reqBody: `{
  "url": "https://hooks.slack.com/services/T000/B000/XXXX",
  "payload": {"text": "New meeting analyzed: 3 action items, ships Friday"},
  "target": null,            // "slack" | "zapier" | "n8n" | "generic" — auto-detected from url if omitted
  "secret": null,             // if set, HMAC-SHA256-signs the exact body sent
  "signature_header": null    // header name for the signature; default "X-Signature-256"
}`,
    resBody: `{"ok": true, "status": 200, "response": "ok", "target": "slack", "signed": false}`,
    note: "url must start with http:// or https:// and resolve to a public address (400 invalid_url / url_not_allowed otherwise — private/loopback/link-local destinations are rejected). target is auto-detected from the URL's hostname when omitted (hooks.slack.com → slack, hooks.zapier.com → zapier), defaulting to generic. Only the slack target reformats the payload — into real Slack Block Kit JSON built from whatever shape you sent (see services/relay_formatting.py); n8n/zapier/generic payloads are posted through byte-for-byte unchanged, since those accept arbitrary JSON. If secret is set, the body is HMAC-SHA256-signed and attached under signature_header (default X-Signature-256, value sha256=<hex>) — a generic capability for any receiver that verifies requests this way. 502 relay_failed if the target endpoint errors or is unreachable. response is the target's response body, truncated to 500 characters.",
  },

  // ── Real-time ───────────────────────────────────────────────────────────
  {
    method: "WS", path: "/stream", category: "Real-time", auth: "token",
    desc: "Streaming transcription over a WebSocket — the browser sends binary audio chunks as they're recorded and gets partial transcripts back before the recording is even finished.",
    reqLabel: "Message protocol",
    reqBody: `→ connect                                     (?token=... required only if
                                                REQUIRE_INTERNAL_TOKEN=true)
← {"type":"ready","provider":"...","message":"..."}
→ <binary audio chunk>                        (repeat while recording)
← {"type":"partial","text":"...","seq":N,"bytes":N}   (periodically, once buffer > 8KB)
→ {"type":"config","provider":"groq"}         (optional — set provider mid-session)
← {"type":"ack","provider":"groq"}
→ {"type":"stop"}
← {"type":"final","text":"...","bytes":N,"language":"en"}
← {"type":"ping","timestamp":"..."}           (every 30s of silence, keepalive)`,
    resLabel: "",
    resBody: "",
    note: "Re-transcribes the accumulated buffer roughly every 3rd chunk once it exceeds 8000 bytes, so \"partial\" results are re-runs of the whole buffer-so-far, not true incremental diffs. Works with whichever STT provider the server is configured for (or whatever `config` sets). Subject to the same connection rate limit as /realtime, and to the token gate via ?token= when REQUIRE_INTERNAL_TOKEN=true — a rejected connection is closed before being accepted, never silently half-open.",
  },
  {
    method: "WS", path: "/realtime", category: "Real-time", auth: "token",
    desc: "The bidirectional voice-agent bridge — real-time, low-latency, speech-in/speech-out conversation with an LLM. This is what the Voice Agent page in the app connects to.",
    reqLabel: "Provider selection (server-side, env-driven — strict, no auto-fallback)",
    reqBody: `REALTIME_PROVIDER = "openai" (default) | "gemini"   — a hard choice, not auto-detected
REALTIME_API_KEY   = OPENAI_API_KEY  when REALTIME_PROVIDER=openai
                    = GEMINI_API_KEY  when REALTIME_PROVIDER=gemini

If the key for the SELECTED provider is missing, the socket sends
  {"type":"error","message":"REALTIME_API_KEY not configured."}
and closes. It does NOT fall back to the other provider even if that
other provider's key happens to be set — e.g. REALTIME_PROVIDER=openai
with only GEMINI_API_KEY configured reports "not configured", it never
silently uses Gemini instead.`,
    resLabel: "",
    resBody: `openai path:
  Raw WebSocket relay to
    wss://api.openai.com/v1/realtime?model=<OPENAI_REALTIME_MODEL>
    (OPENAI_REALTIME_MODEL default: "gpt-4o-realtime-preview")
  OpenAI Realtime API JSON frames are passed through verbatim in both
  directions. A client "client.speech_started" event is intercepted
  server-side and turned into an upstream "response.cancel" (barge-in).

gemini path:
  google-genai SDK, api_version="v1beta", model
    "models/gemini-3.1-flash-live-preview"
    (override via GEMINI_LIVE_MODEL env var)
  voice: "Zephyr", response_modalities: ["AUDIO"]
  → {"type":"input_audio_buffer.append","audio":"<base64 PCM16 @24kHz>"}
      (server downsamples 24kHz→16kHz before forwarding to Gemini)
  → {"type":"input_audio_buffer.commit"}       (end of turn)
  → {"type":"conversation.item.create","item":{...}}   (text turn)
  → {"type":"client.speech_started"}           (barge-in / cancel)
  ← {"type":"response.audio.delta","delta":"<base64 PCM>"}
  ← {"type":"response.audio_transcript.delta","delta":"..."}
  ← {"type":"response.done"}
  All input frames are dropped while a Gemini tool call is in flight
  (is_tool_active gate) — the model has to finish "speaking" first.`,
    note: "Connect with ?token=<VOICEFLOW_INTERNAL_TOKEN> if the deployment sets REQUIRE_INTERNAL_TOKEN=true (browsers can't set custom headers on a WebSocket handshake, so it travels as a query param) — a missing/wrong token closes the connection before it's ever accepted, so no provider call happens. Also subject to a per-IP connection-rate limit regardless of that setting. Practically: click record in the Voice Agent page, talk, the agent replies with audio in real time using whichever provider the deployment is configured for.",
  },
];

const CATEGORIES = [
  "System", "Transcription", "Text-to-Speech", "Analysis",
  "Composite Pipelines", "Integrations", "Real-time",
];

function methodColor(m: string) {
  if (m === "GET") return { bg: "rgba(56,189,248,0.15)", fg: "#38bdf8" };
  if (m === "WS") return { bg: "rgba(74,222,128,0.15)", fg: "#4ade80" };
  if (m === "DELETE") return { bg: "rgba(248,113,113,0.15)", fg: "#f87171" };
  return { bg: "rgba(167,139,250,0.15)", fg: "#a78bfa" };
}

function curlSnippet(ep: Endpoint): string {
  if (ep.method === "WS") {
    return `# WebSocket endpoint — use wscat, websocat, or a WS client library\n# add ?token=$VOICEFLOW_TOKEN only if the server has REQUIRE_INTERNAL_TOKEN=true\nwscat -c "${WS_BASE}${ep.path}"`;
  }
  if (ep.method === "GET") {
    return `curl "${BASE_URL}${ep.path}"  # GET requests are always public, no token needed`;
  }
  if (ep.method === "DELETE") {
    return `curl -X DELETE "${BASE_URL}${ep.path.replace("{voice_id}", "abc123")}" \\\n  -H "X-VoiceFlow-Internal-Token: $VOICEFLOW_TOKEN"`;
  }
  if (ep.path === "/tts/voices/clone") {
    return `curl -X POST "${BASE_URL}${ep.path}" \\\n  -H "X-VoiceFlow-Internal-Token: $VOICEFLOW_TOKEN" \\\n  -F "name=My cloned voice" \\\n  -F "files=@voice_sample.wav"`;
  }
  if (ep.reqLabel === "multipart/form-data") {
    const fileField = ep.path === "/tts" ? "" : `  -F "file=@recording.wav" \\\n`;
    return `curl -X POST "${BASE_URL}${ep.path}" \\\n  -H "X-VoiceFlow-Internal-Token: $VOICEFLOW_TOKEN" \\\n${fileField}  -F "analysis_type=meeting"`;
  }
  const body = ep.reqBody?.trim().startsWith("{") ? ep.reqBody : "{}";
  return `curl -X POST "${BASE_URL}${ep.path}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-VoiceFlow-Internal-Token: $VOICEFLOW_TOKEN" \\\n  -d '${body}'${ep.path === "/tts" ? " \\\n  --output speech.mp3" : ""}`;
}

function pythonSnippet(ep: Endpoint): string {
  if (ep.method === "WS") {
    return `import asyncio, websockets\n\n# append "?token=" + VOICEFLOW_TOKEN to the URL only if the server has\n# REQUIRE_INTERNAL_TOKEN=true\nasync def main():\n    async with websockets.connect("${WS_BASE}${ep.path}") as ws:\n        print(await ws.recv())  # {"type":"ready", ...}\n        # send binary audio chunks / JSON control messages per the protocol above\n\nasyncio.run(main())`;
  }
  if (ep.method === "GET") {
    return `import requests\n\n# GET requests are always public, no token needed\nresp = requests.get("${BASE_URL}${ep.path}")\nprint(resp.json())`;
  }
  if (ep.method === "DELETE") {
    return `import requests\n\nresp = requests.delete(\n    "${BASE_URL}${ep.path.replace("{voice_id}", "abc123")}",\n    headers={"X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN},\n)\nprint(resp.json())`;
  }
  if (ep.path === "/tts/voices/clone") {
    return `import requests\n\nwith open("voice_sample.wav", "rb") as f:\n    resp = requests.post(\n        "${BASE_URL}${ep.path}",\n        files={"files": f},\n        data={"name": "My cloned voice"},\n        headers={"X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN},\n    )\nprint(resp.json())  # {"voice_id": "...", "name": "..."}`;
  }
  if (ep.reqLabel === "multipart/form-data") {
    const extra = ep.path === "/pipeline"
      ? `, "analysis_type": "meeting", "provider": "groq"`
      : ep.path === "/call/analyze" ? `, "call_type": "sales_call"` : "";
    return `import requests\n\nwith open("recording.wav", "rb") as f:\n    resp = requests.post(\n        "${BASE_URL}${ep.path}",\n        files={"file": f},\n        data={"language": "auto"${extra}},\n        headers={"X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN},\n    )\nprint(resp.json())`;
  }
  const outputHandling = ep.path === "/tts"
    ? `with open("speech.mp3", "wb") as f:\n    f.write(resp.content)`
    : `print(resp.json())`;
  return `import requests\n\nresp = requests.post(\n    "${BASE_URL}${ep.path}",\n    json=${ep.reqBody?.trim().startsWith("{") ? ep.reqBody : "{}"},\n    headers={"X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN},\n)\n${outputHandling}`;
}

function nodeSnippet(ep: Endpoint): string {
  if (ep.method === "WS") {
    return `// append "?token=" + VOICEFLOW_TOKEN to the URL only if the server has\n// REQUIRE_INTERNAL_TOKEN=true\nconst ws = new WebSocket("${WS_BASE}${ep.path}");\nws.onmessage = (e) => console.log(JSON.parse(e.data));\n// ws.send(<ArrayBuffer of audio>) / ws.send(JSON.stringify({...}))`;
  }
  if (ep.method === "GET") {
    return `// GET requests are always public, no token needed\nconst res = await fetch("${BASE_URL}${ep.path}");\nconst data = await res.json();`;
  }
  if (ep.method === "DELETE") {
    return `const res = await fetch("${BASE_URL}${ep.path.replace("{voice_id}", "abc123")}", {\n  method: "DELETE",\n  headers: { "X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN },\n});\nconst data = await res.json();`;
  }
  if (ep.path === "/tts/voices/clone") {
    return `const fd = new FormData();\nfd.append("name", "My cloned voice");\nfd.append("files", audioBlob, "voice_sample.wav");\n\nconst res = await fetch("${BASE_URL}${ep.path}", {\n  method: "POST",\n  headers: { "X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN },\n  body: fd,\n});\nconst { voice_id } = await res.json();`;
  }
  if (ep.reqLabel === "multipart/form-data") {
    return `const fd = new FormData();\nfd.append("file", audioBlob, "recording.wav");\nfd.append("analysis_type", "meeting");\n\nconst res = await fetch("${BASE_URL}${ep.path}", {\n  method: "POST",\n  headers: { "X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN },\n  body: fd,\n});\nconst data = await res.json();`;
  }
  const body = ep.reqBody?.trim().startsWith("{") ? ep.reqBody : "{}";
  return `const res = await fetch("${BASE_URL}${ep.path}", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    "X-VoiceFlow-Internal-Token": VOICEFLOW_TOKEN,\n  },\n  body: JSON.stringify(${body}),\n});\n${ep.path === "/tts" ? "const audioBlob = await res.blob();" : "const data = await res.json();"}`;
}

const SNIPPETS: Record<string, (ep: Endpoint) => string> = {
  curl: curlSnippet, python: pythonSnippet, node: nodeSnippet,
};

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      style={{ background: "none", border: "none", cursor: "pointer", color: copied ? "#4ade80" : "#94a3b8", padding: 4 }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div style={{ position: "relative", background: "rgba(0,0,0,0.4)", borderRadius: 8, padding: "14px 40px 14px 14px", fontFamily: "monospace", fontSize: "0.78rem", color: "#e2e8f0", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6 }}>
      <div style={{ position: "absolute", top: 8, right: 8 }}><CopyBtn text={code} /></div>
      {code}
    </div>
  );
}

export default function ApiDocs() {
  const [lang, setLang] = useState("curl");
  const [active, setActive] = useState(0);
  const ep = ENDPOINTS[active];
  const mc = methodColor(ep.method);

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1100, color: "#e2e8f0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <Terminal size={28} color="#4ade80" />
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>VoiceFlow API Reference</h1>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>
            Speech transcription, TTS (with real voice cloning), LLM-powered call/meeting analysis, signed webhook relay, and real-time voice agent — 18 endpoints.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, margin: "20px 0" }}>
        {[
          { icon: Globe, label: "Base URL", value: BASE_URL, color: "#38bdf8" },
          { icon: Shield, label: "Auth", value: "X-VoiceFlow-Internal-Token", color: "#4ade80" },
          { icon: Zap, label: "Format", value: "REST / JSON + 2 WebSockets", color: "#f59e0b" },
          { icon: BookOpen, label: "Docs", value: "OpenAPI at /docs", color: "#a78bfa" },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 16px", display: "flex", gap: 10, alignItems: "center" }}>
            <Icon size={18} color={color} />
            <div><div style={{ fontSize: "0.7rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div><div style={{ fontSize: "0.85rem", fontWeight: 600, wordBreak: "break-all" }}>{value}</div></div>
          </div>
        ))}
      </div>

      <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: "0.78rem", color: "#94a3b8" }}>
        Every GET request — page navigation, health checks, analytics, the scenario list — skips the token check. POST endpoints and both WebSocket routes (<code>WS /stream</code>, <code>WS /realtime</code>) are gated behind a shared secret only when the server sets <code>REQUIRE_INTERNAL_TOKEN=true</code> (off by default) — HTTP callers send <code>X-VoiceFlow-Internal-Token</code>, WebSocket callers send <code>?token=</code> since a handshake can't carry a custom header. Independent of that flag, every non-static request (GET included) is also subject to a per-IP rate limit.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {CATEGORIES.map((cat) => (
            <div key={cat}>
              <div style={{ fontSize: "0.68rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{cat}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {ENDPOINTS.map((e, i) => e.category === cat && (
                  <button
                    key={i}
                    onClick={() => setActive(i)}
                    style={{
                      textAlign: "left",
                      background: active === i ? "rgba(124,58,237,0.15)" : "rgba(255,255,255,0.03)",
                      border: active === i ? "1px solid rgba(124,58,237,0.4)" : "1px solid rgba(255,255,255,0.07)",
                      borderRadius: 8, padding: "10px 14px", cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: "0.68rem", fontWeight: 700, fontFamily: "monospace", background: methodColor(e.method).bg, color: methodColor(e.method).fg, borderRadius: 4, padding: "2px 6px", marginRight: 8 }}>{e.method}</span>
                    <span style={{ fontSize: "0.8rem", fontFamily: "monospace", color: active === i ? "#e2e8f0" : "#94a3b8" }}>{e.path}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.75rem", fontWeight: 700, fontFamily: "monospace", background: mc.bg, color: mc.fg, borderRadius: 5, padding: "3px 8px" }}>{ep.method}</span>
              <code style={{ fontSize: "0.9rem" }}>{ep.method === "WS" ? WS_BASE : BASE_URL}{ep.path}</code>
              <span style={{ fontSize: "0.68rem", color: ep.auth === "public" ? "#4ade80" : "#f59e0b", background: ep.auth === "public" ? "rgba(74,222,128,0.1)" : "rgba(245,158,11,0.1)", borderRadius: 4, padding: "2px 8px" }}>
                {ep.auth === "public" ? "always public" : "token-gated (if enabled)"}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>{ep.desc}</p>
          </div>

          {ep.reqBody && (
            <div>
              <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <Code2 size={13} /> {ep.reqLabel || "Request body"}
              </div>
              <CodeBlock code={ep.reqBody} />
            </div>
          )}

          {ep.resBody && (
            <div>
              <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <Check size={13} color="#4ade80" /> {ep.resLabel || "Sample response"}
              </div>
              <CodeBlock code={ep.resBody} />
            </div>
          )}

          {ep.note && (
            <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "12px 16px", fontSize: "0.78rem", color: "#cbd5e1", lineHeight: 1.6 }}>
              {ep.note}
            </div>
          )}

          <div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
              <span style={{ fontSize: "0.75rem", color: "#64748b", marginRight: 4 }}>Language:</span>
              {["curl", "python", "node"].map((l) => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  style={{
                    padding: "4px 12px", borderRadius: 6, border: "1px solid",
                    borderColor: lang === l ? "#7c3aed" : "rgba(255,255,255,0.1)",
                    background: lang === l ? "rgba(124,58,237,0.2)" : "transparent",
                    color: lang === l ? "#c4b5fd" : "#94a3b8", cursor: "pointer", fontSize: "0.78rem", fontWeight: 600,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <CodeBlock code={SNIPPETS[lang](ep)} />
          </div>
        </div>
      </div>
    </div>
  );
}
