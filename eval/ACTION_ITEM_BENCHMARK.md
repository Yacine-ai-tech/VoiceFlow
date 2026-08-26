# VoiceFlow — Action Item Extraction Benchmark

Real pipeline (real TTS -> real ASR -> real LLM analysis), scored against a 50-meeting synthetic corpus with known ground truth. See `eval/generate_corpus.py` and `eval/run_action_item_benchmark.py` for exactly how this was produced — reproduce with `python3 eval/run_action_item_benchmark.py` (and re-aggregate with `eval/reaggregate_action_item_benchmark.py` if a provider rate-limits mid-run).

**Honesty note:** the 50 meetings are LLM-generated synthetic scripts (see `eval/data/action_item_corpus.jsonl`), not real recorded meetings — a real 50-meeting corpus needs real people and real recordings, which is a data-collection task, not something a coding session can produce. Everything downstream of the script — the TTS audio, the ASR transcript, the LLM extraction, the scoring — is real, measured, and reproducible. This benchmark compares this project's two actual configured LLM tiers (LLM_DEFAULT and LLM_REASONING — see core/config.py for the current models) rather than any fixed pair of models, so it stays meaningful as the underlying model configuration evolves.

**Run**: 50 meetings attempted, 38 completed TTS+ASR successfully, 12 failed before reaching analysis.

**A free-tier API quota ceiling was reached partway through this run** — not a code bug, an actual provider daily token limit. Meetings analyzed by Groq *after* the quota ran out are excluded from Groq's scoring below rather than counted as 0-score extraction failures (a rate limit and a bad extraction are not the same kind of failure, and averaging them together would understate Groq's real accuracy on meetings it actually processed). Claude Sonnet operates under a separate quota and was unaffected — its numbers cover the full run.

## Results

| Model | Meetings scored | Excluded (rate-limited) | Avg precision | Avg recall | Avg F1 |
|---|---|---|---|---|---|
| `groq/llama-3.3-70b-versatile` | 2 | 36 | 0.500 | 0.500 | 0.500 |
| `anthropic/claude-sonnet-4-6` | 38 | 0 | 0.502 | 0.518 | 0.506 |

*(No data in this run for: `groq/openai/gpt-oss-120b` — omitted above rather than shown as a 0.000 score, since they were never actually called, not called-and-scored-zero. Re-run `eval/run_action_item_benchmark.py` to get real numbers for these.)*

**Scoring method**: greedy matching between each model's extracted `action_items` and the meeting's ground-truth list — owner match (case-insensitive substring, worth 0.4) plus action-text Jaccard token overlap (worth 0.6); a pair counts as matched at score >= 0.5. Precision = matched / predicted, recall = matched / ground truth, F1 = harmonic mean, averaged per-meeting then across all scored meetings (macro-average).

**`groq/llama-3.3-70b-versatile` excluded (rate-limited) meeting IDs**: meeting-002, meeting-005, meeting-007, meeting-008, meeting-009, meeting-010, meeting-011, meeting-012, meeting-013, meeting-014, meeting-016, meeting-017, meeting-020, meeting-021, meeting-024, meeting-025, meeting-026, meeting-028, meeting-030, meeting-031, meeting-032, meeting-033, meeting-034, meeting-036, meeting-037, meeting-038, meeting-039, meeting-040, meeting-041, meeting-042, meeting-043, meeting-045, meeting-046, meeting-048, meeting-049, meeting-050

**`anthropic/claude-sonnet-4-6` non-rate-limit analysis errors** (still scored — the model call completed, it just didn't return usable JSON):
- `meeting-017`: non_json_response
- `meeting-021`: non_json_response
- `meeting-040`: non_json_response
- `meeting-048`: non_json_response

## Meetings that failed before scoring (TTS/ASR, not analysis)

- `meeting-004`: timed_out_after_90s
- `meeting-006`: timed_out_after_90s
- `meeting-015`: timed_out_after_90s
- `meeting-018`: timed_out_after_90s
- `meeting-019`: timed_out_after_90s
- `meeting-022`: timed_out_after_90s
- `meeting-023`: timed_out_after_90s
- `meeting-027`: timed_out_after_90s
- `meeting-029`: timed_out_after_90s
- `meeting-035`: timed_out_after_90s
- `meeting-044`: timed_out_after_90s
- `meeting-047`: timed_out_after_90s

## Sample

No single meeting has scored results for every model in this report (likely because the model list changed since this data was collected) — see the per-model sections above instead.
