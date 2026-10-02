import { useEffect, useState } from "react";
import { FileAudio, Sparkles, AlertTriangle } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { ExecutionStages, Label, Segmented } from "../kit/misc";
import { ResultView } from "../components/Results";
import { Analysis, ANALYSIS_TYPES, api, saveHistory, Scenario, Transcript } from "../lib/api";
import { X } from "lucide-react";

const SAMPLE =
  "Sarah: We need the procurement decision before Friday the 20th. The server budget is $45,000 and finance already signed off. " +
  "Tom: I'll follow up with the vendor tomorrow and get the final quote. If it's above budget we escalate to Priya. " +
  "Sarah: Agreed. Also — the onboarding revamp slipped a week; new target is August 3rd. Tom owns the rollout comms.";

const ASR_PROVIDERS = [
  { value: "DEEPGRAM", label: "Deepgram Nova-3" },
  { value: "ASSEMBLYAI", label: "AssemblyAI" },
  { value: "GROQ_WHISPER", label: "Groq Whisper" },
  { value: "LOCAL_WHISPER", label: "Local Whisper (CPU)" },
];

const LANGUAGES = [
  { value: "auto", label: "Auto Detect" },
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
];

export default function Analyze() {
  const [tab, setTab] = useState("text");
  const [mode, setMode] = useState("meeting");
  const [provider, setProvider] = useState("DEEPGRAM");
  const [language, setLanguage] = useState("auto");
  const [diarize, setDiarize] = useState(true);
  const [customFields, setCustomFields] = useState<string[]>(["owner", "deadline", "priority", "task"]);
  const [fieldInput, setFieldInput] = useState("");
  const [instructions, setInstructions] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ transcript?: Transcript | null; analysis: Analysis; type: string; usedScenario?: string | null } | null>(null);
  const [activeStage, setActiveStage] = useState(0);
  const [scenarios, setScenarios] = useState<Record<string, Scenario>>({});
  const [scenario, setScenario] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => { api.scenarios().then(setScenarios).catch(() => {}); }, []);

  const run = async () => {
    setBusy(true); setErr(""); setResult(null); setActiveStage(0);
    const timer = setInterval(() => setActiveStage(s => Math.min(s + 1, tab === "audio" ? 3 : 2)), 1800);
    // The audio path runs transcription on a GPU-tier orchestrator capability
    // (whisper) — a cold backend can take well past a bare spinner's patience to
    // wake and load the model. A running elapsed-time counter is the honest
    // signal for that path; the text path is a plain fast LLM call.
    const startedAt = Date.now();
    setElapsedMs(0);
    const elapsedTimer = tab === "audio" ? window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250) : undefined;
    try {
      if (tab === "text") {
        if (!text.trim()) throw new Error("Paste a transcript first");
        const analysis = mode === "custom"
          ? await api.analyzeCustom(text, customFields, instructions, language)
          : await api.analyze(text, mode, language);
        setResult({ analysis, type: mode });
        saveHistory({ ts: Date.now(), kind: mode, title: text.slice(0, 60) + "…", result: { analysis, analysis_type: mode } });
      } else {
        if (!file) throw new Error("Choose an audio file first");
        const res = await api.pipeline(file, file.name, mode, provider, language, scenario || undefined, diarize);
        setResult({ transcript: res.transcript, analysis: res.analysis, type: res.analysis_type, usedScenario: res.scenario });
        saveHistory({ ts: Date.now(), kind: mode, title: file.name, result: res });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { clearInterval(timer); window.clearInterval(elapsedTimer); setBusy(false); }
  };

  return (
    <div>
      <PageHeader
        title="Analyze"
        sub="Turn any conversation — pasted transcript or audio file — into structured, CRM-ready intelligence."
        actions={<Button variant="secondary" onClick={() => { setTab("text"); setText(SAMPLE); setMode("meeting"); }}>Use sample transcript</Button>}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-[12.5px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-body">Speech Recognition Engines:</span>
          <Chip tone="accent">Deepgram Nova-3</Chip>
          <Chip tone="default">AssemblyAI Conformer-2</Chip>
          <Chip tone="default">Groq Whisper Large-v3</Chip>
          <Chip tone="default">WhisperX Diarization</Chip>
        </div>
        <div className="flex items-center gap-2 text-muted">
          <span>Multilingual:</span>
          <span className="font-medium text-body">EN &middot; FR &middot; Auto</span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <Card title="Input">
          <div className="space-y-4">
            <Segmented value={tab} onChange={(t) => { setTab(t); setErr(""); }} options={[{ value: "text", label: "Transcript text" }, { value: "audio", label: "Audio file (Deepgram / AssemblyAI)" }]} />
            <div>
              <Label>Intelligence mode</Label>
              <Segmented value={mode} onChange={setMode} options={[...ANALYSIS_TYPES.map((t) => ({ value: t.value, label: t.label })), { value: "custom", label: "Custom schema" }]} />
            {mode === "custom" && tab === "text" && (
              <div className="mt-3 space-y-2 rounded-xl border border-line bg-surface-2 p-3">
                <Label>Fields to extract</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {customFields.map((f) => (
                    <span key={f} className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2.5 py-1 text-xs text-body">
                      {f}<button onClick={() => setCustomFields((cs) => cs.filter((x) => x !== f))}><X size={11} className="text-muted hover:text-body" /></button>
                    </span>
                  ))}
                  <input value={fieldInput} onChange={(e) => setFieldInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && fieldInput.trim()) { setCustomFields((cs) => [...new Set([...cs, fieldInput.trim()])]); setFieldInput(""); } }}
                    placeholder="add field + Enter" className="w-32 rounded-input border border-line bg-bg px-2.5 py-1.5 text-xs text-body outline-none focus:border-[var(--accent)]" />
                </div>
                <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="optional instructions…"
                  className="mt-1 w-full rounded-input border border-line bg-bg px-3 py-1.5 text-[12.5px] text-body outline-none focus:border-[var(--accent)]" />
              </div>
            )}
            </div>
            <div>
              <Label>Analysis language</Label>
              <Segmented value={language} onChange={setLanguage} options={LANGUAGES} />
            </div>

            {tab === "text" ? (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={9}
                  placeholder="Paste a conversation transcript in English or French…"
                  className="w-full rounded-input border border-line-strong bg-surface-2 px-3 py-2 text-[13px] leading-6 text-body outline-none focus:border-[var(--accent)]"
                />
                <div className="flex items-center justify-between rounded-lg border border-line bg-surface-1 p-2 text-xs text-dim">
                  <span>Have an audio file to transcribe?</span>
                  <button
                    type="button"
                    onClick={() => setTab("audio")}
                    className="font-medium text-[var(--accent)] hover:underline"
                  >
                    Select Deepgram / AssemblyAI &rarr;
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <Label>ASR Engine</Label>
                  <Segmented value={provider} onChange={setProvider} options={ASR_PROVIDERS} />
                </div>
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
                  <div>
                    <div className="text-[13px] font-medium text-body">Speaker Diarization</div>
                    <div className="text-[11px] text-muted">Separate speakers with timestamps and turn badges</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDiarize(!diarize)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                      diarize ? "border border-ok/40 bg-ok/15 text-ok" : "border border-line bg-surface-3 text-muted"
                    }`}
                  >
                    {diarize ? "Enabled" : "Disabled"}
                  </button>
                </div>
                <label className="flex cursor-pointer items-center gap-2 rounded-input border border-dashed border-line-strong px-3 py-4 text-sm text-dim hover:border-[var(--accent)]">
                  <FileAudio size={16} /> {file ? file.name : "Choose audio (wav, mp3, m4a, webm…)"}
                  <input type="file" accept="audio/*,video/webm" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
                {Object.keys(scenarios).length > 0 && (
                  <div>
                    <Label>Scenario (optional — pins an exact provider, no fallback)</Label>
                    <select value={scenario} onChange={(e) => setScenario(e.target.value)}
                      className="w-full rounded-input border border-line-strong bg-surface-2 px-3 py-2 text-[13px] text-body outline-none focus:border-[var(--accent)]">
                      <option value="">Default (env-configured provider + fallback chain)</option>
                      {Object.entries(scenarios).filter(([, s]) => s.transcription_provider).map(([name, s]) => (
                        <option key={name} value={name}>{name} — {s.description}</option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
            <Button onClick={run} disabled={busy}>
              <Sparkles size={14} /> {busy ? "Analyzing…" : "Extract intelligence"}
            </Button>
            {err && <div className="flex items-start gap-2 text-[13px] text-bad"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{err}</div>}
          </div>
        </Card>

        <div>
          {busy ? (
            <Card>
              <ExecutionStages
                stages={tab === "audio"
                  ? ["Uploading audio", "Transcribing speech", "AI reasoning", "Structuring intelligence"]
                  : ["Sending transcript", "AI reasoning", "Structuring intelligence"]}
                active={activeStage}
              />
              {tab === "audio" && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                  <span className="num">{(elapsedMs / 1000).toFixed(0)}s elapsed</span>
                  {elapsedMs > 20000 && (
                    <span>— still working; a cold transcription endpoint can take a minute or more to wake.</span>
                  )}
                </div>
              )}
            </Card>
          ) : result ? (
            <>
              {result.usedScenario && (
                <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-1 text-[12px] text-dim">
                  Scenario: <span className="font-medium text-body">{result.usedScenario}</span>
                </div>
              )}
              <ResultView transcript={result.transcript} analysis={result.analysis} analysisType={result.type} />
            </>
          ) : (
            <Card>
              <EmptyState
                icon={Sparkles}
                title="No analysis yet"
                hint="Five real extraction schemas: meeting notes, sales calls (deal stage, objections, CRM notes), support calls, interviews, general."
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
