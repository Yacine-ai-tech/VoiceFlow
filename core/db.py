"""
Optional Postgres persistence — durable session usage analytics.

Only active when POSTGRES_URL is set (see core/config.py). Uses psycopg 3
directly (no ORM), same convention as the other projects in this portfolio
that use Postgres. Tables are created idempotently on first use (CREATE
TABLE IF NOT EXISTS) — no separate migration step.

Why this exists: GET /analytics's counters (api.py's in-memory `_stats`)
are real but ephemeral — every restart/redeploy zeroes them, which is a
real limitation for anyone actually relying on that endpoint to track
usage over time. This module makes that same data durable when a database
is configured, without changing anything about how /analytics behaves
when one isn't — the in-memory dict remains the source of truth for reads
either way; this just also persists writes and reloads them at startup.

psycopg is an optional dependency: importing this module when POSTGRES_URL
is unset never touches psycopg at all, so a self-hoster without Postgres
doesn't need it installed.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Any, Dict, Iterator

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

DB_ENABLED = bool(settings.POSTGRES_URL)

_pool = None
_pool_lock = threading.Lock()
_schema_ready = False


def _get_pooler_url(url: str) -> str:
    """Enforce Neon PgBouncer -pooler endpoint to eliminate TCP/TLS handshake latency."""
    if not url or "-pooler" in url or "neon.tech" not in url:
        return url
    import re
    return re.sub(r'(@ep-[a-z0-9-]+)(\.[a-z0-9-.]*neon\.tech)', r'\1-pooler\2', url)


def _get_pool():
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            from psycopg_pool import ConnectionPool
            pool_url = _get_pooler_url(settings.POSTGRES_URL)
            _pool = ConnectionPool(
                pool_url,
                min_size=2,
                max_size=10,
                max_idle=300,
                timeout=10.0,
                reconnect_timeout=30,
                reconnect_failed=None,
                check=ConnectionPool.check_connection,
                open=True,
            )
            log.info("✅ VoiceFlow Neon connection pool initialized (min=2, max=10, pooler enabled)")
    return _pool


@contextmanager
def get_conn() -> Iterator[Any]:
    """Yield a psycopg connection from the pool. Only call when DB_ENABLED is True."""
    pool = _get_pool()
    with pool.connection() as conn:
        yield conn


_SCHEMA = """
CREATE TABLE IF NOT EXISTS session_stats (
    session_id   TEXT NOT NULL,
    counter_key  TEXT NOT NULL,
    value        INTEGER NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, counter_key)
);

CREATE TABLE IF NOT EXISTS voice_records (
    id           TEXT PRIMARY KEY,
    session_id   TEXT,
    kind         TEXT NOT NULL,
    title        TEXT,
    duration_sec DOUBLE PRECISION,
    transcript   JSONB,
    analysis     JSONB,
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_records_session ON voice_records(session_id);
CREATE INDEX IF NOT EXISTS idx_voice_records_created ON voice_records(created_at DESC);
"""


def ensure_schema() -> None:
    """Idempotent CREATE TABLE IF NOT EXISTS — safe to call on every startup."""
    global _schema_ready
    if _schema_ready or not DB_ENABLED:
        return
    with get_conn() as conn:
        conn.execute(_SCHEMA)
        conn.commit()
    _schema_ready = True
    log.info("Postgres schema ready (session_stats, voice_records)")


def save_counter(session_id: str, counter_key: str, value: int) -> None:
    """Upsert one session's one counter to its current value. Called after
    every in-memory increment — see api.py's _session_stats(). Never raises
    into the request path: a DB hiccup here shouldn't fail a real request
    whose actual work (transcription, analysis, etc.) already succeeded."""
    if not DB_ENABLED:
        return
    try:
        ensure_schema()
        with get_conn() as conn:
            conn.execute(
                """
                INSERT INTO session_stats (session_id, counter_key, value, updated_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (session_id, counter_key) DO UPDATE SET
                    value = EXCLUDED.value, updated_at = now()
                """,
                (session_id, counter_key, value),
            )
            conn.commit()
    except Exception as e:
        log.warning("save_counter failed (analytics remain correct in-memory this run): %s", e)


def load_all_counters() -> Dict[str, Dict[str, int]]:
    """Reload every session's counters at startup, so a restart doesn't
    silently zero out usage history when a database is configured."""
    if not DB_ENABLED:
        return {}
    try:
        ensure_schema()
        with get_conn() as conn:
            cur = conn.execute("SELECT session_id, counter_key, value FROM session_stats")
            out: Dict[str, Dict[str, int]] = {}
            for session_id, counter_key, value in cur.fetchall():
                out.setdefault(session_id, {})[counter_key] = value
            return out
    except Exception as e:
        log.warning("load_all_counters failed (starting with empty in-memory analytics): %s", e)
        return {}


def save_voice_record(record: Dict[str, Any]) -> Optional[str]:
    """Persist a conversation/pipeline/transcription voice record into Postgres.
    
    Scoped by session_id so demo users only see their own sessions, while Omni-Admin
    has complete visibility across all users.
    """
    if not DB_ENABLED:
        return None
    import uuid
    import json
    record_id = str(record.get("id") or uuid.uuid4())
    session_id = record.get("session_id")
    kind = str(record.get("kind") or "general")
    title = str(record.get("title") or "Voice Conversation")
    duration_sec = record.get("duration_sec")
    transcript = json.dumps(record.get("transcript")) if record.get("transcript") is not None else None
    analysis = json.dumps(record.get("analysis")) if record.get("analysis") is not None else None
    metadata = json.dumps(record.get("metadata")) if record.get("metadata") is not None else None

    try:
        ensure_schema()
        with get_conn() as conn:
            conn.execute(
                """
                INSERT INTO voice_records (
                    id, session_id, kind, title, duration_sec, transcript, analysis, metadata, created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (id) DO UPDATE SET
                    session_id = EXCLUDED.session_id,
                    kind = EXCLUDED.kind,
                    title = EXCLUDED.title,
                    duration_sec = EXCLUDED.duration_sec,
                    transcript = EXCLUDED.transcript,
                    analysis = EXCLUDED.analysis,
                    metadata = EXCLUDED.metadata,
                    created_at = now()
                """,
                (record_id, session_id, kind, title, duration_sec, transcript, analysis, metadata),
            )
            conn.commit()
            return record_id
    except Exception as e:
        log.warning("save_voice_record failed: %s", e)
        return None


def list_voice_records(
    session_id: Optional[str] = None,
    is_admin: bool = False,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """List voice records with session isolation.
    
    - Admin or session_id='*': returns all records.
    - session_id provided: returns records for that session OR initial seed records (NULL).
    - Anonymous (no session): returns ONLY seed records (NULL) — never leaks other users' records.
    """
    if not DB_ENABLED:
        return []
    try:
        ensure_schema()
        clauses = []
        params: List[Any] = []
        if is_admin or session_id == "*":
            where_sql = ""
        elif session_id:
            where_sql = " WHERE (session_id = %s OR kind = 'seed' OR (metadata IS NOT NULL AND metadata->>'is_seed' = 'true'))"
            params.append(session_id)
        else:
            where_sql = " WHERE (kind = 'seed' OR (metadata IS NOT NULL AND metadata->>'is_seed' = 'true'))"

        sql = f"SELECT id, session_id, kind, title, duration_sec, transcript, analysis, metadata, created_at FROM voice_records{where_sql} ORDER BY created_at DESC LIMIT %s"
        params.append(limit)

        with get_conn() as conn:
            cur = conn.execute(sql, params)
            rows = []
            for r in cur.fetchall():
                rows.append({
                    "id": r[0],
                    "session_id": r[1],
                    "kind": r[2],
                    "title": r[3],
                    "duration_sec": r[4],
                    "transcript": r[5],
                    "analysis": r[6],
                    "metadata": r[7],
                    "created_at": r[8].isoformat() if hasattr(r[8], "isoformat") else str(r[8]),
                })
            return rows
    except Exception as e:
        log.warning("list_voice_records failed: %s", e)
        return []


def delete_voice_record(record_id: str, session_id: Optional[str] = None, is_admin: bool = False) -> bool:
    """Delete a single voice record scoped to the owner session unless admin."""
    if not DB_ENABLED:
        return False
    try:
        ensure_schema()
        params: List[Any] = [record_id]
        where = "WHERE id = %s"
        if not is_admin and session_id != "*":
            if session_id:
                where += " AND (session_id = %s OR session_id IS NULL)"
                params.append(session_id)
            else:
                where += " AND session_id IS NULL"

        with get_conn() as conn:
            cur = conn.execute(f"DELETE FROM voice_records {where}", params)
            conn.commit()
            return cur.rowcount > 0
    except Exception as e:
        log.warning("delete_voice_record failed: %s", e)
        return False


def clear_voice_records(session_id: Optional[str] = None, is_admin: bool = False) -> int:
    """Clear voice records scoped to the owner session unless admin."""
    if not DB_ENABLED:
        return 0
    try:
        ensure_schema()
        params: List[Any] = []
        if is_admin or session_id == "*":
            where = ""
        elif session_id:
            where = "WHERE session_id = %s"
            params.append(session_id)
        else:
            where = "WHERE session_id IS NULL"

        with get_conn() as conn:
            cur = conn.execute(f"DELETE FROM voice_records {where}", params)
            conn.commit()
            return cur.rowcount
    except Exception as e:
        log.warning("clear_voice_records failed: %s", e)
        return 0

