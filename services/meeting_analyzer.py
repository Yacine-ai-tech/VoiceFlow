"""
MeetingAnalyzer — Transcript → structured intelligence via multi-LLM routing.

ANALYSIS_MODELS dict routes per analysis type to a specific LLM tier.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Dict, List, Optional

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

try:
    from litellm import acompletion
    _LITELLM = True
except ImportError:
    _LITELLM = False

# Ceiling on a single LLM call. Without this, a rate-limited or slow
# upstream provider (litellm retries 429s internally with its own backoff,
# not bounded by anything the caller can see) can hold a request open
# indefinitely — confirmed directly in this project's own benchmark work
# (eval/run_action_item_benchmark.py), where an identical unbounded call
# genuinely hung. asyncio.wait_for guarantees an upper bound regardless of
# how long litellm's own retry loop would otherwise run; it does not change
# litellm's retry behavior itself (num_retries stays at litellm's default
# here — a deliberate choice for production, unlike the benchmark script,
# which disables retries entirely for its own reproducibility needs).
ANALYSIS_TIMEOUT_SECONDS = int(os.getenv("LLM_ANALYSIS_TIMEOUT_SECONDS", "60"))

# Transcripts longer than this are truncated before being sent to the model
# (see _truncate below) — kept as a module constant so the truncation flag
# added to every response and the actual slicing can never drift apart.
MAX_TRANSCRIPT_CHARS = 12000


def _truncate(transcript: str) -> tuple[str, bool, int]:
    original_length = len(transcript)
    if original_length <= MAX_TRANSCRIPT_CHARS:
        return transcript, False, original_length
    return transcript[:MAX_TRANSCRIPT_CHARS], True, original_length


ANALYSIS_MODELS: Dict[str, str] = {
    "meeting": settings.LLM_DEFAULT,
    "general": settings.LLM_DEFAULT,
    "sales_call": settings.LLM_REASONING,
    "support_call": settings.LLM_JUDGE,
    "interview": settings.LLM_REASONING,
}


PROMPTS: Dict[str, str] = {
    "meeting": (
        "Extract from this meeting transcript as JSON: "
        "meeting_summary (3-5 sentences), duration_minutes (estimate from word count if absent), "
        "participants_mentioned, decisions, "
        "action_items: [{owner, action, due (ISO YYYY-MM-DD or null), priority}], "
        "key_numbers, open_questions, next_steps, "
        "sentiment (positive|neutral|tense|mixed), topics_covered. JSON only."
    ),
    "sales_call": (
        "Extract from this sales-call transcript as JSON: "
        "call_summary, prospect_company, prospect_contact, prospect_role, "
        "pain_points, objections: [{type, content}], buying_signals, budget_mentioned, "
        "deal_stage (discovery|evaluation|negotiation|closing), "
        "crm_notes (Salesforce/HubSpot-paste ready), overall_sentiment, "
        "likelihood_to_close (0-1). JSON only."
    ),
    "support_call": (
        "Extract from this support-call transcript as JSON: "
        "customer_issue, severity (low|medium|high|critical), "
        "resolution_summary, escalation_needed (true|false), "
        "follow_ups: [{action, owner, due}], sentiment. JSON only."
    ),
    "interview": (
        "Extract from this interview transcript as JSON: "
        "candidate_name, role_discussed, strengths, gaps, "
        "key_quotes (3-5), recommendation (hire|maybe|no_hire), reasoning. JSON only."
    ),
    "general": (
        "Extract structured intelligence from this transcript as JSON. "
        "Use whatever fields naturally describe the content. JSON only."
    ),
}


def _strip_fences(text: str) -> str:
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


class MeetingAnalyzer:
    """Multi-LLM analyzer for transcripts."""

    async def analyze(self, transcript: str, analysis_type: str = "meeting",
                      model: Optional[str] = None) -> Dict[str, Any]:
        """`model` overrides the analysis_type's default tier — used by named
        scenarios (services/scenarios.py) to pin an exact model for benchmarking."""
        if not _LITELLM:
            return {"error": "litellm_not_installed", "analysis_type": analysis_type}
        prompt = PROMPTS.get(analysis_type, PROMPTS["general"])
        model = model or ANALYSIS_MODELS.get(analysis_type, settings.LLM_DEFAULT)
        sent_transcript, truncated, original_length = _truncate(transcript)
        try:
            resp = await asyncio.wait_for(
                acompletion(
                    model=model,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": sent_transcript},
                    ],
                    temperature=0.2,
                ),
                timeout=ANALYSIS_TIMEOUT_SECONDS,
            )
            content = resp.choices[0].message.content or "{}"
            result = json.loads(_strip_fences(content))
        except asyncio.TimeoutError:
            return {"error": f"analysis_timed_out_after_{ANALYSIS_TIMEOUT_SECONDS}s", "analysis_type": analysis_type}
        except json.JSONDecodeError:
            return {"error": "non_json_response", "raw": content[:500] if 'content' in dir() else ""}
        except Exception as e:
            log.exception("analyze (%s) failed: %s", analysis_type, e)
            return {"error": str(e)}
        if truncated and isinstance(result, dict):
            result["truncated"] = True
            result["original_length"] = original_length
        return result

    async def analyze_custom(self, transcript: str, fields: List[str],
                             instructions: str = "") -> Dict[str, Any]:
        """Extract a caller-defined JSON schema from a transcript (v1 custom-schema ask)."""
        if not _LITELLM:
            return {"error": "litellm_not_installed"}
        field_list = ", ".join(f for f in fields if f.strip())
        prompt = (
            "Extract the following fields from this transcript as JSON: "
            f"{field_list}. "
            + (f"Additional instructions: {instructions}. " if instructions.strip() else "")
            + "Return ONLY valid JSON with exactly these keys; use null for anything absent."
        )
        sent_transcript, truncated, original_length = _truncate(transcript)
        try:
            resp = await asyncio.wait_for(
                acompletion(
                    model=settings.LLM_REASONING,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": sent_transcript},
                    ],
                    temperature=0.1,
                ),
                timeout=ANALYSIS_TIMEOUT_SECONDS,
            )
            content = resp.choices[0].message.content or "{}"
            result = json.loads(_strip_fences(content))
        except asyncio.TimeoutError:
            return {"error": f"analysis_timed_out_after_{ANALYSIS_TIMEOUT_SECONDS}s"}
        except json.JSONDecodeError:
            return {"error": "non_json_response", "raw": (content[:500] if "content" in dir() else "")}
        except Exception as e:
            log.exception("analyze_custom failed: %s", e)
            return {"error": str(e)}
        if truncated and isinstance(result, dict):
            result["truncated"] = True
            result["original_length"] = original_length
        return result

    async def analyze_meeting(self, transcript: str) -> Dict[str, Any]:
        return await self.analyze(transcript, "meeting")

    async def analyze_sales_call(self, transcript: str) -> Dict[str, Any]:
        return await self.analyze(transcript, "sales_call")

    async def analyze_support_call(self, transcript: str) -> Dict[str, Any]:
        return await self.analyze(transcript, "support_call")

    async def analyze_interview(self, transcript: str) -> Dict[str, Any]:
        return await self.analyze(transcript, "interview")

    async def general_analysis(self, transcript: str) -> Dict[str, Any]:
        return await self.analyze(transcript, "general")
