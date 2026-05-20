"""Smoke tests for VoiceFlow."""
import pytest
from fastapi.testclient import TestClient


def test_imports():
    from core import config, logger
    from services import meeting_analyzer, transcription_router, whisperx_service
    assert config.settings is not None


def test_app_creates():
    from api import app
    assert app.title == "VoiceFlow"


def test_health_endpoint():
    from api import app
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["service"] == "voiceflow"


def test_meeting_analyzer_instantiates():
    from services.meeting_analyzer import MeetingAnalyzer, ANALYSIS_MODELS
    a = MeetingAnalyzer()
    assert a is not None
    assert "meeting" in ANALYSIS_MODELS
    assert "sales_call" in ANALYSIS_MODELS


def test_settings_has_required_fields():
    from core.config import settings
    assert settings.LLM_DEFAULT
    assert settings.LLM_REASONING
    assert settings.LLM_JUDGE
