import { useState } from "react";
import { Volume2, AlertTriangle } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, EmptyState } from "../kit/primitives";
import { Label, Segmented } from "../kit/misc";
import { api } from "../lib/api";

export default function Speech() {
  const [text, setText] = useState("VoiceFlow turns spoken conversations into structured business intelligence.");
  const [lang, setLang] = useState<"en" | "fr">("en");
  const [gender, setGender] = useState("default");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const u = await api.tts(text, lang, gender);
      setUrl((old) => { if (old) URL.revokeObjectURL(old); return u; });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader
        title="Text to speech"
        sub="Neural TTS via edge-tts — English and French voices, no API key required. The audio below is generated live by the backend."
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
            {err && <div className="flex items-start gap-2 text-[13px] text-bad"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{err}</div>}
          </div>
        </Card>
        <Card title="Audio">
          {url ? (
            <audio controls autoPlay src={url} className="w-full" />
          ) : (
            <EmptyState icon={Volume2} title="Nothing synthesized yet" hint="Type text on the left and generate real speech from the /tts endpoint." />
          )}
        </Card>
      </div>
    </div>
  );
}
