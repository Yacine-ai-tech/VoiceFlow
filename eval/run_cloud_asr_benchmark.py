"""Research-grade ASR benchmark for Cloud Providers (Deepgram) on LibriSpeech test-clean.

Usage:  set -a && source ../.env && set +a && python eval/run_cloud_asr_benchmark.py --n 20
"""
from __future__ import annotations

import argparse
import re
import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", s.lower())).strip()

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20)
    a = ap.parse_args()

    import io
    import jiwer
    from datasets import Audio, load_dataset
    from core.config import settings
    from services.transcription_router import transcribe

    if not settings.DEEPGRAM_API_KEY:
        print("Missing DEEPGRAM_API_KEY")
        sys.exit(1)

    print(f"\nWER benchmark — LibriSpeech test-clean — model=DEEPGRAM N={a.n}")
    ds = load_dataset("openslr/librispeech_asr", "clean", split="test", streaming=True, trust_remote_code=True)
    ds = ds.cast_column("audio", Audio(decode=False))

    refs, hyps = [], []
    for i, ex in enumerate(ds):
        if i >= a.n:
            break
        ab = ex["audio"]
        if ab.get("bytes"):
            audio_bytes = ab["bytes"]
        else:
            with open(ab["path"], "rb") as f:
                audio_bytes = f.read()

        # Call deepgram via our router
        # route_transcription signature: async def route_transcription(audio_bytes: bytes, filename: str, provider: str = None) -> str
        try:
            res = await transcribe(audio_bytes, "test.flac", provider="DEEPGRAM")
            transcript = res.get("text", "")
        except Exception as e:
            print(f"Error on {i}: {e}")
            transcript = ""

        refs.append(_norm(ex["text"]))
        hyps.append(_norm(transcript))
        if (i + 1) % 5 == 0:
            print(f"  transcribed {i+1}/{a.n}")

    wer = jiwer.wer(refs, hyps)
    cer = jiwer.cer(refs, hyps)
    print(f"\n=== RESULTS (N={len(refs)}) ===")
    print(f"  WER: {wer:.3f}  ({wer*100:.1f}%)")
    print(f"  CER: {cer:.3f}  ({cer*100:.1f}%)")
    print(f"  (LibriSpeech test-clean; DEEPGRAM)")

if __name__ == "__main__":
    asyncio.run(main())
