import { AudioWaveform, BrainCircuit, Volume2 } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Card, Chip } from "../kit/primitives";

/* Factual routing page — providers and model IDs verified against
   services/transcription_router.py and core/config.py (GAP_REPORT §1). */

export default function Models() {
  return (
    <div>
      <PageHeader
        title="Model routing"
        sub="VoiceFlow routes each stage to the best available provider — and every response names the provider that actually handled it."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card hover>
          <AudioWaveform size={20} style={{ color: "var(--accent)" }} strokeWidth={1.6} />
          <div className="mt-3 text-[15px] font-semibold text-body">Speech recognition</div>
          <div className="mt-3 space-y-2 text-[13px] leading-6 text-dim">
            <div><Chip tone="accent">GROQ_WHISPER</Chip> Whisper large on Groq — fast cloud STT (used when a Groq key is configured; the live deployment's default).</div>
            <div><Chip>DEEPGRAM</Chip> / <Chip>ASSEMBLYAI</Chip> alternate cloud providers, key-gated.</div>
            <div><Chip>LOCAL_WHISPERX</Chip> private on-host WhisperX; the API returns an explicit error when it is unavailable.</div>
          </div>
        </Card>

        <Card hover>
          <BrainCircuit size={20} style={{ color: "var(--accent)" }} strokeWidth={1.6} />
          <div className="mt-3 text-[15px] font-semibold text-body">Intelligence extraction</div>
          <div className="num mt-0.5 font-mono text-[11.5px] text-muted">anthropic/claude-sonnet-4-6</div>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            Claude reasoning turns transcripts into typed structures — five real schemas: meeting
            notes (action items with owners/deadlines), sales calls (deal stage, objections,
            CRM-paste-ready notes), support calls, interviews, and general extraction.
          </p>
        </Card>

        <Card hover>
          <Volume2 size={20} style={{ color: "var(--accent)" }} strokeWidth={1.6} />
          <div className="mt-3 text-[15px] font-semibold text-body">Speech synthesis</div>
          <div className="num mt-0.5 font-mono text-[11.5px] text-muted">edge-tts neural voices</div>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            English and French neural voices with gender selection, no API key required. Streaming
            MP3 straight from the <code className="font-mono text-[12px]">/tts</code> endpoint.
          </p>
        </Card>
      </div>

      <Card title="Realtime voice agent" className="mt-5">
        <p className="text-[13px] leading-6 text-dim">
          The <code className="font-mono text-[12px]">/realtime</code> WebSocket is a true bidirectional
          relay to the OpenAI Realtime API (<code className="font-mono text-[12px]">gpt-4o-realtime-preview</code>).
          It is key-gated: without <code className="font-mono text-[12px]">OPENAI_API_KEY</code> the server says so
          explicitly rather than simulating a conversation — see the Voice Agent page.
        </p>
      </Card>
    </div>
  );
}
