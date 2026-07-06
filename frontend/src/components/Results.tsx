import { useState } from "react";
import { motion } from "framer-motion";
import { ClipboardCopy, Check } from "lucide-react";
import { Card, Chip, EmptyState } from "../kit/primitives";
import { Segmented } from "../kit/misc";
import { JSONViewer } from "../kit/JSONViewer";
import { Analysis, Transcript } from "../lib/api";

/** Structured-intelligence renderer shared by Record / Analyze / History.
 *  Renders whatever fields the API actually returned — nothing is invented. */
export function ResultView({
  transcript,
  analysis,
  analysisType,
}: {
  transcript?: Transcript | null;
  analysis: Analysis;
  analysisType: string;
}) {
  const [view, setView] = useState("cards");
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
        <div className="ml-auto">
          <Segmented
            value={view}
            onChange={setView}
            options={[{ value: "cards", label: "Cards" }, { value: "json", label: "JSON" }, ...(transcript ? [{ value: "transcript", label: "Transcript" }] : [])]}
          />
        </div>
      </div>

      {view === "json" ? (
        <JSONViewer data={{ transcript, analysis, analysis_type: analysisType }} maxHeight={480} />
      ) : view === "transcript" && transcript ? (
        <Card title="Transcript">
          {transcript.error ? (
            <div className="text-[13px] text-warn">{String(transcript.error)}</div>
          ) : (
            <p className="max-h-[420px] overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-7 text-dim">
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
  const summaryKeys = entries.filter(([k]) => /summary|notes/i.test(k) && typeof analysis[k] === "string");
  const rest = entries.filter(([k]) => !summaryKeys.some(([sk]) => sk === k));
  return (
    <div className="space-y-4">
      {summaryKeys.map(([k, v]) => (
        <Card key={k} title={pretty(k)} actions={<CopyBtn text={String(v)} />}>
          <p className="whitespace-pre-wrap text-[13.5px] leading-7 text-dim">{String(v)}</p>
        </Card>
      ))}
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

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-dim hover:text-body"
      onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}
    >
      {ok ? <Check size={11} className="text-ok" /> : <ClipboardCopy size={11} />} {ok ? "Copied" : "Copy"}
    </button>
  );
}

function pretty(k: string) {
  return k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
