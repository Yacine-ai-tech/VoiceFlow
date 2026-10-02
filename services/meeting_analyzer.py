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
    import litellm
    from litellm import acompletion
    # Some model families (e.g. the gpt-5 line) reject a temperature other than the
    # provider default and raise UnsupportedParamsError instead of silently ignoring
    # it — drop_params lets litellm strip an incompatible sampling param per-model
    # rather than this analyzer needing a model-family special case for every tier
    # it might be pointed at via LLM_DEFAULT/LLM_REASONING/LLM_JUDGE.
    litellm.drop_params = True
    _LITELLM = True
except ImportError:
    _LITELLM = False

_AUTH_SIGNALS = (
    "AuthenticationError", "PermissionDeniedError", "APIError", "RateLimitError",
    "401", "402", "403", "429", "insufficient_balance", "invalid_api_key",
    "invalid api key", "credit", "quota", "resource_exhausted", "billing", "unauthorized",
    "credit balance is too low", "credit_balance", "payment_required"
)


def _resolve_fallback(fallback: str = "") -> str:
    """Resolve an operational fallback model dynamically if not explicitly specified."""
    if fallback:
        return fallback
    if getattr(settings, "LLM_REASONING_FALLBACK", ""):
        return settings.LLM_REASONING_FALLBACK
    if getattr(settings, "GROQ_API_KEY", ""):
        return os.getenv("GROQ_FALLBACK_MODEL", "groq/openai/gpt-oss-120b")
    if getattr(settings, "GEMINI_API_KEY", ""):
        return os.getenv("GEMINI_FALLBACK_MODEL", "gemini/gemini-2.5-flash")
    return ""


async def _llm_with_fallback(model: str, messages: list, fallback: str = "", **kwargs) -> Any:
    """acompletion wrapper with chained auth/billing/credit error fallback to Groq & Gemini."""
    call_kwargs = dict(kwargs)
    if "num_retries" not in call_kwargs:
        call_kwargs["num_retries"] = 1
    if "timeout" not in call_kwargs:
        call_kwargs["timeout"] = 15

    # Build prioritized candidate fallback chain
    candidate_models: list[str] = [model]
    explicit_fb = fallback or getattr(settings, "LLM_REASONING_FALLBACK", "")
    if explicit_fb and explicit_fb not in candidate_models:
        candidate_models.append(explicit_fb)
    # Dynamic Groq fallback
    groq_fb = os.getenv("GROQ_FALLBACK_MODEL", "groq/openai/gpt-oss-120b")
    if getattr(settings, "GROQ_API_KEY", "") and groq_fb not in candidate_models:
        candidate_models.append(groq_fb)
    # Dynamic Gemini fallback
    gemini_fb = os.getenv("GEMINI_FALLBACK_MODEL", "gemini/gemini-2.5-flash")
    if getattr(settings, "GEMINI_API_KEY", "") and gemini_fb not in candidate_models:
        candidate_models.append(gemini_fb)

    last_exc = None
    for idx, candidate in enumerate(candidate_models):
        try:
            return await acompletion(model=candidate, messages=messages, **call_kwargs)
        except Exception as exc:
            last_exc = exc
            exc_str = (str(exc) + " " + type(exc).__name__).lower()
            is_auth_or_quota = any(s.lower() in exc_str for s in _AUTH_SIGNALS)
            if (is_auth_or_quota or idx == 0) and idx + 1 < len(candidate_models):
                log.warning(
                    "model=%s failed (%s) — retrying with fallback %s",
                    candidate, type(exc).__name__, candidate_models[idx + 1]
                )
                continue
            raise
    if last_exc:
        raise last_exc


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


MULTILINGUAL_DIRECTIVES: Dict[str, str] = {
    "fr": (
        "Vous êtes un analyste expert d'intelligence conversationnelle. "
        "Rédigez l'ensemble des résumés, actions, descriptions, décisions et notes EN FRANÇAIS. "
        "Conservez les noms propres originaux et produisez strictement du JSON valide."
    ),
    "en": (
        "You are an expert conversational intelligence analyst. "
        "Produce all summaries, action items, descriptions, decisions, and notes IN ENGLISH. "
        "Preserve original proper nouns and output strictly valid JSON."
    ),
    "auto": (
        "You are an expert multilingual conversational intelligence analyst. "
        "Faithfully analyze the transcript in its primary language (e.g., French if the discussion was in French, English if in English). "
        "Output strictly valid JSON conforming exactly to the requested schema."
    ),
}

PROMPTS: Dict[str, str] = {
    "meeting": (
        "Extract from this meeting transcript as JSON: "
        "meeting_summary (3-5 sentences), duration_minutes (estimate from word count if absent), "
        "participants_mentioned, decisions, "
        "action_items: [{owner, action, due (ISO YYYY-MM-DD or null), priority (low|medium|high)}], "
        "annotations: [{time, speaker, type (decision|action_item|objection|insight|question|quote), title, note, quote}], "
        "key_numbers, open_questions, next_steps, "
        "sentiment (positive|neutral|tense|mixed), topics_covered. JSON only."
    ),
    "sales_call": (
        "Extract from this sales-call transcript as JSON: "
        "call_summary, prospect_company, prospect_contact, prospect_role, "
        "pain_points, objections: [{type, content}], buying_signals, budget_mentioned, "
        "deal_stage (discovery|evaluation|negotiation|closing), "
        "annotations: [{time, speaker, type (decision|action_item|objection|insight|question|quote), title, note, quote}], "
        "crm_notes (Salesforce/HubSpot-paste ready notes with next steps), overall_sentiment, "
        "likelihood_to_close (float 0.0 to 1.0). JSON only."
    ),
    "support_call": (
        "Extract from this support-call transcript as JSON: "
        "customer_issue, severity (low|medium|high|critical), "
        "resolution_summary, escalation_needed (boolean true|false), "
        "annotations: [{time, speaker, type (decision|action_item|objection|insight|question|quote), title, note, quote}], "
        "follow_ups: [{action, owner, due}], sentiment (positive|neutral|frustrated|satisfied). JSON only."
    ),
    "interview": (
        "Extract from this interview transcript as JSON: "
        "candidate_name, role_discussed, strengths: [string], gaps: [string], "
        "key_quotes: [string] (3-5 verbatim quotes), "
        "annotations: [{time, speaker, type (decision|action_item|objection|insight|question|quote), title, note, quote}], "
        "recommendation (hire|maybe|no_hire), reasoning. JSON only."
    ),
    "general": (
        "Extract structured intelligence from this transcript as JSON: "
        "summary (3-5 sentences), main_topics: [string], key_insights: [string], "
        "decisions: [string], action_items: [{owner, action, due, priority}], "
        "annotations: [{time, speaker, type (decision|action_item|objection|insight|question|quote), title, note, quote}], "
        "participants_mentioned: [string], sentiment (positive|neutral|negative|mixed). JSON only."
    ),
}


def _synthesize_annotations(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Synthesize structured annotations from parsed fields if annotations was absent or empty."""
    items: List[Dict[str, Any]] = []
    # Decisions
    for d in data.get("decisions") or []:
        title = d if isinstance(d, str) else d.get("title", d.get("decision", "Decision"))
        items.append({
            "time": None,
            "speaker": None,
            "type": "decision",
            "title": str(title)[:100],
            "note": str(d) if isinstance(d, str) else d.get("note", str(d)),
            "quote": None,
        })
    # Action items
    for a in data.get("action_items") or data.get("follow_ups") or []:
        if isinstance(a, dict):
            owner = a.get("owner")
            act = a.get("action", "Action item")
            due = a.get("due")
            pri = a.get("priority", "medium")
            items.append({
                "time": None,
                "speaker": owner,
                "type": "action_item",
                "title": str(act)[:100],
                "note": f"Priority: {pri}" + (f", Due: {due}" if due else ""),
                "quote": None,
            })
        else:
            items.append({
                "time": None,
                "speaker": None,
                "type": "action_item",
                "title": str(a)[:100],
                "note": str(a),
                "quote": None,
            })
    # Objections
    for o in data.get("objections") or []:
        if isinstance(o, dict):
            items.append({
                "time": None,
                "speaker": None,
                "type": "objection",
                "title": str(o.get("type", "Objection"))[:100],
                "note": str(o.get("content", str(o))),
                "quote": None,
            })
        else:
            items.append({
                "time": None,
                "speaker": None,
                "type": "objection",
                "title": "Objection",
                "note": str(o),
                "quote": None,
            })
    # Insights / key numbers
    for num in data.get("key_numbers") or data.get("key_insights") or []:
        items.append({
            "time": None,
            "speaker": None,
            "type": "insight",
            "title": "Key Insight",
            "note": str(num),
            "quote": None,
        })
    # Open questions
    for q in data.get("open_questions") or []:
        items.append({
            "time": None,
            "speaker": None,
            "type": "question",
            "title": "Open Question",
            "note": str(q),
            "quote": None,
        })
    # Quotes
    for q in data.get("key_quotes") or []:
        items.append({
            "time": None,
            "speaker": None,
            "type": "quote",
            "title": "Key Quote",
            "note": str(q),
            "quote": str(q),
        })
    return items


def _strip_fences(text: str) -> str:
    text = text.strip()
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1).strip()
    brace_match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", text)
    if brace_match:
        return brace_match.group(1).strip()
    return text


class MeetingAnalyzer:
    """Multi-LLM analyzer for transcripts."""

    async def analyze(self, transcript: str, analysis_type: str = "meeting",
                      model: Optional[str] = None,
                      language: Optional[str] = "auto") -> Dict[str, Any]:
        """`model` overrides the analysis_type's default tier — used by named
        scenarios (services/scenarios.py) to pin an exact model for benchmarking.
        `language` selects or guides the output language ('fr', 'en', or 'auto')."""
        if not _LITELLM:
            return {"error": "litellm_not_installed", "analysis_type": analysis_type}
        transcript = transcript or ""
        base_prompt = PROMPTS.get(analysis_type, PROMPTS["general"])
        lang_key = (language or "auto").strip().lower()
        directive = MULTILINGUAL_DIRECTIVES.get(lang_key, MULTILINGUAL_DIRECTIVES["auto"])
        prompt = f"{directive}\n\n{base_prompt}"
        model = model or ANALYSIS_MODELS.get(analysis_type, settings.LLM_DEFAULT)
        sent_transcript, truncated, original_length = _truncate(transcript)
        if not sent_transcript.strip():
            sent_transcript = "[no speech detected in this audio]"
        try:
            fallback = settings.LLM_REASONING_FALLBACK if "reasoning" in model.lower() or model == settings.LLM_REASONING else settings.LLM_JUDGE_FALLBACK
            resp = await asyncio.wait_for(
                _llm_with_fallback(
                    model=model,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": sent_transcript},
                    ],
                    fallback=fallback,
                    temperature=0.2,
                ),
                timeout=ANALYSIS_TIMEOUT_SECONDS,
            )
            content = resp.choices[0].message.content or "{}"
            result = json.loads(_strip_fences(content))
            if isinstance(result, dict):
                raw_ann = result.get("annotations")
                if not raw_ann or not isinstance(raw_ann, list):
                    result["annotations"] = _synthesize_annotations(result)
                else:
                    clean_ann = []
                    for item in raw_ann:
                        if isinstance(item, dict) and (item.get("title") or item.get("note")):
                            clean_ann.append({
                                "time": item.get("time") or None,
                                "speaker": item.get("speaker") or None,
                                "type": str(item.get("type") or "insight").lower(),
                                "title": str(item.get("title") or item.get("note") or "")[:120],
                                "note": str(item.get("note") or item.get("title") or ""),
                                "quote": item.get("quote") or None,
                            })
                    result["annotations"] = clean_ann if clean_ann else _synthesize_annotations(result)
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
                             instructions: str = "",
                             language: Optional[str] = "auto") -> Dict[str, Any]:
        """Extract a caller-defined JSON schema from a transcript (v1 custom-schema ask)."""
        if not _LITELLM:
            return {"error": "litellm_not_installed"}
        field_list = ", ".join(f for f in fields if f.strip())
        lang_key = (language or "auto").strip().lower()
        directive = MULTILINGUAL_DIRECTIVES.get(lang_key, MULTILINGUAL_DIRECTIVES["auto"])
        prompt = (
            f"{directive}\n\n"
            "Extract the following fields from this transcript as JSON: "
            f"{field_list}. "
            + (f"Additional instructions: {instructions}. " if instructions.strip() else "")
            + "Return ONLY valid JSON with exactly these keys; use null for anything absent."
        )
        sent_transcript, truncated, original_length = _truncate(transcript)
        try:
            resp = await asyncio.wait_for(
                _llm_with_fallback(
                    model=settings.LLM_REASONING,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": sent_transcript},
                    ],
                    fallback=settings.LLM_REASONING_FALLBACK,
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

    async def analyze_meeting(self, transcript: str, language: Optional[str] = "auto") -> Dict[str, Any]:
        return await self.analyze(transcript, "meeting", language=language)

    async def analyze_sales_call(self, transcript: str, language: Optional[str] = "auto") -> Dict[str, Any]:
        return await self.analyze(transcript, "sales_call", language=language)

    async def analyze_support_call(self, transcript: str, language: Optional[str] = "auto") -> Dict[str, Any]:
        return await self.analyze(transcript, "support_call", language=language)

    async def analyze_interview(self, transcript: str, language: Optional[str] = "auto") -> Dict[str, Any]:
        return await self.analyze(transcript, "interview", language=language)

    async def general_analysis(self, transcript: str, language: Optional[str] = "auto") -> Dict[str, Any]:
        return await self.analyze(transcript, "general", language=language)

    async def extract_annotations(self, transcript: str, language: Optional[str] = "auto") -> Dict[str, Any]:
        """Extract rich semantic and actionable annotations categorized by type from any dialogue transcript."""
        if not _LITELLM:
            return {"error": "litellm_not_installed", "annotations": [], "counts": {}}
        transcript = transcript or ""
        lang_key = (language or "auto").strip().lower()
        directive = MULTILINGUAL_DIRECTIVES.get(lang_key, MULTILINGUAL_DIRECTIVES["auto"])
        prompt = (
            f"{directive}\n\n"
            "You are an expert conversation intelligence and transcript annotation engine. "
            "Analyze the following transcript (which may contain timestamps and speaker turns). "
            "Extract all significant semantic and dialogue annotations, categorized into: "
            "'decision' (agreed choice/direction), 'action_item' (assigned task with owner), "
            "'objection' (concern, obstacle, doubt, or pushback), 'insight' (valuable revelation or metric), "
            "'question' (crucial unresolved query), or 'quote' (pivotal memorable statement).\n\n"
            "Anchor each annotation to its exact speaker and timestamp if available in the transcript.\n\n"
            "Return strictly JSON with this schema:\n"
            "{\n"
            '  "summary": "1-2 sentence overview of the conversation intelligence",\n'
            '  "annotations": [\n'
            "    {\n"
            '      "time": "MM:SS or timestamp if present, otherwise null",\n'
            '      "speaker": "Speaker 0 / Name if present, otherwise null",\n'
            '      "type": "decision|action_item|objection|insight|question|quote",\n'
            '      "title": "Concise headline (under 8 words)",\n'
            '      "note": "Clear context and explanation",\n'
            '      "quote": "Verbatim quote snippet from dialogue or null"\n'
            "    }\n"
            "  ],\n"
            '  "counts": {"decision": 0, "action_item": 0, "objection": 0, "insight": 0, "question": 0, "quote": 0}\n'
            "}\n"
        )
        sent_transcript, truncated, original_length = _truncate(transcript)
        if not sent_transcript.strip():
            return {"summary": "No speech detected", "annotations": [], "counts": {}}
        try:
            resp = await asyncio.wait_for(
                _llm_with_fallback(
                    model=settings.LLM_DEFAULT,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": sent_transcript},
                    ],
                    fallback=settings.LLM_REASONING_FALLBACK,
                    temperature=0.1,
                ),
                timeout=ANALYSIS_TIMEOUT_SECONDS,
            )
            content = resp.choices[0].message.content or "{}"
            result = json.loads(_strip_fences(content))
            if not isinstance(result, dict):
                result = {"annotations": []}
            raw_ann = result.get("annotations") or []
            clean_ann = []
            for item in raw_ann:
                if isinstance(item, dict) and (item.get("title") or item.get("note")):
                    clean_ann.append({
                        "time": item.get("time") or None,
                        "speaker": item.get("speaker") or None,
                        "type": str(item.get("type") or "insight").lower(),
                        "title": str(item.get("title") or item.get("note") or "")[:120],
                        "note": str(item.get("note") or item.get("title") or ""),
                        "quote": item.get("quote") or None,
                    })
            result["annotations"] = clean_ann
            counts: Dict[str, int] = {}
            for a in clean_ann:
                t = a.get("type", "insight")
                counts[t] = counts.get(t, 0) + 1
            result["counts"] = counts
            if truncated:
                result["truncated"] = True
                result["original_length"] = original_length
            return result
        except Exception as e:
            log.exception("extract_annotations failed: %s", e)
            return {"error": str(e), "annotations": [], "counts": {}}


