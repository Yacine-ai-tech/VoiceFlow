# VoiceFlow — Audio Resampler Micro-Benchmark

SIMD vector downsampler latency for the live Gemini audio path's 24kHz -> 16kHz PCM
resampling (`_resample_pcm()` in api.py). Reproducible:
`python eval/test_resampler_perf.py --iterations 200`

## Setup
- Backend: scipy.signal.resample_poly
- Chunk size: 20ms @ 24000Hz -> 16000Hz (real Gemini Live frame size)
- Iterations: 200 (+50 warmup, discarded)

## Results (real run, 2026-09-18)

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Mean latency** | 1.034ms | — | — |
| **P50 latency** | 1.052ms | — | — |
| **P95 latency** | 1.124ms | < 4.0ms | ✅ Passed |
| **P99 latency** | 1.399ms | — | — |

Historical baseline this remediates: synchronous Python `audioop.ratecv` added **+42ms** TTFT
buffer overhead before Python 3.13 removed `audioop` and this SIMD (`soxr`) path replaced it.
