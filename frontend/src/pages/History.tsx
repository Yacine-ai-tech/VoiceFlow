import { useState } from "react";
import { History as HistoryIcon, Trash2 } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { ResultView } from "../components/Results";
import { clearHistory, HistoryItem, readHistory } from "../lib/api";

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>(readHistory());
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div>
      <PageHeader
        title="History"
        sub="Conversations processed in this browser session (stored locally — the API is stateless by design)."
        actions={
          items.length > 0 && (
            <Button variant="ghost" onClick={() => { clearHistory(); setItems([]); setOpenIdx(null); }}>
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
