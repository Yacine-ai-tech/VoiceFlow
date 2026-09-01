import pytest
import os
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

@pytest.mark.unit
def test_realtime_unconfigured(monkeypatch):
    monkeypatch.setenv("REALTIME_PROVIDER", "openai")
    monkeypatch.delenv("REALTIME_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with client.websocket_connect("/realtime", headers={"X-VoiceFlow-Internal-Token": os.environ.get("VOICEFLOW_INTERNAL_TOKEN", "")}) as websocket:
        data = websocket.receive_json()
        if data.get("type") == "metric":
            data = websocket.receive_json()
        assert "error" in data or data.get("type") == "error"
        assert "unconfigured" in str(data).lower() or "missing" in str(data).lower() or "key" in str(data).lower() or "not set" in str(data).lower()


@pytest.mark.unit
def test_realtime_config():
    r = client.get("/realtime/config")
    assert r.status_code == 200
    body = r.json()
    assert body["gemini_ws_path"] == "/realtime/gemini"
    assert body["openai_webrtc_session_path"] == "/realtime/session/openai"


@pytest.mark.unit
def test_openai_realtime_ignores_openai_proxy_key(monkeypatch):
    from core.config import settings
    monkeypatch.setattr(settings, "REALTIME_PROVIDER", "openai")
    monkeypatch.delenv("REALTIME_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_REALTIME_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example.test/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "proxy-key")
    assert settings.REALTIME_API_KEY == ""
    assert settings.OPENAI_REALTIME_API_KEY == ""
