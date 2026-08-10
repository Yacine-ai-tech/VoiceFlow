import { AudioWaveform, BrainCircuit, Volume2 } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Card, Chip } from "../kit/primitives";

/* Factual routing page — providers and model IDs verified against
   services/transcription_router.py and core/config.py. */

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
            <div><Chip tone="accent">GROQ</Chip> fast, cheap Whisper — the "fast" scenario's default.</div>
            <div><Chip>DEEPGRAM</Chip> nova-3, best diarization of the cloud options.</div>
            <div><Chip>ASSEMBLYAI</Chip> native diarization, strong streaming.</div>
            <div><Chip>REMOTE</Chip> your own WhisperX+diarization endpoint (<code className="font-mono text-[11px]">VOICEFLOW_REMOTE_ENDPOINT</code>) — a black box; run whatever engine you want behind it.</div>
            <div><Chip>LOCAL_WHISPERX</Chip> private on-host WhisperX (default local engine); returns an explicit error when unavailable, never a silent guess.</div>
            <div><Chip>NEMO CANARY</Chip> research-SOTA local alternative (<code className="font-mono text-[11px]">LOCAL_ASR_ENGINE=nemo_canary</code>), GPU-recommended.</div>
          </div>
        </Card>

        <Card hover>
          <BrainCircuit size={20} style={{ color: "var(--accent)" }} strokeWidth={1.6} />
          <div className="mt-3 text-[15px] font-semibold text-body">Intelligence extraction</div>
          <div className="num mt-0.5 font-mono text-[11.5px] text-muted">Configured via LiteLLM (Groq, Anthropic, or Gemini)</div>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            Turns transcripts into typed structures — five real schemas: meeting notes
            (action items with owners/deadlines), sales calls (deal stage, objections,
            CRM-paste-ready notes), support calls, interviews, and general extraction. Each
            type routes to a different model tier — see the Benchmark page.
          </p>
        </Card>

        <Card hover>
          <Volume2 size={20} style={{ color: "var(--accent)" }} strokeWidth={1.6} />
          <div className="mt-3 text-[15px] font-semibold text-body">Speech synthesis</div>
          <div className="mt-3 space-y-2 text-[13px] leading-6 text-dim">
            <div><Chip tone="accent">EDGE-TTS</Chip> default, no API key, EN/FR.</div>
            <div><Chip>ELEVENLABS</Chip> premium quality + real Instant Voice Cloning — clone a voice from a real audio sample on the Speech page (<code className="font-mono text-[11px]">POST /tts/voices/clone</code>), not just 2 stock voice IDs.</div>
            <div><Chip>OPENAI</Chip> tts-1-hd.</div>
            <div><Chip>KOKORO</Chip> open-source, self-hosted, no API key.</div>
          </div>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            Every non-default provider falls back to edge-tts automatically on failure. Streaming
            audio straight from the <code className="font-mono text-[12px]">/tts</code> endpoint.
          </p>
        </Card>
      </div>

      <Card title="Diarization &amp; local vs. remote compute" className="mt-5">
        <p className="text-[13px] leading-6 text-dim">
          Speaker diarization is engine-selectable (<code className="font-mono text-[12px]">LOCAL_DIARIZATION_ENGINE</code>):
          <Chip tone="accent">PYANNOTE</Chip> (default, needs <code className="font-mono text-[12px]">HF_TOKEN</code>, GPU-recommended) or
          <Chip>NEMO</Chip> (CPU-capable alternative). If neither is available, the transcript comes back without
          speaker labels — <code className="font-mono text-[12px]">diarized: false</code>, honestly, never a fabricated result.
        </p>
        <p className="mt-3 text-[13px] leading-6 text-dim">
          Every heavy local model (WhisperX, NeMo Canary, pyannote/NeMo diarization, Kokoro TTS) can run
          directly on this host, or be delegated to a remote host you control instead — a decision made
          per-capability via environment variables, not a single global switch. See <code className="font-mono text-[12px]">docs/ASR_PROVIDERS.md</code> for
          the full local-vs-remote guide.
        </p>
      </Card>

      <Card title="Named scenarios — for reproducible comparisons" className="mt-5">
        <p className="text-[13px] leading-6 text-dim">
          <code className="font-mono text-[12px]">POST /pipeline</code> with a <code className="font-mono text-[12px]">scenario</code> field
          (<code className="font-mono text-[12px]">fast</code>, <code className="font-mono text-[12px]">accurate</code>, <code className="font-mono text-[12px]">cheap</code>, <code className="font-mono text-[12px]">streaming</code>)
          pins an exact provider + diarization + model combination with no fallback substitution —
          a failure is reported honestly instead of silently running on a different provider than
          the one requested. See <code className="font-mono text-[12px]">GET /scenarios</code> for the full catalog — the same selector is
          available right on the Analyze page.
        </p>
      </Card>

      <Card title="Realtime voice agent" className="mt-5">
        <p className="text-[13px] leading-6 text-dim">
          The <code className="font-mono text-[12px]">/realtime</code> WebSocket is a true bidirectional
          relay to the OpenAI Realtime API (<code className="font-mono text-[12px]">gpt-4o-realtime-preview</code>)
          or the Gemini Multimodal Live API — <code className="font-mono text-[12px]">REALTIME_PROVIDER</code> is
          an explicit choice, not auto-detected, and there is no fallback between them. Without the matching key the
          server says so explicitly rather than simulating a conversation. If <code className="font-mono text-[12px]">AGENT_TOOLS_URL</code> is
          set, the model can also call whatever tools that service exposes mid-conversation — see the Voice Agent page.
        </p>
      </Card>
    </div>
  );
}
