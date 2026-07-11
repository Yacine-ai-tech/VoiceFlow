import { Link } from "react-router-dom";
import { ArrowRight, Mic, Sparkles, AudioLines, Volume2, LucideIcon } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Card } from "../kit/primitives";

const ACTIONS: { to: string; icon: LucideIcon; title: string; desc: string }[] = [
  { to: "/record", icon: Mic, title: "Start recording", desc: "Capture a live conversation and run the full speech-intelligence pipeline." },
  { to: "/analyze", icon: Sparkles, title: "Analyze a conversation", desc: "Paste a transcript or upload audio — extract action items, deal signals, CRM notes." },
  { to: "/agent", icon: AudioLines, title: "Voice agent", desc: "Live bridge to the OpenAI or Gemini Realtime API with a transparent event stream." },
  { to: "/speech", icon: Volume2, title: "Text to speech", desc: "Neural EN/FR voices synthesized by the backend — no API key needed." },
];

export default function Workspace() {
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
  return (
    <div>
      <PageHeader
        title={`${g} What conversation would you like AI to understand today?`}
        sub="VoiceFlow transforms speech into structured, actionable business data — transcription, reasoning, extraction, automation."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {ACTIONS.map((a) => (
          <Link key={a.to} to={a.to} className="group">
            <Card hover className="h-full">
              <a.icon size={20} style={{ color: "var(--accent)" }} strokeWidth={1.6} />
              <div className="mt-3 text-[15px] font-semibold text-body group-hover:underline group-hover:decoration-dotted">{a.title}</div>
              <p className="mt-1.5 text-[13px] leading-6 text-dim">{a.desc}</p>
            </Card>
          </Link>
        ))}
      </div>
      <Card title="How it works" className="mt-5">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-dim">
          {["Voice", "Transcription", "AI reasoning", "Structured extraction", "Business intelligence", "Action"].map((s, i, arr) => (
            <span key={s} className="flex items-center gap-2">
              <span className={`rounded-lg border px-2.5 py-1 ${i === 3 ? "border-[var(--accent)] text-body" : "border-line"}`}>{s}</span>
              {i < arr.length - 1 && <ArrowRight size={13} className="text-muted" />}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
