"""Research-grade ASR benchmark: Word Error Rate (WER) on **LibriSpeech test-clean** (Panayotov
et al., 2015 — the standard ASR benchmark) for the local faster-whisper route. Standard text
normalization (lowercase, strip punctuation) before scoring with `jiwer`.

Usage:  python eval/run_wer_benchmark.py --n 20 --model base
Needs:  faster-whisper, jiwer, soundfile, datasets. GPU auto-used if available.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", s.lower())).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--model", default="base")
    a = ap.parse_args()

    import io
    import jiwer
    import soundfile as sf
    from datasets import Audio, load_dataset
    from faster_whisper import WhisperModel
    try:
        import torch
        dev = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        dev = "cpu"
    ct = "float16" if dev == "cuda" else "int8"

    print(f"\nWER benchmark — LibriSpeech test-clean — model={a.model} device={dev} N={a.n}")
    # decode=False → get raw FLAC bytes and decode with soundfile (avoids torchcodec/ffmpeg dep)
    ds = load_dataset("librispeech_asr", "clean", split="test", streaming=True)
    ds = ds.cast_column("audio", Audio(decode=False))
    m = WhisperModel(a.model, device=dev, compute_type=ct)

    refs, hyps = [], []
    for i, ex in enumerate(ds):
        if i >= a.n:
            break
        ab = ex["audio"]
        if ab.get("bytes"):
            arr, _sr = sf.read(io.BytesIO(ab["bytes"]), dtype="float32")
        else:
            arr, _sr = sf.read(ab["path"], dtype="float32")
        segs, _ = m.transcribe(arr, language="en", beam_size=5)
        refs.append(_norm(ex["text"]))
        hyps.append(_norm(" ".join(s.text for s in segs)))
        if (i + 1) % 5 == 0:
            print(f"  transcribed {i+1}/{a.n}")

    wer = jiwer.wer(refs, hyps)
    cer = jiwer.cer(refs, hyps)
    print(f"\n=== RESULTS (N={len(refs)}) ===")
    print(f"  WER: {wer:.3f}  ({wer*100:.1f}%)")
    print(f"  CER: {cer:.3f}  ({cer*100:.1f}%)")
    print(f"  (LibriSpeech test-clean; whisper-{a.model}; standard published WER for base ~5-6%)")


if __name__ == "__main__":
    main()
