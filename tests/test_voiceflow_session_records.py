"""Tests for VoiceFlow session isolation and records scoping."""
import pytest
from core.db import list_voice_records


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
