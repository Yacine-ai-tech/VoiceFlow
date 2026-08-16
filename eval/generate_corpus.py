"""
Generates eval/data/action_item_corpus.jsonl — 50 SYNTHETIC meeting
transcripts with known ground-truth action items, for
run_action_item_benchmark.py to score real transcription+analysis output
against.

Honesty note: these are LLM-generated meeting scripts, not real recorded
meetings. A real 50-meeting corpus (real people, real recordings, human-
labeled ground truth) is a data-collection task outside what a coding
session can produce — see ACTION_ITEM_BENCHMARK.md for what this
substitutes for and why the substitution is still a legitimate way to
measure real pipeline behavior (real TTS audio, real ASR, real LLM
analysis, real scoring — only the source meeting content is synthetic).

Usage: python3 eval/generate_corpus.py
Requires ANTHROPIC_API_KEY. Idempotent-ish: overwrites the corpus file.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import settings

DOMAINS = [
    "engineering sprint standup", "sales discovery call", "quarterly budget review",
    "product roadmap planning", "incident postmortem", "candidate hiring debrief",
    "marketing campaign retro", "customer support escalation", "board update briefing",
    "vendor contract negotiation", "new-hire onboarding sync", "OKR check-in",
    "partnership exploration call", "legal contract review", "infrastructure migration planning",
    "customer renewal call", "design review", "compliance audit prep",
    "cross-team dependency sync", "executive staff meeting", "fundraising update",
    "churn analysis review", "performance review calibration", "launch readiness review",
    "supply chain coordination", "data privacy review", "pricing strategy discussion",
    "customer success QBR", "security incident review", "annual planning kickoff",
    "engineering architecture review", "customer feedback triage", "expansion market analysis",
    "team retrospective", "procurement approval meeting", "content calendar planning",
    "user research readout", "disaster recovery drill debrief", "internal tooling review",
    "M&A due diligence sync", "brand partnership pitch", "localization planning",
    "developer platform office hours", "capacity planning review", "customer onboarding kickoff",
    "regulatory compliance briefing", "all-hands Q&A follow-up",
    "customer churn save call", "release train planning", "third-party audit kickoff",
]

BATCH_SIZE = 5
N_MEETINGS = 50

PROMPT_TEMPLATE = """Generate {n} realistic, DISTINCT business meeting transcripts for an ASR/LLM \
evaluation benchmark. Domains to use (one each, in order): {domains}.

For each meeting, write:
- A short spoken-style transcript (90-140 words), as if one or two people are talking \
  naturally in a real meeting — first names only, concrete numbers/dates/companies, \
  natural filler occasionally ("okay", "so", "yeah"). NOT a bulleted summary — actual \
  spoken dialogue a person would say out loud.
- 2-4 ground-truth action items that a good notetaker would extract from that transcript. \
  Each action item MUST be clearly stated or strongly implied in the transcript text itself \
  (owner's first name, a concrete action, and a due date or relative timeframe like "Friday" \
  or "end of week" if one is mentioned — use null if genuinely no due date is mentioned).

Return ONLY a JSON array, no prose, no markdown fences. Each element:
{{"domain": "...", "transcript": "...", "ground_truth_action_items": [{{"owner": "...", "action": "...", "due": "... or null"}}]}}
"""


async def generate_batch(domains: list[str]) -> list[dict]:
    from litellm import acompletion
    prompt = PROMPT_TEMPLATE.format(n=len(domains), domains=", ".join(domains))
    resp = await acompletion(
        model="anthropic/claude-sonnet-4-6",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.9,
        max_tokens=4000,
    )
    content = resp["choices"][0]["message"]["content"].strip()
    if content.startswith("```"):
        content = content.split("```")[1]
        if content.startswith("json"):
            content = content[4:]
    return json.loads(content)


async def main():
    if not settings.ANTHROPIC_API_KEY:
        print("ANTHROPIC_API_KEY not configured — cannot generate corpus.")
        sys.exit(1)

    all_meetings = []
    for i in range(0, N_MEETINGS, BATCH_SIZE):
        batch_domains = DOMAINS[i:i + BATCH_SIZE]
        print(f"Generating meetings {i+1}-{i+len(batch_domains)} ({', '.join(batch_domains)})...")
        try:
            batch = await generate_batch(batch_domains)
        except Exception as e:
            print(f"  FAILED: {e}")
            continue
        for m in batch:
            m["id"] = f"meeting-{len(all_meetings)+1:03d}"
            all_meetings.append(m)
        print(f"  got {len(batch)} meetings, total so far: {len(all_meetings)}")

    out_path = Path(__file__).resolve().parent / "data" / "action_item_corpus.jsonl"
    with open(out_path, "w") as f:
        for m in all_meetings:
            f.write(json.dumps(m) + "\n")
    print(f"\nWrote {len(all_meetings)} meetings to {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
