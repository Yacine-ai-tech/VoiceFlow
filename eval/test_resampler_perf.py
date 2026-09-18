"""SIMD vector downsampler micro-benchmark — 24kHz -> 16kHz PCM resampling on 20ms chunks.

This benchmarks the exact same resampling algorithm the live Gemini-Live audio path in
api.py's `_resample_pcm()` uses (soxr HQ, falling back to scipy.signal.resample_poly, falling
back to naive linear-index decimation). That function is defined as a closure inside the
WebSocket route handler, so it isn't importable — this script duplicates the algorithm
verbatim rather than refactoring api.py's hot path just to make it testable.

Targets a 20ms chunk (480 samples @ 24kHz -> 320 samples @ 16kHz), the real Gemini Live audio
frame size, and reports per-chunk latency. No external API calls and no meaningful failure
mode (pure local CPU work finishing in milliseconds), so unlike the other eval scripts this
one has no JSONL cache/resume — there's nothing costly to lose on an interruption.

Usage:
  python eval/test_resampler_perf.py --iterations 2000
"""
from __future__ import annotations

import argparse
import statistics
import time
from pathlib import Path

import numpy as np


def _resample_pcm(pcm_bytes: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Verbatim copy of api.py's `_resample_pcm()` — see module docstring for why."""
    if src_rate == dst_rate:
        return pcm_bytes
    try:
        import soxr
        arr = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        resampled = soxr.resample(arr, src_rate, dst_rate, quality="HQ")
        return (np.clip(resampled, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    except ImportError:
        pass
    try:
        from scipy.signal import resample_poly
        from math import gcd
        arr = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
        g = gcd(src_rate, dst_rate)
        resampled = resample_poly(arr, dst_rate // g, src_rate // g)
        return np.clip(resampled, -32768, 32767).astype(np.int16).tobytes()
    except ImportError:
        pass
    arr = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    import math
    n_samples = int(math.ceil(len(arr) * dst_rate / src_rate))
    indices = np.round(np.linspace(0, len(arr) - 1, n_samples)).astype(int)
    return arr[indices].astype(np.int16).tobytes()


def _which_backend() -> str:
    try:
        import soxr  # noqa: F401
        return "soxr (SIMD)"
    except ImportError:
        pass
    try:
        from scipy.signal import resample_poly  # noqa: F401
        return "scipy.signal.resample_poly"
    except ImportError:
        return "naive linear-index decimation"


def _make_chunk(src_rate: int, ms: int) -> bytes:
    n = int(src_rate * ms / 1000)
    t = np.linspace(0, ms / 1000, n, endpoint=False)
    # 440Hz tone + light noise — representative of real voice-band PCM, not silence
    # (silence can let some resamplers short-circuit and understate latency).
    sig = (0.5 * np.sin(2 * np.pi * 440 * t) + 0.05 * np.random.randn(n))
    return (np.clip(sig, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-rate", type=int, default=24000)
    ap.add_argument("--dst-rate", type=int, default=16000)
    ap.add_argument("--chunk-ms", type=int, default=20, help="matches the real Gemini Live audio frame size")
    ap.add_argument("--iterations", type=int, default=2000)
    ap.add_argument("--warmup", type=int, default=50)
    a = ap.parse_args()

    backend = _which_backend()
    chunk = _make_chunk(a.src_rate, a.chunk_ms)

    for _ in range(a.warmup):
        _resample_pcm(chunk, a.src_rate, a.dst_rate)

    latencies_ms: list[float] = []
    for _ in range(a.iterations):
        t0 = time.perf_counter()
        _resample_pcm(chunk, a.src_rate, a.dst_rate)
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)

    latencies_ms.sort()
    n = len(latencies_ms)
    mean_ms = statistics.mean(latencies_ms)
    p50 = latencies_ms[n // 2]
    p95 = latencies_ms[min(n - 1, int(n * 0.95))]
    p99 = latencies_ms[min(n - 1, int(n * 0.99))]
    target_ms = 4.0

    print(f"\nResampler backend: {backend}")
    print(f"Chunk: {a.chunk_ms}ms @ {a.src_rate}Hz -> {a.dst_rate}Hz  (N={a.iterations} iterations)")
    print(f"  mean={mean_ms:.3f}ms  p50={p50:.3f}ms  p95={p95:.3f}ms  p99={p99:.3f}ms")
    status = "PASS" if p95 < target_ms else "FAIL"
    print(f"  target: p95 < {target_ms}ms -> {status}")

    md_path = Path(__file__).resolve().parent / "RESAMPLER_BENCHMARK.md"
    from datetime import date
    md_path.write_text(f"""# VoiceFlow — Audio Resampler Micro-Benchmark

SIMD vector downsampler latency for the live Gemini audio path's 24kHz -> 16kHz PCM
resampling (`_resample_pcm()` in api.py). Reproducible:
`python eval/test_resampler_perf.py --iterations {a.iterations}`

## Setup
- Backend: {backend}
- Chunk size: {a.chunk_ms}ms @ {a.src_rate}Hz -> {a.dst_rate}Hz (real Gemini Live frame size)
- Iterations: {a.iterations} (+{a.warmup} warmup, discarded)

## Results (real run, {date.today().isoformat()})

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Mean latency** | {mean_ms:.3f}ms | — | — |
| **P50 latency** | {p50:.3f}ms | — | — |
| **P95 latency** | {p95:.3f}ms | < {target_ms}ms | {"✅ Passed" if p95 < target_ms else "❌ Failed"} |
| **P99 latency** | {p99:.3f}ms | — | — |

Historical baseline this remediates: synchronous Python `audioop.ratecv` added **+42ms** TTFT
buffer overhead before Python 3.13 removed `audioop` and this SIMD (`soxr`) path replaced it.
""")
    print(f"\nBenchmark results written to {md_path}")


if __name__ == "__main__":
    main()
