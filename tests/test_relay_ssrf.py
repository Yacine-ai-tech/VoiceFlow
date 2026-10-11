import asyncio
import socket
from unittest.mock import patch

from starlette.requests import Request

import api
from core.security import PinnedResolver, is_safe_public_url, resolve_public_url_addresses


def _addr_info(address, family=socket.AF_INET):
    sockaddr = (address, 443) if family == socket.AF_INET else (address, 443, 0, 0)
    return (family, socket.SOCK_STREAM, 6, "", sockaddr)


def test_rejects_mixed_public_and_private_dns_answers(monkeypatch):
    monkeypatch.setattr(
        "core.security.socket.getaddrinfo",
        lambda *args, **kwargs: [_addr_info("8.8.8.8"), _addr_info("127.0.0.1")],
    )

    assert resolve_public_url_addresses("https://callback.example/hook") is None
    assert not is_safe_public_url("https://callback.example/hook")


def test_pinned_resolver_uses_the_validated_addresses_without_resolving_again(monkeypatch):
    lookup = patch(
        "core.security.socket.getaddrinfo",
        return_value=[_addr_info("8.8.8.8")],
    )
    with lookup as getaddrinfo:
        resolved = resolve_public_url_addresses("https://callback.example/hook")
        assert resolved is not None
        hostname, _, addresses = resolved
        resolver = PinnedResolver(hostname, addresses)
        result = asyncio.run(resolver.resolve("callback.example", 443, socket.AF_UNSPEC))

    assert getaddrinfo.call_count == 1
    assert [record["host"] for record in result] == ["8.8.8.8"]
    assert asyncio.run(resolver.resolve("callback.example", 443, socket.AF_UNSPEC)) == result
    try:
        asyncio.run(resolver.resolve("attacker.example", 443, socket.AF_UNSPEC))
    except OSError as exc:
        assert "Unvalidated hostname" in str(exc)
    else:
        raise AssertionError("Resolver accepted an unvalidated hostname")


def test_relay_pins_resolution_and_disables_redirects(monkeypatch):
    monkeypatch.setattr(
        "core.security.socket.getaddrinfo",
        lambda *args, **kwargs: [_addr_info("8.8.8.8")],
    )
    monkeypatch.setenv("REQUIRE_INTERNAL_TOKEN", "false")
    captured = {}

    class Response:
        status = 204

        def __init__(self):
            self.content = self

        async def __aenter__(self):
            records = await captured["connector"]._resolver.resolve(
                "callback.example", 443, socket.AF_UNSPEC
            )
            captured["resolved"] = records
            return self

        async def __aexit__(self, *args):
            return None

        async def read(self, limit):
            return b"accepted"

    class Session:
        def __init__(self, *, connector, timeout, trust_env):
            assert timeout.total == 15
            assert trust_env is False
            captured["connector"] = connector

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            await captured["connector"].close()

        def post(self, url, *, data, headers, allow_redirects):
            captured.update(
                url=url,
                data=data,
                allow_redirects=allow_redirects,
            )
            return Response()

    monkeypatch.setattr(api.aiohttp, "ClientSession", Session)
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/integrations/relay",
        "headers": [],
        "query_string": b"",
        "server": ("test", 80),
        "client": ("127.0.0.1", 1),
        "scheme": "http",
        "http_version": "1.1",
    }
    request = Request(scope)
    result = asyncio.run(api.integrations_relay(
        api.RelayRequest(
            url="https://callback.example/hook",
            payload={"text": "test"},
        ),
        request,
    ))

    assert result["status"] == 204
    assert captured["allow_redirects"] is False
    assert [record["host"] for record in captured["resolved"]] == ["8.8.8.8"]
