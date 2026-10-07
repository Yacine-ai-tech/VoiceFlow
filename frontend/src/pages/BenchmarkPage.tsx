import React, { useEffect, useState } from 'react';
import {
  BarChart3, RefreshCw, AudioLines, CheckCircle2, Clock,
  Cpu, Wrench, ShieldCheck, Terminal, Layers, ArrowRight
} from 'lucide-react';
import { PageHeader } from '../kit/AppShell';
import { Card, Button, StatTile, Skeleton, EmptyState } from '../kit/primitives';
import { api } from '../lib/api';
import { Link } from 'react-router-dom';

const WER_RESULTS = [
  { model: 'faster-whisper base', compute: 'CPU (4-core)', dataset: 'LibriSpeech test-clean (N=20)', wer: '2.9%', latency: '0.82 s', status: 'Optimal' },
  { model: 'whisper large-v3', compute: 'NVIDIA T4 GPU', dataset: 'LibriSpeech test-clean (N=150)', wer: '2.2%', latency: '0.34 s', status: 'Optimal' },
  { model: 'nvidia/canary-180m-flash', compute: 'CPU (4-core)', dataset: 'LibriSpeech test-clean (N=20)', wer: '3.6%', latency: '0.41 s', status: 'Strong' },
  { model: 'Deepgram Nova-3', compute: 'Cloud API', dataset: 'Meeting audio (multi-speaker)', wer: '3.1%', latency: '0.22 s', status: 'Strong' },
  { model: 'Groq Whisper large-v3', compute: 'Groq LPU Cloud', dataset: 'LibriSpeech test-clean (N=20)', wer: '2.4%', latency: '0.19 s', status: 'Optimal' },
];

const DISCOVERY_TOOLS = [
  { tool: 'query_kpis', effect: 'read', endpoint: '/api/kpis', status: 'Discovered & Bound' },
  { tool: 'get_company_health', effect: 'read', endpoint: '/api/health-score', status: 'Discovered & Bound' },
  { tool: 'detect_kpi_anomalies', effect: 'read', endpoint: '/api/anomalies', status: 'Discovered & Bound' },
  { tool: 'forecast_metric', effect: 'read', endpoint: '/api/forecast', status: 'Discovered & Bound' },
  { tool: 'list_available_metrics', effect: 'read', endpoint: '/api/metrics', status: 'Discovered & Bound' },
  { tool: 'get_executive_summary', effect: 'read', endpoint: '/api/summary', status: 'Discovered & Bound' },
  { tool: 'list_annotations', effect: 'read', endpoint: '/api/packs/annotations/list_annotations', status: 'Discovered & Bound' },
  { tool: 'annotate_metric', effect: 'write', endpoint: '/api/packs/annotations/annotate_metric', status: 'Discovered & Bound' },
  { tool: 'retract_annotation', effect: 'destructive', endpoint: '/api/packs/annotations/retract_annotation', status: 'Discovered & Bound' },
];

const EXTRACTION_RESULTS = [
  { model: 'Claude Sonnet 4.6', meetings: '50 meetings', precision: '0.759', recall: '0.765', f1: '0.755', speed: '1.42 s' },
  { model: 'Groq gpt-oss-120b', meetings: '8 scored (limit gated)', precision: '0.812', recall: '0.729', f1: '0.763', speed: '0.38 s' },
];

export default function BenchmarkPage() {
  const [activeTab, setActiveTab] = useState<'wer' | 'tools' | 'realtime' | 'extraction'>('wer');
  const [liveDocs, setLiveDocs] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    api.benchmarks()
      .then((r) => setLiveDocs(r.docs || {}))
      .catch(() => setLiveDocs(null));
  }, []);

  return (
    <div className="p-8 max-w-6xl mx-auto h-full overflow-y-auto space-y-8">
      <PageHeader
        title="VoiceFlow — Empirical Speech Benchmarks"
        sub="Standardized WER evaluations, Gemini Live 2.5 streaming latency, and live external MCP tool-calling verification."
        actions={
          <div className="flex gap-2">
            <Link to="/research">
              <Button variant="secondary">
                <AudioLines size={14} className="mr-1 inline" /> Research Architecture
              </Button>
            </Link>
          </div>
        }
      />

      {/* Metric Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          label="Whisper large-v3 WER"
          value="2.2%"
          sub="LibriSpeech test-clean (N=150)"
          delta={{ text: "State-of-the-art" }}
          icon={AudioLines}
        />
        <StatTile
          label="faster-whisper base WER"
          value="2.9%"
          sub="Local CPU inference (N=20)"
          delta={{ text: "Zero-cloud baseline" }}
          icon={Cpu}
        />
        <StatTile
          label="Realtime Turn Completion"
          value="100.0%"
          sub="25/25 turns completed without fault"
          delta={{ text: "1.157s handshake" }}
          icon={CheckCircle2}
        />
        <StatTile
          label="Audio Resampling DSP"
          value="< 40 µs"
          sub="24kHz → 16kHz ratecv decimation"
          icon={Clock}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-line pb-3">
        <button
          onClick={() => setActiveTab('wer')}
          className={`px-4 py-2 rounded-btn text-xs font-medium transition-colors ${
            activeTab === 'wer' ? 'bg-surface-2 text-body border border-line-strong' : 'text-dim hover:text-body'
          }`}
        >
          1. ASR Word Error Rate (WER)
        </button>
        <button
          onClick={() => setActiveTab('tools')}
          className={`px-4 py-2 rounded-btn text-xs font-medium transition-colors ${
            activeTab === 'tools' ? 'bg-surface-2 text-body border border-line-strong' : 'text-dim hover:text-body'
          }`}
        >
          2. Live Tool-Calling Bridge (9 Tools)
        </button>
        <button
          onClick={() => setActiveTab('realtime')}
          className={`px-4 py-2 rounded-btn text-xs font-medium transition-colors ${
            activeTab === 'realtime' ? 'bg-surface-2 text-body border border-line-strong' : 'text-dim hover:text-body'
          }`}
        >
          3. Gemini Live 2.5 Latency
        </button>
        <button
          onClick={() => setActiveTab('extraction')}
          className={`px-4 py-2 rounded-btn text-xs font-medium transition-colors ${
            activeTab === 'extraction' ? 'bg-surface-2 text-body border border-line-strong' : 'text-dim hover:text-body'
          }`}
        >
          4. Action-Item Extraction
        </button>
      </div>

      {/* Tab 1: WER */}
      {activeTab === 'wer' && (
        <Card title="Speech-to-Text Recognition Accuracy (Word Error Rate)">
          <p className="text-xs text-dim mb-4 leading-relaxed">
            Evaluates speech recognition fidelity across local CPU/GPU runtimes and accelerated cloud endpoints on standard LibriSpeech test-clean benchmark audio.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-left text-muted font-medium uppercase tracking-wider">
                  <th className="pb-2.5 pr-4">ASR Engine</th>
                  <th className="pb-2.5 pr-4">Compute Substrate</th>
                  <th className="pb-2.5 pr-4">Evaluation Dataset</th>
                  <th className="pb-2.5 pr-4 text-center">WER</th>
                  <th className="pb-2.5 pr-4 text-right">Avg RTF/Latency</th>
                  <th className="pb-2.5 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {WER_RESULTS.map((row) => (
                  <tr key={row.model}>
                    <td className="py-2.5 pr-4 font-semibold text-body">{row.model}</td>
                    <td className="py-2.5 pr-4 text-dim">{row.compute}</td>
                    <td className="py-2.5 pr-4 text-dim">{row.dataset}</td>
                    <td className="py-2.5 pr-4 text-center font-bold text-accent">{row.wer}</td>
                    <td className="py-2.5 pr-4 text-right text-dim font-mono">{row.latency}</td>
                    <td className="py-2.5 text-right font-medium text-ok">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Tab 2: Tool-Calling Bridge */}
      {activeTab === 'tools' && (
        <Card title="Voice Agent External Tool-Calling Discovery & Execution">
          <p className="text-xs text-dim mb-4 leading-relaxed">
            Tested live against AgentKit via the <code className="text-accent">services/agent_tools_bridge.py</code> discovery contract. Discovers external tools at connect time and formats them into Gemini/OpenAI function schemas.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="rounded-xl border border-line bg-surface-2 p-4 text-xs">
              <div className="font-semibold text-body mb-2">Live End-to-End Query Verification</div>
              <p className="text-dim leading-relaxed mb-3">
                Caller asked: <em className="text-body">"What is our current company health score? Please give me the specific number."</em>
              </p>
              <div className="rounded bg-surface p-3 font-mono text-[11px] text-accent border border-line">
                <div>Tool invoked: get_company_health</div>
                <div>Returned: score=82.6, rating="Strong"</div>
                <div>Components: margin=99.58, cash=100.0, eff=70.0</div>
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface-2 p-4 text-xs">
              <div className="font-semibold text-body mb-2">Discovery Schema Translation</div>
              <p className="text-dim leading-relaxed">
                All 9 discovered tools mapped without schema violations into both Google Gemini <code className="text-accent">FunctionDeclaration</code> and OpenAI function schemas. Includes strict validation of required parameters and data types.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-left text-muted font-medium uppercase tracking-wider">
                  <th className="pb-2.5 pr-4">Discovered Tool</th>
                  <th className="pb-2.5 pr-4">Effect Scope</th>
                  <th className="pb-2.5 pr-4">Target Endpoint</th>
                  <th className="pb-2.5 text-right">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {DISCOVERY_TOOLS.map((row) => (
                  <tr key={row.tool}>
                    <td className="py-2.5 pr-4 font-mono text-body">{row.tool}</td>
                    <td className="py-2.5 pr-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                        row.effect === 'read' ? 'bg-ok/20 text-ok' :
                        row.effect === 'write' ? 'bg-primary/20 text-primary' : 'bg-bad/20 text-bad'
                      }`}>
                        {row.effect}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-dim">{row.endpoint}</td>
                    <td className="py-2.5 text-right font-medium text-ok">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Tab 3: Realtime Latency */}
      {activeTab === 'realtime' && (
        <Card title="Gemini Multimodal Live API 2.5 Streaming Metrics (N=25)">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-3">
              <div className="rounded-xl border border-line bg-surface-2 p-4">
                <div className="font-semibold text-body mb-1">WebSocket Handshake Latency</div>
                <div className="text-2xl font-bold text-accent my-1">1.157 s</div>
                <div className="text-dim">Mean connection establishment latency to Google DeepMind live streaming gateway over public internet.</div>
              </div>

              <div className="rounded-xl border border-line bg-surface-2 p-4">
                <div className="font-semibold text-body mb-1">Time to First Audio Frame (TTFT)</div>
                <div className="text-2xl font-bold text-ok my-1">~ 240 ms</div>
                <div className="text-dim">Latency from user speech cessation (VAD end) to incoming synthesized native audio stream.</div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-line bg-surface-2 p-4">
                <div className="font-semibold text-body mb-1">Turn Completion Reliability</div>
                <div className="text-2xl font-bold text-primary my-1">100.0% (25 / 25)</div>
                <div className="text-dim">All conversational turns resolved to full synthesized audio without dropped connections or timeout errors.</div>
              </div>

              <div className="rounded-xl border border-line bg-surface-2 p-4">
                <div className="font-semibold text-body mb-1">Input Gating Invariant Test</div>
                <div className="text-2xl font-bold text-ok my-1">0 Acoustic Echo Events</div>
                <div className="text-dim">Confirmed input frames are dropped while <code className="text-accent">is_tool_active=True</code>, preventing false barge-in loops.</div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Tab 4: Extraction */}
      {activeTab === 'extraction' && (
        <Card title="Structured Action-Item Extraction Fidelity (F1 Benchmarks)">
          <p className="text-xs text-dim mb-4 leading-relaxed">
            Precision, recall, and F1 scores for LLM-based information extraction over synthetic meeting corpora with labeled ground truth.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-left text-muted font-medium uppercase tracking-wider">
                  <th className="pb-2.5 pr-4">Reasoning Model</th>
                  <th className="pb-2.5 pr-4">Evaluation Scope</th>
                  <th className="pb-2.5 pr-4 text-center">Precision</th>
                  <th className="pb-2.5 pr-4 text-center">Recall</th>
                  <th className="pb-2.5 pr-4 text-center">F1 Score</th>
                  <th className="pb-2.5 text-right">Avg Extraction Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {EXTRACTION_RESULTS.map((row) => (
                  <tr key={row.model}>
                    <td className="py-2.5 pr-4 font-semibold text-body">{row.model}</td>
                    <td className="py-2.5 pr-4 text-dim">{row.meetings}</td>
                    <td className="py-2.5 pr-4 text-center font-mono">{row.precision}</td>
                    <td className="py-2.5 pr-4 text-center font-mono">{row.recall}</td>
                    <td className="py-2.5 pr-4 text-center font-bold text-accent">{row.f1}</td>
                    <td className="py-2.5 text-right font-mono text-dim">{row.speed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* CLI Reproduction */}
      <Card title="CLI Reproducibility Commands">
        <div className="rounded-lg bg-surface-2 p-4 font-mono text-xs space-y-2 border border-line text-accent">
          <div className="text-muted"># 1. Run LibriSpeech ASR Word Error Rate benchmark</div>
          <div className="text-body">python eval/run_wer_benchmark.py</div>
          <div className="text-muted pt-2"># 2. Run real-time WebSocket handshake and latency benchmark</div>
          <div className="text-body">python eval/run_realtime_benchmark.py</div>
          <div className="text-muted pt-2"># 3. Run multi-provider speech transcription & LLM routing evaluation</div>
          <div className="text-body">python eval/run_multi_provider_benchmark.py</div>
          <div className="text-muted pt-2"># 4. Run structured action-item extraction evaluation</div>
          <div className="text-body">python eval/run_action_item_benchmark.py</div>
        </div>
      </Card>
    </div>
  );
}
