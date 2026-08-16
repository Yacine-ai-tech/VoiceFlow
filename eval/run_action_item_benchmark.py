"""
Real, end-to-end action-item extraction benchmark: "Speech-to-Intelligence —
Evaluating LLM Post-Processing of Whisper Transcripts for Action Item
Extraction."

Pipeline per meeting, all real, no shortcuts:
  1. Real TTS (edge-tts) synthesizes the meeting script into actual audio.
  2. Real ASR (Groq Whisper) transcribes that audio back to text — this is
     the "Whisper transcript" the meeting content actually went through,
     with real transcription noise/errors, not the original script text.
  3. Real LLM analysis (services/meeting_analyzer.py, analysis_type="meeting")
     extracts action items from that real transcript, once per model under
     comparison — LLM_DEFAULT (Groq Llama 3.3 70B) vs LLM_REASONING (Claude
     Sonnet 4.6), the two tiers this project actually uses (see
     ACTION_ITEM_BENCHMARK.md for the full model comparison rationale).
  4. Real scoring: each model's extracted action_items vs the corpus's
     ground-truth action_items, via greedy owner+action-similarity matching.

Robustness (added after a real run hung on 3/50 meetings — litellm retrying
a rate-limited Groq call internally with no upper bound the caller could see):
  - Every meeting is wrapped in an overall asyncio.wait_for timeout, so one
    stuck call can't block the whole run indefinitely.
  - Results are appended to the raw JSONL file as each meeting finishes, not
    only at the end — killing a stuck run doesn't lose completed work.
  - A per-model circuit breaker: after N consecutive rate-limit errors from
    one model, that model is skipped (not called) for the rest of the run —
    once a daily quota is confirmed exhausted, retrying it per-meeting just
    burns time and (usually) more of the same exhausted quota.

Honesty note: the 50 *meetings themselves* are LLM-generated synthetic
scripts (see generate_corpus.py), not real recordings — real audio, real
transcription, real analysis, real scoring all still happen on top of that
synthetic source text. See ACTION_ITEM_BENCHMARK.md for exactly what this
does and doesn't prove.

Usage: python3 eval/run_action_item_benchmark.py [--limit N] [--concurrency N]
Then:  python3 eval/reaggregate_action_item_benchmark.py   (writes the .md report)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.meeting_analyzer import MeetingAnalyzer
from services.transcription_adapter import transcribe as route_transcribe
from services.tts_service import generate_speech

# litellm retries rate-limit errors internally by default, with its own
# backoff — that's the right default for production (services/meeting_
# analyzer.py, untouched here), but for this benchmark it meant a single
# rate-limited call could silently eat most of MEETING_TIMEOUT_S before
# ever raising, defeating the circuit breaker below (which needs the real
# error back quickly to count failures and trip). Disabled for this
# process only.
import litellm
litellm.num_retries = 0
litellm.request_timeout = 25

CORPUS_PATH = Path(__file__).resolve().parent / "data" / "action_item_corpus.jsonl"
RAW_PATH = Path(__file__).resolve().parent / "data" / "action_item_results.jsonl"

MODELS_UNDER_TEST = [
    "groq/llama-3.3-70b-versatile",
    "anthropic/claude-sonnet-4-6",
]

MEETING_TIMEOUT_S = 90
CIRCUIT_BREAKER_THRESHOLD = 3  # consecutive rate-limit errors before skipping a model for the rest of the run

_STOPWORDS = {"the", "a", "an", "to", "for", "of", "on", "in", "by", "and", "with", "will", "is", "be"}
_RATE_LIMIT_MARKERS = ("rate_limit", "RateLimitError", "429")


def _tokens(s: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in _STOPWORDS}


def _action_similarity(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _owner_match(a: str, b: str) -> bool:
    a, b = (a or "").strip().lower(), (b or "").strip().lower()
    if not a or not b:
        return False
    return a == b or a in b or b in a


def score_action_items(predicted: list, ground_truth: list) -> dict:
    used = set()
    matched = 0
    for gt in ground_truth:
        best_idx, best_score = None, 0.0
        for i, pred in enumerate(predicted):
            if i in used:
                continue
            score = (0.4 if _owner_match(gt.get("owner"), pred.get("owner")) else 0.0) + \
                    0.6 * _action_similarity(gt.get("action"), pred.get("action"))
            if score > best_score:
                best_score, best_idx = score, i
        if best_idx is not None and best_score >= 0.5:
            used.add(best_idx)
            matched += 1
    precision = matched / len(predicted) if predicted else (1.0 if not ground_truth else 0.0)
    recall = matched / len(ground_truth) if ground_truth else 1.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"matched": matched, "predicted": len(predicted), "ground_truth": len(ground_truth),
            "precision": precision, "recall": recall, "f1": f1}


def _is_rate_limited(err) -> bool:
    if not err:
        return False
    s = str(err)
    return any(m in s for m in _RATE_LIMIT_MARKERS)


async def process_meeting(analyzer: MeetingAnalyzer, meeting: dict, broken_models: set) -> dict:
    mid = meeting["id"]
    script = meeting["transcript"]
    gt_items = meeting["ground_truth_action_items"]

    try:
        audio = await generate_speech(script, provider="edge")
    except Exception as e:
        return {"id": mid, "error": f"tts_failed: {e}"}

    trans = await route_transcribe(audio, provider="groq")
    asr_text = trans.get("text", "")
    if not asr_text.strip():
        return {"id": mid, "error": f"asr_failed: {trans.get('error')}"}

    per_model = {}
    for model in MODELS_UNDER_TEST:
        if model in broken_models:
            per_model[model] = {"predicted_action_items": [], "score": None, "analysis_error": "circuit_breaker_skipped"}
            continue
        analysis = await analyzer.analyze(asr_text, analysis_type="meeting", model=model)
        predicted = analysis.get("action_items", []) if isinstance(analysis, dict) else []
        if not isinstance(predicted, list):
            predicted = []
        err = analysis.get("error") if isinstance(analysis, dict) else "non_dict_response"
        per_model[model] = {
            "predicted_action_items": predicted,
            "score": score_action_items(predicted, gt_items),
            "analysis_error": err,
        }

    return {
        "id": mid, "domain": meeting.get("domain"),
        "asr_method": trans.get("method"), "asr_text_len": len(asr_text),
        "ground_truth_count": len(gt_items),
        "per_model": per_model,
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--concurrency", type=int, default=3)
    args = ap.parse_args()

    if not CORPUS_PATH.exists():
        print(f"Corpus not found at {CORPUS_PATH} — run eval/generate_corpus.py first.")
        sys.exit(1)

    meetings = [json.loads(l) for l in open(CORPUS_PATH) if l.strip()]
    if args.limit:
        meetings = meetings[:args.limit]
    print(f"Running {len(meetings)} meetings through real TTS -> real ASR -> real analysis "
          f"(timeout={MEETING_TIMEOUT_S}s/meeting, concurrency={args.concurrency})...")

    analyzer = MeetingAnalyzer()
    sem = asyncio.Semaphore(args.concurrency)
    t0 = time.time()

    broken_models: set = set()
    consecutive_rate_limits = {m: 0 for m in MODELS_UNDER_TEST}
    raw_file = open(RAW_PATH, "w")
    lock = asyncio.Lock()
    n_done = 0

    async def _run(m, i):
        nonlocal n_done
        async with sem:
            try:
                r = await asyncio.wait_for(process_meeting(analyzer, m, broken_models), timeout=MEETING_TIMEOUT_S)
            except asyncio.TimeoutError:
                r = {"id": m["id"], "error": f"timed_out_after_{MEETING_TIMEOUT_S}s"}

            if "error" not in r:
                for model in MODELS_UNDER_TEST:
                    pm = r["per_model"].get(model, {})
                    if _is_rate_limited(pm.get("analysis_error")):
                        consecutive_rate_limits[model] += 1
                        if consecutive_rate_limits[model] >= CIRCUIT_BREAKER_THRESHOLD and model not in broken_models:
                            broken_models.add(model)
                            print(f"  !! circuit breaker tripped for {model} after "
                                  f"{CIRCUIT_BREAKER_THRESHOLD} consecutive rate limits — skipping it for the rest of the run")
                    else:
                        consecutive_rate_limits[model] = 0

            async with lock:
                raw_file.write(json.dumps(r) + "\n")
                raw_file.flush()
                n_done += 1
                print(f"  [{n_done}/{len(meetings)}] {m['id']} ({m.get('domain')}) -> "
                      f"{'ERROR: ' + r['error'] if 'error' in r else 'ok'}")
            return r

    await asyncio.gather(*[_run(m, i) for i, m in enumerate(meetings)])
    raw_file.close()
    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s. Raw results written incrementally to {RAW_PATH}")
    print("Run eval/reaggregate_action_item_benchmark.py to produce ACTION_ITEM_BENCHMARK.md")


if __name__ == "__main__":
    asyncio.run(main())
