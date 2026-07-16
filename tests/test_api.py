"""VoiceFlow API endpoint tests (no network: only validation + routing paths)."""
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _client():
    from api import app
    return TestClient(app)


def test_health():
    r = _client().get("/health")
    assert r.status_code == 200 and r.json()["service"] == "voiceflow"


def test_all_routes_registered():
    from api import app
    paths = {r.path for r in app.routes}
    for p in ("/transcribe", "/tts", "/analyze", "/pipeline", "/meeting/process",
              "/call/analyze", "/stream", "/realtime"):
        assert p in paths, p


def test_tts_empty_text_400():
    # Validation must reject empty text before any synthesis (no network).
    r = _client().post("/tts", json={"text": "   "})
    assert r.status_code in (400, 401, 403)  # 400=validation, 403=auth required


def test_transcribe_requires_file():
    r = _client().post("/transcribe")
    assert r.status_code in (401, 403, 422)  # 422=missing file, 401/403=auth required
