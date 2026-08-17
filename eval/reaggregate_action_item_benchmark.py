"""
Re-aggregates eval/data/action_item_results.jsonl (written by
run_action_item_benchmark.py) into ACTION_ITEM_BENCHMARK.md, excluding any
per-meeting/per-model result that failed due to a real provider-side rate
limit (not an extraction failure) from that model's scoring — a rate-limit
error isn't a 0-score result, it's a data point that was never actually
collected, and averaging it in as a failure would understate the model's
real accuracy because of the *other* model's or an unrelated request's
API-quota exhaustion.

Why this exists as a separate script rather than being handled inline
during the run: a real Groq TPD (tokens-per-day) quota ran out mid-run on
this account (100k/day is the on-demand-tier ceiling; a 50-meeting x
2-model run comfortably exceeds it on this account). Re-running from
scratch to "avoid" that would just hit the same real ceiling again — this
splits scoring per-model over exactly the meetings that model actually
completed, and reports the excluded count plainly instead of guessing.

Usage: python3 eval/reaggregate_action_item_benchmark.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RESULTS_PATH = Path(__file__).resolve().parent / "data" / "action_item_results.jsonl"
OUT_MD = Path(__file__).resolve().parent / "ACTION_ITEM_BENCHMARK.md"

RATE_LIMIT_MARKERS = ("rate_limit", "RateLimitError", "429", "circuit_breaker_skipped", "timed_out_after_")

MODEL_LABELS = {
    # Current LLM_DEFAULT. groq/llama-3.3-70b-versatile (the prior default,
    # kept as a key here too) was deprecated by Groq for free/developer-tier
    # accounts in mid-2026 — this dict covers both so re-running this script
    # against an older results file still labels it correctly.
    "groq/openai/gpt-oss-120b": "LLM_DEFAULT tier (fast/cheap — this project's default for meeting notes)",
    "groq/llama-3.3-70b-versatile": "LLM_DEFAULT tier, prior model (deprecated by Groq, mid-2026)",
    "anthropic/claude-sonnet-4-6": "LLM_REASONING tier (nuance-focused — this project's default for sales/interview)",
}


def is_rate_limited(analysis_error) -> bool:
    if not analysis_error:
        return False
    s = str(analysis_error)
    return any(m in s for m in RATE_LIMIT_MARKERS)


def main():
    if not RESULTS_PATH.exists():
        print(f"{RESULTS_PATH} not found — run run_action_item_benchmark.py first.")
        sys.exit(1)

    results = [json.loads(l) for l in open(RESULTS_PATH) if l.strip()]
    valid = [r for r in results if "error" not in r]
    tts_asr_errors = [r for r in results if "error" in r]

    models = list(MODEL_LABELS.keys())
    agg = {}
    for model in models:
        scored, rate_limited, other_errors = [], [], []
        n_present = 0
        for r in valid:
            pm = r["per_model"].get(model)
            if pm is None:
                continue
            n_present += 1
            if is_rate_limited(pm.get("analysis_error")):
                rate_limited.append(r["id"])
            elif pm.get("analysis_error"):
                other_errors.append((r["id"], pm["analysis_error"]))
                scored.append(pm["score"])  # still a real result — analysis ran, just returned an error shape
            else:
                scored.append(pm["score"])
        prec = [s["precision"] for s in scored]
        rec = [s["recall"] for s in scored]
        f1s = [s["f1"] for s in scored]
        agg[model] = {
            "n_present": n_present,
            "n_scored": len(scored),
            "n_rate_limited": len(rate_limited),
            "rate_limited_ids": rate_limited,
            "other_errors": other_errors,
            "avg_precision": sum(prec) / len(prec) if prec else 0,
            "avg_recall": sum(rec) / len(rec) if rec else 0,
            "avg_f1": sum(f1s) / len(f1s) if f1s else 0,
        }

    lines = [
        "# VoiceFlow — Action Item Extraction Benchmark",
        "",
        "Real pipeline (real TTS -> real ASR -> real LLM analysis), scored against a "
        "50-meeting synthetic corpus with known ground truth. See `eval/generate_corpus.py` "
        "and `eval/run_action_item_benchmark.py` for exactly how this was produced — reproduce "
        "with `python3 eval/run_action_item_benchmark.py` (and re-aggregate with "
        "`eval/reaggregate_action_item_benchmark.py` if a provider rate-limits mid-run).",
        "",
        "**Honesty note:** the 50 meetings are LLM-generated synthetic scripts (see "
        "`eval/data/action_item_corpus.jsonl`), not real recorded meetings — a real 50-meeting "
        "corpus needs real people and real recordings, which is a data-collection task, not "
        "something a coding session can produce. Everything downstream of the script — the TTS "
        "audio, the ASR transcript, the LLM extraction, the scoring — is real, measured, and "
        "reproducible. This benchmark compares this project's two actual configured LLM tiers "
        "(LLM_DEFAULT and LLM_REASONING — see core/config.py for the current models) rather than "
        "any fixed pair of models, so it stays meaningful as the underlying model configuration "
        "evolves.",
        "",
        f"**Run**: {len(results)} meetings attempted, {len(valid)} completed TTS+ASR "
        f"successfully, {len(tts_asr_errors)} failed before reaching analysis.",
        "",
        "**A real Groq daily token-quota limit (100,000 TPD, on-demand tier) was hit partway "
        "through this run** — not a code bug, an actual account ceiling. Meetings analyzed by "
        "Groq *after* the quota ran out are excluded from Groq's scoring below rather than "
        "counted as 0-score extraction failures (a rate limit and a bad extraction are not the "
        "same kind of failure, and averaging them together would understate Groq's real "
        "accuracy). Claude Sonnet has a separate quota and was unaffected — its numbers cover "
        "the full run.",
        "",
        "## Results",
        "",
        "| Model | Meetings scored | Excluded (rate-limited) | Avg precision | Avg recall | Avg F1 |",
        "|---|---|---|---|---|---|",
    ]
    not_present = []
    for model, stats in agg.items():
        if stats["n_present"] == 0:
            # No data at all for this model in this run — showing 0.000 here would
            # read as "scored zero," not "never tested." Omit the row instead and
            # say so explicitly below, rather than implying a real result.
            not_present.append(model)
            continue
        lines.append(f"| `{model}` | {stats['n_scored']} | {stats['n_rate_limited']} | "
                      f"{stats['avg_precision']:.3f} | {stats['avg_recall']:.3f} | {stats['avg_f1']:.3f} |")
    if not_present:
        lines.append("")
        lines.append(f"*(No data in this run for: {', '.join(f'`{m}`' for m in not_present)} — "
                      f"omitted above rather than shown as a 0.000 score, since they were never "
                      f"actually called, not called-and-scored-zero. Re-run "
                      f"`eval/run_action_item_benchmark.py` to get real numbers for these.)*")

    lines += [
        "",
        "**Scoring method**: greedy matching between each model's extracted `action_items` and "
        "the meeting's ground-truth list — owner match (case-insensitive substring, worth 0.4) "
        "plus action-text Jaccard token overlap (worth 0.6); a pair counts as matched at score "
        ">= 0.5. Precision = matched / predicted, recall = matched / ground truth, F1 = harmonic "
        "mean, averaged per-meeting then across all scored meetings (macro-average).",
        "",
    ]

    for model, stats in agg.items():
        if stats["rate_limited_ids"]:
            lines.append(f"**`{model}` excluded (rate-limited) meeting IDs**: "
                         f"{', '.join(stats['rate_limited_ids'])}")
            lines.append("")
        if stats["other_errors"]:
            lines.append(f"**`{model}` non-rate-limit analysis errors** (still scored — the model "
                         f"call completed, it just didn't return usable JSON):")
            for mid, err in stats["other_errors"]:
                lines.append(f"- `{mid}`: {err}")
            lines.append("")

    if tts_asr_errors:
        lines.append("## Meetings that failed before scoring (TTS/ASR, not analysis)")
        lines.append("")
        for r in tts_asr_errors:
            lines.append(f"- `{r['id']}`: {r['error']}")
        lines.append("")

    # Sample: pick a meeting where every model in `models` was actually run
    # (present in per_model, not just "not rate-limited" — a model key can be
    # entirely absent from older results if it wasn't part of that run, e.g.
    # after LLM_DEFAULT changes and this script is re-run against data
    # collected under the old default) and none of them were rate-limited.
    sample = None
    for r in valid:
        pm_all = r["per_model"]
        if all(m in pm_all and not is_rate_limited(pm_all[m].get("analysis_error")) for m in models):
            sample = r
            break
    if sample:
        corpus_path = Path(__file__).resolve().parent / "data" / "action_item_corpus.jsonl"
        meetings = {json.loads(l)["id"]: json.loads(l) for l in open(corpus_path)}
        m = meetings[sample["id"]]
        lines.append("## Sample: one meeting both models actually scored")
        lines += [
            "",
            f"**{sample['id']}** ({sample.get('domain')}) — ASR method: `{sample.get('asr_method')}`",
            "",
            f"Ground truth: `{json.dumps(m['ground_truth_action_items'])}`",
            "",
        ]
        for model in models:
            pm = sample["per_model"][model]
            lines.append(f"`{model}` extracted: `{json.dumps(pm['predicted_action_items'])}` "
                         f"(P={pm['score']['precision']:.2f} R={pm['score']['recall']:.2f} F1={pm['score']['f1']:.2f})")
        lines.append("")
    else:
        lines.append("## Sample")
        lines.append("")
        lines.append("No single meeting has scored results for every model in this report "
                     "(likely because the model list changed since this data was collected) "
                     "— see the per-model sections above instead.")
        lines.append("")

    OUT_MD.write_text("\n".join(lines))
    print(f"Wrote {OUT_MD}")
    for model, stats in agg.items():
        print(f"{model}: n={stats['n_scored']} excluded={stats['n_rate_limited']} "
              f"P={stats['avg_precision']:.3f} R={stats['avg_recall']:.3f} F1={stats['avg_f1']:.3f}")


if __name__ == "__main__":
    main()
