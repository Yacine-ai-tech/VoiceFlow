import { useEffect, useState } from "react";
import { History as HistoryIcon, Trash2 } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { ResultView } from "../components/Results";
import { api, clearHistory, HistoryItem, readHistory } from "../lib/api";

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>(readHistory());
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    api.getRecords(50).then((res) => {
      if (!active || !res?.records) return;
      const serverItems: HistoryItem[] = res.records.map((r) => ({
        ts: new Date(r.created_at).getTime(),
        kind: r.kind,
        title: r.title,
        durationSec: r.duration_sec ?? undefined,
        result: {
          transcript: r.transcript || undefined,
          analysis: r.analysis || undefined,
          analysis_type: r.kind,
        },
      }));
      setItems((prev) => {
        const combined = [...serverItems];
        const seen = new Set(combined.map((x) => x.ts));
        for (const it of prev) {
          if (!seen.has(it.ts)) {
            combined.push(it);
            seen.add(it.ts);
          }
        }
        return combined.sort((a, b) => b.ts - a.ts);
      });
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const handleClear = async () => {
    try {
      await api.clearRecords();
    } catch {}
    clearHistory();
    setItems([]);
    setOpenIdx(null);
  };

  return (
    <div>
      <PageHeader
        title="History"
        sub="Conversations and analysis processed in this session (persisted durably with strict session isolation)."
        actions={
          items.length > 0 && (
            <Button variant="ghost" onClick={handleClear}>
              <Trash2 size={14} /> Clear
            </Button>
          )
        }
      />
      {items.length === 0 ? (
        <Card>
          <EmptyState icon={HistoryIcon} title="No conversations yet" hint="Results from Record and Analyze are kept here for this session." />
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((it, i) => (
            <Card key={it.ts}>
              <button className="flex w-full flex-wrap items-center gap-3 text-left" onClick={() => setOpenIdx(openIdx === i ? null : i)}>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-body">{it.title}</span>
                <Chip tone="accent">{it.kind.replace("_", " ")}</Chip>
                {it.durationSec != null && <Chip className="num">{Math.floor(it.durationSec / 60)}:{String(it.durationSec % 60).padStart(2, "0")}</Chip>}
                <span className="num text-[11.5px] text-muted">{new Date(it.ts).toLocaleString()}</span>
              </button>
              {openIdx === i && (
                <div className="mt-4 border-t border-line pt-4">
                  <ResultView
                    transcript={"transcript" in it.result ? it.result.transcript : undefined}
                    analysis={it.result.analysis}
                    analysisType={it.result.analysis_type}
                  />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
