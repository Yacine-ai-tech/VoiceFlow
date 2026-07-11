import { useState } from "react";
import { motion } from "framer-motion";
import { Webhook, Slack, Send, Check, AlertTriangle, Boxes } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip } from "../kit/primitives";
import { Label } from "../kit/misc";
import { JSONViewer } from "../kit/JSONViewer";
import { api, readHistory } from "../lib/api";

/* v1 "Integrations" — REAL: the server relays structured output to any webhook
   (Slack incoming webhook, Zapier/n8n catch hook, custom endpoint). The browser can't
   POST cross-origin, so /integrations/relay does it server-side. */

const TARGETS = [
  { icon: Slack, label: "Slack", hint: "Incoming Webhook URL — posts a JSON message to a channel" },
  { icon: Boxes, label: "n8n / Zapier", hint: "Catch-hook URL — triggers a workflow with the payload" },
  { icon: Webhook, label: "Custom webhook", hint: "Any HTTPS endpoint that accepts a JSON POST" },
];

export default function Integrations() {
  const history = readHistory();
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<"latest" | "custom">("latest");
  const [custom, setCustom] = useState('{\n  "event": "voiceflow.result",\n  "summary": "..."\n}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; status: number; response: string } | null>(null);
  const [err, setErr] = useState("");

  const latest = history[0];

  const send = async () => {
    setBusy(true); setErr(""); setResult(null);
    try {
      const payload = source === "latest"
        ? (latest ? { event: "voiceflow.result", kind: latest.kind, title: latest.title, ...latest.result } : {})
        : JSON.parse(custom);
      setResult(await api.relay(url, payload));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader
        title="Integrations"
        sub="Push structured output to the tools your team already uses. The server relays the payload to any webhook you point it at."
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        {TARGETS.map((t) => (
          <Card key={t.label}>
            <t.icon size={18} style={{ color: "var(--accent)" }} strokeWidth={1.7} />
            <div className="mt-3 text-[15px] font-semibold text-body">{t.label}</div>
            <p className="mt-1.5 text-[13px] leading-6 text-dim">{t.hint}</p>
          </Card>
        ))}
      </div>

      <Card title="Send to a webhook">
        <div className="space-y-4">
          <div>
            <Label>Webhook URL</Label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…"
              className="w-full rounded-input border border-line-strong bg-surface-2 px-3 py-2 text-sm text-body outline-none focus:border-[var(--accent)]" />
          </div>
          <div>
            <Label>Payload</Label>
            <div className="mb-2 flex gap-2">
              <button onClick={() => setSource("latest")} className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${source === "latest" ? "border-[var(--accent)] text-body" : "border-line text-muted"}`} disabled={!latest}>
                Latest result {latest ? `· ${latest.kind}` : "(none yet)"}
              </button>
              <button onClick={() => setSource("custom")} className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${source === "custom" ? "border-[var(--accent)] text-body" : "border-line text-muted"}`}>
                Custom JSON
              </button>
            </div>
            {source === "custom" ? (
              <textarea value={custom} onChange={(e) => setCustom(e.target.value)} rows={6}
                className="num w-full rounded-input border border-line-strong bg-surface-2 px-3 py-2 font-mono text-[12px] text-body outline-none focus:border-[var(--accent)]" />
            ) : latest ? (
              <JSONViewer data={{ event: "voiceflow.result", kind: latest.kind, title: latest.title, ...latest.result }} maxHeight={220} />
            ) : (
              <div className="rounded-xl border border-line bg-surface-2 p-4 text-[13px] text-muted">Analyze a conversation first — its result becomes the payload.</div>
            )}
          </div>
          <Button onClick={send} disabled={busy || !url}>
            <Send size={14} /> {busy ? "Relaying…" : "Send"}
          </Button>
          {err && <div className="flex items-start gap-2 text-[13px] text-bad"><AlertTriangle size={14} className="mt-0.5" />{err}</div>}
          {result && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px]">
              {result.ok ? <Check size={15} className="text-ok" /> : <AlertTriangle size={15} className="text-bad" />}
              <Chip tone={result.ok ? "ok" : "bad"} className="num">HTTP {result.status}</Chip>
              <span className="truncate text-dim">{result.response || "(empty response)"}</span>
            </motion.div>
          )}
        </div>
      </Card>
    </div>
  );
}
