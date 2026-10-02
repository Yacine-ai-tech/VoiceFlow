import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  ClipboardCopy,
  Check,
  Users,
  Clock,
  Sparkles,
  CheckCircle,
  CheckSquare,
  AlertTriangle,
  Lightbulb,
  HelpCircle,
  Quote,
  Download,
  Search,
} from "lucide-react";
import { Card, Chip, EmptyState } from "../kit/primitives";
import { Segmented } from "../kit/misc";
import { JSONViewer } from "../kit/JSONViewer";
import { Analysis, AnnotationItem, Transcript, TranscriptSegment } from "../lib/api";

const SPEAKER_PALETTES = [
  { bg: "rgba(99, 102, 241, 0.12)", text: "#818cf8", border: "rgba(99, 102, 241, 0.3)", badge: "border-indigo-500/30 bg-indigo-500/15 text-indigo-300" },
  { bg: "rgba(16, 185, 129, 0.12)", text: "#34d399", border: "rgba(16, 185, 129, 0.3)", badge: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" },
  { bg: "rgba(14, 165, 233, 0.12)", text: "#38bdf8", border: "rgba(14, 165, 233, 0.3)", badge: "border-sky-500/30 bg-sky-500/15 text-sky-300" },
  { bg: "rgba(245, 158, 11, 0.12)", text: "#fbbf24", border: "rgba(245, 158, 11, 0.3)", badge: "border-amber-500/30 bg-amber-500/15 text-amber-300" },
  { bg: "rgba(236, 72, 153, 0.12)", text: "#f472b6", border: "rgba(236, 72, 153, 0.3)", badge: "border-pink-500/30 bg-pink-500/15 text-pink-300" },
  { bg: "rgba(168, 85, 247, 0.12)", text: "#c084fc", border: "rgba(168, 85, 247, 0.3)", badge: "border-purple-500/30 bg-purple-500/15 text-purple-300" },
];

function getSpeakerStyle(speaker?: string, index = 0) {
  if (!speaker) return SPEAKER_PALETTES[0];
  const numMatch = speaker.match(/\d+/);
  if (numMatch) {
    const idx = parseInt(numMatch[0], 10) % SPEAKER_PALETTES.length;
    return SPEAKER_PALETTES[idx];
  }
  const charCode = speaker.charCodeAt(speaker.length - 1);
  return SPEAKER_PALETTES[charCode % SPEAKER_PALETTES.length] || SPEAKER_PALETTES[index % SPEAKER_PALETTES.length];
}

const ANNOTATION_CONFIG: Record<
  string,
  { label: string; icon: typeof CheckCircle; bg: string; text: string; border: string }
> = {
  decision: { label: "Decision", icon: CheckCircle, bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/30" },
  action_item: { label: "Action Item", icon: CheckSquare, bg: "bg-indigo-500/10", text: "text-indigo-400", border: "border-indigo-500/30" },
  objection: { label: "Objection", icon: AlertTriangle, bg: "bg-rose-500/10", text: "text-rose-400", border: "border-rose-500/30" },
  insight: { label: "Insight", icon: Lightbulb, bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30" },
  question: { label: "Question", icon: HelpCircle, bg: "bg-sky-500/10", text: "text-sky-400", border: "border-sky-500/30" },
  quote: { label: "Quote", icon: Quote, bg: "bg-purple-500/10", text: "text-purple-400", border: "border-purple-500/30" },
};

function formatTimestamp(seconds?: number): string {
  if (seconds == null || isNaN(seconds)) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Structured-intelligence renderer shared by Record / Analyze / History.
 *  Renders real returned fields: Cards, Diarization, Annotations, Transcript, JSON. */
export function ResultView({
  transcript,
  analysis,
  analysisType,
}: {
  transcript?: Transcript | null;
  analysis: Analysis;
  analysisType: string;
}) {
  const annotations = analysis.annotations || [];
  const segments = transcript?.segments || [];
  const hasDiarization = segments.length > 0 || !!transcript?.diarized_text;
  const hasAnnotations = annotations.length > 0;

  const [view, setView] = useState("cards");

  const viewOptions = [
    { value: "cards", label: "Cards" },
    ...(hasDiarization ? [{ value: "diarization", label: "Diarization" }] : []),
    ...(hasAnnotations ? [{ value: "annotations", label: `Annotations (${annotations.length})` }] : []),
    ...(transcript ? [{ value: "transcript", label: "Transcript" }] : []),
    { value: "json", label: "JSON" },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="accent">{analysisType.replace("_", " ")}</Chip>
        {typeof analysis.sentiment === "string" && <Chip>sentiment: {analysis.sentiment}</Chip>}
        {typeof analysis.overall_sentiment === "string" && <Chip>sentiment: {analysis.overall_sentiment}</Chip>}
        {typeof analysis.deal_stage === "string" && <Chip tone="ok">stage: {analysis.deal_stage}</Chip>}
        {typeof analysis.likelihood_to_close === "number" && (
          <Chip className="num">close likelihood {(analysis.likelihood_to_close * 100).toFixed(0)}%</Chip>
        )}
        {transcript?.speakers && transcript.speakers.length > 0 && (
          <Chip tone="ok">
            <Users size={12} className="mr-1 inline" /> {transcript.speakers.length} speakers
          </Chip>
        )}
        {hasAnnotations && (
          <Chip tone="accent">
            <Sparkles size={12} className="mr-1 inline" /> {annotations.length} annotations
          </Chip>
        )}
        <div className="ml-auto">
          <Segmented value={view} onChange={setView} options={viewOptions} />
        </div>
      </div>

      {view === "json" ? (
        <JSONViewer data={{ transcript, analysis, analysis_type: analysisType }} maxHeight={540} />
      ) : view === "diarization" && hasDiarization ? (
        <DiarizationView transcript={transcript} annotations={annotations} />
      ) : view === "annotations" && hasAnnotations ? (
        <AnnotationsView annotations={annotations} />
      ) : view === "transcript" && transcript ? (
        <Card title="Raw Transcript" actions={<CopyBtn text={String(transcript.text ?? "")} />}>
          {transcript.error ? (
            <div className="text-[13px] text-warn">{String(transcript.error)}</div>
          ) : (
            <p className="max-h-[460px] overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-7 text-dim">
              {String(transcript.text ?? "")}
            </p>
          )}
        </Card>
      ) : (
        <AnalysisCards analysis={analysis} />
      )}
    </motion.div>
  );
}

function DiarizationView({
  transcript,
  annotations,
}: {
  transcript?: Transcript | null;
  annotations: AnnotationItem[];
}) {
  const [filterSpeaker, setFilterSpeaker] = useState<string>("all");
  const [search, setSearch] = useState("");

  const segments: TranscriptSegment[] = useMemo(() => {
    if (transcript?.segments && transcript.segments.length > 0) {
      return transcript.segments;
    }
    // Fallback if only diarized_text exists: parse lines into turns
    if (transcript?.diarized_text) {
      const lines = transcript.diarized_text.split("\n").filter(Boolean);
      return lines.map((line) => {
        const match = line.match(/^\[(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\]\s*([^:]+):\s*(.*)$/);
        if (match) {
          return {
            speaker: match[3].trim(),
            start: 0,
            end: 0,
            text: match[4].trim(),
          };
        }
        return { speaker: "Speaker 0", text: line };
      });
    }
    return [];
  }, [transcript]);

  const uniqueSpeakers = useMemo(() => {
    const set = new Set<string>();
    segments.forEach((s) => {
      if (s.speaker) set.add(s.speaker);
    });
    return Array.from(set);
  }, [segments]);

  const filteredSegments = useMemo(() => {
    return segments.filter((s) => {
      if (filterSpeaker !== "all" && s.speaker !== filterSpeaker) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (s.text || "").toLowerCase().includes(q) || (s.speaker || "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [segments, filterSpeaker, search]);

  const diarizedFullText = useMemo(() => {
    if (transcript?.diarized_text) return transcript.diarized_text;
    return segments
      .map(
        (s) =>
          `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}] ${s.speaker || "Speaker 0"}: ${s.text || ""}`
      )
      .join("\n");
  }, [transcript, segments]);

  const downloadTranscript = () => {
    const blob = new Blob([diarizedFullText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "diarized_transcript.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card
      title="Speaker Diarization Timeline"
      actions={
        <div className="flex items-center gap-2">
          <CopyBtn text={diarizedFullText} label="Copy Dialogue" />
          <button
            type="button"
            onClick={downloadTranscript}
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-dim hover:text-body"
          >
            <Download size={11} /> Download .txt
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold text-muted">Filter:</span>
            <button
              type="button"
              onClick={() => setFilterSpeaker("all")}
              className={`rounded-full px-2.5 py-1 text-xs transition ${
                filterSpeaker === "all" ? "bg-[var(--accent)] text-white" : "border border-line bg-surface-2 text-dim"
              }`}
            >
              All Speakers ({segments.length})
            </button>
            {uniqueSpeakers.map((spk, idx) => {
              const count = segments.filter((s) => s.speaker === spk).length;
              const style = getSpeakerStyle(spk, idx);
              const isActive = filterSpeaker === spk;
              return (
                <button
                  key={spk}
                  type="button"
                  onClick={() => setFilterSpeaker(spk)}
                  className={`rounded-full px-2.5 py-1 text-xs transition border ${
                    isActive ? "font-semibold " + style.badge : "border-line bg-surface-2 text-dim"
                  }`}
                >
                  {spk} ({count})
                </button>
              );
            })}
          </div>

          <div className="relative min-w-[200px]">
            <Search size={13} className="absolute left-2.5 top-2.5 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search speaker turns…"
              className="w-full rounded-input border border-line bg-surface-2 py-1.5 pl-8 pr-3 text-xs text-body outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {filteredSegments.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted">No speaker dialogue turns match your filter.</div>
        ) : (
          <div className="max-h-[500px] space-y-3 overflow-y-auto pr-1">
            {filteredSegments.map((seg, idx) => {
              const spkStyle = getSpeakerStyle(seg.speaker, idx);
              const initials = (seg.speaker || "S0")
                .split(" ")
                .map((w) => w[0])
                .join("")
                .toUpperCase()
                .slice(0, 2);

              const matchingAnnotations = annotations.filter((ann) => {
                if (ann.speaker && seg.speaker && ann.speaker.toLowerCase() === seg.speaker.toLowerCase()) {
                  if (ann.quote && seg.text && seg.text.toLowerCase().includes(ann.quote.toLowerCase())) {
                    return true;
                  }
                }
                return false;
              });

              return (
                <div
                  key={idx}
                  className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-3 transition hover:border-line-strong"
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={{ background: spkStyle.bg, color: spkStyle.text, border: `1px solid ${spkStyle.border}` }}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-body">{seg.speaker || "Speaker 0"}</span>
                      {(seg.start != null || seg.end != null) && (
                        <span className="flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-mono text-muted">
                          <Clock size={10} />
                          {formatTimestamp(seg.start)} &ndash; {formatTimestamp(seg.end)}
                        </span>
                      )}
                      {matchingAnnotations.map((ann, aIdx) => {
                        const conf = ANNOTATION_CONFIG[ann.type] || ANNOTATION_CONFIG.insight;
                        return (
                          <span
                            key={aIdx}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${conf.bg} ${conf.text} ${conf.border}`}
                          >
                            <conf.icon size={10} /> {conf.label}: {ann.title}
                          </span>
                        );
                      })}
                    </div>
                    <p className="whitespace-pre-wrap text-[13px] leading-6 text-dim">{seg.text}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

function AnnotationsView({ annotations }: { annotations: AnnotationItem[] }) {
  const [selectedType, setSelectedType] = useState<string>("all");
  const [search, setSearch] = useState("");

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    annotations.forEach((a) => {
      const t = a.type || "insight";
      map[t] = (map[t] || 0) + 1;
    });
    return map;
  }, [annotations]);

  const filtered = useMemo(() => {
    return annotations.filter((a) => {
      if (selectedType !== "all" && (a.type || "").toLowerCase() !== selectedType) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          a.title.toLowerCase().includes(q) ||
          a.note.toLowerCase().includes(q) ||
          (a.quote || "").toLowerCase().includes(q) ||
          (a.speaker || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [annotations, selectedType, search]);

  const copyMarkdown = () => {
    const md = annotations
      .map((a) => {
        const type = (a.type || "insight").toUpperCase();
        const header = `### [${type}] ${a.title}${a.speaker ? ` — ${a.speaker}` : ""}${a.time ? ` (${a.time})` : ""}`;
        const note = a.note ? `\n${a.note}` : "";
        const quote = a.quote ? `\n> "${a.quote}"` : "";
        return `${header}${note}${quote}\n`;
      })
      .join("\n");
    navigator.clipboard.writeText(md);
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(annotations, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript_annotations.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const categories = ["all", "decision", "action_item", "objection", "insight", "question", "quote"];

  return (
    <Card
      title="Intelligent Transcript Annotations"
      actions={
        <div className="flex items-center gap-2">
          <CopyBtn text={JSON.stringify(annotations, null, 2)} label="Copy JSON" />
          <button
            type="button"
            onClick={copyMarkdown}
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-dim hover:text-body"
          >
            <ClipboardCopy size={11} /> Copy Markdown
          </button>
          <button
            type="button"
            onClick={downloadJson}
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-dim hover:text-body"
          >
            <Download size={11} /> JSON
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {categories.map((cat) => {
              const count = cat === "all" ? annotations.length : counts[cat] || 0;
              if (cat !== "all" && count === 0) return null;
              const isActive = selectedType === cat;
              const label =
                cat === "all" ? "All" : ANNOTATION_CONFIG[cat]?.label || cat.replace("_", " ");
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedType(cat)}
                  className={`rounded-full px-2.5 py-1 text-xs transition border ${
                    isActive
                      ? "bg-[var(--accent)] font-semibold text-white border-transparent"
                      : "border-line bg-surface-2 text-dim hover:text-body"
                  }`}
                >
                  {label} ({count})
                </button>
              );
            })}
          </div>

          <div className="relative min-w-[200px]">
            <Search size={13} className="absolute left-2.5 top-2.5 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search annotations…"
              className="w-full rounded-input border border-line bg-surface-2 py-1.5 pl-8 pr-3 text-xs text-body outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted">No annotations match your filter.</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {filtered.map((item, idx) => {
              const conf = ANNOTATION_CONFIG[item.type] || ANNOTATION_CONFIG.insight;
              const Icon = conf.icon;
              return (
                <div
                  key={idx}
                  className={`flex flex-col justify-between rounded-xl border p-3.5 transition hover:border-line-strong bg-surface-2 ${conf.border}`}
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${conf.bg} ${conf.text} ${conf.border}`}
                      >
                        <Icon size={11} /> {conf.label}
                      </span>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted">
                        {item.speaker && (
                          <span className="rounded bg-surface-3 px-1.5 py-0.5 font-medium text-dim">
                            {item.speaker}
                          </span>
                        )}
                        {item.time && (
                          <span className="flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 font-mono">
                            <Clock size={9} /> {item.time}
                          </span>
                        )}
                      </div>
                    </div>

                    <h4 className="text-[13.5px] font-semibold text-body">{item.title}</h4>
                    {item.note && <p className="text-[12.5px] leading-5 text-dim">{item.note}</p>}
                  </div>

                  {item.quote && (
                    <div className="mt-3 rounded-lg border-l-2 border-line-strong bg-surface-1 px-2.5 py-1.5 text-[12px] italic text-muted">
                      &ldquo;{item.quote}&rdquo;
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

function AnalysisCards({ analysis }: { analysis: Analysis }) {
  const entries = Object.entries(analysis).filter(([k]) => k !== "error" && k !== "raw");
  if (analysis.error) {
    return (
      <Card>
        <div className="text-[13px] text-warn">
          The analyzer returned a non-JSON response ({String(analysis.error)}). Raw output is in the JSON tab.
        </div>
      </Card>
    );
  }
  if (entries.length === 0) return <EmptyState title="Empty analysis" />;

  const annotations = analysis.annotations || [];
  const summaryKeys = entries.filter(
    ([k]) => /summary|notes/i.test(k) && typeof analysis[k] === "string"
  );
  const rest = entries.filter(([k]) => k !== "annotations" && !summaryKeys.some(([sk]) => sk === k));

  return (
    <div className="space-y-4">
      {summaryKeys.map(([k, v]) => (
        <Card key={k} title={pretty(k)} actions={<CopyBtn text={String(v)} />}>
          <p className="whitespace-pre-wrap text-[13.5px] leading-7 text-dim">{String(v)}</p>
        </Card>
      ))}

      {annotations.length > 0 && (
        <Card title="Key Annotations & Decisions">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {annotations.slice(0, 6).map((ann, i) => {
              const conf = ANNOTATION_CONFIG[ann.type] || ANNOTATION_CONFIG.insight;
              const Icon = conf.icon;
              return (
                <div key={i} className={`rounded-xl border p-3 ${conf.border} bg-surface-2`}>
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${conf.bg} ${conf.text}`}>
                      <Icon size={11} /> {conf.label}
                    </span>
                    {ann.speaker && <span className="text-muted">&middot; {ann.speaker}</span>}
                    {ann.time && <span className="font-mono text-muted">({ann.time})</span>}
                  </div>
                  <div className="mt-1 text-[13px] font-medium text-body">{ann.title}</div>
                  {ann.note && <div className="mt-0.5 text-[12px] text-dim">{ann.note}</div>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {rest.map(([k, v]) => (
          <Card key={k} title={pretty(k)}>
            <FieldValue v={v} />
          </Card>
        ))}
      </div>
    </div>
  );
}

function FieldValue({ v }: { v: unknown }) {
  if (v == null || v === "") return <span className="text-[13px] text-muted">—</span>;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="text-[13px] text-muted">none</span>;
    return (
      <ul className="space-y-2">
        {v.map((item, i) => (
          <li key={i} className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] leading-6 text-dim">
            {typeof item === "object" && item !== null ? <ObjectRow o={item as Record<string, unknown>} /> : String(item)}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof v === "object") return <ObjectRow o={v as Record<string, unknown>} />;
  if (typeof v === "boolean") return <Chip tone={v ? "warn" : "ok"}>{String(v)}</Chip>;
  return <p className="whitespace-pre-wrap text-[13.5px] leading-6 text-dim">{String(v)}</p>;
}

function ObjectRow({ o }: { o: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {Object.entries(o).map(([k, v]) => (
        <span key={k} className="text-[12.5px]">
          <span className="text-muted">{pretty(k)}: </span>
          <span className="text-body">{v == null ? "—" : String(v)}</span>
        </span>
      ))}
    </div>
  );
}

function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-dim hover:text-body"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
    >
      {ok ? <Check size={11} className="text-ok" /> : <ClipboardCopy size={11} />} {ok ? "Copied" : label}
    </button>
  );
}

function pretty(k: string) {
  return k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
