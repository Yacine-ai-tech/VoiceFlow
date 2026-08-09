import {
  Mic, Sparkles, AudioLines, Volume2, Webhook, Compass, Code2,
  GitFork, Scale, Package, ShieldCheck,
} from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Card, Chip } from "../kit/primitives";

/* User-facing guide — kept in sync with the real feature set (services/*,
   api.py, ARCHITECTURE.md). No fabricated capabilities. */

export default function UserGuidePage() {
  return (
    <div>
      <PageHeader
        title="User guide"
        sub="How to use the live demo, reuse the API in your own project, what you can build by cloning this repo, and the licensing that applies either way."
      />

      <div className="space-y-5">
        <Card title={<span className="flex items-center gap-2"><Compass size={16} style={{ color: "var(--accent)" }} /> Using the live demo</span>}>
          <p className="text-[13px] leading-6 text-dim">
            Every page in the sidebar is a real feature, not a mockup — there's no seeded or fake
            data anywhere in this app. Start on <strong className="text-body">Workspace</strong> and
            launch from there, or jump straight to a page:
          </p>
          <div className="mt-3 space-y-2 text-[13px] leading-6 text-dim">
            <div><Chip tone="accent">RECORD</Chip> capture from your microphone with a live waveform; streams partial captions over <code className="font-mono text-[12px]">WS /stream</code> while you talk, then runs the full clip through <code className="font-mono text-[12px]">/pipeline</code> when you stop.</div>
            <div><Chip tone="accent">ANALYZE</Chip> paste a transcript or upload an audio file, pick one of 5 analysis types (or define your own field schema), optionally pin a named scenario for reproducible provider/model selection.</div>
            <div><Chip tone="accent">VOICE AGENT</Chip> a live, two-way spoken conversation with an LLM — talk, it replies out loud in real time, and you can interrupt it mid-sentence.</div>
            <div><Chip tone="accent">TEXT TO SPEECH</Chip> type text, pick a provider (edge / ElevenLabs / OpenAI / Kokoro), get back real synthesized audio with a download link.</div>
            <div><Chip tone="accent">INTEGRATIONS</Chip> push a result to a Slack, n8n, Zapier, or custom webhook — the server relays it so your browser doesn't need CORS access to that third-party URL.</div>
            <div><Chip tone="accent">ANALYTICS</Chip> your own browser's usage counters only — never anyone else's.</div>
            <div><Chip tone="accent">HISTORY</Chip> your last 30 results, kept in this browser's <code className="font-mono text-[12px]">localStorage</code>, never sent to a server-side database.</div>
            <div><Chip tone="accent">MODELS / API DOCS / BENCHMARK</Chip> reference pages — real provider routing, real endpoint contracts, real measured (or honestly-empty) benchmark reports.</div>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Mic size={16} style={{ color: "var(--accent)" }} /> Transcription</span>}>
          <p className="text-[13px] leading-6 text-dim">
            Audio is routed through a provider chain: local transcription first when
            <code className="font-mono text-[12px]"> VOICEFLOW_TRANSCRIPTION_MODE=local</code> (or no remote endpoint is
            configured), otherwise it walks the remote chain — your own <code className="font-mono text-[12px]">VOICEFLOW_REMOTE_ENDPOINT</code>,
            then Groq, Deepgram, and AssemblyAI, in whichever order <code className="font-mono text-[12px]">ASR_PROVIDER</code> lists.
            Local mode is itself engine-selectable (<code className="font-mono text-[12px]">LOCAL_ASR_ENGINE</code>: WhisperX or
            NeMo Canary). You can also force a specific provider per request.
          </p>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            Turn on <strong className="text-body">diarize</strong> to attach speaker labels — real
            RTTM-based diarization via pyannote or NeMo's clustering diarizer
            (<code className="font-mono text-[12px]">LOCAL_DIARIZATION_ENGINE</code>), whichever is configured. If neither is
            available the transcript still comes back, just without labels — the response's
            <code className="font-mono text-[12px]"> diarized</code> field always tells you the truth, never a fabricated
            <code className="font-mono text-[12px]"> true</code>.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Sparkles size={16} style={{ color: "var(--accent)" }} /> Meeting & call analysis</span>}>
          <p className="text-[13px] leading-6 text-dim">
            The Analyze page (and <code className="font-mono text-[12px]">/pipeline</code>,
            <code className="font-mono text-[12px]"> /meeting/process</code>, <code className="font-mono text-[12px]">/call/analyze</code>) turn
            a transcript into structured JSON via one of five analysis types, each routed to a
            model chosen for the reasoning it needs:
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-dim">
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 font-medium">Extracts</th>
                </tr>
              </thead>
              <tbody className="text-dim">
                <tr className="border-b border-line"><td className="py-2 pr-4 font-mono text-[12px] text-body">meeting</td><td className="py-2 pr-4 font-mono text-[11.5px]">groq/llama-3.3-70b-versatile</td><td className="py-2">Summary, action items, decisions, sentiment, next steps</td></tr>
                <tr className="border-b border-line"><td className="py-2 pr-4 font-mono text-[12px] text-body">general</td><td className="py-2 pr-4 font-mono text-[11.5px]">groq/llama-3.3-70b-versatile</td><td className="py-2">Open-ended structured extraction, no fixed schema</td></tr>
                <tr className="border-b border-line"><td className="py-2 pr-4 font-mono text-[12px] text-body">sales_call</td><td className="py-2 pr-4 font-mono text-[11.5px]">anthropic/claude-sonnet-4-6</td><td className="py-2">Pain points, objections, buying signals, deal stage, CRM notes</td></tr>
                <tr className="border-b border-line"><td className="py-2 pr-4 font-mono text-[12px] text-body">interview</td><td className="py-2 pr-4 font-mono text-[11.5px]">anthropic/claude-sonnet-4-6</td><td className="py-2">Strengths, gaps, key quotes, hire/no-hire recommendation</td></tr>
                <tr><td className="py-2 pr-4 font-mono text-[12px] text-body">support_call</td><td className="py-2 pr-4 font-mono text-[11.5px]">anthropic/claude-haiku-4-5</td><td className="py-2">Issue summary, severity, escalation flag, follow-ups</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            Need fields these five don't cover? Custom extraction mode names your own field list
            (plus optional instructions) and returns exactly that schema. For reproducible
            comparisons across providers, pin a named <strong className="text-body">scenario</strong> on
            <code className="font-mono text-[12px]"> /pipeline</code> instead of a raw provider — see the Models page and
            <code className="font-mono text-[12px]"> GET /scenarios</code>.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><AudioLines size={16} style={{ color: "var(--accent)" }} /> Real-time voice agent</span>}>
          <p className="text-[13px] leading-6 text-dim">
            The Voice Agent page opens <code className="font-mono text-[12px]">WS /realtime</code> and waits for
            "ready", then relays your microphone audio to whichever provider
            <code className="font-mono text-[12px]"> REALTIME_PROVIDER</code> selects — <strong className="text-body">a
            deliberate, fixed choice, not automatic detection based on which API key happens to be
            present</strong>. <code className="font-mono text-[12px]">openai</code> (default) uses the OpenAI Realtime API;
            <code className="font-mono text-[12px]"> gemini</code> uses Gemini Multimodal Live. If the matching key isn't
            configured, the agent reports "not configured" and closes — it never silently falls
            back to the other provider. Speak again mid-response to interrupt it (barge-in). If
            <code className="font-mono text-[12px]"> AGENT_TOOLS_URL</code> is set, the model can also call whatever tools
            that service exposes — this project's own demo target is AgentKit, but the discovery
            contract has no AgentKit-specific code, so any compliant service works.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Volume2 size={16} style={{ color: "var(--accent)" }} /> Text-to-speech</span>}>
          <p className="text-[13px] leading-6 text-dim">
            Four providers: <strong className="text-body">edge-tts</strong> (default, no API key,
            EN + FR), <strong className="text-body">ElevenLabs</strong> (premium, needs
            <code className="font-mono text-[12px]"> ELEVENLABS_API_KEY</code>), <strong className="text-body">OpenAI
            tts-1-hd</strong> (needs <code className="font-mono text-[12px]">OPENAI_API_KEY</code>), and
            <strong className="text-body"> Kokoro</strong> (open-source, self-hosted or delegated to
            <code className="font-mono text-[12px]"> VOICEFLOW_TTS_REMOTE_ENDPOINT</code>, no API key). Any provider
            failure falls back to edge-tts automatically. Only Kokoro returns WAV — the app always
            reads the real response format rather than assuming it from what was requested, since a
            requested provider can silently fall back.
          </p>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            ElevenLabs also supports real <strong className="text-body">Instant Voice Cloning</strong> —
            upload a real audio sample on the Speech page and get back a usable voice ID, not just a
            pick between 2 stock voices. Requires an ElevenLabs plan that supports cloning; on a plan
            that doesn't, ElevenLabs' own upgrade message is shown verbatim rather than a fake success.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Webhook size={16} style={{ color: "var(--accent)" }} /> Integrations (webhook relay)</span>}>
          <p className="text-[13px] leading-6 text-dim">
            Send a completed analysis or transcript to Slack, Zapier, n8n, or a custom endpoint.
            Because browsers can't POST cross-origin to arbitrary third-party URLs, the request is
            relayed server-side — give VoiceFlow a target URL and a JSON payload, it POSTs on your
            behalf and reports back the target's status and response. Slack targets are
            auto-detected from the URL and reformatted into real Slack Block Kit JSON; n8n and
            Zapier catch-hooks get the payload unchanged, since that's what they're built to accept.
          </p>
          <p className="mt-3 text-[13px] leading-6 text-dim">
            For receivers that verify requests cryptographically, the relay can also
            <strong className="text-body"> HMAC-SHA256-sign</strong> the exact body it sends — give it a
            shared secret and it attaches <code className="font-mono text-[12px]">X-Signature-256: sha256=&lt;hex&gt;</code> (or
            any header name you choose). This is a generic capability, not tied to one receiver's
            scheme — it just happens to be exactly what a signature-verifying webhook endpoint needs.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Code2 size={16} style={{ color: "var(--accent)" }} /> Reusing the API in your own project</span>}>
          <p className="text-[13px] leading-6 text-dim">
            Nothing about VoiceFlow requires this web app — every feature above is a plain HTTP or
            WebSocket call. The <strong className="text-body">API Docs</strong> page has the exact
            request/response shape, auth model, and copy-pasteable curl/Python/Node snippets for
            every endpoint. In short:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] leading-6 text-dim">
            <li>Every <code className="font-mono text-[12px]">GET</code> (health, analytics, scenarios, benchmarks) is always public. <code className="font-mono text-[12px]">POST</code> endpoints are only gated behind <code className="font-mono text-[12px]">X-OmniIntel-Internal-Token</code> when the deployment sets <code className="font-mono text-[12px]">REQUIRE_INTERNAL_TOKEN=true</code> — off by default.</li>
            <li><code className="font-mono text-[12px]">POST /pipeline</code> is the single-call integration path: audio in, transcript + analysis out. Add <code className="font-mono text-[12px]">scenario=</code> for a strictly-pinned provider/model combo instead of the default fallback chain.</li>
            <li>Every GPU-heavy component (ASR, diarization, TTS) is env-driven local-vs-remote — run it on this host, or point it at a remote endpoint you control (<code className="font-mono text-[12px]">VOICEFLOW_REMOTE_ENDPOINT</code>, <code className="font-mono text-[12px]">VOICEFLOW_TTS_REMOTE_ENDPOINT</code>). Your integration doesn't need to know which one is in effect.</li>
            <li>The webhook relay and the agent-tools bridge are both generic contracts, not hardcoded to any specific external product — point them at your own n8n instance, your own inference orchestrator, or any service that implements the discovery contract in <code className="font-mono text-[12px]">services/agent_tools_bridge.py</code>.</li>
          </ul>
        </Card>

        <Card title={<span className="flex items-center gap-2"><GitFork size={16} style={{ color: "var(--accent)" }} /> Cloning this repo — what you can build</span>}>
          <p className="text-[13px] leading-6 text-dim">
            VoiceFlow is a standalone speech-intelligence service — it doesn't assume any particular
            frontend, agent framework, or downstream consumer. Starting points if you fork it:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] leading-6 text-dim">
            <li><strong className="text-body">Swap the frontend entirely</strong> — build your own UI (or none) against the REST/WebSocket API; the React app here is one reference client, not a requirement.</li>
            <li><strong className="text-body">Point it at a different agent backend</strong> — anything implementing the agent-tools discovery contract works with the realtime voice agent, not just AgentKit.</li>
            <li><strong className="text-body">Run it as a pure ASR/diarization microservice</strong> — call <code className="font-mono text-[12px]">/transcribe</code> or <code className="font-mono text-[12px]">/transcribe-json</code> from another backend and ignore the analysis/TTS layers entirely.</li>
            <li><strong className="text-body">Use the scenario system for research</strong> — <code className="font-mono text-[12px]">services/scenarios.py</code> and <code className="font-mono text-[12px]">eval/run_scenario_benchmark.py</code> give you a strict, no-fallback harness for comparing ASR/diarization/LLM combinations head-to-head on your own audio.</li>
            <li><strong className="text-body">Wire it into your own automation</strong> — the webhook relay and env-driven local/remote compute model were built specifically so this integrates into an existing n8n workflow or self-hosted inference host without any VoiceFlow-side code changes.</li>
          </ul>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Scale size={16} style={{ color: "var(--accent)" }} /> Licensing</span>}>
          <p className="text-[13px] leading-6 text-dim">
            VoiceFlow is dual-licensed. The source in this repository is available under the
            <strong className="text-body"> GNU Affero General Public License v3.0</strong> (see
            <code className="font-mono text-[12px]"> LICENSE</code>) — free to use, modify, and self-host, intended for
            students, academics, and researchers, with AGPL's copyleft terms applying (network use
            counts as distribution: if you run a modified version as a service, you must offer its
            source to your users). Any commercial use — internal business operations, a commercial
            product or service, or integrating this into a proprietary system — requires a separate
            commercial license instead; see <code className="font-mono text-[12px]">COMMERCIAL.md</code> for what counts as
            commercial use and contact details.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Package size={16} style={{ color: "var(--accent)" }} /> Packaging</span>}>
          <p className="text-[13px] leading-6 text-dim">
            VoiceFlow ships as a full application — a FastAPI backend plus a Vite/React frontend —
            not as an installable Python package. There's no <code className="font-mono text-[12px]">pyproject.toml</code>,
            <code className="font-mono text-[12px]"> setup.py</code>, or published wheel/PyPI package, so
            <code className="font-mono text-[12px]"> pip install voiceflow</code> isn't a thing. To depend on it from another
            Python project, run it as a service and call it over HTTP/WebSocket (see "Reusing the
            API" above) rather than importing it as a library.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><ShieldCheck size={16} style={{ color: "var(--accent)" }} /> Practical notes</span>}>
          <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-6 text-dim">
            <li>Nothing needs to be configured just to boot the app — <code className="font-mono text-[12px]">GET /health</code> works with zero keys, and every feature above degrades gracefully with a clear error (never a fabricated success) when its key or engine is missing.</li>
            <li>Never commit <code className="font-mono text-[12px]">.env</code> files or hardcode API keys — every credential is read from the environment at runtime; see <code className="font-mono text-[12px]">.env.example</code> and <code className="font-mono text-[12px]">SELF_HOSTING.md</code> for the full list.</li>
            <li>For exact request/response shapes and copy-pasteable snippets for every endpoint, see the <strong className="text-body">API Docs</strong> page.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
