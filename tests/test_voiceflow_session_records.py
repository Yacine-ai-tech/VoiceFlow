"""Tests for VoiceFlow session isolation and records scoping."""
import pytest
from core.db import list_voice_records
from fastapi.testclient import TestClient


def test_voiceflow_records_session_scoping_in_memory():
    """Verify session isolation filtering logic."""
    records = [
        {"id": "rec-seed", "session_id": None, "kind": "meeting", "title": "Seed Meeting"},
        {"id": "rec-user-a", "session_id": "session_user_a", "kind": "sales_call", "title": "User A Call"},
        {"id": "rec-user-b", "session_id": "session_user_b", "kind": "support_call", "title": "User B Call"},
    ]

    def filter_records(session_id=None, is_admin=False):
        if is_admin or session_id == "*":
            return records
        if session_id:
            return [r for r in records if r["session_id"] == session_id or r["session_id"] is None]
        return [r for r in records if r["session_id"] is None]

    # User A sees seed + User A
    user_a = filter_records(session_id="session_user_a")
    assert len(user_a) == 2
    assert {r["id"] for r in user_a} == {"rec-seed", "rec-user-a"}

    # User B sees seed + User B
    user_b = filter_records(session_id="session_user_b")
    assert len(user_b) == 2
    assert {r["id"] for r in user_b} == {"rec-seed", "rec-user-b"}

    # Anonymous visitor sees only seed
    anon = filter_records(session_id=None)
    assert len(anon) == 1
    assert anon[0]["id"] == "rec-seed"

    # Admin sees all 3
    admin = filter_records(is_admin=True)
    assert len(admin) == 3


def test_record_wildcard_requires_admin(monkeypatch):
    from api import app

    monkeypatch.setenv("ADMIN_TOKEN", "admin-test-token")
    client = TestClient(app)
    responses = [
        client.get("/records?session_id=*"),
        client.delete("/records?session_id=*"),
        client.delete("/records/record-id?session_id=*"),
    ]

    assert [response.status_code for response in responses] == [403, 403, 403]


def test_admin_can_use_record_wildcard(monkeypatch):
    from api import app, db

    monkeypatch.setenv("ADMIN_TOKEN", "admin-test-token")
    monkeypatch.setattr(db, "list_voice_records", lambda **kwargs: [])
    response = TestClient(app).get(
        "/records?session_id=*", headers={"X-Admin-Token": "admin-test-token"}
    )

    assert response.status_code == 200


def test_session_token_sign_and_verify(monkeypatch):
    from api import _sign_session_id, _verify_session_token

    monkeypatch.setenv("SESSION_SIGNING_SECRET", "test-session-secret")
    token = _sign_session_id("browser-session-1")
    assert token.startswith("browser-session-1.")
    assert _verify_session_token(token) == "browser-session-1"
    # Bare id, wrong signature and a signature transplanted onto another id
    # are all rejected.
    assert _verify_session_token("browser-session-1") is None
    assert _verify_session_token("browser-session-1." + "0" * 16) is None
    assert _verify_session_token("other-session." + token.rsplit(".", 1)[1]) is None


def test_session_token_issued_in_response_header(monkeypatch):
    from api import app

    monkeypatch.setenv("SESSION_SIGNING_SECRET", "test-session-secret")
    response = TestClient(app).get(
        "/health", headers={"X-VoiceFlow-Session": "browser-abc"}
    )
    token = response.headers.get("X-VoiceFlow-Session-Token")
    assert token and token.startswith("browser-abc.")


def test_records_delete_requires_signed_session(monkeypatch):
    from api import _sign_session_id, app

    monkeypatch.setenv("SESSION_SIGNING_SECRET", "test-session-secret")
    client = TestClient(app)
    # Bare self-asserted id and forged signatures are rejected outright.
    assert client.delete("/records/some-id", headers={"X-VoiceFlow-Session": "victim"}).status_code == 403
    assert client.delete("/records", headers={"X-VoiceFlow-Session": "victim"}).status_code == 403
    assert client.delete(
        "/records/some-id", headers={"X-VoiceFlow-Session": "victim." + "0" * 16}
    ).status_code == 403
    # No session at all → session_required.
    assert client.delete("/records/some-id").status_code == 403
    # A valid signed token passes the gate (DB is disabled under tests, so
    # the delete itself is a no-op but the request is authorized → 200).
    token = _sign_session_id("my-session")
    assert client.delete("/records/some-id", headers={"X-VoiceFlow-Session": token}).status_code == 200
    assert client.delete("/records", headers={"X-VoiceFlow-Session": token}).status_code == 200


def test_records_read_scopes_only_signed_sessions(monkeypatch):
    from api import _sign_session_id, app, db

    monkeypatch.setenv("SESSION_SIGNING_SECRET", "test-session-secret")
    seen = {}

    def fake_list(session_id=None, is_admin=False, limit=50):
        seen["session_id"] = session_id
        return []

    monkeypatch.setattr(db, "list_voice_records", fake_list)
    client = TestClient(app)

    # A bare/self-asserted id degrades to the anonymous (seed-only) view —
    # it is NOT trusted as a session scope.
    client.get("/records", headers={"X-VoiceFlow-Session": "someone-else"})
    assert seen["session_id"] is None

    # The signed token resolves to its canonical session id.
    client.get("/records", headers={"X-VoiceFlow-Session": _sign_session_id("my-session")})
    assert seen["session_id"] == "my-session"
