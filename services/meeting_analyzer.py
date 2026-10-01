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
    "invalid api key", "credit", "quota", "resource_exhausted", "billing", "unauthorized"
)


def _resolve_fallback(fallback: str = "") -> str:
    """Resolve an operational fallback model dynamically if not explicitly specified."""
    if fallback:
        return fallback
    if getattr(settings, "LLM_REASONING_FALLBACK", ""):
        return settings.LLM_REASONING_FALLBACK
    if getattr(settings, "GROQ_API_KEY", ""):
        return "groq/moonshotai/kimi-k2-instruct"
    if getattr(settings, "GEMINI_API_KEY", ""):
        return "gemini/gemini-2.5-flash"
    return ""


async def _llm_with_fallback(model: str, messages: list, fallback: str = "", **kwargs) -> Any:
    """acompletion wrapper with auth/billing error fallback to a provider override model.

    ``fallback`` comes from settings.LLM_REASONING_FALLBACK / LLM_JUDGE_FALLBACK, or
    dynamically falls back to available high-speed providers (Groq/Gemini).
    """
    resolved_fb = _resolve_fallback(fallback)
    # Use bounded retries so 402/insufficient balance or auth errors fail fast to the fallback
    call_kwargs = dict(kwargs)
    if "num_retries" not in call_kwargs:
        call_kwargs["num_retries"] = 1
    if "timeout" not in call_kwargs:
        call_kwargs["timeout"] = 15

    try:
        return await acompletion(model=model, messages=messages, **call_kwargs)
    except Exception as exc:
        exc_str = (str(exc) + " " + type(exc).__name__).lower()
        is_auth = any(s.lower() in exc_str for s in _AUTH_SIGNALS)
        if is_auth and resolved_fb and resolved_fb != model:
            log.warning("model=%s auth/quota error (%s) — retrying with fallback %s", model, type(exc).__name__, resolved_fb)
            return await acompletion(model=resolved_fb, messages=messages, **kwargs)
        raise


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
        "key_numbers, open_questions, next_steps, "
        "sentiment (positive|neutral|tense|mixed), topics_covered. JSON only."
    ),
    "sales_call": (
        "Extract from this sales-call transcript as JSON: "
        "call_summary, prospect_company, prospect_contact, prospect_role, "
        "pain_points, objections: [{type, content}], buying_signals, budget_mentioned, "
        "deal_stage (discovery|evaluation|negotiation|closing), "
        "crm_notes (Salesforce/HubSpot-paste ready notes with next steps), overall_sentiment, "
        "likelihood_to_close (float 0.0 to 1.0). JSON only."
    ),
    "support_call": (
        "Extract from this support-call transcript as JSON: "
        "customer_issue, severity (low|medium|high|critical), "
        "resolution_summary, escalation_needed (boolean true|false), "
        "follow_ups: [{action, owner, due}], sentiment (positive|neutral|frustrated|satisfied). JSON only."
    ),
    "interview": (
        "Extract from this interview transcript as JSON: "
        "candidate_name, role_discussed, strengths: [string], gaps: [string], "
        "key_quotes: [string] (3-5 verbatim quotes), recommendation (hire|maybe|no_hire), reasoning. JSON only."
    ),
    "general": (
        "Extract structured intelligence from this transcript as JSON: "
        "summary (3-5 sentences), main_topics: [string], key_insights: [string], "
        "decisions: [string], action_items: [{owner, action, due, priority}], "
        "participants_mentioned: [string], sentiment (positive|neutral|negative|mixed). JSON only."
    ),
}


def _strip_fences(text: str) -> str:
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


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

