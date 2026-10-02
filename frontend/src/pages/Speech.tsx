import { useEffect, useRef, useState } from "react";
import {
  Volume2,
  AlertTriangle,
  Download,
  Mic2,
  Trash2,
  Sparkles,
  FileAudio,
  Mic,
  MicOff,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { Label, Segmented } from "../kit/misc";
import { api, ElevenLabsVoice, getSessionId } from "../lib/api";

const TTS_PROVIDERS = [
  { value: "edge", label: "Edge TTS" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "deepgram", label: "Deepgram Aura" },
  { value: "kokoro", label: "Kokoro 82M" },
  { value: "openai", label: "OpenAI tts-1-hd" },
];

const STT_PROVIDERS = [
  { value: "DEEPGRAM", label: "Deepgram Nova-3" },
  { value: "GROQ_WHISPER", label: "Groq Whisper Large-v3" },
  { value: "ASSEMBLYAI", label: "AssemblyAI Conformer-2" },
  { value: "LOCAL_WHISPER", label: "Local WhisperX" },
];

const STT_LANGUAGES = [
  { value: "auto", label: "Auto Detect" },
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
];

export default function Speech() {
  const [activeTab, setActiveTab] = useState<"tts" | "stt">("tts");

  // ── TTS State ─────────────────────────────────────────────────────────────
  const [text, setText] = useState("VoiceFlow turns spoken conversations into structured business intelligence.");
  const [lang, setLang] = useState<"en" | "fr">("en");
  const [gender, setGender] = useState("default");
  const [ttsProvider, setTtsProvider] = useState("edge");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [isWav, setIsWav] = useState(false);
  const [actualProvider, setActualProvider] = useState<string | null>(null);
  const [wasTranslated, setWasTranslated] = useState(false);
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // ElevenLabs voices
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [voicesErr, setVoicesErr] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [showClone, setShowClone] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneErr, setCloneErr] = useState("");
  const [cloneMsg, setCloneMsg] = useState("");

  // ── STT State ─────────────────────────────────────────────────────────────
  const [sttProvider, setSttProvider] = useState("DEEPGRAM");
  const [sttLang, setSttLang] = useState("auto");
  const [sttFile, setSttFile] = useState<File | null>(null);
  const [sttBusy, setSttBusy] = useState(false);
  const [sttErr, setSttErr] = useState("");
  const [sttTranscript, setSttTranscript] = useState("");
  const [sttActualEngine, setSttActualEngine] = useState("");
  const [sttElapsedMs, setSttElapsedMs] = useState(0);
  const [sttIsRecording, setSttIsRecording] = useState(false);

  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<BlobPart[]>([]);

  const loadVoices = () => {
    api.ttsVoices().then((r) => { setVoices(r.voices); setVoicesErr(r.error || ""); }).catch((e) => setVoicesErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => { if (ttsProvider === "elevenlabs") loadVoices(); }, [ttsProvider]);

  const cloneVoice = async () => {
    if (!cloneName.trim() || !cloneFile) return;
    setCloneBusy(true); setCloneErr(""); setCloneMsg("");
    try {
      const result = await api.cloneVoice(cloneName.trim(), [cloneFile]);
      setCloneMsg(`Cloned "${result.name}" — selected below.`);
      setVoiceId(result.voice_id);
      setCloneName(""); setCloneFile(null);
      loadVoices();
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : String(e));
    } finally { setCloneBusy(false); }
  };

  const deleteVoice = async (id: string) => {
    try {
      await api.deleteVoice(id);
      if (voiceId === id) setVoiceId("");
      loadVoices();
    } catch (e) {
      setVoicesErr(e instanceof Error ? e.message : String(e));
    }
  };

  const runTts = async () => {
    setBusy(true); setErr("");
    const startedAt = Date.now();
    setElapsedMs(0);
    const elapsedTimer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    try {
      const res = await api.tts(text, lang, gender, ttsProvider, ttsProvider === "elevenlabs" ? voiceId || undefined : undefined);
      setIsWav(res.isWav);
      setActualProvider(res.actualProvider);
      setWasTranslated(res.translated);
      setTranslatedText(res.translatedText || null);
      setUrl((old) => { if (old) URL.revokeObjectURL(old); return res.url; });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { window.clearInterval(elapsedTimer); setBusy(false); }
  };

  const runStt = async (fileToProcess?: File) => {
    const target = fileToProcess || sttFile;
    if (!target) return;
    setSttBusy(true);
    setSttErr("");
    setSttTranscript("");
    const startedAt = Date.now();
    setSttElapsedMs(0);
    const elapsedTimer = window.setInterval(() => setSttElapsedMs(Date.now() - startedAt), 250);
    try {
      const res = await api.pipeline(target, target.name, "meeting", sttProvider, sttLang, undefined, false);
      if (res.transcript?.text) {
        setSttTranscript(res.transcript.text);
      } else {
        setSttTranscript("No speech detected in audio.");
      }
      setSttActualEngine(sttProvider);
    } catch (e) {
      setSttErr(e instanceof Error ? e.message : String(e));
    } finally {
      window.clearInterval(elapsedTimer);
      setSttBusy(false);
    }
  };

  const toggleMicRecording = async () => {
    if (sttIsRecording) {
      mediaRecRef.current?.stop();
      setSttIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micChunksRef.current = [];
      const rec = new MediaRecorder(stream);
      mediaRecRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) micChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(micChunksRef.current, { type: rec.mimeType || "audio/webm" });
        const recordedFile = new File([audioBlob], "live_recording.webm", { type: rec.mimeType || "audio/webm" });
        setSttFile(recordedFile);
        runStt(recordedFile);
      };
      rec.start();
      setSttIsRecording(true);
    } catch (e: any) {
      setSttErr(e.message || "Failed to access microphone.");
    }
  };

  return (
    <div>
      <PageHeader
        title="Speech & Voice Studio"
        sub="Comprehensive multi-engine voice suite. Choose your preferred provider for both Speech-to-Text (STT) transcription and Text-to-Speech (TTS) synthesis."
      />

      <div className="mb-4 flex items-center justify-between gap-4 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <Segmented
            value={activeTab}
            onChange={(v) => setActiveTab(v as "tts" | "stt")}
            options={[
              { value: "tts", label: "Text to Speech (TTS)" },
              { value: "stt", label: "Speech to Text (STT)" },
            ]}
          />
        </div>
      </div>

      {activeTab === "tts" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Speech Synthesis Config">
            <div className="space-y-4">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                className="w-full rounded-input border border-line-strong bg-surface-2 px-3 py-2 text-[13.5px] leading-6 text-body outline-none focus:border-[var(--accent)]"
                placeholder="Enter text to synthesize..."
              />
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <Label>TTS Provider</Label>
                  <Segmented value={ttsProvider} onChange={setTtsProvider} options={TTS_PROVIDERS} />
                </div>
                <div>
                  <Label>Language</Label>
                  <Segmented value={lang} onChange={(v) => setLang(v as "en" | "fr")} options={[{ value: "en", label: "English" }, { value: "fr", label: "Français" }]} />
                </div>
                <div>
                  <Label>Voice Tone</Label>
                  <Segmented value={gender} onChange={setGender} options={[{ value: "default", label: "Default" }, { value: "female", label: "Female" }, { value: "male", label: "Male" }]} />
                </div>
                <Button onClick={runTts} disabled={busy || !text.trim()}>
                  <Volume2 size={14} /> {busy ? "Synthesizing…" : "Synthesize Voice"}
                </Button>
              </div>

              {lang === "fr" && (
                <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-dim">
                  <Sparkles size={13} className="text-[var(--accent)] shrink-0" />
                  <span>Input text in English will automatically be translated into fluent French before voice synthesis.</span>
                </div>
              )}

              {busy && (
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="num">{(elapsedMs / 1000).toFixed(0)}s elapsed</span>
                  {elapsedMs > 15000 && (
                    <span>— still processing; initial model pipeline warming can take a few seconds.</span>
                  )}
                </div>
              )}

              {ttsProvider === "elevenlabs" && (
                <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
                  <div>
                    <Label>ElevenLabs Voice</Label>
                    <select
                      value={voiceId}
                      onChange={(e) => setVoiceId(e.target.value)}
                      className="w-full rounded-input border border-line-strong bg-bg px-3 py-2 text-[13px] text-body outline-none focus:border-[var(--accent)]"
                    >
                      <option value="">Default stock voice (by gender above)</option>
                      {voices.map((v) => (
                        <option key={v.voice_id} value={v.voice_id}>
                          {v.category === "cloned" ? "★ " : ""}{v.name}
                        </option>
                      ))}
                    </select>
                    {voicesErr && <div className="mt-1.5 text-[12px] text-warn">{voicesErr}</div>}
                  </div>

                  {voices.some((v) => v.category === "cloned") && (
                    <div className="flex flex-wrap gap-1.5">
                      {voices.filter((v) => v.category === "cloned").map((v) => (
                        <span key={v.voice_id} className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-1 text-[11.5px] text-body">
                          {v.name}
                          <button onClick={() => deleteVoice(v.voice_id)} aria-label={`Delete cloned voice ${v.name}`}>
                            <Trash2 size={11} className="text-muted hover:text-bad" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={() => setShowClone((s) => !s)}
                    className="flex items-center gap-1.5 text-[12.5px] font-medium text-dim hover:text-body"
                  >
                    <Mic2 size={13} /> {showClone ? "Cancel cloning" : "Clone a voice from an audio sample"}
                  </button>

                  {showClone && (
                    <div className="space-y-2 rounded-lg border border-dashed border-line-strong p-3">
                      <input
                        value={cloneName}
                        onChange={(e) => setCloneName(e.target.value)}
                        placeholder="Voice name"
                        className="w-full rounded-input border border-line bg-bg px-2.5 py-1.5 text-[12.5px] text-body outline-none focus:border-[var(--accent)]"
                      />
                      <label className="flex cursor-pointer items-center gap-2 rounded-input border border-line px-2.5 py-2 text-[12.5px] text-dim hover:border-[var(--accent)]">
                        {cloneFile ? cloneFile.name : "Choose audio sample (wav, mp3, m4a…)"}
                        <input type="file" accept="audio/*" className="hidden" onChange={(e) => setCloneFile(e.target.files?.[0] ?? null)} />
                      </label>
                      <Button variant="secondary" onClick={cloneVoice} disabled={cloneBusy || !cloneName.trim() || !cloneFile}>
                        <Sparkles size={13} /> {cloneBusy ? "Cloning…" : "Clone voice"}
                      </Button>
                      {cloneErr && <div className="flex items-start gap-2 text-[12px] text-bad"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{cloneErr}</div>}
                      {cloneMsg && <Chip tone="ok">{cloneMsg}</Chip>}
                    </div>
                  )}
                </div>
              )}

              {err && <div className="flex items-start gap-2 text-[13px] text-bad"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{err}</div>}
            </div>
          </Card>

          <Card title="Synthesized Audio">
            {url ? (
              <div className="space-y-3">
                {actualProvider && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={actualProvider === "elevenlabs" ? "ok" : actualProvider === "kokoro" ? "accent" : "default"}>
                      Engine: {actualProvider.toUpperCase()}
                    </Chip>
                    {actualProvider !== ttsProvider && (
                      <span className="text-[12px] text-muted">
                        (Requested {ttsProvider}, fell back to {actualProvider})
                      </span>
                    )}
                  </div>
                )}
                {wasTranslated && translatedText && (
                  <div className="rounded-lg border border-line bg-surface-2 p-2.5 text-xs text-dim">
                    <span className="font-semibold text-body">Translated to French: </span>
                    <span className="italic">{translatedText}</span>
                  </div>
                )}
                <audio controls autoPlay src={url} className="w-full" />
                <a
                  href={url}
                  download={`voiceflow-speech-${Date.now()}.${isWav ? "wav" : "mp3"}`}
                  className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] text-body hover:bg-surface-2"
                >
                  <Download size={14} /> Download {isWav ? "WAV" : "MP3"}
                </a>
              </div>
            ) : (
              <EmptyState icon={Volume2} title="Nothing synthesized yet" hint="Configure text and provider on the left and synthesize audio." />
            )}
          </Card>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Speech Recognition Config">
            <div className="space-y-4">
              <div>
                <Label>Select STT Engine</Label>
                <Segmented value={sttProvider} onChange={setSttProvider} options={STT_PROVIDERS} />
              </div>

              <div>
                <Label>Language Detection</Label>
                <Segmented value={sttLang} onChange={setSttLang} options={STT_LANGUAGES} />
              </div>

              <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted block mb-1">
                  Audio Input Source
                </span>
                <div className="flex flex-wrap gap-2.5">
                  <Button
                    variant={sttIsRecording ? "danger" : "secondary"}
                    onClick={toggleMicRecording}
                    disabled={sttBusy}
                    className="flex items-center gap-2"
                  >
                    {sttIsRecording ? <MicOff size={15} /> : <Mic size={15} />}
                    <span>{sttIsRecording ? "Stop & Transcribe" : "Record Microphone"}</span>
                  </Button>

                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-btn border border-line px-3.5 py-1.5 text-xs font-semibold text-body hover:bg-surface transition-colors">
                    <FileAudio size={14} />
                    <span>{sttFile ? sttFile.name : "Upload Audio File"}</span>
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          setSttFile(f);
                          runStt(f);
                        }
                      }}
                    />
                  </label>
                </div>

                {sttIsRecording && (
                  <div className="flex items-center gap-2 text-xs text-bad animate-pulse pt-1">
                    <div className="h-2 w-2 rounded-full bg-bad" />
                    <span>Recording microphone in real time...</span>
                  </div>
                )}
              </div>

              {sttBusy && (
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Clock size={13} className="text-dim" />
                  <span className="num">{(sttElapsedMs / 1000).toFixed(0)}s elapsed</span>
                  <span>— transcribing with {sttProvider}...</span>
                </div>
              )}

              {sttErr && (
                <div className="flex items-start gap-2 text-[13px] text-bad">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{sttErr}</span>
                </div>
              )}
            </div>
          </Card>

          <Card title="Transcription Result">
            {sttTranscript ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Chip tone="ok">
                    Engine: {sttActualEngine || sttProvider}
                  </Chip>
                  <span className="text-[11px] font-mono text-dim">
                    Completed in {sttElapsedMs}ms
                  </span>
                </div>
                <div className="rounded-xl border border-line bg-surface-2 p-4 text-[13.5px] leading-relaxed text-body whitespace-pre-wrap shadow-inner">
                  {sttTranscript}
                </div>
              </div>
            ) : (
              <EmptyState
                icon={FileAudio}
                title="No transcription yet"
                hint="Record from microphone or upload an audio file to test any speech recognition engine."
              />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
