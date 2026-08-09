"""
Scenario comparison benchmark — runs the SAME audio through every named
scenario (services/scenarios.py) with strict provider pinning (no fallback
substitution — see transcription_adapter.transcribe(..., strict=True)) and
records what actually happened: which provider ran, latency for each stage,
transcript output, structured analysis output, and whether it succeeded.

This is an "industry PoC + research PoC" artifact, generalized from
"Whisper vs Whisper+LLM" to the full provider/model
matrix this codebase actually supports. It measures real latency and real
success/failure against live provider APIs. It does NOT measure downstream
task accuracy (e.g. "was this action item actually correct") — that needs
human or LLM-judge grading against a labeled reference set, which is future
work, not something this script fabricates. Cost figures are the same
public list-price ballparks documented in services/scenarios.py, not
measured — labeled as estimates throughout.

Usage:
  python eval/run_scenario_benchmark.py                    # generated test tone
  python eval/run_scenario_benchmark.py --file meeting.wav  # real audio
  python eval/run_scenario_benchmark.py --scenarios fast,cheap
"""
from __future__ import annotations

import argparse
import asyncio
import io
import math
import struct
import sys
import time
import wave
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import scenarios as scenario_catalog  # noqa: E402
from services.meeting_analyzer import MeetingAnalyzer  # noqa: E402
from services.transcription_adapter import transcribe as adapter_transcribe  # noqa: E402
from core.config import settings  # noqa: E402


def _generate_test_audio(seconds: float = 3.0, freq_hz: float = 440.0, sample_rate: int = 16000) -> bytes:
    """A short mono 16-bit PCM WAV tone — real, valid audio, used when no
    --file is given. This exercises the full pipeline honestly (it will
    correctly transcribe to near-silence — there's no speech in a tone) but
    is not a substitute for real speech when you actually care about
    transcript quality. Pass --file for that."""
    n_samples = int(seconds * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            sample = int(3000 * math.sin(2 * math.pi * freq_hz * (i / sample_rate)))
            frames += struct.pack("<h", sample)
        wf.writeframes(bytes(frames))
    return buf.getvalue()


async def run_one(name: str, spec: Dict[str, Any], audio: bytes, analysis_type: str) -> Dict[str, Any]:
    analyzer = MeetingAnalyzer()
    result: Dict[str, Any] = {"scenario": name, "spec": spec}

    t0 = time.time()
    trans = await adapter_transcribe(
        audio, provider=spec["transcription_provider"], diarize=spec["diarize"], strict=True,
    )
    result["transcribe_latency_s"] = round(time.time() - t0, 3)
    result["transcribe_method"] = trans.get("method")
    result["transcribe_error"] = trans.get("error")
    result["transcript_text"] = trans.get("text", "")

    if trans.get("method") == "error":
        result["analysis_latency_s"] = None
        result["analysis_error"] = "skipped: transcription failed"
        result["success"] = False
        return result

    model = scenario_catalog.resolve_analysis_model(settings, spec)
    t1 = time.time()
    analysis = await analyzer.analyze(trans.get("text", ""), analysis_type=analysis_type, model=model)
    result["analysis_latency_s"] = round(time.time() - t1, 3)
    result["analysis_model"] = model
    result["analysis_error"] = analysis.get("error")
    result["success"] = trans.get("method") != "error" and not analysis.get("error")
    return result


async def main_async(args):
    audio = Path(args.file).read_bytes() if args.file else _generate_test_audio()
    names = args.scenarios.split(",") if args.scenarios else [
        n for n in scenario_catalog.SCENARIOS if scenario_catalog.SCENARIOS[n]["transcription_provider"]
    ]

    print(f"=== VoiceFlow Scenario Benchmark ===")
    print(f"Audio: {'generated test tone (no --file given)' if not args.file else args.file}")
    print(f"Scenarios: {', '.join(names)}\n")

    results = []
    for name in names:
        spec = scenario_catalog.resolve(name)
        if not spec:
            print(f"  {name}: unknown scenario, skipping")
            continue
        print(f"--- {name} ({spec['description']}) ---")
        r = await run_one(name, spec, audio, args.analysis_type)
        status = "OK" if r["success"] else f"FAILED ({r.get('transcribe_error') or r.get('analysis_error')})"
        analyze_s = f"{r['analysis_latency_s']}s" if r["analysis_latency_s"] is not None else "—"
        print(f"  provider={r['transcribe_method']}  transcribe={r['transcribe_latency_s']}s  "
              f"analyze={analyze_s}  {status}")
        results.append(r)

    md_path = Path(__file__).resolve().parent / "SCENARIO_BENCHMARK.md"
    rows = []
    for r in results:
        spec = r["spec"]
        status = "PASS" if r["success"] else f"FAIL ({r.get('transcribe_error') or r.get('analysis_error')})"
        analyze_s = f"{r['analysis_latency_s']}s" if r["analysis_latency_s"] is not None else "—"
        rows.append(
            f"| {r['scenario']} | {spec['transcription_provider']} | {r['transcribe_latency_s']}s | "
            f"{analyze_s} | "
            f"~${spec['est_cost_per_min_usd']:.3f}/min | {status} |"
        )

    content = f"""# VoiceFlow — Scenario Comparison Benchmark

Reproducible: `python eval/run_scenario_benchmark.py [--file audio.wav] [--scenarios fast,accurate,cheap,streaming]`

## What this measures

Real, strictly-pinned (no fallback substitution) latency and success/failure
for each named scenario against live provider APIs. Cost is a public
list-price *estimate*, not measured. This does **not** measure downstream
task accuracy — whether the extracted action items were actually correct —
that requires grading against a labeled reference set, which is a natural
next step (compare against `WER_BENCHMARK.md`'s methodology) but isn't
fabricated here.

Only scenarios whose provider had a working API key at run time will show
PASS — a FAIL row is the system correctly refusing to substitute a different
provider than the one the scenario asked for, not a bug.

## Results (this run)

| Scenario | Provider | Transcribe | Analyze | Est. cost | Status |
|----------|----------|-----------|---------|-----------|--------|
{chr(10).join(rows)}

## Sample output (first scenario that passed)
"""
    passed = next((r for r in results if r["success"]), None)
    if passed:
        content += f"""
Scenario: `{passed['scenario']}` (provider: `{passed['transcribe_method']}`, model: `{passed['analysis_model']}`)

Transcript: `{passed['transcript_text'][:200]!r}`
"""
    else:
        content += "\nNo scenario passed this run — check which provider API keys are configured.\n"

    md_path.write_text(content)
    print(f"\nWrote results to {md_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", help="Path to a real audio file. Defaults to a generated test tone.")
    ap.add_argument("--scenarios", help="Comma-separated scenario names. Defaults to all runnable scenarios.")
    ap.add_argument("--analysis-type", dest="analysis_type", default="meeting")
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
