import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Mic, Square, AlertTriangle, RotateCw, Radio } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { ExecutionStages, Label, Segmented } from "../kit/misc";
import { ResultView } from "../components/Results";
import { ANALYSIS_TYPES, api, PipelineResult, saveHistory } from "../lib/api";

type Phase = "idle" | "recording" | "processing" | "done" | "error";

/* Live transcription is REAL now: audio chunks stream to WS /stream, which re-transcribes
   the growing buffer via the provider router and returns partial + final transcripts. */

export default function Record() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState("meeting");
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [liveText, setLiveText] = useState("");
  const [wsState, setWsState] = useState<"off" | "connecting" | "live" | "error">("off");
  const [activeStage, setActiveStage] = useState(0);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    window.clearInterval(timerRef.current);
    audioCtxRef.current?.close();
    wsRef.current?.close();
  }, []);

  const start = useCallback(async () => {
    setErr(""); setResult(null); setLiveText("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // open the live transcription socket
      let wsUrl;
      const baseEnv = import.meta.env.VITE_API_BASE_URL;
      if (baseEnv) {
        wsUrl = baseEnv.replace(/^http/, "ws") + "/stream";
      } else {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        wsUrl = `${proto}://${location.host}/stream`;
      }
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      setWsState("connecting");
      ws.onopen = () => setWsState("live");
      ws.onerror = () => setWsState("error");
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data);
          if (d.type === "partial" && d.text) setLiveText(d.text);
          if (d.type === "final") setLiveText(d.text || "");
        } catch { /* ignore */ }
      };

      const rec = new MediaRecorder(stream);
      mediaRef.current = rec;
      chunks.current = [];
      rec.ondataavailable = (e) => {
        chunks.current.push(e.data);
        if (ws.readyState === 1 && e.data.size > 0) e.data.arrayBuffer().then((b) => ws.send(b));
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setBlob(new Blob(chunks.current, { type: rec.mimeType || "audio/webm" }));
      };
      rec.start(2000); // emit a chunk every 2s → streamed to /stream

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        const c = canvasRef.current;
        if (c) {
          const g = c.getContext("2d")!;
          analyser.getByteFrequencyData(data);
          g.clearRect(0, 0, c.width, c.height);
          const bars = 64, bw = c.width / bars;
          for (let i = 0; i < bars; i++) {
            const v = data[Math.floor((i / bars) * data.length)] / 255;
            const h = Math.max(2, v * c.height * 0.9);
            g.fillStyle = "rgba(34,227,214,.85)";
            g.fillRect(i * bw + 1, (c.height - h) / 2, bw - 2, h);
          }
        }
        rafRef.current = requestAnimationFrame(draw);
      };
      draw();

      setElapsed(0);
      timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
      setPhase("recording");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, []);

  const stop = useCallback(() => {
    mediaRef.current?.stop();
    cancelAnimationFrame(rafRef.current);
    window.clearInterval(timerRef.current);
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: "stop" }));
    setTimeout(() => wsRef.current?.close(), 1500);
    setWsState("off");
    setPhase("idle");
  }, []);

  // keyboard shortcut: space toggles recording (v1 "keyboard shortcuts")
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        if (phase === "recording") stop();
        else if (phase !== "processing") start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, start, stop]);

  const process = async (b: Blob) => {
    setPhase("processing"); setErr(""); setActiveStage(0);
    const timer = setInterval(() => setActiveStage(s => Math.min(s + 1, 3)), 2000);
    try {
      const res = await api.pipeline(b, "recording.webm", mode);
      setResult(res);
      setPhase("done");
      saveHistory({ ts: Date.now(), kind: mode, title: `Recording · ${fmt(elapsed)}`, durationSec: elapsed, result: res });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      clearInterval(timer);
    }
  };

  useEffect(() => { if (blob && phase === "idle") void process(blob); /* eslint-disable-line */ }, [blob]);

  return (
    <div>
      <PageHeader
        title="Record"
        sub="Capture a conversation with live transcription, then run the full intelligence pipeline. Press Space to start or stop."
      />

      <Card>
        <div className="flex flex-col items-center gap-5 py-6">
          <div>
            <Label>Intelligence mode</Label>
            <Segmented value={mode} onChange={setMode} options={ANALYSIS_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
          </div>

          {phase === "recording" ? (
            <motion.button onClick={stop}
              className="flex h-20 w-20 items-center justify-center rounded-full border-2"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
              animate={{ boxShadow: ["0 0 0 0 rgba(255,107,107,.35)", "0 0 0 16px rgba(255,107,107,0)"] }}
              transition={{ repeat: Infinity, duration: 1.4 }} aria-label="stop recording">
              <Square size={26} fill="currentColor" />
            </motion.button>
          ) : (
            <button onClick={start} disabled={phase === "processing"}
              className="flex h-20 w-20 items-center justify-center rounded-full text-[var(--accent-contrast)] shadow-card transition-transform hover:scale-105 disabled:opacity-40"
              style={{ background: "var(--accent-grad)" }} aria-label="start recording">
              <Mic size={28} />
            </button>
          )}

          <div className="num flex items-center gap-3 text-sm text-muted">
            {phase === "recording" ? (
              <>
                <span className="flex items-center gap-2 text-body">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--danger)" }} />
                  Recording · {fmt(elapsed)}
                </span>
                <Chip tone={wsState === "live" ? "ok" : wsState === "error" ? "bad" : "warn"}>
                  <Radio size={11} /> {wsState === "live" ? "transcribing" : wsState}
                </Chip>
              </>
            ) : phase === "processing" ? "Processing…" : "Click or press Space to start"}
          </div>

          <canvas ref={canvasRef} width={900} height={80} className={`w-full max-w-2xl ${phase === "recording" ? "" : "opacity-20"}`} />

          {(liveText || phase === "recording") && (
            <div className="w-full max-w-2xl rounded-xl border border-line bg-surface-2 px-4 py-3">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Live transcript</div>
              <p className="min-h-[24px] text-[13.5px] leading-6 text-dim">{liveText || <span className="text-muted">listening…</span>}</p>
            </div>
          )}

          {phase === "processing" && (
            <ExecutionStages stages={["Uploading audio", "Transcribing speech", "AI reasoning", "Structuring intelligence"]} active={activeStage} />
          )}
        </div>
      </Card>

      {phase === "error" && (
        <Card className="mt-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-bad" />
            <div>
              <div className="text-sm font-semibold text-body">Pipeline failed</div>
              <div className="mt-1 text-[13px] text-dim">{err}</div>
              {blob && <Button variant="secondary" className="mt-3" onClick={() => process(blob)}><RotateCw size={13} /> Retry</Button>}
            </div>
          </div>
        </Card>
      )}

      {phase === "done" && result && (
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2">
            <Chip tone="ok">pipeline complete</Chip>
            <Chip className="num">{fmt(elapsed)} audio</Chip>
          </div>
          <ResultView transcript={result.transcript} analysis={result.analysis} analysisType={result.analysis_type} />
        </div>
      )}

      {phase === "idle" && !result && (
        <Card className="mt-4">
          <EmptyState icon={Mic} title="Nothing recorded yet"
            hint="Audio streams to the server live for incremental transcription; on stop it runs the full /pipeline (transcription + Claude reasoning)." />
        </Card>
      )}
    </div>
  );
}

function fmt(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
