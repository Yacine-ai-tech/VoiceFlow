"""
Named scenarios — explicit, reproducible provider/model combinations for the
transcribe -> analyze pipeline.

Why this exists: the provider router (transcription_adapter.py) is built for
production resilience — try the configured provider, fall through to the
next one if it fails, degrade gracefully. That's the right behavior for a
live service, but it's the wrong behavior for benchmarking or reproducible
research, where "which provider actually ran" needs to be a controlled
variable, not whatever happened to answer first.

A scenario pins every stage explicitly: which ASR provider, whether to
diarize, and which LLM tier handles the analysis. Pass ?scenario=accurate to
/pipeline and you get exactly that combination — no fallback substitution —
so the same request against different scenarios is a fair, comparable trial.
This is what eval/run_scenario_benchmark.py runs across to produce
comparative results instead of "whichever provider happened to answer."

Rough cost figures are public list-price ballparks (USD), not measured —
labeled as estimates everywhere they're shown, same honesty standard as
WER_BENCHMARK.md.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, TypedDict


class Scenario(TypedDict):
    description: str
    transcription_provider: str  # one of transcription_adapter's canonical names
    diarize: bool
    analysis_model_setting: str  # which core.config.Settings attr to use (LLM_DEFAULT | LLM_REASONING | LLM_JUDGE)
    est_cost_per_min_usd: float  # rough, list-price ballpark — see module docstring
    notes: str


SCENARIOS: Dict[str, Scenario] = {
    "fast": {
        "description": "Lowest latency, cheapest per-call. Good for interactive/high-volume use.",
        "transcription_provider": "groq",
        "diarize": False,
        "analysis_model_setting": "LLM_DEFAULT",
        "est_cost_per_min_usd": 0.02,
        "notes": "Groq Whisper (~10x faster than self-host) + Groq Llama 3.3 70B.",
    },
    "accurate": {
        "description": "Best transcription + real diarization, higher latency/cost.",
        "transcription_provider": "deepgram",
        "diarize": True,
        "analysis_model_setting": "LLM_REASONING",
        "est_cost_per_min_usd": 0.05,
        "notes": "Deepgram (best diarization) + Claude Sonnet for nuance.",
    },
    "cheap": {
        "description": "No per-call API cost — local compute only.",
        "transcription_provider": "local",
        "diarize": True,
        "analysis_model_setting": "LLM_DEFAULT",
        "est_cost_per_min_usd": 0.0,
        "notes": "Local WhisperX (+ pyannote if HF_TOKEN is set) + Groq Llama 3.3 70B.",
    },
    "streaming": {
        "description": "Tuned for real-time/streaming call analysis.",
        "transcription_provider": "assemblyai",
        "diarize": True,
        "analysis_model_setting": "LLM_JUDGE",
        "est_cost_per_min_usd": 0.03,
        "notes": "AssemblyAI Universal-2 (strong streaming) + Claude Haiku for speed.",
    },
    "research-compare": {
        "description": "Not a single provider — signals the caller wants every provider run for comparison. "
                        "See eval/run_scenario_benchmark.py rather than /pipeline for this one.",
        "transcription_provider": "",
        "diarize": True,
        "analysis_model_setting": "LLM_REASONING",
        "est_cost_per_min_usd": 0.0,
        "notes": "Benchmark-only scenario, not directly runnable via /pipeline.",
    },
}


def resolve(name: str) -> Optional[Scenario]:
    return SCENARIOS.get((name or "").strip().lower())


def list_scenarios() -> Dict[str, Any]:
    """JSON-safe scenario catalog for GET /scenarios."""
    return {
        name: {k: v for k, v in spec.items()}
        for name, spec in SCENARIOS.items()
    }


def resolve_analysis_model(settings: Any, scenario: Scenario) -> str:
    return getattr(settings, scenario["analysis_model_setting"], settings.LLM_DEFAULT)
