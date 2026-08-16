"""
Security helpers shared across api.py:

  - is_safe_public_url(): SSRF guard for /integrations/relay. Blocks
    requests to loopback/private/link-local/reserved/multicast addresses —
    resolved via real DNS lookup, not just a string check on the URL, so
    a public hostname that resolves to an internal IP (DNS rebinding, or
    just an internal service registered under a public-looking name) is
    still caught.

  - RateLimiter: a small in-memory sliding-window limiter, keyed by
    client IP. This process has no database/Redis (see ARCHITECTURE.md),
    and there is no per-user auth system at all — every endpoint here is
    reachable by anyone. A per-IP request cap is the realistic, deployable
    mitigation for unbounded abuse of paid upstream providers (LLM/ASR/TTS/
    realtime) without requiring a login system this product doesn't have
    and without breaking the anonymous-by-design frontend. It resets on
    every process restart, same as the existing /analytics counters —
    an acceptable tradeoff for abuse mitigation, not a hard guarantee.
"""
from __future__ import annotations

import ipaddress
import socket
import time
from collections import defaultdict, deque
from typing import Deque, Dict
from urllib.parse import urlparse


def _is_blocked_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # unparseable — refuse rather than guess
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def is_safe_public_url(url: str) -> bool:
    """True only if `url` is http(s) and every address its host resolves to
    is a real public address. Used to gate /integrations/relay — a
    caller-supplied destination the server fetches on the caller's behalf,
    which is exactly the shape of an SSRF vector without this check."""
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False

    host = parsed.hostname
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False  # can't resolve — refuse rather than guess
    if not infos:
        return False

    for info in infos:
        addr = info[4][0]
        if _is_blocked_ip(addr):
            return False
    return True


class RateLimiter:
    """Sliding-window per-key limiter: at most `limit` calls in any
    `window_seconds` interval. Not distributed, not persistent — see
    module docstring for why that's an acceptable tradeoff here."""

    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.time()
        dq = self._hits[key]
        cutoff = now - self.window
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= self.limit:
            return False
        dq.append(now)
        return True


def client_ip(headers, client_host: str) -> str:
    """Best-effort real client IP behind Render's proxy — falls back to the
    direct connection's host if no forwarding header is present (local/dev)."""
    fwd = headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return client_host or "unknown"
