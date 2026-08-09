"""
Agent Tools Bridge — lets the /realtime voice agent call out to an external
"agent tools" service mid-conversation (business intelligence, automation,
whatever that service exposes).

This is intentionally generic. VoiceFlow does not hardcode any specific
agent-tools product, and knows nothing about what's on the other end beyond
the discovery contract below. Point AGENT_TOOLS_URL at any service that
implements it and its tools become available to the model — swap the URL and
you've swapped providers, no code change. AgentKit is used as the demo target
for this project's own development and research work, but nothing in this
file names it or assumes it specifically; any compliant service works the
same way.

Discovery contract (a service opts in to being callable from here by
implementing this):

  GET  {AGENT_TOOLS_URL}/api/tools
    -> {"tools": [
          {"name": str, "description": str, "endpoint": str,
           "params": [{"name": str, "type": "string"|"integer"|"number"|"boolean",
                       "required": bool, "default"?: Any}, ...]},
          ...
        ]}

  GET  {AGENT_TOOLS_URL}{tool.endpoint}?<params as query string>
    -> JSON result (any shape — passed through to the model as-is)

The tool list is discovered once and cached for AGENT_TOOLS_CACHE_TTL
seconds. If discovery fails (nothing configured, service down, wrong shape),
/realtime just runs without tools instead of failing — voice-only still
works.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import httpx

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

_JSON_TYPE_MAP = {
    "string": "string",
    "integer": "integer",
    "number": "number",
    "boolean": "boolean",
}

_cache: Dict[str, Any] = {"tools": None, "fetched_at": 0.0}


def _params_to_json_schema(params: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Convert the discovery contract's flat param list into JSON Schema."""
    properties: Dict[str, Any] = {}
    required: List[str] = []
    for p in params or []:
        name = p.get("name")
        if not name:
            continue
        properties[name] = {"type": _JSON_TYPE_MAP.get(p.get("type"), "string")}
        if p.get("required"):
            required.append(name)
    return {"type": "object", "properties": properties, "required": required}


async def discover_tools(force: bool = False) -> List[Dict[str, Any]]:
    """Fetch + cache the tool list from AGENT_TOOLS_URL. Returns [] (never
    raises) if nothing is configured or discovery fails for any reason."""
    ttl = settings.AGENT_TOOLS_CACHE_TTL
    if not force and _cache["tools"] is not None and (time.time() - _cache["fetched_at"]) < ttl:
        return _cache["tools"]

    base = settings.AGENT_TOOLS_URL
    if not base:
        _cache["tools"] = []
        _cache["fetched_at"] = time.time()
        return []

    headers = {}
    if settings.AGENT_TOOLS_TOKEN:
        headers["X-OmniIntel-Internal-Token"] = settings.AGENT_TOOLS_TOKEN

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/api/tools", headers=headers)
        resp.raise_for_status()
        data = resp.json()
        tools = data.get("tools", [])
        if not isinstance(tools, list):
            raise ValueError("malformed discovery response: 'tools' is not a list")
        _cache["tools"] = tools
        _cache["fetched_at"] = time.time()
        log.info("agent-tools discovery: found %d tool(s) at %s", len(tools), base)
        return tools
    except Exception as e:
        log.warning("agent-tools discovery failed (%s) — continuing without tools", e)
        _cache["tools"] = []
        _cache["fetched_at"] = time.time()
        return []


async def openai_tools() -> List[Dict[str, Any]]:
    """Discovered tools in OpenAI Realtime API's `session.update` shape."""
    tools = await discover_tools()
    return [
        {
            "type": "function",
            "name": t["name"],
            "description": t.get("description", ""),
            "parameters": _params_to_json_schema(t.get("params", [])),
        }
        for t in tools
        if t.get("name")
    ]


async def gemini_tool_declarations():
    """Discovered tools as google-genai FunctionDeclaration objects for
    Gemini Live. Imports google-genai lazily so this module loads fine
    without it installed. Returns [] if there's nothing to declare."""
    tools = await discover_tools()
    if not tools:
        return []
    from google.genai import types as _gtypes  # type: ignore

    return [
        _gtypes.Tool(function_declarations=[
            _gtypes.FunctionDeclaration(
                name=t["name"],
                description=t.get("description", ""),
                parameters=_params_to_json_schema(t.get("params", [])),
            )
            for t in tools
            if t.get("name")
        ])
    ]


async def call_tool(name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Execute one discovered tool call. Never raises — on any failure this
    returns an {"error": ...} dict so the model can tell the user the tool
    wasn't reachable instead of the call just hanging."""
    tools = await discover_tools()
    spec = next((t for t in tools if t.get("name") == name), None)
    if not spec:
        return {"error": f"unknown_tool: {name}"}

    base = settings.AGENT_TOOLS_URL
    endpoint = spec.get("endpoint")
    if not base or not endpoint:
        return {"error": "tool_endpoint_unavailable"}

    params = {k: v for k, v in (arguments or {}).items() if v is not None}
    headers = {}
    if settings.AGENT_TOOLS_TOKEN:
        headers["X-OmniIntel-Internal-Token"] = settings.AGENT_TOOLS_TOKEN

    url = f"{base}{endpoint}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params=params, headers=headers)
        if resp.status_code >= 400:
            return {"error": f"agent_tool_error_{resp.status_code}", "detail": resp.text[:300]}
        return resp.json()
    except httpx.RequestError as e:
        log.warning("agent tool call %r failed: %s", name, e)
        return {"error": "agent_tools_unreachable", "detail": str(e), "agent_tools_url": base}
    except Exception as e:
        log.exception("agent tool call %r failed unexpectedly: %s", name, e)
        return {"error": "agent_tool_call_failed", "detail": str(e)}
