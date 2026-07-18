import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Activity, Mic, Send, RefreshCw, Layers } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, EmptyState, Skeleton, StatTile } from "../kit/primitives";
import { api, readHistory } from "../lib/api";

/* v1 "Analytics" — real server counters (/analytics) combined with this browser's
   session history for per-mode volumes. */

type Stats = { total_analyses: number; stream_sessions: number; relays: number; by_mode: Record<string, number> };

export default function Analytics() {
  const [st, setSt] = useState<Stats | null>(null);
  const load = () => { setSt(null); api.analytics().then(setSt).catch(() => setSt({ total_analyses: 0, stream_sessions: 0, relays: 0, by_mode: {} })); };
  useEffect(load, []);

  const history = readHistory();
  const localByMode: Record<string, number> = {};
  history.forEach((h) => { localByMode[h.kind] = (localByMode[h.kind] ?? 0) + 1; });

  const modeData = Object.entries({ ...localByMode }).map(([mode, n]) => ({
    mode: mode.replace("_", " "),
    server: st?.by_mode[mode] ?? 0,
    session: n,
  }));

  return (
    <div>
      <PageHeader
        title="Analytics"
        sub="Usage across the platform. Server counters are process-wide; the per-mode chart also reflects this browser's session."
        actions={<Button variant="ghost" onClick={load} aria-label="refresh"><RefreshCw size={14} /></Button>}
      />
      {!st ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Analyses run" value={st.total_analyses} icon={Activity} sub="server-wide this session" />
            <StatTile label="Live recordings" value={st.stream_sessions} icon={Mic} sub="streamed to /stream" />
            <StatTile label="Integration relays" value={st.relays} icon={Send} sub="webhooks fired" />
            <StatTile label="This browser" value={history.length} icon={Layers} sub="conversations processed" />
          </div>

          <Card title="By intelligence mode" className="mt-5">
            {!Array.isArray(modeData) || modeData.length === 0 ? (
              <EmptyState title="No analyses yet" hint="Run a meeting, sales, support or custom analysis to populate this." />
            ) : (
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={modeData} margin={{ top: 12, right: 8, left: -20, bottom: 0 }} barGap={4}>
                    <CartesianGrid stroke="var(--grid-line)" vertical={false} />
                    <XAxis dataKey="mode" tick={{ fill: "var(--text-muted)", fontSize: 11 }} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: "var(--text-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "rgba(255,255,255,.03)" }}
                      contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", borderRadius: 12, color: "var(--text)", fontSize: 12 }} />
                    <Bar dataKey="server" name="server" fill="var(--accent)" radius={[5, 5, 0, 0]} maxBarSize={34} isAnimationActive={false} />
                    <Bar dataKey="session" name="this browser" fill="var(--accent-2)" radius={[5, 5, 0, 0]} maxBarSize={34} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
