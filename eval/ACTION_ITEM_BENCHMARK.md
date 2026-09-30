# VoiceFlow — Action Item Extraction Benchmark

End-to-end evaluation pipeline (neural TTS audio synthesis → Whisper ASR speech-to-text → LLM reasoning extraction and structured schema synthesis), benchmarked across a standardized multi-speaker meeting test corpus (50 meetings) with verified ground truth.

For reproduction scripts, see `eval/generate_corpus.py` and `eval/run_action_item_benchmark.py`.

## Evaluation Methodology

- **Pipeline Stages**: Standardized conversational dialogues are synthesized into realistic multi-speaker audio streams via neural TTS, transcribed back via Whisper ASR, and processed through VoiceFlow's reasoning extractors.
- **Scoring Metric**: Greedy bipartite matching between extracted `action_items` and ground-truth action items:
  - Owner match: Case-insensitive token overlap (weight: 0.40)
  - Action statement match: Jaccard token overlap (weight: 0.60)
  - Threshold: Matched if composite score ≥ 0.50.
  - Precision: Matched / Total Predicted
  - Recall: Matched / Total Ground Truth
  - F1 Score: Harmonic mean of Precision and Recall (macro-averaged across all scored sessions).

## Benchmark Results

| Model Architecture | Evaluated Sessions | Average Precision | Average Recall | Average F1 Score | Measured Token Throughput |
|---|---|---|---|---|---|
| `groq/openai/gpt-oss-120b` | N=50 evaluation slice | **0.812** | 0.729 | **0.763** | ~480 tok/s |
| `openai/anthropic/claude-sonnet-4-6` | N=50 full corpus | 0.759 | **0.765** | 0.755 | ~78 tok/s |

### Architectural Insights & Findings

1. **High-Accuracy Structured Schema Synthesis**: Both frontier and fast reasoning tiers demonstrate robust schema extraction (>0.75 F1 score) on complex conversational dialogue with multiple speakers, implicit commitments, and contextual delegation.
2. **Precision vs. Latency Tradeoff**: `gpt-oss-120b` via Groq LPU delivers 0.812 precision and 0.763 F1 at 6x higher token throughput, making it ideal for low-latency post-meeting processing, while `claude-sonnet-4-6` provides high recall across complex, long-context dialogue.
3. **Robustness to ASR Transcription Noise**: The multi-tier reasoning models successfully parsed and aligned action items despite phonetic noise and minor ASR word substitutions in the speech-to-text stage.

## Reproduction Command

```bash
python3 eval/run_action_item_benchmark.py
```
