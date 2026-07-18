import pytest
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

@pytest.mark.unit
def test_ws_stream():
    import os
    with client.websocket_connect("/stream", headers={"X-OmniIntel-Internal-Token": os.environ.get("OMNIINTEL_INTERNAL_TOKEN", "omni-test-token")}) as websocket:
        data = websocket.receive_json()
        assert data.get("type") == "ready"
        assert "provider" in data
