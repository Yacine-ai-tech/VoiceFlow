# VoiceFlow — ASR WER Benchmark (LibriSpeech test-clean)

Standard ASR evaluation of the local faster-whisper route. Reproducible:
`python eval/run_wer_benchmark.py --n 20 --model base` (needs faster-whisper, jiwer, soundfile,
datasets; GPU auto-used if present).

## Setup
- Dataset: **LibriSpeech test-clean** (Panayotov et al., 2015) — the standard ASR benchmark.
- Model: faster-whisper `base`, beam_size=5. Standard text normalization (lowercase, strip
  punctuation) before scoring with `jiwer`.

## Results (real run, 2026-06-17, N=20, CPU)
| Metric | Value |
|--------|-------|
| **WER** | **2.9%** |
| **CER** | **0.9%** |

**Honest caveat:** N=20 is a small clean subset — the published whisper-`base` WER on full
test-clean is ~5–6%, so 2.9% here is optimistic. Raise `--n` (and try `--model small/medium`)
for a tighter, more representative number; GPU makes large N fast.

## Update — whisper-large-v3 on GPU (2026-06-17)
| Model | Device | N | WER | CER |
|-------|--------|---|-----|-----|
| base | CPU | 20 | 2.9% | 0.9% |
| **large-v3** | **T4 GPU** | **150** | **2.2%** | **0.8%** |

Tuning to the larger model (base → large-v3) lowered WER to **2.2%** on a bigger, more credible
N=150 sample — approaching the published large-v3 SOTA of ~1.8% on full test-clean.
