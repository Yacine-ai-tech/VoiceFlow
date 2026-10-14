import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity, Award, BookOpen, Boxes, Brain, Cable, Cloud, Cog, Cpu, Database, FileText, Filter,
  Gauge, GitBranch, Globe, Layers, Lock, Mic, Network, Pause, Play, Radio, RadioTower, Scale,
  Search, ShieldCheck, Sigma, Sparkles, Terminal, Wrench, Workflow, Zap, type LucideIcon,
} from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip } from "../kit/primitives";
import { PipelineFlow, type Stage } from "../kit/PipelineFlow";

const ICONS: Record<string, LucideIcon> = {
  Activity, Award, BookOpen, Boxes, Brain, Cable, Cloud, Cog, Cpu, Database, FileText, Filter,
  Gauge, GitBranch, Globe, Layers, Lock, Mic, Network, Radio, RadioTower, Scale, Search,
  ShieldCheck, Sigma, Sparkles, Terminal, Wrench, Workflow, Zap,
};

type NodeInfo = { id: string; label: string; layer: string; icon: string; summary: string; detail: string[]; env?: string[] };
type StageInfo = { id: string; label: string; icon: string; text: string; nodes: string[] };
type Arch = {
  title: string; sub: string; lifecycleTitle: string; layers: string[]; nodes: NodeInfo[]; stages: StageInfo[];
  endpoints: [string, string][]; decisions: [string, string][]; links: { to: string; label: string }[];
};

const DATA: Arch = {
  "title": "Architecture",
  "sub": "How audio becomes transcripts, structured analysis, synthesised speech and a live voice agent.",
  "lifecycleTitle": "From audio to structured intelligence",
  "layers": [
    "Input",
    "Speech to text",
    "Intelligence",
    "Output"
  ],
  "nodes": [
    {
      "id": "ingest",
      "label": "Audio ingress",
      "layer": "Input",
      "icon": "Mic",
      "summary": "File upload, base64 JSON, streaming WebSocket or microphone.",
      "detail": [
        "Per-client rate limits for HTTP requests and WebSocket connects.",
        "Undecodable audio is a client error (422), not a server fault."
      ],
      "env": [
        "RATE_LIMIT_HTTP_PER_MIN",
        "RATE_LIMIT_WS_CONNECTS_PER_MIN",
        "REQUIRE_INTERNAL_TOKEN"
      ]
    },
    {
      "id": "chain",
      "label": "Transcription chain",
      "layer": "Speech to text",
      "icon": "Network",
      "summary": "Remote host, Groq, Deepgram, AssemblyAI, then local WhisperX.",
      "detail": [
        "Order comes from configuration; a failing provider falls through to the next.",
        "Diarization requests prefer providers with native speaker separation.",
        "Strict mode (named scenarios) runs only the requested provider, so benchmarks never measure a substitute."
      ],
      "env": [
        "ASR_PROVIDER",
        "VOICEFLOW_TRANSCRIPTION_MODE",
        "ALLOW_LOCAL_ASR_FALLBACK",
        "VOICEFLOW_REMOTE_ENDPOINT"
      ]
    },
    {
      "id": "local",
      "label": "Local engine",
      "layer": "Speech to text",
      "icon": "Cpu",
      "summary": "WhisperX or NeMo Canary on this host; preloaded at start-up.",
      "detail": [
        "/ready stays 503 until the model has been loaded and exercised.",
        "Model size is configurable to fit the host."
      ],
      "env": [
        "WHISPER_MODEL",
        "WHISPER_DEVICE",
        "LOCAL_ASR_ENGINE",
        "LOCAL_DIARIZATION_ENGINE"
      ]
    },
    {
      "id": "analyzer",
      "label": "Meeting analyzer",
      "layer": "Intelligence",
      "icon": "Brain",
      "summary": "Transcript to summary, actions, decisions and sentiment.",
      "detail": [
        "Each analysis type maps to a model tier (default, reasoning, judge).",
        "Authentication, billing or quota failures retry once on a configured fallback.",
        "Prompts carry a language directive so French audio yields French output."
      ],
      "env": [
        "LLM_DEFAULT",
        "LLM_REASONING",
        "LLM_JUDGE",
        "LLM_ANALYSIS_TIMEOUT_SECONDS"
      ]
    },
    {
      "id": "realtime",
      "label": "Realtime bridge",
      "layer": "Intelligence",
      "icon": "Radio",
      "summary": "OpenAI Realtime or Gemini Live voice agent over WebSocket.",
      "detail": [
        "Input is resampled server-side where the provider requires it.",
        "Tool calls run within a time budget; destinations supplied by callers are refused."
      ],
      "env": [
        "REALTIME_PROVIDER",
        "GEMINI_LIVE_MODEL",
        "OPENAI_REALTIME_MODEL",
        "AGENT_TOOLS_URL"
      ]
    },
    {
      "id": "tts",
      "label": "Text to speech",
      "layer": "Output",
      "icon": "Sparkles",
      "summary": "edge, ElevenLabs, OpenAI or Kokoro; edge is the universal fallback.",
      "detail": [
        "Voice cloning through ElevenLabs.",
        "Speech output never fails because a premium provider did."
      ],
      "env": [
        "TTS_PROVIDER",
        "ELEVENLABS_API_KEY",
        "KOKORO_REPO_ID"
      ]
    },
    {
      "id": "relay",
      "label": "Relay & records",
      "layer": "Output",
      "icon": "Cable",
      "summary": "Slack, n8n, Zapier or custom webhooks; optional saved records.",
      "detail": [
        "Destination URLs must resolve to public addresses (SSRF guard).",
        "Records and counters persist when a database is configured; otherwise they stay in memory."
      ],
      "env": [
        "POSTGRES_URL",
        "ADMIN_TOKEN"
      ]
    }
  ],
  "stages": [
    {
      "id": "in",
      "label": "Receive audio",
      "icon": "Mic",
      "text": "Rate-limit, validate and decode the audio.",
      "nodes": [
        "ingest"
      ]
    },
    {
      "id": "asr",
      "label": "Transcribe",
      "icon": "Network",
      "text": "Walk the provider chain; diarize when requested.",
      "nodes": [
        "chain",
        "local"
      ]
    },
    {
      "id": "analyse",
      "label": "Analyze",
      "icon": "Brain",
      "text": "Route to the model tier for the analysis type; truncate and flag very long transcripts.",
      "nodes": [
        "analyzer"
      ]
    },
    {
      "id": "speak",
      "label": "Speak / relay",
      "icon": "Sparkles",
      "text": "Optionally synthesise speech or relay the result to an integration.",
      "nodes": [
        "tts",
        "relay"
      ]
    },
    {
      "id": "save",
      "label": "Record",
      "icon": "Database",
      "text": "Update session counters and save the record when persistence is enabled.",
      "nodes": [
        "relay"
      ]
    }
  ],
  "endpoints": [
    [
      "POST /transcribe, /transcribe-json",
      "Speech to text (file or base64)"
    ],
    [
      "POST /analyze, /analyze/custom",
      "Analyze a transcript"
    ],
    [
      "POST /pipeline",
      "Transcribe and analyze in one call; optional named scenario"
    ],
    [
      "POST /tts",
      "Synthesize speech"
    ],
    [
      "GET /tts/voices",
      "List voices"
    ],
    [
      "POST /tts/voices/clone",
      "Clone a voice"
    ],
    [
      "WS /stream",
      "Streaming transcription"
    ],
    [
      "WS /realtime, /realtime/gemini, /realtime/openai",
      "Voice agent bridge"
    ],
    [
      "POST /integrations/relay",
      "Send a result to Slack, n8n, Zapier or a webhook"
    ],
    [
      "POST /meeting/process, /call/analyze",
      "Meeting and call analysis workflows"
    ],
    [
      "GET /records, /analytics, /scenarios, /benchmarks",
      "History, usage and metadata"
    ],
    [
      "GET /health",
      "Liveness"
    ],
    [
      "GET /ready",
      "Readiness: 503 warming_up until the speech model is loaded"
    ]
  ],
  "decisions": [
    [
      "Provider chain",
      "Any ASR or TTS provider can fail or hit limits; the pipeline keeps answering instead of failing."
    ],
    [
      "Strict scenarios",
      "Comparable trials need the provider to be a controlled variable, so scenarios never fall back."
    ],
    [
      "Bounded abuse surface",
      "No accounts means per-client limits and an SSRF guard protect paid upstream APIs."
    ]
  ],
  "links": [
    {
      "to": "/research",
      "label": "Research"
    },
    {
      "to": "/benchmark",
      "label": "Benchmarks"
    }
  ]
};

export default function ArchitecturePage() {
  const [selected, setSelected] = useState<string>(DATA.nodes[0].id);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [filter, setFilter] = useState("");

  const stages: (Stage & { text: string; nodes: string[] })[] = useMemo(
    () => DATA.stages.map((s) => ({ ...s, icon: ICONS[s.icon] ?? Zap })), []);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => (s + 1) % (stages.length + 1)), 1800);
    return () => clearInterval(t);
  }, [playing, stages.length]);

  const current = stages[Math.min(step, stages.length - 1)];
  const lit = useMemo(() => new Set(step < stages.length ? current.nodes : []), [step, current, stages.length]);
  const node = DATA.nodes.find((n) => n.id === selected) ?? DATA.nodes[0];
  const endpoints = DATA.endpoints.filter(([r, p]) => (r + " " + p).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="p-8 max-w-6xl mx-auto h-full overflow-y-auto space-y-8">
      <PageHeader
        title={DATA.title}
        sub={DATA.sub}
        actions={
          <div className="flex gap-2">
            {DATA.links.map((l) => (
              <Link key={l.to} to={l.to}><Button variant="secondary">{l.label}</Button></Link>
            ))}
          </div>
        }
      />

      <Card title={DATA.lifecycleTitle}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-dim">Pick a stage or let it play; the components involved are highlighted below.</div>
          <Button variant="secondary" onClick={() => setPlaying((p) => !p)}>
            {playing ? <Pause size={14} className="mr-1 inline" /> : <Play size={14} className="mr-1 inline" />}
            {playing ? "Pause" : "Play"}
          </Button>
        </div>
        <PipelineFlow stages={stages} active={step} done={step >= stages.length} />
        <div className="mt-3 flex flex-wrap gap-2">
          {stages.map((s, i) => (
            <button key={s.id} onClick={() => { setPlaying(false); setStep(i); }}
              className={`rounded-lg border px-3 py-1 text-xs ${i === step ? "border-accent text-body" : "border-line text-dim"}`}>
              {i + 1}. {s.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-dim">{step < stages.length ? current.text : "Complete."}</p>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {DATA.layers.map((layer) => (
            <Card key={layer} title={layer}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {DATA.nodes.filter((n) => n.layer === layer).map((n) => {
                  const Icon = ICONS[n.icon] ?? Boxes;
                  const active = selected === n.id;
                  return (
                    <button key={n.id} onClick={() => setSelected(n.id)}
                      className={`text-left rounded-xl border p-3 transition-colors ${active ? "border-accent bg-surface-2" : "border-line bg-surface"} ${lit.has(n.id) ? "ring-1 ring-accent" : ""}`}>
                      <div className="flex items-center gap-2 text-sm font-semibold text-body"><Icon size={14} /> {n.label}</div>
                      <div className="mt-1 text-xs text-dim">{n.summary}</div>
                    </button>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>

        <Card title={node.label} className="h-fit lg:sticky lg:top-4">
          <p className="text-sm text-dim">{node.summary}</p>
          <ul className="mt-3 space-y-2 text-xs text-dim list-disc pl-4">
            {node.detail.map((d) => <li key={d}>{d}</li>)}
          </ul>
          {node.env && node.env.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Configuration</div>
              <div className="flex flex-wrap gap-1.5">{node.env.map((e) => <Chip key={e}>{e}</Chip>)}</div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Interfaces">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter routes…"
          aria-label="Filter routes"
          className="w-full mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-body outline-none focus:border-accent"
        />
        <div className="divide-y divide-line text-xs">
          {endpoints.map(([r, p]) => (
            <div key={r} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-2">
              <code className="sm:w-72 shrink-0 text-body">{r}</code>
              <span className="text-dim">{p}</span>
            </div>
          ))}
          {endpoints.length === 0 && <div className="py-3 text-dim">No route matches.</div>}
        </div>
      </Card>

      <Card title="Design decisions">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-dim">
          {DATA.decisions.map(([t, d]) => (
            <div key={t} className="rounded-xl border border-line bg-surface-2 p-4">
              <div className="font-semibold text-body text-sm mb-1">{t}</div>{d}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
