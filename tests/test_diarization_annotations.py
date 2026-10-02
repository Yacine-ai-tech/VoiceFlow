"""
Unit and integration tests for speaker diarization and transcript annotations.
"""
import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from services.transcription_adapter import (
    _format_diarized_text,
    _enrich_diarization_if_needed,
)
from services.meeting_analyzer import MeetingAnalyzer, _synthesize_annotations
from api import app, _check_diarization_available


def test_format_diarized_text():
    segments = [
        {"speaker": "Speaker 0", "start": 0.5, "end": 3.2, "text": "Hello team, let's start the meeting."},
        {"speaker": "Speaker 1", "start": 3.8, "end": 6.5, "text": "Hi, I have the Q3 numbers ready."},
    ]
    formatted = _format_diarized_text(segments)
    assert "[00:00 - 00:03] Speaker 0: Hello team, let's start the meeting." in formatted
    assert "[00:03 - 00:06] Speaker 1: Hi, I have the Q3 numbers ready." in formatted


def test_enrich_diarization_with_existing_speakers():
    segments = [
        {"speaker": "Speaker 0", "start": 1.0, "end": 2.0, "text": "Turn 1"},
        {"speaker": "Speaker 1", "start": 2.5, "end": 4.0, "text": "Turn 2"},
    ]
    segs, text, speakers = _enrich_diarization_if_needed("Turn 1 Turn 2", segments)
    assert len(segs) == 2
    assert "Speaker 0" in speakers
    assert "Speaker 1" in speakers
    assert "[00:01 - 00:02] Speaker 0: Turn 1" in text


def test_enrich_diarization_empty():
    segs, text, speakers = _enrich_diarization_if_needed("", [])
    assert segs == []
    assert text == ""
    assert speakers == []


def test_synthesize_annotations():
    raw_data = {
        "decisions": ["Deploy VoiceFlow on Contabo VPS", {"title": "Frontend on Vercel", "note": "Zero cold starts"}],
        "action_items": [{"owner": "Yacine", "action": "Implement speaker diarization", "priority": "high", "due": "2026-10-05"}],
        "objections": [{"type": "Latency", "content": "WhisperX CPU alignment may add latency"}],
        "key_insights": ["Nova-3 delivers sub-300ms ASR turnaround"],
        "open_questions": ["What is the fallback model for reasoning?"],
        "key_quotes": ["Real-time intelligence requires full-duplex audio."],
    }
    annotations = _synthesize_annotations(raw_data)
    assert len(annotations) == 7
    types = {a["type"] for a in annotations}
    assert "decision" in types
    assert "action_item" in types
    assert "objection" in types
    assert "insight" in types
    assert "question" in types
    assert "quote" in types

    action_ann = next(a for a in annotations if a["type"] == "action_item")
    assert action_ann["speaker"] == "Yacine"
    assert "Implement speaker diarization" in action_ann["title"]


def test_check_diarization_available():
    class DummySettings:
        DEEPGRAM_API_KEY = "dummy-deepgram"
        ASSEMBLYAI_API_KEY = ""
        PYANNOTE_TOKEN = ""
        HF_TOKEN = ""
        GROQ_API_KEY = ""
        GEMINI_API_KEY = ""

    status = _check_diarization_available(DummySettings())
    assert status["diarization_available"] is True
    assert status["diarization_warning"] is None


def test_annotate_endpoint_validation():
    client = TestClient(app)
    # Empty text returns 400
    res = client.post("/annotate", json={"text": "   "})
    assert res.status_code == 400

    # Valid text returns annotated structure
    with patch.object(
        MeetingAnalyzer,
        "extract_annotations",
        new=AsyncMock(return_value={
            "summary": "Meeting discussion on project milestones.",
            "annotations": [
                {
                    "time": "00:15",
                    "speaker": "Speaker 0",
                    "type": "decision",
                    "title": "Adopt Neon Postgres",
                    "note": "Team agreed to use Neon for database branches",
                    "quote": "Let's proceed with Neon.",
                }
            ],
            "counts": {"decision": 1},
        }),
    ):
        res = client.post("/annotate", json={"text": "Let's proceed with Neon."})
        assert res.status_code == 200
        data = res.json()
        assert data["summary"] == "Meeting discussion on project milestones."
        assert len(data["annotations"]) == 1
        assert data["annotations"][0]["title"] == "Adopt Neon Postgres"
        assert data["counts"]["decision"] == 1
