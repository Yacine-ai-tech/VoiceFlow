"""VoiceFlow API endpoint tests (no network: only validation + routing paths)."""
import sys
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

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


def test_gemini_audio_activity_brackets_audio_and_ends_once():
    import asyncio
    from types import SimpleNamespace

    from api import _GeminiAudioActivity

    calls = []

    class FakeSession:
        async def send_realtime_input(self, **kwargs):
            calls.append(kwargs)

    types = SimpleNamespace(
        ActivityStart=lambda: "start",
        ActivityEnd=lambda: "end",
        Blob=lambda data, mime_type: (data, mime_type),
    )

    async def exercise():
        activity = _GeminiAudioActivity(FakeSession(), types, asyncio.Lock())
        await activity.send_audio(b"first")
        await activity.send_audio(b"second")
        assert await activity.end()
        assert not await activity.end()

    asyncio.run(exercise())

    assert calls == [
        {"activity_start": "start"},
        {"media": (b"first", "audio/pcm;rate=16000")},
        {"media": (b"second", "audio/pcm;rate=16000")},
        {"activity_end": "end"},
    ]


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


def test_agent_tools_test_rejects_caller_controlled_destination(monkeypatch):
    import api

    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    monkeypatch.setenv("AGENT_TOOLS_URL", "https://agentkit.example")
    discover = AsyncMock()
    monkeypatch.setattr(api.agent_tools_bridge, "discover_tools", discover)

    response = _client().get("/api/agent-tools/test?url=https://attacker.example")

    assert response.status_code == 400
    assert discover.await_count == 0


def test_agent_tools_test_uses_only_configured_destination(monkeypatch):
    import api

    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    monkeypatch.setenv("AGENT_TOOLS_URL", "https://agentkit.example")
    discover = AsyncMock(return_value=[{"name": "status"}])
    monkeypatch.setattr(api.agent_tools_bridge, "discover_tools", discover)

    response = _client().get("/api/agent-tools/test")

    assert response.status_code == 200
    assert response.json()["tools"] == [{"name": "status"}]
    discover.assert_awaited_once_with("https://agentkit.example", force=True)


def test_realtime_config_rejects_caller_controlled_destination(monkeypatch):
    import api

    monkeypatch.setenv("AGENT_TOOLS_URL", "https://agentkit.example")

    response = _client().get("/realtime/config?agent_tools_url=https://attacker.example")

    assert response.status_code == 400


def test_openai_webrtc_session_rejects_caller_controlled_destination(monkeypatch):
    import api

    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    monkeypatch.setenv("AGENT_TOOLS_URL", "https://agentkit.example")

    response = _client().post(
        "/realtime/session/openai?agent_tools_url=https://attacker.example",
        headers={"Content-Type": "application/sdp"},
        content="v=0",
    )

    assert response.status_code == 400


def test_realtime_tool_call_rejects_caller_controlled_destination(monkeypatch):
    import api

    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    monkeypatch.setenv("AGENT_TOOLS_URL", "https://agentkit.example")
    call_tool = AsyncMock()
    monkeypatch.setattr(api.agent_tools_bridge, "call_tool", call_tool)

    response = _client().post(
        "/realtime/tool-call",
        json={"name": "status", "arguments": {}, "agent_tools_url": "https://attacker.example"},
    )

    assert response.status_code == 400
    assert call_tool.await_count == 0


def test_realtime_websocket_rejects_caller_controlled_destination(monkeypatch):
    import pytest
    import api

    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    monkeypatch.setenv("AGENT_TOOLS_URL", "https://agentkit.example")

    with pytest.raises(WebSocketDisconnect) as exc:
        with _client().websocket_connect("/realtime?agent_tools_url=https://attacker.example"):
            pass

    assert exc.value.code == 1008
