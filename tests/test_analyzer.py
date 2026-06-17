"""MeetingAnalyzer unit tests (pure — no LLM calls)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def test_analysis_models_cover_all_types():
    from services.meeting_analyzer import ANALYSIS_MODELS, PROMPTS
    for t in ("meeting", "sales_call", "support_call", "interview", "general"):
        assert t in PROMPTS
        assert t in ANALYSIS_MODELS and ANALYSIS_MODELS[t]  # routes to a non-empty model id


def test_sales_call_routes_to_reasoning_tier():
    # Nuance-critical analysis should use the reasoning tier, not the cheap default.
    from services.meeting_analyzer import ANALYSIS_MODELS
    assert ANALYSIS_MODELS["sales_call"] == ANALYSIS_MODELS.get("interview")  # both reasoning tier
    assert ANALYSIS_MODELS["sales_call"] != ANALYSIS_MODELS["meeting"]        # ≠ default tier


def test_strip_fences():
    from services.meeting_analyzer import _strip_fences
    assert _strip_fences('```json\n{"a":1}\n```') == '{"a":1}'


def test_analyzer_has_typed_methods():
    from services.meeting_analyzer import MeetingAnalyzer
    a = MeetingAnalyzer()
    for m in ("analyze", "analyze_meeting", "analyze_sales_call",
              "analyze_support_call", "analyze_interview", "general_analysis"):
        assert callable(getattr(a, m))
