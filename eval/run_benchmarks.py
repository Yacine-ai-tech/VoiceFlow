"""
VoiceFlow realtime-audio-pipeline micro-benchmark.

Measures the one thing about VoiceFlow's realtime audio pipeline that's
meaningfully benchmarkable in isolation: real 24kHz -> 16kHz PCM
downsampling latency, via the exact stdlib call api.py uses for the Gemini
Realtime input path (`audioop.ratecv`), run against random (not all-zero)
16-bit PCM so the timing reflects real audio content rather than a
degenerate all-zero buffer.

What this script deliberately does NOT report:
  - Input-frame gating "fidelity" during tool calls. The actual rule in
    api.py's ws_realtime is a single `if is_tool_active: continue` before
    any frame is forwarded — its correctness follows directly from that
    code structure, not from a statistical measurement, and a synthetic
    simulation of it would just be testing the simulation's own bookkeeping
    rather than the real code. It's exercised by the realtime tests in
    tests/test_e2e.py instead.
  - End-to-end realtime voice latency (network + provider processing time).
    That number only means something measured against a live connection to
    a real provider, and depends on network conditions at measurement time
    — see eval/run_realtime_benchmark.py / REALTIME_BENCHMARK.md for that,
    rather than a canned or simulated figure here.

Usage:
    python3 eval/run_benchmarks.py
"""
from __future__ import annotations

import audioop
import json
import os
import random
import time
from pathlib import Path

VOICEFLOW_ROOT = Path(__file__).resolve().parents[1]


def _bench_resample(iterations: int = 1000) -> dict:
    """Times the real audioop.ratecv 24kHz->16kHz call api.py's Gemini path
    uses, against random 20ms 16-bit mono PCM chunks (960 bytes = 480
    samples at 24kHz)."""
    rng = random.Random(42)
    chunk = bytes(rng.randrange(256) for _ in range(960))
    times_ms = []
    for _ in range(iterations):
        t0 = time.perf_counter()
        audioop.ratecv(chunk, 2, 1, 24000, 16000, None)
        times_ms.append((time.perf_counter() - t0) * 1000.0)
    times_ms.sort()
    n = len(times_ms)
    return {
        "iterations": iterations,
        "avg_ms": round(sum(times_ms) / n, 5),
        "p50_ms": round(times_ms[n // 2], 5),
        "p99_ms": round(times_ms[int(n * 0.99)], 5),
    }


def run_voiceflow_benchmarks() -> dict:
    print("VoiceFlow realtime-audio-pipeline micro-benchmark")
    print("=" * 50)

    resample = _bench_resample()

    results = {
        "benchmark": "VoiceFlow realtime audio downsampling latency (real audioop.ratecv call)",
        "resample_24k_to_16k": resample,
        "note": "Frame-gating fidelity and end-to-end realtime voice latency are "
                "intentionally not reported by this script — see the module "
                "docstring for why, and eval/run_realtime_benchmark.py / "
                "REALTIME_BENCHMARK.md for a live-measured latency number.",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    print(json.dumps(results, indent=2))

    out_path = VOICEFLOW_ROOT / "eval" / "benchmark_results.json"
    out_path.write_text(json.dumps(results, indent=2))
    print(f"\nWritten to: {out_path}")
    return results


if __name__ == "__main__":
    run_voiceflow_benchmarks()
