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


def _get_pool():
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            from psycopg_pool import ConnectionPool
            _pool = ConnectionPool(settings.POSTGRES_URL, min_size=1, max_size=5, open=True)
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
    log.info("Postgres schema ready (session_stats)")


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
