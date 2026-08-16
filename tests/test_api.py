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


# ── Auth-disabled behavior (REQUIRE_INTERNAL_TOKEN unset/false — the actual
#    live-deployment default; see ARCHITECTURE.md) ──────────────────────────
#
# These previously asserted `status_code in (400, 401, 403)` — a range wide
# enough to pass whether or not the auth gate was actually enforcing
# anything, which made this test unable to ever fail from a real regression
# in either direction. Split into explicit, single-outcome assertions per
# configuration so a real auth regression actually turns the test red.

def test_tts_empty_text_400_when_auth_disabled(monkeypatch):
    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    r = _client().post("/tts", json={"text": "   "})
    assert r.status_code == 400


def test_transcribe_requires_file_when_auth_disabled(monkeypatch):
    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    r = _client().post("/transcribe")
    assert r.status_code == 422


# ── Auth-enabled behavior (REQUIRE_INTERNAL_TOKEN=true — what an operator
#    who wants the gate enforced actually turns on) ─────────────────────────

def test_post_endpoint_rejects_missing_token_when_auth_enabled(monkeypatch):
    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "true")
    monkeypatch.setenv("VOICEFLOW_INTERNAL_TOKEN", "test-secret-token")
    r = _client().post("/tts", json={"text": "hello"})
    assert r.status_code == 403
    assert "X-VoiceFlow-Internal-Token" in r.json()["detail"]


def test_post_endpoint_rejects_wrong_token_when_auth_enabled(monkeypatch):
    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "true")
    monkeypatch.setenv("VOICEFLOW_INTERNAL_TOKEN", "test-secret-token")
    r = _client().post("/tts", json={"text": "hello"}, headers={"X-VoiceFlow-Internal-Token": "wrong"})
    assert r.status_code == 403


def test_post_endpoint_accepts_correct_token_when_auth_enabled(monkeypatch):
    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "true")
    monkeypatch.setenv("VOICEFLOW_INTERNAL_TOKEN", "test-secret-token")
    # A correct token must clear the auth gate and reach real validation —
    # empty text still 400s, but for the validation reason, not auth.
    r = _client().post("/tts", json={"text": "   "}, headers={"X-VoiceFlow-Internal-Token": "test-secret-token"})
    assert r.status_code == 400


def test_get_requests_bypass_token_gate_even_when_auth_enabled(monkeypatch):
    # GET is documented as always-public (page navigation, /health, etc.) —
    # verify_internal_token's own logic returns early for any GET before the
    # token check runs at all.
    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "true")
    monkeypatch.setenv("VOICEFLOW_INTERNAL_TOKEN", "test-secret-token")
    r = _client().get("/scenarios")
    assert r.status_code == 200
