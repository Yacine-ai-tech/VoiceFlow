import pytest
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

@pytest.mark.unit
def test_ws_stream():
    with client.websocket_connect("/stream") as websocket:
        websocket.send_bytes(b"dummy audio data")
        data = websocket.receive_json()
        assert "partial" in data
        assert data["partial"] == "transcript stub"
