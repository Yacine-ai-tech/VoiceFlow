"""
Multi-provider ASR latency/availability benchmark.

This measures what it can actually measure without ground-truth transcripts:
real round-trip latency and success rate against each provider's live API,
using a short generated audio clip. It does NOT compute WER/CER — that needs
a reference transcript to compare against, which is what run_wer_benchmark.py
does against real LibriSpeech data. See WER_BENCHMARK.md for that methodology.

Any provider without an API key set is skipped, not scored as a failure.
"""
import asyncio
import base64
import math
import struct
import time
import os
import wave
import io
from pathlib import Path
from typing import Dict, Tuple

import httpx


def _generate_test_audio(seconds: float = 2.0, freq_hz: float = 440.0, sample_rate: int = 16000) -> bytes:
    """A short mono 16-bit PCM WAV tone — real, valid audio (not a ground-truth
    transcript), enough for providers to accept and return a real response."""
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


TEST_AUDIO = _generate_test_audio()


class MultiProviderBenchmark:
    def __init__(self):
        self.providers = {
            "openai": {
                "url": "https://api.openai.com/v1/audio/transcriptions",
                "api_key": os.environ.get("OPENAI_API_KEY", ""),
                "model": "whisper-1"
            },
            "gemini": {
                # gemini-1.5-pro was retired from the v1 REST API (confirmed live: 404
                # "models/gemini-1.5-pro is not found for API version v1") — gemini-3.5-flash
                # is the current, working multimodal model, confirmed live via a real API call.
                "url": "https://generativelanguage.googleapis.com/v1/models/gemini-3.5-flash:generateContent",
                "api_key": os.environ.get("GEMINI_API_KEY", ""),
                "model": "gemini-3.5-flash"
            },
            "groq": {
                "url": "https://api.groq.com/openai/v1/audio/transcriptions",
                "api_key": os.environ.get("GROQ_API_KEY", ""),
                "model": "whisper-large-v3"
            }
        }

    async def transcribe(self, provider: str, audio_data: bytes) -> Tuple[float, str]:
        """Call the provider once and return (latency_seconds, result_or_error)."""
        config = self.providers[provider]

        if not config["api_key"]:
            return 0.0, f"SKIPPED: No API key for {provider}"

        start_time = time.time()

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                if provider in ("openai", "groq"):
                    response = await client.post(
                        config["url"],
                        headers={"Authorization": f"Bearer {config['api_key']}"},
                        files={"file": ("audio.wav", audio_data, "audio/wav")},
                        data={"model": config["model"]}
                    )
                elif provider == "gemini":
                    # The v1 REST API expects camelCase keys (inlineData/mimeType) and the
                    # inline bytes base64-encoded, not hex — sending hex-encoded bytes under
                    # snake_case keys is silently invalid (400 "invalid argument", no field-
                    # level detail), confirmed by testing both encodings live. A "transcribe
                    # this" text part alongside the audio part is required too — an
                    # audio-only content array is otherwise rejected.
                    response = await client.post(
                        f"{config['url']}?key={config['api_key']}",
                        json={
                            "contents": [{
                                "parts": [
                                    {"text": "Transcribe this audio."},
                                    {"inlineData": {
                                        "mimeType": "audio/wav",
                                        "data": base64.b64encode(audio_data).decode("ascii"),
                                    }},
                                ]
                            }]
                        }
                    )

                latency = time.time() - start_time

                if response.status_code == 200:
                    result = response.json()
                    if provider in ("openai", "groq"):
                        transcription = result.get("text", "")
                    else:
                        transcription = str(result)  # Simplified for Gemini
                    return latency, transcription
                else:
                    return latency, f"ERROR: {response.status_code} - {response.text[:100]}"

        except Exception as e:
            return time.time() - start_time, f"ERROR: {str(e)}"

    async def run_benchmark(self, n_iterations: int = 10) -> Dict[str, Dict]:
        """Run the latency/availability check across all configured providers."""
        results = {}

        for provider in self.providers.keys():
            print(f"\n=== Testing {provider.upper()} ===")
            latencies = []
            errors = []

            for i in range(n_iterations):
                latency, result = await self.transcribe(provider, TEST_AUDIO)

                if result.startswith("ERROR") or result.startswith("SKIPPED"):
                    errors.append(result)
                    print(f"  Iteration {i+1}: {result}")
                else:
                    latencies.append(latency)
                    print(f"  Iteration {i+1}: {latency:.3f}s - {len(result)} chars")

            success_rate = len(latencies) / n_iterations
            results[provider] = {
                "avg_latency": (sum(latencies) / len(latencies)) if latencies else 0.0,
                "success_rate": success_rate,
                "n_iterations": n_iterations,
                "errors": errors,
            }
            if latencies:
                print(f"  Results: {results[provider]['avg_latency']:.3f}s avg latency, {success_rate*100:.1f}% success")
            else:
                print(f"  Results: All failed/skipped — {errors[0] if errors else 'no attempts'}")

        return results


async def main():
    print("=== VoiceFlow Multi-Provider ASR Latency Benchmark ===")
    print("Testing across OpenAI, Gemini, and Groq providers (whichever have API keys set)")

    benchmark = MultiProviderBenchmark()
    results = await benchmark.run_benchmark(n_iterations=5)

    md_path = Path(__file__).resolve().parent / "MULTI_PROVIDER_BENCHMARK.md"

    rows = []
    for provider, data in results.items():
        if data["success_rate"] > 0:
            rows.append(
                f"| {provider.title()} | {data['avg_latency']:.2f}s | "
                f"{data['success_rate']*100:.0f}% ({int(data['success_rate']*data['n_iterations'])}/{data['n_iterations']}) |"
            )
        else:
            status = "no API key" if any("SKIPPED" in e for e in data["errors"]) else "all requests failed"
            rows.append(f"| {provider.title()} | — | 0% ({status}) |")

    measured = [(p, d) for p, d in results.items() if d["success_rate"] > 0]
    if measured:
        fastest = min(measured, key=lambda pd: pd[1]["avg_latency"])
        analysis = f"**{fastest[0].title()}** had the lowest measured round-trip latency this run ({fastest[1]['avg_latency']:.2f}s)."
    else:
        analysis = "No provider had an API key configured for this run — set at least one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GROQ_API_KEY` and re-run."

    content = f"""# VoiceFlow — Multi-Provider ASR Latency Benchmark

Reproducible: `python eval/run_multi_provider_benchmark.py`

## What this measures
Real round-trip latency and success rate against each provider's live API,
using a short generated tone (not a ground-truth transcript). It does **not**
measure Word Error Rate — that requires a reference transcript to score
against. For WER against real speech (LibriSpeech `test-clean`), see
[`WER_BENCHMARK.md`](WER_BENCHMARK.md), which is scored with `jiwer` against
actual reference text.

## Setup
- Audio: a generated 2s mono 16kHz sine-wave WAV (real, valid audio — not fake bytes)
- Providers: OpenAI Whisper, Google Gemini, Groq Whisper — each tried {5} times
- Metrics: average latency, success rate

## Results (this run)

| Provider | Avg Latency | Success Rate |
|----------|-------------|---------------|
{chr(10).join(rows)}

**Analysis:** {analysis}
"""

    with open(md_path, "w") as f:
        f.write(content)

    print(f"\nBenchmark complete! Results written to {md_path}")


if __name__ == "__main__":
    asyncio.run(main())
