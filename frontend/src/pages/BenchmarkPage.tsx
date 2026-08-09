import { useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, EmptyState, Skeleton } from "../kit/primitives";
import { api } from "../lib/api";

type Doc = { title: string; filename: string; content: string | null };
type Docs = Record<string, Doc>;

const ORDER = ["wer", "multi_provider", "scenario", "realtime"];
const SCRIPTS: Record<string, string> = {
  wer: "eval/run_wer_benchmark.py",
  multi_provider: "eval/run_multi_provider_benchmark.py",
  scenario: "eval/run_scenario_benchmark.py",
  realtime: "eval/run_realtime_benchmark.py",
};

export default function BenchmarkPage() {
  const [docs, setDocs] = useState<Docs | null>(null);
  const [err, setErr] = useState("");
  const [active, setActive] = useState("wer");

  const load = () => {
    setDocs(null); setErr("");
    api.benchmarks().then((r) => setDocs(r.docs)).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const keys = docs ? ORDER.filter((k) => k in docs) : [];
  const doc = docs?.[active];

  return (
    <div>
      <PageHeader
        title="Evaluation benchmarks"
        sub="Every eval/*.md report VoiceFlow's CLI harnesses have actually produced, fetched live from disk on every load — never a hardcoded snapshot baked into this page."
        actions={<Button variant="ghost" onClick={load} aria-label="refresh"><RefreshCw size={14} /></Button>}
      />

      {!docs && !err && <Skeleton className="h-64 w-full" />}

      {err && (
        <Card className="mt-2">
          <EmptyState title="Couldn't load benchmark reports" hint={err} />
        </Card>
      )}

      {docs && (
        <>
          <div className="flex flex-wrap gap-2">
            {keys.map((k) => (
              <button
                key={k}
                onClick={() => setActive(k)}
                className={`rounded-btn border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                  active === k
                    ? "border-[var(--accent)] bg-surface-2 text-body"
                    : "border-line-strong text-dim hover:bg-surface-2"
                }`}
              >
                {docs[k].title}
              </button>
            ))}
          </div>

          <Card title={doc?.title} actions={<span className="font-mono text-[11px] text-muted">eval/{doc?.filename}</span>} className="mt-4">
            {doc?.content ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-6 text-dim">{doc.content}</pre>
            ) : (
              <EmptyState
                icon={BarChart3}
                title="Not generated yet"
                hint={`Run \`python ${SCRIPTS[active]}\` to produce this report, then reload this page.`}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
