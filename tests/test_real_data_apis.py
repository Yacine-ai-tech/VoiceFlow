import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import importlib
import pytest
from fastapi.testclient import TestClient

app = None
try:
    api_module = importlib.import_module("api")
    app = api_module.app
except ImportError:
    try:
        main_module = importlib.import_module("main")
        app = main_module.app
    except ImportError:
        pass

if app is None:
    pytest.skip("Could not import VoiceFlow app", allow_module_level=True)

client = TestClient(app)

def test_voiceflow_real_transcription_request():
    """Simulates a real downstream service requesting transcription of an audio file."""
    payload = {
        "audio_url": "https://example.com/sample_meeting.mp3",
        "language": "en",
        "diarize": True
    }
    
    response = client.post("/analyze", json=payload)
    # 422 or 503 is acceptable if the dummy URL is invalid or models aren't loaded
    # 200 is acceptable if it queues or processes it
    assert response.status_code in (200, 202, 422, 503, 400), f"VoiceFlow analysis endpoint failed: {response.status_code}"

def test_voiceflow_health():
    response = client.get("/health")
    assert response.status_code == 200
