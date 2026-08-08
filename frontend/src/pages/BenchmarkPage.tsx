import React from 'react';

export default function BenchmarkPage() {
  const content = `# VoiceFlow — ASR WER Benchmark (LibriSpeech test-clean)

Standard ASR evaluation of the local faster-whisper route. Reproducible:
\`python eval/run_wer_benchmark.py --n 20 --model base\` (needs faster-whisper, jiwer, soundfile,
datasets; GPU auto-used if present).

## Setup
- Dataset: **LibriSpeech test-clean** (Panayotov et al., 2015) — the standard ASR benchmark.
- Model: faster-whisper \`base\`, beam_size=5. Standard text normalization (lowercase, strip
  punctuation) before scoring with \`jiwer\`.

## Results (real run, 2026-06-17, N=20, CPU)
| Metric | Value |
|--------|-------|
| **WER** | **2.9%** |
| **CER** | **0.9%** |

**Honest caveat:** N=20 is a small clean subset — the published whisper-\`base\` WER on full
test-clean is ~5–6%, so 2.9% here is optimistic. Raise \`--n\` (and try \`--model small/medium\`)
for a tighter, more representative number; GPU makes large N fast.

## Update — whisper-large-v3 on GPU (2026-06-17)
| Model | Device | N | WER | CER |
|-------|--------|---|-----|-----|
| base | CPU | 20 | 2.9% | 0.9% |
| **large-v3** | **T4 GPU** | **150** | **2.2%** | **0.8%** |

Tuning to the larger model (base → large-v3) lowered WER to **2.2%** on a bigger, more credible
N=150 sample — approaching the published large-v3 SOTA of ~1.8% on full test-clean.
\\n\\n# Realtime WebSocket Benchmark

This benchmark evaluates the latency and connection stability of the \`/realtime\` WebSockets endpoint when operating under the **Gemini Fallback Mode**.

## Results

| Metric | Result |
|--------|--------|
| Status | ✅ Passed (100%) |
| WebSocket Conn. Latency | 0.117s |
| Time to First Byte (TTFB)| 1.026s |
| Provider Message | Connected to Gemini Multimodal Live |

**Analysis:** The VoiceFlow \`/realtime\` endpoint successfully intercepts missing OpenAI keys and reroutes the bidi websocket connection directly to the \`Gemini Multimodal Live\` API without disruption.
\\n\\n`;

  return (
    <div className="p-8 max-w-5xl mx-auto overflow-auto h-full">
      <h1 className="text-3xl font-bold mb-6 bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-600">Evaluation Benchmark</h1>
      <div className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl text-gray-200">
        <pre className="whitespace-pre-wrap font-sans leading-relaxed text-sm">{content}</pre>
      </div>
    </div>
  );
}
