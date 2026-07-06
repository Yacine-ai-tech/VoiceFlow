import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Mic, Square, AlertTriangle, RotateCw } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { ExecutionStages, Label, Segmented } from "../kit/misc";
import { ResultView } from "../components/Results";
import { ANALYSIS_TYPES, api, PipelineResult, saveHistory } from "../lib/api";

type Phase = "idle" | "recording" | "processing" | "done" | "error";

export default function Record() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState("meeting");
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef(0);

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); window.clearInterval(timerRef.current); audioCtxRef.current?.close(); }, []);

  const start = async () => {
    setErr(""); setResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      mediaRef.current = rec;
      chunks.current = [];
      rec.ondataavailable = (e) => chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setBlob(new Blob(chunks.current, { type: rec.mimeType || "audio/webm" }));
      };
      rec.start();

      // real waveform from the live mic signal (WebAudio analyser)
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
          const bars = 64;
          const bw = c.width / bars;
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
  };

  const stop = () => {
    mediaRef.current?.stop();
    cancelAnimationFrame(rafRef.current);
    window.clearInterval(timerRef.current);
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setPhase("idle");
  };

  const process = async (b: Blob) => {
    setPhase("processing");
    setErr("");
    try {
      const res = await api.pipeline(b, "recording.webm", mode);
      setResult(res);
      setPhase("done");
      saveHistory({
        ts: Date.now(),
        kind: mode,
        title: `Recording · ${fmt(elapsed)}`,
        durationSec: elapsed,
        result: res,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    if (blob && phase === "idle") void process(blob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob]);

  return (
    <div>
      <PageHeader
        title="Record"
        sub="Capture a conversation and run it through the real speech-intelligence pipeline: transcription, AI reasoning, structured extraction."
      />

      <Card>
        <div className="flex flex-col items-center gap-5 py-6">
          <div>
            <Label>Intelligence mode</Label>
            <Segmented value={mode} onChange={setMode} options={ANALYSIS_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
          </div>

          {phase === "recording" ? (
            <motion.button
              onClick={stop}
              className="flex h-20 w-20 items-center justify-center rounded-full border-2"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
              animate={{ boxShadow: ["0 0 0 0 rgba(255,107,107,.35)", "0 0 0 16px rgba(255,107,107,0)"] }}
              transition={{ repeat: Infinity, duration: 1.4 }}
              aria-label="stop recording"
            >
              <Square size={26} fill="currentColor" />
            </motion.button>
          ) : (
            <button
              onClick={start}
              disabled={phase === "processing"}
              className="flex h-20 w-20 items-center justify-center rounded-full text-[var(--accent-contrast)] shadow-card transition-transform hover:scale-105 disabled:opacity-40"
              style={{ background: "var(--accent-grad)" }}
              aria-label="start recording"
            >
              <Mic size={28} />
            </button>
          )}

          <div className="num text-sm text-muted">
            {phase === "recording" ? (
              <span className="flex items-center gap-2 text-body">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--danger)" }} />
                Recording · {fmt(elapsed)} — click to stop &amp; analyze
              </span>
            ) : phase === "processing" ? (
              "Processing…"
            ) : (
              "Click to start recording"
            )}
          </div>

          <canvas ref={canvasRef} width={900} height={80} className={`w-full max-w-2xl ${phase === "recording" ? "" : "opacity-20"}`} />

          {phase === "processing" && (
            <ExecutionStages stages={["Uploading audio", "Transcribing speech", "AI reasoning", "Structuring intelligence"]} active={1} />
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
              {blob && (
                <Button variant="secondary" className="mt-3" onClick={() => process(blob)}>
                  <RotateCw size={13} /> Retry with same audio
                </Button>
              )}
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
          <EmptyState
            icon={Mic}
            title="Nothing recorded yet"
            hint="Recording stays in your browser until you stop — then it runs through the real /pipeline endpoint (transcription provider + Claude reasoning)."
          />
        </Card>
      )}
    </div>
  );
}

function fmt(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
