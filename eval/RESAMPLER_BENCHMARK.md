# VoiceFlow — Audio Resampler Micro-Benchmark

> Figures recorded: 2026-10. Document last reviewed: 2026-10-14.

SIMD vector downsampler latency for the live Gemini audio path's 24kHz -> 16kHz PCM
resampling (`_resample_pcm()` in api.py). Reproducible:
`python eval/test_resampler_perf.py --iterations 500`

## Setup
- Backend measured: `scipy.signal.resample_poly` (the fallback path; `soxr` is used first when installed)
- Chunk size: 20ms @ 24000Hz -> 16000Hz (real Gemini Live frame size)
- Iterations: 500 (+50 warmup, discarded)

## Results (real run, 2026-09-18)

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Mean latency** | 1.050ms | — | — |
| **P50 latency** | 0.956ms | — | — |
| **P95 latency** | 1.822ms | < 4.0ms | ✅ Passed |
| **P99 latency** | 2.098ms | — | — |

Historical baseline this remediates: synchronous Python `audioop.ratecv` added **+42ms** TTFT
buffer overhead before Python 3.13 removed `audioop`. It was replaced by `soxr` with the scipy path above as the fallback.
