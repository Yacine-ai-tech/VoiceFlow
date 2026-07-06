import { useEffect, useRef, useState } from "react";
import { AudioLines, Plug, PlugZap, SendHorizontal, TriangleAlert } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { JSONViewer } from "../kit/JSONViewer";

/* Real bridge: WS /realtime relays bidirectionally to OpenAI Realtime.
   Honest states: when the deployment has no OPENAI_API_KEY the server sends
   {type:"error"} and closes — we show that, not a fake demo. Text-mode
   conversation uses standard Realtime events. */

type Msg = { role: "user" | "assistant"; text: string };

export default function VoiceAgent() {
  const [state, setState] = useState<"connecting" | "ready" | "unconfigured" | "closed" | "error">("connecting");
  const [statusMsg, setStatusMsg] = useState("");
  const [events, setEvents] = useState<{ type: string; at: number; raw: unknown }[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const draft = useRef("");

  const connect = () => {
    setState("connecting"); setEvents([]); setMsgs([]);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/realtime`);
    wsRef.current = ws;
    ws.onmessage = (m) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(m.data); } catch { return; }
      const type = String(data.type ?? "unknown");
      setEvents((e) => [{ type, at: Date.now(), raw: data }, ...e].slice(0, 80));

      if (type === "error" && String(data.message ?? "").includes("OPENAI_API_KEY")) {
        setState("unconfigured");
        setStatusMsg(String(data.message));
        return;
      }
      if (type === "ready") { setState("ready"); setStatusMsg(String(data.message ?? "")); return; }
      if (type === "response.text.delta" || type === "response.audio_transcript.delta") {
        draft.current += String(data.delta ?? "");
        setMsgs((old) => {
          const rest = old[old.length - 1]?.role === "assistant" ? old.slice(0, -1) : old;
          return [...rest, { role: "assistant", text: draft.current }];
        });
      }
      if (type === "response.done") draft.current = "";
    };
    ws.onclose = () => setState((s) => (s === "unconfigured" ? s : "closed"));
    ws.onerror = () => setState((s) => (s === "unconfigured" ? s : "error"));
  };

  useEffect(() => { connect(); return () => wsRef.current?.close(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const send = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1 || !input.trim()) return;
    const text = input.trim();
    setMsgs((m) => [...m, { role: "user", text }]);
    setInput("");
    draft.current = "";
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    }));
    ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["text"] } }));
  };

  return (
    <div>
      <PageHeader
        title="Voice agent"
        sub="A live bridge to the OpenAI Realtime API — the backend relays this browser session bidirectionally over WebSocket."
        actions={
          <Chip tone={state === "ready" ? "ok" : state === "connecting" ? "warn" : "bad"}>
            {state === "ready" ? <PlugZap size={11} /> : <Plug size={11} />} {state}
          </Chip>
        }
      />

      {state === "unconfigured" ? (
        <Card>
          <div className="flex items-start gap-3">
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <div className="text-sm font-semibold text-body">Realtime agent not configured on this deployment</div>
              <p className="mt-1 max-w-xl text-[13px] leading-6 text-dim">
                The server reported: <em>{statusMsg}</em> The relay is fully implemented and
                activates the moment an <code className="font-mono text-[12px]">OPENAI_API_KEY</code>{" "}
                is set in the environment. No simulated conversation is displayed.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <Card title="Conversation" noPad className="flex min-h-[420px] flex-col overflow-hidden">
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {msgs.length === 0 ? (
                <EmptyState icon={AudioLines} title={state === "ready" ? "Connected — say something" : "Waiting for connection…"} hint="Text-mode conversation over the live Realtime relay." />
              ) : (
                msgs.map((m, i) => (
                  <div key={i} className={`max-w-[85%] rounded-2xl border border-line px-4 py-2.5 text-[13.5px] leading-6 ${m.role === "user" ? "ml-auto bg-surface-2 text-body" : "bg-surface text-dim"}`}>
                    {m.text}
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-line p-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                disabled={state !== "ready"}
                placeholder={state === "ready" ? "Message the agent…" : "Not connected"}
                className="min-w-0 flex-1 rounded-input border border-line-strong bg-surface-2 px-3 py-2 text-sm text-body outline-none focus:border-[var(--accent)] disabled:opacity-40"
              />
              <Button onClick={send} disabled={state !== "ready"}><SendHorizontal size={14} /></Button>
              {(state === "closed" || state === "error") && (
                <Button variant="secondary" onClick={connect}>Reconnect</Button>
              )}
            </div>
          </Card>

          <Card title="Event stream" noPad className="overflow-hidden">
            {events.length === 0 ? (
              <EmptyState title="No events yet" hint="Every raw Realtime event appears here as it crosses the relay." />
            ) : (
              <div className="max-h-[420px] divide-y divide-[var(--border)] overflow-y-auto">
                {events.map((e, i) => (
                  <details key={i} className="group px-4 py-2">
                    <summary className="flex cursor-pointer items-center justify-between text-[12px] text-dim">
                      <span className="truncate font-mono">{e.type}</span>
                      <span className="num ml-2 shrink-0 text-[10.5px] text-muted">{new Date(e.at).toLocaleTimeString()}</span>
                    </summary>
                    <div className="pb-2 pt-1"><JSONViewer data={e.raw} maxHeight={180} /></div>
                  </details>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
