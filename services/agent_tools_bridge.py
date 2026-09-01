"""
Agent Tools Bridge — lets the /realtime voice agent call out to an external
"agent tools" service mid-conversation.

This module is intentionally generic. VoiceFlow does not hardcode any specific
agent-tools product. Point AGENT_TOOLS_URL at any service that implements the
discovery contract below and its tools, resources, and prompts become available
to the realtime voice model — swap the URL and you've swapped providers, no
code change needed.

Discovery contract — a compliant service exposes:

  GET  {AGENT_TOOLS_URL}/api/tools
    -> {
         "tools":     [{"name", "description", "endpoint", "effect", "params": [...]}],
         "resources": [{"uri", "name", "description"}],
         "prompts":   [{"name", "description", "arguments": [...]}]
       }

  GET  {AGENT_TOOLS_URL}{tool.endpoint}?<params>          # read tools (effect=read)
  POST {AGENT_TOOLS_URL}{tool.endpoint}                    # write/destructive tools
       body: {"param1": val, ..., "dry_run": bool, "approval_token": str|null}
    -> JSON result (any shape — passed through to the model as-is)

  GET  {AGENT_TOOLS_URL}/api/resources?uri=<encoded_uri>
    -> {"uri": str, "content": str, "mime_type": str}

  GET  {AGENT_TOOLS_URL}/api/prompts/{name}?arg=val&...
    -> {"name": str, "content": str}

Effect classes (tools only):
  read        — no side effects, called via GET
  write       — creates/modifies state, called via POST; requires AGENTKIT_ALLOW_WRITES=true
                on the downstream service
  destructive — irreversible, called via POST; additionally requires a human-held
                approval_token the model never has

Graceful degradation: if AGENT_TOOLS_URL is unset or any discovery/call fails,
this module returns [] or {"error": ...} — never raises. The voice agent runs
tool-free rather than crashing.
"""
from __future__ import annotations

import time
import asyncio
from typing import Any, Dict, List, Optional

import httpx

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

_JSON_TYPE_MAP = {
    "string":  "string",
    "integer": "integer",
    "number":  "number",
    "boolean": "boolean",
}

# Cache: single dict holding tools + resources + prompts discovered together
_cache: Dict[str, Any] = {
    "tools":      None,
    "resources":  None,
    "prompts":    None,
    "fetched_at": 0.0,
}

_result_cache: Dict[str, Dict[str, Any]] = {}


def _cache_key(name: str, arguments: Optional[Dict[str, Any]]) -> str:
    import json
    return json.dumps([name, arguments or {}], sort_keys=True, separators=(",", ":"))


# ── Helpers ──────────────────────────────────────────────────────────────────

def _auth_headers() -> Dict[str, str]:
    """Return the auth header dict for requests to AGENT_TOOLS_URL.
    Uses X-AgentKit-Internal-Token when a token is configured; empty otherwise.
    """
    token = settings.AGENT_TOOLS_TOKEN
    return {"X-AgentKit-Internal-Token": token} if token else {}


def _params_to_json_schema(params: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Convert a flat param list from the discovery contract into JSON Schema."""
    properties: Dict[str, Any] = {}
    required: List[str] = []
    for p in params or []:
        name = p.get("name")
        if not name:
            continue
        prop: Dict[str, Any] = {"type": _JSON_TYPE_MAP.get(p.get("type", "string"), "string")}
        if p.get("description"):
            prop["description"] = p["description"]
        if "default" in p:
            prop["default"] = p["default"]
        properties[name] = prop
        if p.get("required"):
            required.append(name)
    return {"type": "object", "properties": properties, "required": required}


def _effect_suffix(effect: str) -> str:
    """Human-readable suffix appended to tool descriptions for non-read tools."""
    if effect == "write":
        return " [ACTION: writes data — requires AGENTKIT_ALLOW_WRITES on the service]"
    if effect == "destructive":
        return " [ACTION: destructive — requires human approval_token]"
    return ""


# ── Discovery ────────────────────────────────────────────────────────────────

async def _refresh_cache(force: bool = False) -> None:
    """Fetch and cache tools + resources + prompts from AGENT_TOOLS_URL/api/tools.
    Silently no-ops if the URL is unset or the request fails.
    """
    ttl = settings.AGENT_TOOLS_CACHE_TTL
    if (
        not force
        and _cache["tools"] is not None
        and (time.time() - _cache["fetched_at"]) < ttl
    ):
        return  # still fresh

    base = settings.AGENT_TOOLS_URL
    if not base:
        _cache.update({"tools": [], "resources": [], "prompts": [], "fetched_at": time.time()})
        return

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/api/tools", headers=_auth_headers())
        resp.raise_for_status()
        data = resp.json()

        tools     = data.get("tools", []) if isinstance(data.get("tools"), list) else []
        resources = data.get("resources", []) if isinstance(data.get("resources"), list) else []
        prompts   = data.get("prompts", []) if isinstance(data.get("prompts"), list) else []

        _cache.update({
            "tools":      tools,
            "resources":  resources,
            "prompts":    prompts,
            "fetched_at": time.time(),
        })
        log.info(
            "agent-tools discovery: %d tool(s), %d resource(s), %d prompt(s) at %s",
            len(tools), len(resources), len(prompts), base,
        )
    except Exception as exc:
        log.warning("agent-tools discovery failed (%s) — continuing without tools", exc)
        # If we had a previous good discovery, keep serving it. A transient
        # AgentKit/Render cold start should not remove tools from live sessions.
        if _cache["tools"] is None:
            _cache.update({"tools": [], "resources": [], "prompts": [], "fetched_at": time.time()})


async def prewarm() -> None:
    """Best-effort background discovery warmup for realtime sessions."""
    await _refresh_cache(force=True)


def cached_tools_snapshot() -> List[Dict[str, Any]]:
    """Return the current in-memory tools without network I/O."""
    return _cache["tools"] or []


async def discover_tools(force: bool = False) -> List[Dict[str, Any]]:
    """Return the cached tool list. Empty list if unset or unreachable."""
    await _refresh_cache(force=force)
    return _cache["tools"] or []


async def discover_resources(force: bool = False) -> List[Dict[str, Any]]:
    """Return the cached resource list `[{"uri", "name", "description"}, ...]`.
    Empty list if unset or unreachable.
    """
    await _refresh_cache(force=force)
    return _cache["resources"] or []


async def discover_prompts(force: bool = False) -> List[Dict[str, Any]]:
    """Return the cached prompt list `[{"name", "description", "arguments"}, ...]`.
    Empty list if unset or unreachable.
    """
    await _refresh_cache(force=force)
    return _cache["prompts"] or []


async def discover_all(force: bool = False) -> Dict[str, List[Dict[str, Any]]]:
    """Return all three discovery lists in one call."""
    await _refresh_cache(force=force)
    return {
        "tools":     _cache["tools"]     or [],
        "resources": _cache["resources"] or [],
        "prompts":   _cache["prompts"]   or [],
    }


# ── Realtime model tool shapes ────────────────────────────────────────────────

async def openai_tools() -> List[Dict[str, Any]]:
    """Tools in OpenAI Realtime API's `session.update` shape.

    Write/destructive tools have their effect class appended to the description
    so the model knows they cause side effects before invoking them.
    """
    tools = await discover_tools()
    result = []
    for t in tools:
        if not t.get("name"):
            continue
        effect = t.get("effect", "read")
        description = (t.get("description") or "") + _effect_suffix(effect)
        result.append({
            "type": "function",
            "name": t["name"],
            "description": description,
            "parameters": _params_to_json_schema(t.get("params", [])),
        })
    return result


def openai_tools_from_snapshot() -> List[Dict[str, Any]]:
    """OpenAI tool declarations from the current cache only."""
    result = []
    for t in cached_tools_snapshot():
        if not t.get("name"):
            continue
        effect = t.get("effect", "read")
        result.append({
            "type": "function",
            "name": t["name"],
            "description": (t.get("description") or "") + _effect_suffix(effect),
            "parameters": _params_to_json_schema(t.get("params", [])),
        })
    return result


async def gemini_tool_declarations():
    """Tools as google-genai FunctionDeclaration objects for Gemini Live.

    Imports google-genai lazily so this module loads without it installed.
    Write/destructive effects are appended to descriptions.
    Returns [] if nothing to declare.
    """
    tools = await discover_tools()
    if not tools:
        return []

    from google.genai import types as _gtypes  # type: ignore

    declarations = []
    for t in tools:
        if not t.get("name"):
            continue
        effect = t.get("effect", "read")
        description = (t.get("description") or "") + _effect_suffix(effect)
        declarations.append(
            _gtypes.FunctionDeclaration(
                name=t["name"],
                description=description,
                parameters=_params_to_json_schema(t.get("params", [])),
            )
        )
    return [_gtypes.Tool(function_declarations=declarations)] if declarations else []


def gemini_tool_declarations_from_snapshot():
    """Gemini tool declarations from the current cache only."""
    tools = cached_tools_snapshot()
    if not tools:
        return []

    from google.genai import types as _gtypes  # type: ignore

    declarations = []
    for t in tools:
        if not t.get("name"):
            continue
        effect = t.get("effect", "read")
        declarations.append(
            _gtypes.FunctionDeclaration(
                name=t["name"],
                description=(t.get("description") or "") + _effect_suffix(effect),
                parameters=_params_to_json_schema(t.get("params", [])),
            )
        )
    return [_gtypes.Tool(function_declarations=declarations)] if declarations else []


# ── Tool execution ────────────────────────────────────────────────────────────

async def call_tool(
    name: str,
    arguments: Optional[Dict[str, Any]] = None,
    *,
    dry_run: bool = False,
    approval_token: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute a discovered tool call.

    Effect-aware routing:
      - read tools        → GET {endpoint}?params
      - write tools       → POST {endpoint} with JSON body
      - destructive tools → POST {endpoint} with JSON body + approval_token

    dry_run=True previews a mutating action without committing (the downstream
    service runs the operation inside a rolled-back transaction and returns the
    would-be result). Safe to call on read tools — has no effect.

    approval_token is forwarded as-is in the POST body for destructive tools.
    The model never generates or holds this token; it must come from a human or
    supervising system that supplies it to the voice agent session.

    Never raises — returns {"error": ...} on any failure so the model can
    report the issue to the user.
    """
    tools = cached_tools_snapshot() or await discover_tools()
    spec = next((t for t in tools if t.get("name") == name), None)
    if not spec:
        return {"error": f"unknown_tool: {name}"}

    base     = settings.AGENT_TOOLS_URL
    endpoint = spec.get("endpoint")
    if not base or not endpoint:
        return {"error": "tool_endpoint_unavailable"}

    effect = spec.get("effect", "read")
    url    = f"{base}{endpoint}"
    # Strip the two control fields out of whatever the model supplied, rather
    # than trusting the discovery contract to never expose them as ordinary
    # params. approval_token in particular is documented (module docstring)
    # to come only from a human/supervising system, never the model — if a
    # downstream tool's own JSON schema ever declared a same-named param,
    # a manipulated/prompt-injected model could otherwise "supply" a fake
    # approval_token as a regular argument and have it ride through to
    # `body` unfiltered, silently bypassing the human-approval gate this
    # function's own explicit `approval_token=` keyword is meant to enforce.
    args = {
        k: v for k, v in (arguments or {}).items()
        if v is not None and k not in ("approval_token", "dry_run")
    }

    log.debug("agent-tool call: %r  effect=%s  dry_run=%s", name, effect, dry_run)

    result_key = _cache_key(name, args)
    now = time.time()
    if effect == "read" and not dry_run:
        cached = _result_cache.get(result_key)
        if cached and now - cached["fetched_at"] < int(__import__("os").getenv("AGENT_TOOLS_RESULT_CACHE_TTL", "30")):
            return cached["value"]

    try:
        async def _request() -> httpx.Response:
            async with httpx.AsyncClient(timeout=float(__import__("os").getenv("AGENT_TOOLS_HTTP_TIMEOUT_SECONDS", "8"))) as client:
                if effect in ("write", "destructive"):
                    body: Dict[str, Any] = {**args}
                    if dry_run:
                        body["dry_run"] = True
                    if approval_token:
                        body["approval_token"] = approval_token
                    return await client.post(url, json=body, headers=_auth_headers())
                params = dict(args)
                if dry_run:
                    params["dry_run"] = "true"
                return await client.get(url, params=params, headers=_auth_headers())

        resp = await asyncio.wait_for(
            _request(),
            timeout=float(__import__("os").getenv("AGENT_TOOLS_CALL_BUDGET_SECONDS", "2.0")),
        )

        if resp.status_code >= 400:
            return {
                "error":  f"agent_tool_error_{resp.status_code}",
                "detail": resp.text[:300],
            }
        value = resp.json()
        if effect == "read" and not dry_run:
            _result_cache[result_key] = {"value": value, "fetched_at": time.time()}
        return value

    except asyncio.TimeoutError:
        return {"error": "agent_tool_timeout", "detail": f"tool exceeded {__import__('os').getenv('AGENT_TOOLS_CALL_BUDGET_SECONDS', '2.0')}s budget"}
    except httpx.RequestError as exc:
        log.warning("agent tool call %r failed: %s", name, exc)
        return {"error": "agent_tools_unreachable", "detail": str(exc), "url": base}
    except Exception as exc:
        log.exception("agent tool call %r failed unexpectedly: %s", name, exc)
        return {"error": "agent_tool_call_failed", "detail": str(exc)}


# ── Resource fetching ─────────────────────────────────────────────────────────

async def fetch_resource(uri: str) -> Dict[str, Any]:
    """Fetch a single resource by URI from the agent tools service.

    Returns {"uri", "content", "mime_type"} on success, {"error": ...} on
    failure — never raises.

    Use this to pin live data into the voice agent's context without a tool
    call: e.g. fetch a config snapshot or current report before the session
    starts so the model has it ready.
    """
    base = settings.AGENT_TOOLS_URL
    if not base:
        return {"error": "agent_tools_url_not_configured"}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{base}/api/resources",
                params={"uri": uri},  # httpx URL-encodes query params itself
                headers=_auth_headers(),
            )
        if resp.status_code >= 400:
            return {"error": f"resource_fetch_error_{resp.status_code}", "uri": uri}
        return resp.json()
    except Exception as exc:
        log.warning("resource fetch %r failed: %s", uri, exc)
        return {"error": "resource_fetch_failed", "detail": str(exc), "uri": uri}


# ── Prompt invocation ─────────────────────────────────────────────────────────

async def invoke_prompt(name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Invoke a named prompt template from the agent tools service.

    Returns {"name", "content"} where `content` is the rendered prompt string,
    or {"error": ...} on failure — never raises.

    Use this to inject a domain-specific system prompt into the voice session
    at connect time, rather than hardcoding prompt text in VoiceFlow:

      prompt = await invoke_prompt("weekly_summary", {"metric": "revenue"})
      if "content" in prompt:
          session_instructions += "\\n\\n" + prompt["content"]
    """
    base = settings.AGENT_TOOLS_URL
    if not base:
        return {"error": "agent_tools_url_not_configured"}

    params = {k: v for k, v in (arguments or {}).items() if v is not None}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{base}/api/prompts/{name}",
                params=params,
                headers=_auth_headers(),
            )
        if resp.status_code >= 400:
            return {"error": f"prompt_invoke_error_{resp.status_code}", "name": name}
        return resp.json()
    except Exception as exc:
        log.warning("prompt invoke %r failed: %s", name, exc)
        return {"error": "prompt_invoke_failed", "detail": str(exc), "name": name}
