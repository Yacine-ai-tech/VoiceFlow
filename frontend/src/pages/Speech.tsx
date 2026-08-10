import { useEffect, useState } from "react";
import { Volume2, AlertTriangle, Download, Mic2, Trash2, Sparkles } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip, EmptyState } from "../kit/primitives";
import { Label, Segmented } from "../kit/misc";
import { api, ElevenLabsVoice } from "../lib/api";

const PROVIDERS = [
  { value: "edge", label: "Edge (default)" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "openai", label: "OpenAI tts-1-hd" },
  { value: "kokoro", label: "Kokoro" },
];

export default function Speech() {
  const [text, setText] = useState("VoiceFlow turns spoken conversations into structured business intelligence.");
  const [lang, setLang] = useState<"en" | "fr">("en");
  const [gender, setGender] = useState("default");
  const [provider, setProvider] = useState("edge");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [isWav, setIsWav] = useState(false);

  // ElevenLabs voices — stock library voices + real cloned ones.
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [voicesErr, setVoicesErr] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [showClone, setShowClone] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneErr, setCloneErr] = useState("");
  const [cloneMsg, setCloneMsg] = useState("");

  const loadVoices = () => {
    api.ttsVoices().then((r) => { setVoices(r.voices); setVoicesErr(r.error || ""); }).catch((e) => setVoicesErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => { if (provider === "elevenlabs") loadVoices(); }, [provider]);

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

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const { url: u, isWav: wav } = await api.tts(text, lang, gender, provider, provider === "elevenlabs" ? voiceId || undefined : undefined);
      setIsWav(wav);
      setUrl((old) => { if (old) URL.revokeObjectURL(old); return u; });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader
        title="Text to speech"
        sub="Four providers — edge-tts (default, no key), ElevenLabs, OpenAI tts-1-hd, or self-hosted Kokoro. Every non-default provider falls back to edge-tts automatically if it isn't configured."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Input">
          <div className="space-y-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="w-full rounded-input border border-line-strong bg-surface-2 px-3 py-2 text-[13.5px] leading-6 text-body outline-none focus:border-[var(--accent)]"
            />
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <Label>Provider</Label>
                <Segmented value={provider} onChange={setProvider} options={PROVIDERS} />
              </div>
              <div>
                <Label>Language</Label>
                <Segmented value={lang} onChange={(v) => setLang(v as "en" | "fr")} options={[{ value: "en", label: "English" }, { value: "fr", label: "Français" }]} />
              </div>
              <div>
                <Label>Voice</Label>
                <Segmented value={gender} onChange={setGender} options={[{ value: "default", label: "Default" }, { value: "female", label: "Female" }, { value: "male", label: "Male" }]} />
              </div>
              <Button onClick={run} disabled={busy || !text.trim()}>
                <Volume2 size={14} /> {busy ? "Synthesizing…" : "Speak"}
              </Button>
            </div>

            {provider === "elevenlabs" && (
              <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
                <div>
                  <Label>ElevenLabs voice</Label>
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
                      {cloneFile ? cloneFile.name : "Choose a real audio sample (wav, mp3, m4a…)"}
                      <input type="file" accept="audio/*" className="hidden" onChange={(e) => setCloneFile(e.target.files?.[0] ?? null)} />
                    </label>
                    <Button variant="secondary" onClick={cloneVoice} disabled={cloneBusy || !cloneName.trim() || !cloneFile}>
                      <Sparkles size={13} /> {cloneBusy ? "Cloning…" : "Clone voice"}
                    </Button>
                    <p className="text-[11.5px] leading-5 text-muted">
                      Real ElevenLabs Instant Voice Cloning — requires a plan that supports it
                      (<code className="font-mono">can_use_instant_voice_cloning</code>); a free-tier
                      account will report ElevenLabs' own upgrade message here, not a generic failure.
                    </p>
                    {cloneErr && <div className="flex items-start gap-2 text-[12px] text-bad"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{cloneErr}</div>}
                    {cloneMsg && <Chip tone="ok">{cloneMsg}</Chip>}
                  </div>
                )}
              </div>
            )}

            {err && <div className="flex items-start gap-2 text-[13px] text-bad"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{err}</div>}
          </div>
        </Card>
        <Card title="Audio">
          {url ? (
            <div className="space-y-3">
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
            <EmptyState icon={Volume2} title="Nothing synthesized yet" hint="Type text on the left and generate real speech from the /tts endpoint." />
          )}
        </Card>
      </div>
    </div>
  );
}
