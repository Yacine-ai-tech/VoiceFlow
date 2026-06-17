"""LIVE meeting-analysis test — real LLM call (needs ANTHROPIC_API_KEY/GROQ_API_KEY). Proves the
analyzer returns real structured intelligence (summary + action items) from a transcript."""
import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

pytestmark = pytest.mark.skipif(
    not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("GROQ_API_KEY")),
    reason="live test needs an LLM key",
)

TRANSCRIPT = """
Alice: Welcome. We need to ship the billing fix before Friday.
Bob: I'll own the billing patch and have it ready by Thursday.
Alice: Good. Carol, can you update the pricing page after that?
Carol: Yes, I'll do the pricing page update by next Monday.
Alice: Decision: we go with the $29 tier. Revenue target is $50k MRR this quarter.
"""


def test_meeting_analysis_returns_structured_intelligence():
    from services.meeting_analyzer import MeetingAnalyzer
    out = asyncio.run(MeetingAnalyzer().analyze_meeting(TRANSCRIPT))
    print("\nLIVE meeting analysis keys:", sorted(out.keys()))
    assert "error" not in out, out
    assert out.get("meeting_summary")            # real summary text
    items = out.get("action_items") or []
    assert isinstance(items, list) and len(items) >= 1   # extracted ≥1 action item
    blob = str(out).lower()
    assert "billing" in blob or "pricing" in blob        # grounded in the transcript
