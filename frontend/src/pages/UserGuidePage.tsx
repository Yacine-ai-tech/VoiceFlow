import React from 'react';
import { BookOpen, Mic, Sparkles, AudioLines, Volume2, Webhook, Users, ShieldAlert, CheckCircle } from 'lucide-react';

export default function UserGuidePage() {
  return (
    <div className="p-8 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center gap-3 mb-8">
        <BookOpen className="w-10 h-10 text-blue-500" />
        <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-600">
          VoiceFlow User Guide
        </h1>
      </div>

      <p className="text-lg text-gray-300 mb-8 leading-relaxed">
        VoiceFlow turns spoken audio into structured intelligence: transcription, LLM-powered
        meeting/call analysis, text-to-speech, and a real-time voice agent you can talk to.
        This guide covers what each feature actually does and what it needs to work.
      </p>

      <div className="space-y-8 text-gray-200">

        {/* Transcription */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Mic className="w-6 h-6 text-green-400" /> Transcription
          </h2>
          <div className="space-y-4">
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-blue-400 text-lg mb-2">Provider chain</h3>
              <p className="text-sm text-gray-300">
                Uploaded or recorded audio goes through a provider router. By default it uses
                <strong className="text-gray-100"> local WhisperX</strong> (bundled faster-whisper + forced
                alignment) — no API key required, no audio leaves the server. On memory-constrained
                deployments where the local model isn't loaded (e.g. a slim Render instance),
                or if you set <code>VOICEFLOW_TRANSCRIPTION_MODE=remote</code>, it falls through
                to cloud providers in order: <strong className="text-gray-100">Groq Whisper</strong> →
                <strong className="text-gray-100"> Deepgram</strong> → <strong className="text-gray-100">AssemblyAI</strong> —
                whichever have API keys configured. You can also force a specific engine per-request
                (the Record page exposes a provider picker).
              </p>
            </div>
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-purple-400 text-lg mb-2">Speaker diarization</h3>
              <p className="text-sm text-gray-300">
                Enable the "diarize" option to attach speaker labels. This only works with local
                WhisperX and requires a Hugging Face token with pyannote access
                (<code>PYANNOTE_TOKEN</code> or <code>HF_TOKEN</code>). If no token is configured,
                the request does not fail — you still get a full transcript back, just without
                speaker labels, and the response's <code>diarized</code> field will honestly read
                <code>false</code> so you always know whether labels were actually attached.
              </p>
            </div>
          </div>
        </section>

        {/* Analysis */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Sparkles className="w-6 h-6 text-purple-400" /> Meeting & Call Analysis
          </h2>
          <p className="text-sm text-gray-300 mb-4">
            The Analyze page (and the /pipeline, /meeting/process, /call/analyze endpoints) turn a
            transcript into structured JSON via one of five analysis types. Each type is routed to
            a specific model, chosen for the kind of reasoning it needs:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="py-2 pr-4">Analysis type</th>
                  <th className="py-2 pr-4">Model</th>
                  <th className="py-2">Extracts</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                <tr className="border-b border-gray-800">
                  <td className="py-2 pr-4 font-mono text-blue-300">meeting</td>
                  <td className="py-2 pr-4 font-mono text-xs">groq/llama-3.3-70b-versatile</td>
                  <td className="py-2">Summary, action items, decisions, sentiment, next steps</td>
                </tr>
                <tr className="border-b border-gray-800">
                  <td className="py-2 pr-4 font-mono text-blue-300">general</td>
                  <td className="py-2 pr-4 font-mono text-xs">groq/llama-3.3-70b-versatile</td>
                  <td className="py-2">Open-ended structured extraction, no fixed schema</td>
                </tr>
                <tr className="border-b border-gray-800">
                  <td className="py-2 pr-4 font-mono text-blue-300">sales_call</td>
                  <td className="py-2 pr-4 font-mono text-xs">anthropic/claude-sonnet-4-6</td>
                  <td className="py-2">Pain points, objections, buying signals, deal stage, CRM notes</td>
                </tr>
                <tr className="border-b border-gray-800">
                  <td className="py-2 pr-4 font-mono text-blue-300">interview</td>
                  <td className="py-2 pr-4 font-mono text-xs">anthropic/claude-sonnet-4-6</td>
                  <td className="py-2">Strengths, gaps, key quotes, hire/no-hire recommendation</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-mono text-blue-300">support_call</td>
                  <td className="py-2 pr-4 font-mono text-xs">anthropic/claude-haiku-4-5</td>
                  <td className="py-2">Issue summary, severity, escalation flag, follow-ups</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm text-gray-300 mt-4">
            Need fields these five types don't cover? The Analyze page also supports a
            <strong className="text-gray-100"> custom extraction</strong> mode — name your own field
            list (and optional instructions), and it returns exactly that schema, no built-in
            template needed.
          </p>
        </section>

        {/* Real-time voice agent */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <AudioLines className="w-6 h-6 text-cyan-400" /> Real-Time Voice Agent
          </h2>
          <p className="text-sm text-gray-300 mb-3">
            The Voice Agent page is a live, two-way conversation with an AI over your microphone —
            not a record-then-transcribe workflow. In practice:
          </p>
          <ol className="list-decimal list-inside text-sm text-gray-300 space-y-1 ml-2">
            <li>Open the Voice Agent page — it opens a WebSocket connection and waits for "ready".</li>
            <li>Click the mic button and start talking.</li>
            <li>The agent replies with synthesized speech in real time, streamed back over the same connection — you'll hear it, not just read a transcript.</li>
            <li>You can interrupt it mid-sentence (barge-in) — speaking again cancels its current response.</li>
          </ol>
          <p className="text-sm text-gray-300 mt-3">
            Under the hood this bridges to one of two providers, selected on the server via the
            <code> REALTIME_PROVIDER</code> environment variable — <strong className="text-gray-100">it is a
            deliberate, fixed choice, not automatic detection based on which API key happens to be
            present</strong>:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-300 space-y-1 ml-2 mt-2">
            <li><code>REALTIME_PROVIDER=openai</code> (the default) relays to the <strong className="text-gray-100">OpenAI Realtime API</strong> using <code>OPENAI_API_KEY</code>.</li>
            <li><code>REALTIME_PROVIDER=gemini</code> relays to <strong className="text-gray-100">Gemini Multimodal Live</strong> (model <code>models/gemini-3.1-flash-live-preview</code>, via the official <code>google-genai</code> SDK) using <code>GEMINI_API_KEY</code>.</li>
          </ul>
          <p className="text-sm text-gray-300 mt-3">
            If the key for whichever provider is selected isn't configured, the agent reports
            "not configured" and closes the connection — it will not silently fall back to the
            other provider even if that provider's key is set.
          </p>
        </section>

        {/* TTS */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Volume2 className="w-6 h-6 text-amber-400" /> Text-to-Speech
          </h2>
          <p className="text-sm text-gray-300">
            The Text to Speech page converts written text into an MP3 using
            <strong className="text-gray-100"> edge-tts</strong> (Microsoft Edge's neural voices) —
            no API key needed, works out of the box. English and French are supported, each with a
            male and female voice option. An optional ElevenLabs path exists for premium voices if
            <code> ELEVENLABS_API_KEY</code> is configured, but it isn't required and every failure
            (missing key, request error) falls back to edge-tts automatically. There is no
            OpenAI TTS or Kokoro integration in this service — edge-tts and ElevenLabs are the
            only two providers actually implemented.
          </p>
        </section>

        {/* Integrations */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Webhook className="w-6 h-6 text-orange-400" /> Integrations (Webhook Relay)
          </h2>
          <p className="text-sm text-gray-300">
            The Integrations page lets you send a completed analysis or transcript to any webhook —
            Slack, Zapier, n8n, or a custom endpoint you control. Because browsers can't POST
            cross-origin to arbitrary third-party URLs, the request is relayed server-side: you give
            VoiceFlow a target URL and a JSON payload, and the server does the POST on your behalf
            and reports back the target's status code and response body.
          </p>
        </section>

        {/* Security & practical notes */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <ShieldAlert className="w-6 h-6 text-red-400" /> Practical Notes
          </h2>
          <ul className="space-y-3">
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300">
                Nothing needs to be configured just to boot the app — <code>GET /health</code> works
                with zero keys, and every feature above degrades gracefully with a clear error
                instead of crashing when its key is missing.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300">
                Internal-token auth (<code>X-OmniIntel-Internal-Token</code>) is only enforced when
                the server sets <code>REQUIRE_INTERNAL_TOKEN=true</code>; health, root, and the two
                WebSocket endpoints are always public regardless.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300">
                Never commit <code>.env</code> files or hardcode API keys — every credential
                (Groq, Anthropic, OpenAI, Gemini, Deepgram, AssemblyAI, ElevenLabs, HF/PYANNOTE) is
                read from the environment at runtime.
              </span>
            </li>
          </ul>
        </section>

        {/* Where to go next */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Users className="w-6 h-6 text-blue-400" /> Full API Reference
          </h2>
          <p className="text-sm text-gray-300">
            For exact request/response shapes, every parameter, and copy-pasteable curl/Python/Node
            snippets for all 14 endpoints (including the WebSocket protocols), see the
            <strong className="text-gray-100"> API Docs</strong> page in the sidebar.
          </p>
        </section>

      </div>
    </div>
  );
}
