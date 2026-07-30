import pytest
import os
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

@pytest.mark.unit
def test_realtime_unconfigured(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with client.websocket_connect("/realtime", headers={"X-OmniIntel-Internal-Token": os.environ.get("OMNIINTEL_INTERNAL_TOKEN", "omni-test-token")}) as websocket:
        data = websocket.receive_json()
        assert "error" in data or data.get("type") == "error"
        assert "unconfigured" in str(data).lower() or "missing" in str(data).lower() or "key" in str(data).lower() or "not set" in str(data).lower()
