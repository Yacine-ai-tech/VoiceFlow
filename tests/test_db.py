"""Tests for core/db.py — optional Postgres session-analytics persistence."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import core.db as db  # noqa: E402
from core.config import settings  # noqa: E402


def test_db_disabled_without_postgres_url(monkeypatch):
    """With no POSTGRES_URL, every db.py function must be a safe no-op —
    this is what keeps Postgres entirely optional."""
    monkeypatch.setattr(db, "DB_ENABLED", False)

    db.save_counter("s1", "analyze:meeting", 3)  # must not raise
    assert db.load_all_counters() == {}


@pytest.mark.skipif(not settings.POSTGRES_URL, reason="POSTGRES_URL not configured")
def test_db_real_roundtrip_when_configured():
    """When a real POSTGRES_URL is configured, a save must actually persist
    and be readable back — exercised against the real database, not a mock,
    consistent with this project's real-integration testing throughout."""
    assert db.DB_ENABLED is True
    session_id = "pytest-db-roundtrip-session"
    db.save_counter(session_id, "analyze:meeting", 7)
    counters = db.load_all_counters()
    assert counters.get(session_id, {}).get("analyze:meeting") == 7

    # Clean up the test row so repeated runs don't accumulate junk data.
    with db.get_conn() as conn:
        conn.execute("DELETE FROM session_stats WHERE session_id = %s", (session_id,))
        conn.commit()
