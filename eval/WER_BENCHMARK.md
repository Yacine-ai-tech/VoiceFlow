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
N=150 sample. For context against real published numbers (not a claim that N=150 here is
statistically equivalent to a full-test-set run): Whisper large-v3 itself is commonly cited around
2.7-2.8% WER on LibriSpeech test-clean, so this run's 2.2% sits in the expected competitive range
rather than beating a documented baseline — sample-size variance (150 vs. the full ~2,620-utterance
set) is the more likely explanation than a genuine accuracy edge. Separately, as of 2026 the
actual leaderboard-topping open model on the Hugging Face Open ASR Leaderboard is NVIDIA's
Canary-Qwen-2.5B (~1.6% WER on LibriSpeech clean) — a different model family than anything in
VoiceFlow's current provider chain (VoiceFlow's own NeMo Canary option is the much smaller
`nvidia/canary-180m-flash`, not the leaderboard-topping 2.5B variant), noted here as an honest
point of reference rather than a claim VoiceFlow matches or exceeds it.

## Update — whisper-base on CPU, N=500 (2026-09-18)

| Model | Device | N | WER | CER |
|-------|--------|---|-----|-----|
| base | CPU | 20 | 2.9% | 0.9% |
| large-v3 | T4 GPU | 150 | 2.2% | 0.8% |
| **base** | **CPU** | **500** | **6.4%** | **2.6%** |

The full N≥500 run (`openslr/librispeech_asr` — the bare "librispeech_asr" repo id used by the
old script is deprecated/removed on current `datasets`, fixed as part of this run) lands almost
exactly on whisper-`base`'s published ~5-6% WER on full test-clean — confirming the earlier N=20
number (2.9%) genuinely was the small-sample optimism the original caveat predicted, not a real
model advantage. This is the statistically credible number going forward for the `base` CPU route.
