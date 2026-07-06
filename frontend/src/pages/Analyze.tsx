import { useState } from "react";
import { FileAudio, Sparkles, AlertTriangle } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, EmptyState } from "../kit/primitives";
import { ExecutionStages, Label, Segmented } from "../kit/misc";
import { ResultView } from "../components/Results";
import { Analysis, ANALYSIS_TYPES, api, saveHistory, Transcript } from "../lib/api";
import { X } from "lucide-react";

const SAMPLE =
  "Sarah: We need the procurement decision before Friday the 20th. The server budget is $45,000 and finance already signed off. " +
  "Tom: I'll follow up with the vendor tomorrow and get the final quote. If it's above budget we escalate to Priya. " +
  "Sarah: Agreed. Also — the onboarding revamp slipped a week; new target is August 3rd. Tom owns the rollout comms.";

export default function Analyze() {
  const [tab, setTab] = useState("text");
  const [mode, setMode] = useState("meeting");
  const [customFields, setCustomFields] = useState<string[]>(["owner", "deadline", "priority", "task"]);
  const [fieldInput, setFieldInput] = useState("");
  const [instructions, setInstructions] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ transcript?: Transcript | null; analysis: Analysis; type: string } | null>(null);

  const run = async () => {
    setBusy(true); setErr(""); setResult(null);
    try {
      if (tab === "text") {
        if (!text.trim()) throw new Error("Paste a transcript first");
        const analysis = mode === "custom"
          ? await api.analyzeCustom(text, customFields, instructions)
          : await api.analyze(text, mode);
        setResult({ analysis, type: mode });
        saveHistory({ ts: Date.now(), kind: mode, title: text.slice(0, 60) + "…", result: { analysis, analysis_type: mode } });
      } else {
        if (!file) throw new Error("Choose an audio file first");
        const res = await api.pipeline(file, file.name, mode);
        setResult({ transcript: res.transcript, analysis: res.analysis, type: res.analysis_type });
        saveHistory({ ts: Date.now(), kind: mode, title: file.name, result: res });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader
        title="Analyze"
        sub="Turn any conversation — pasted transcript or audio file — into structured, CRM-ready intelligence."
        actions={<Button variant="secondary" onClick={() => { setTab("text"); setText(SAMPLE); setMode("meeting"); }}>Use sample transcript</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <Card title="Input">
          <div className="space-y-4">
            <Segmented value={tab} onChange={(t) => { setTab(t); setErr(""); }} options={[{ value: "text", label: "Transcript text" }, { value: "audio", label: "Audio file" }]} />
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
            {tab === "text" ? (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                placeholder="Paste a conversation transcript…"
                className="w-full rounded-input border border-line-strong bg-surface-2 px-3 py-2 text-[13px] leading-6 text-body outline-none focus:border-[var(--accent)]"
              />
            ) : (
              <label className="flex cursor-pointer items-center gap-2 rounded-input border border-dashed border-line-strong px-3 py-4 text-sm text-dim hover:border-[var(--accent)]">
                <FileAudio size={16} /> {file ? file.name : "Choose audio (wav, mp3, m4a, webm…)"}
                <input type="file" accept="audio/*,video/webm" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
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
                active={1}
              />
            </Card>
          ) : result ? (
            <ResultView transcript={result.transcript} analysis={result.analysis} analysisType={result.type} />
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
