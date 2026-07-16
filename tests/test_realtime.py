import pytest
import os
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

@pytest.mark.unit
def test_realtime_unconfigured(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with client.websocket_connect("/realtime") as websocket:
        data = websocket.receive_json()
        assert "error" in data or data.get("type") == "error"
        # The exact message might differ depending on implementation, but it should fail gracefully
        assert "unconfigured" in str(data).lower() or "missing" in str(data).lower() or "key" in str(data).lower()
