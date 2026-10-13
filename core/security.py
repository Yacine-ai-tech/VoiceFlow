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
from typing import Deque, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from aiohttp.abc import AbstractResolver


def _is_blocked_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # unparseable — refuse rather than guess
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not ip.is_global


def resolve_public_url_addresses(
    url: str,
) -> Optional[Tuple[str, int, List[Tuple[int, str, int]]]]:
    """Resolve a public webhook once and return the addresses safe to pin."""
    try:
        parsed = urlparse(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            return None
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except Exception:
        return None
    if not infos:
        return None

    addresses = []
    for info in infos:
        family, _, protocol, _, sockaddr = info
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        address = sockaddr[0]
        if _is_blocked_ip(address):
            return None
        entry = (family, address, protocol)
        if entry not in addresses:
            addresses.append(entry)
    return (host, port, addresses) if addresses else None


def is_safe_public_url(url: str) -> bool:
    """True only when every address resolved for a webhook is globally routable."""
    return resolve_public_url_addresses(url) is not None


class PinnedResolver(AbstractResolver):
    """Return only the public addresses validated for this relay request."""

    def __init__(self, hostname: str, addresses: List[Tuple[int, str, int]]):
        self.hostname = hostname.rstrip(".").casefold()
        self.addresses = addresses

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET):
        if host.rstrip(".").casefold() != self.hostname:
            raise OSError("Unvalidated hostname requested")
        results = [
            {
                "hostname": host,
                "host": address,
                "port": port,
                "family": address_family,
                "proto": protocol,
                "flags": 0,
            }
            for address_family, address, protocol in self.addresses
            if family in (socket.AF_UNSPEC, address_family)
        ]
        if not results:
            raise OSError("No validated address for requested address family")
        return results

    async def close(self):
        return None


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
    """Best-effort real client IP behind a reverse proxy — falls back to the
    direct connection's host if no forwarding header is present (local/dev)."""
    fwd = headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return client_host or "unknown"
