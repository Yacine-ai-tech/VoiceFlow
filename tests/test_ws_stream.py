import pytest
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

@pytest.mark.unit
def test_ws_stream():
    import os
    with client.websocket_connect("/stream", headers={"X-VoiceFlow-Internal-Token": os.environ.get("VOICEFLOW_INTERNAL_TOKEN", "")}) as websocket:
        data = websocket.receive_json()
        assert data.get("type") == "ready"
        assert "provider" in data
