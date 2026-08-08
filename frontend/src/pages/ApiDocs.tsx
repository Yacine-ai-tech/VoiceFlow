import { useState } from "react";
import { Terminal, Copy, Check, Code2, Globe, Shield, Zap, BookOpen } from "lucide-react";

// Real production gateway path for this service (frontend/.env.production).
const BASE_URL = "https://gateway.ysiddo-ai-projects.app/voiceflow";
const WS_BASE = BASE_URL.replace(/^http/, "ws");

type Endpoint = {
  method: "GET" | "POST" | "WS";
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
    desc: "Liveness/readiness check used by the Render health check and the frontend's connection banner.",
    resBody: `{"status":"ok","service":"voiceflow","version":"0.1.0"}`,
  },
  {
    method: "GET", path: "/analytics", category: "System", auth: "token",
    desc: "Real, process-local usage counters (not a database) — how many times each analysis type, /pipeline call, relay, and stream session has run since the server process last started. Resets on every restart/redeploy.",
    resBody: `{
  "counters": {"analyze:meeting": 3, "pipeline": 1, "relay": 2},
  "total_analyses": 3,
  "stream_sessions": 0,
  "relays": 2,
  "by_mode": {"meeting": 3}
}`,
  },

  // ── Transcription ───────────────────────────────────────────────────────
  {
    method: "POST", path: "/transcribe", category: "Transcription", auth: "token",
    desc: "Transcribe an uploaded audio file (mp3, wav, webm, m4a, ...). Runs through the same provider router as every other transcription endpoint.",
    reqLabel: "multipart/form-data",
    reqBody: `file:      <audio binary>                 required
provider:  local | orchestrator | groq |
           deepgram | assemblyai            optional
           (aliases accepted, case-insensitive:
            LOCAL_WHISPERX, GROQ_WHISPER,
            DEEPGRAM_NOVA2 ...)
language:  "en" | "fr" | ... | "auto"        default "auto"
diarize:   true | false                      default false`,
    resBody: `{
  "text": "Hello, this is a test recording.",
  "language": "en",
  "segments": [{"start": 0.0, "end": 2.4, "text": "Hello, this is a test recording."}],
  "method": "whisperx",
  "diarized": false
}`,
    note: "Provider chain: if `provider` is omitted, the router uses local WhisperX first when it's installed and no remote endpoint is configured (VOICEFLOW_TRANSCRIPTION_MODE / TRANSCRIPTION_PROVIDER default \"LOCAL_WHISPERX\"); otherwise it walks the remote chain in ASR_PROVIDER order — orchestrator → groq → deepgram → assemblyai. If every provider in the chosen path fails, local WhisperX is tried once more as a last resort before returning {\"method\":\"error\",\"error\":\"all_providers_failed\"}. `diarize` attaches pyannote speaker labels via local WhisperX only when HF_TOKEN/PYANNOTE_TOKEN is configured — the transcript always comes back either way, `diarized` in the response tells you the truth about whether labels were actually attached.",
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
    desc: "Synthesize speech from text. Returns raw audio/mpeg (MP3) bytes, not JSON.",
    reqLabel: "application/json",
    reqBody: `{
  "text": "Hello from VoiceFlow",
  "language": "en",
  "voice_gender": "female",
  "provider": "edge"
}`,
    resLabel: "audio/mpeg (binary)",
    resBody: `<binary MP3 stream>
Content-Disposition: inline; filename="speech.mp3"`,
    note: "Only two TTS providers are actually wired up: edge-tts (Microsoft Edge neural voices — the default, no API key needed, EN + FR) and ElevenLabs (premium, requires ELEVENLABS_API_KEY; used only when provider=\"elevenlabs\" AND the key is set). ElevenLabs failures — or a missing key while provider=\"elevenlabs\" is requested — fall back to edge-tts automatically, never a hard error. There is no Kokoro or OpenAI TTS integration in this service. Voices: en-US-AriaNeural/GuyNeural (EN female/male), fr-FR-DeniseNeural/HenriNeural (FR female/male). 400 if text is blank, 501 if edge-tts isn't installed.",
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
    note: "analysis_type → model: meeting & general → LLM_DEFAULT (groq/llama-3.3-70b-versatile); sales_call & interview → LLM_REASONING (anthropic/claude-sonnet-4-6); support_call → LLM_JUDGE (anthropic/claude-haiku-4-5). Each type returns a different JSON schema (sales_call adds objections/buying_signals/likelihood_to_close; support_call adds severity/escalation_needed; interview adds candidate_name/recommendation). Unrecognized types fall back to the \"general\" prompt/schema. On failure: {\"error\":\"litellm_not_installed\"} if the litellm package is missing, {\"error\":\"non_json_response\",\"raw\":...} if the model didn't return valid JSON.",
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
language:        "en" | ... | "auto"      default "auto"`,
    resBody: `{
  "transcript": {"text": "...", "language": "en", "segments": [...], "method": "whisperx"},
  "analysis": {"meeting_summary": "...", "action_items": [...]},
  "analysis_type": "meeting"
}`,
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
    desc: "Posts structured VoiceFlow output (an analysis, a transcript, anything) to any external webhook — Slack, Zapier, n8n, or your own endpoint. Exists because a browser can't POST cross-origin to arbitrary third-party URLs; the server does it on the client's behalf.",
    reqLabel: "application/json",
    reqBody: `{
  "url": "https://hooks.slack.com/services/T000/B000/XXXX",
  "payload": {"text": "New meeting analyzed: 3 action items, ships Friday"}
}`,
    resBody: `{"ok": true, "status": 200, "response": "ok"}`,
    note: "url must start with http:// or https:// (400 invalid_url otherwise). 502 relay_failed if the target endpoint errors or is unreachable. response is the target's response body, truncated to 500 characters.",
  },

  // ── Real-time ───────────────────────────────────────────────────────────
  {
    method: "WS", path: "/stream", category: "Real-time", auth: "public",
    desc: "Streaming transcription over a WebSocket — the browser sends binary audio chunks as they're recorded and gets partial transcripts back before the recording is even finished.",
    reqLabel: "Message protocol",
    reqBody: `→ connect                                     (no query params)
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
    note: "Re-transcribes the accumulated buffer roughly every 3rd chunk once it exceeds 8000 bytes, so \"partial\" results are re-runs of the whole buffer-so-far, not true incremental diffs. Works with whichever STT provider the server is configured for (or whatever `config` sets). Not gated by the internal-token check.",
  },
  {
    method: "WS", path: "/realtime", category: "Real-time", auth: "public",
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
    note: "Not gated by the internal-token check. Practically: click record in the Voice Agent page, talk, the agent replies with audio in real time using whichever provider the deployment is configured for.",
  },
];

const CATEGORIES = [
  "System", "Transcription", "Text-to-Speech", "Analysis",
  "Composite Pipelines", "Integrations", "Real-time",
];

function methodColor(m: string) {
  if (m === "GET") return { bg: "rgba(56,189,248,0.15)", fg: "#38bdf8" };
  if (m === "WS") return { bg: "rgba(74,222,128,0.15)", fg: "#4ade80" };
  return { bg: "rgba(167,139,250,0.15)", fg: "#a78bfa" };
}

function curlSnippet(ep: Endpoint): string {
  if (ep.method === "WS") {
    return `# WebSocket endpoint — use wscat, websocat, or a WS client library\nwscat -c "${WS_BASE}${ep.path}"`;
  }
  if (ep.method === "GET") {
    return `curl "${BASE_URL}${ep.path}" \\\n  -H "X-OmniIntel-Internal-Token: $VOICEFLOW_TOKEN"`;
  }
  if (ep.reqLabel === "multipart/form-data") {
    const fileField = ep.path === "/tts" ? "" : `  -F "file=@recording.wav" \\\n`;
    return `curl -X POST "${BASE_URL}${ep.path}" \\\n  -H "X-OmniIntel-Internal-Token: $VOICEFLOW_TOKEN" \\\n${fileField}  -F "analysis_type=meeting"`;
  }
  const body = ep.reqBody?.trim().startsWith("{") ? ep.reqBody : "{}";
  return `curl -X POST "${BASE_URL}${ep.path}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-OmniIntel-Internal-Token: $VOICEFLOW_TOKEN" \\\n  -d '${body}'${ep.path === "/tts" ? " \\\n  --output speech.mp3" : ""}`;
}

function pythonSnippet(ep: Endpoint): string {
  if (ep.method === "WS") {
    return `import asyncio, websockets\n\nasync def main():\n    async with websockets.connect("${WS_BASE}${ep.path}") as ws:\n        print(await ws.recv())  # {"type":"ready", ...}\n        # send binary audio chunks / JSON control messages per the protocol above\n\nasyncio.run(main())`;
  }
  if (ep.method === "GET") {
    return `import requests\n\nresp = requests.get(\n    "${BASE_URL}${ep.path}",\n    headers={"X-OmniIntel-Internal-Token": VOICEFLOW_TOKEN},\n)\nprint(resp.json())`;
  }
  if (ep.reqLabel === "multipart/form-data") {
    const extra = ep.path === "/pipeline"
      ? `, "analysis_type": "meeting", "provider": "groq"`
      : ep.path === "/call/analyze" ? `, "call_type": "sales_call"` : "";
    return `import requests\n\nwith open("recording.wav", "rb") as f:\n    resp = requests.post(\n        "${BASE_URL}${ep.path}",\n        files={"file": f},\n        data={"language": "auto"${extra}},\n        headers={"X-OmniIntel-Internal-Token": VOICEFLOW_TOKEN},\n    )\nprint(resp.json())`;
  }
  const outputHandling = ep.path === "/tts"
    ? `with open("speech.mp3", "wb") as f:\n    f.write(resp.content)`
    : `print(resp.json())`;
  return `import requests\n\nresp = requests.post(\n    "${BASE_URL}${ep.path}",\n    json=${ep.reqBody?.trim().startsWith("{") ? ep.reqBody : "{}"},\n    headers={"X-OmniIntel-Internal-Token": VOICEFLOW_TOKEN},\n)\n${outputHandling}`;
}

function nodeSnippet(ep: Endpoint): string {
  if (ep.method === "WS") {
    return `const ws = new WebSocket("${WS_BASE}${ep.path}");\nws.onmessage = (e) => console.log(JSON.parse(e.data));\n// ws.send(<ArrayBuffer of audio>) / ws.send(JSON.stringify({...}))`;
  }
  if (ep.method === "GET") {
    return `const res = await fetch("${BASE_URL}${ep.path}", {\n  headers: { "X-OmniIntel-Internal-Token": VOICEFLOW_TOKEN },\n});\nconst data = await res.json();`;
  }
  if (ep.reqLabel === "multipart/form-data") {
    return `const fd = new FormData();\nfd.append("file", audioBlob, "recording.wav");\nfd.append("analysis_type", "meeting");\n\nconst res = await fetch("${BASE_URL}${ep.path}", {\n  method: "POST",\n  headers: { "X-OmniIntel-Internal-Token": VOICEFLOW_TOKEN },\n  body: fd,\n});\nconst data = await res.json();`;
  }
  const body = ep.reqBody?.trim().startsWith("{") ? ep.reqBody : "{}";
  return `const res = await fetch("${BASE_URL}${ep.path}", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    "X-OmniIntel-Internal-Token": VOICEFLOW_TOKEN,\n  },\n  body: JSON.stringify(${body}),\n});\n${ep.path === "/tts" ? "const audioBlob = await res.blob();" : "const data = await res.json();"}`;
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
            Speech transcription, TTS, LLM-powered call/meeting analysis, webhook relay and real-time voice agent — 14 endpoints.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, margin: "20px 0" }}>
        {[
          { icon: Globe, label: "Base URL", value: BASE_URL, color: "#38bdf8" },
          { icon: Shield, label: "Auth", value: "X-OmniIntel-Internal-Token", color: "#4ade80" },
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
        The internal-token header is only enforced when the server sets <code>REQUIRE_INTERNAL_TOKEN=true</code> (off by default). <code>GET /</code>, <code>GET /health</code>, <code>WS /stream</code>, and <code>WS /realtime</code> are always public regardless of that setting.
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
