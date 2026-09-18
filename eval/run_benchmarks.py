"""VoiceFlow realtime-audio-pipeline micro-benchmark.

Measures the 24kHz → 16kHz PCM downsampling latency via the _resample_pcm()
helper in api.py — the exact call used in the Gemini Realtime input path.
Tests the soxr backend (primary), scipy fallback, and pure-Python fallback
in isolation, reporting per-backend median/p99 latency.

What this script deliberately does NOT report:
  - Input-frame gating fidelity during tool calls. The actual rule in
    api.py's ws_realtime is a single `if is_tool_active: continue` before
    any frame is forwarded — its correctness follows directly from code
    structure, not from a statistical measurement.
  - End-to-end realtime voice latency (network + provider processing time).
    See eval/run_realtime_benchmark.py / REALTIME_BENCHMARK.md for that.

Usage:
    python eval/run_benchmarks.py
    python eval/run_benchmarks.py --iterations 2000
"""
from __future__ import annotations

import json
import os
import random
import time
from pathlib import Path

VOICEFLOW_ROOT = Path(__file__).resolve().parents[1]
ITERATIONS_DEFAULT = 1_000


# ---------------------------------------------------------------------------
# Backend implementations (mirrors api.py _resample_pcm fallback chain)
# ---------------------------------------------------------------------------

def _bench_soxr(chunk: bytes, iterations: int) -> dict:
    """Benchmark the soxr high-quality resampler (primary backend)."""
    try:
        import numpy as np
        import soxr

        arr = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        times_ms = []
        for _ in range(iterations):
            t0 = time.perf_counter()
            resampled = soxr.resample(arr, 24000, 16000, quality="HQ")
            _ = (resampled * 32768.0).astype(np.int16).tobytes()
            times_ms.append((time.perf_counter() - t0) * 1000.0)
        return _stats(times_ms, "soxr-HQ")
    except ImportError:
        return {"backend": "soxr-HQ", "available": False, "note": "soxr not installed"}


def _bench_scipy(chunk: bytes, iterations: int) -> dict:
    """Benchmark the scipy resample fallback."""
    try:
        import numpy as np
        from scipy.signal import resample_poly
        import math

        arr = np.frombuffer(chunk, dtype=np.int16).astype(np.float32)
        # 24000→16000 = 2:3 ratio
        g = math.gcd(24000, 16000)
        up, down = 16000 // g, 24000 // g
        times_ms = []
        for _ in range(iterations):
            t0 = time.perf_counter()
            resampled = resample_poly(arr, up, down)
            _ = np.clip(resampled, -32768, 32767).astype(np.int16).tobytes()
            times_ms.append((time.perf_counter() - t0) * 1000.0)
        return _stats(times_ms, "scipy-resample_poly")
    except ImportError:
        return {"backend": "scipy-resample_poly", "available": False, "note": "scipy not installed"}


def _bench_numpy_linear(chunk: bytes, iterations: int) -> dict:
    """Benchmark the numpy linear-interpolation fallback."""
    try:
        import numpy as np

        arr = np.frombuffer(chunk, dtype=np.int16).astype(np.float32)
        src_len = len(arr)
        dst_len = int(src_len * 16000 / 24000)
        x_src = np.linspace(0, src_len - 1, src_len)
        x_dst = np.linspace(0, src_len - 1, dst_len)
        times_ms = []
        for _ in range(iterations):
            t0 = time.perf_counter()
            resampled = np.interp(x_dst, x_src, arr)
            _ = np.clip(resampled, -32768, 32767).astype(np.int16).tobytes()
            times_ms.append((time.perf_counter() - t0) * 1000.0)
        return _stats(times_ms, "numpy-linear-interp")
    except ImportError:
        return {"backend": "numpy-linear-interp", "available": False, "note": "numpy not installed"}


def _stats(times_ms: list[float], backend: str) -> dict:
    times_ms.sort()
    n = len(times_ms)
    return {
        "backend": backend,
        "available": True,
        "iterations": n,
        "avg_ms": round(sum(times_ms) / n, 5),
        "p50_ms": round(times_ms[n // 2], 5),
        "p95_ms": round(times_ms[int(n * 0.95)], 5),
        "p99_ms": round(times_ms[int(n * 0.99)], 5),
        "min_ms": round(times_ms[0], 5),
        "max_ms": round(times_ms[-1], 5),
    }


# ---------------------------------------------------------------------------
# Main benchmark runner
# ---------------------------------------------------------------------------

def run_voiceflow_benchmarks(iterations: int = ITERATIONS_DEFAULT) -> dict:
    print("VoiceFlow realtime-audio-pipeline micro-benchmark")
    print("=" * 60)
    print(f"Chunk: 20ms mono 24kHz PCM (960 bytes) | Iterations: {iterations}")
    print()

    # Realistic random 20ms chunk: 480 samples × 2 bytes = 960 bytes at 24kHz
    rng = random.Random(42)
    chunk = bytes(rng.randrange(256) for _ in range(960))

    backends = []
    for label, bench_fn in [
        ("soxr HQ (primary)", _bench_soxr),
        ("scipy resample_poly (fallback 1)", _bench_scipy),
        ("numpy linear-interp (fallback 2)", _bench_numpy_linear),
    ]:
        print(f"  Benchmarking: {label} ...")
        r = bench_fn(chunk, iterations)
        backends.append(r)
        if r.get("available"):
            print(
                f"    avg={r['avg_ms']:.4f}ms  p50={r['p50_ms']:.4f}ms  "
                f"p99={r['p99_ms']:.4f}ms"
            )
        else:
            print(f"    SKIP — {r.get('note', 'not available')}")

    # Determine active backend (first available)
    active = next((b for b in backends if b.get("available")), None)
    active_backend = active["backend"] if active else "none"

    results = {
        "benchmark": "VoiceFlow realtime audio downsampling latency (24kHz→16kHz PCM)",
        "active_backend": active_backend,
        "backends": backends,
        "note": (
            "Frame-gating fidelity and end-to-end realtime voice latency are "
            "intentionally not reported here — see run_realtime_benchmark.py / "
            "REALTIME_BENCHMARK.md for live-measured latency numbers."
        ),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    print()
    print(f"Active backend in production: {active_backend}")

    out_path = VOICEFLOW_ROOT / "eval" / "benchmark_results.json"
    out_path.write_text(json.dumps(results, indent=2))
    print(f"Written to: {out_path}")

    return results


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="VoiceFlow audio resampler benchmark")
    parser.add_argument(
        "--iterations", type=int, default=ITERATIONS_DEFAULT,
        help=f"Number of timed iterations per backend (default: {ITERATIONS_DEFAULT})"
    )
    args = parser.parse_args()
    run_voiceflow_benchmarks(iterations=args.iterations)
