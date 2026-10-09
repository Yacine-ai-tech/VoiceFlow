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

# Cache: URL-aware dictionary holding tools + resources + prompts per endpoint
_url_cache: Dict[str, Dict[str, Any]] = {}

def _get_url_cache(url: Optional[str] = None) -> Dict[str, Any]:
    base = (url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    if base not in _url_cache:
        _url_cache[base] = {
            "tools":      None,
            "resources":  None,
            "prompts":    None,
            "gemini_tools": None,
            "fetched_at": 0.0,
        }
    return _url_cache[base]

_result_cache: Dict[str, Dict[str, Any]] = {}
import threading

_client_local = threading.local()


def _get_shared_client() -> httpx.AsyncClient:
    """Return a thread-local, loop-bound httpx.AsyncClient with persistent keep-alive connection pooling."""
    try:
        import asyncio
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    client = getattr(_client_local, "client", None)
    client_loop = getattr(_client_local, "loop", None)

    if client is not None:
        if client.is_closed or client_loop is None or client_loop is not loop:
            client = None
            _client_local.client = None
            _client_local.loop = None

    if client is None:
        timeout = float(__import__("os").getenv("AGENT_TOOLS_HTTP_TIMEOUT_SECONDS", "8"))
        client = httpx.AsyncClient(
            timeout=timeout,
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=30.0),
        )
        _client_local.client = client
        _client_local.loop = loop

    return client


def _cache_key(name: str, arguments: Optional[Dict[str, Any]]) -> str:
    import json
    return json.dumps([name, arguments or {}], sort_keys=True, separators=(",", ":"))


# ── Helpers ──────────────────────────────────────────────────────────────────

def _auth_headers(custom_token: Optional[str] = None) -> Dict[str, str]:
    """Return the auth header dict for requests to AGENT_TOOLS_URL.
    Sends standard Authorization Bearer header as well as common token headers
    so any compliant external agent service can authenticate requests.
    """
    token = custom_token or settings.AGENT_TOOLS_TOKEN
    if not token:
        return {}
    return {
        "Authorization": f"Bearer {token}",
        "X-Agent-Tools-Token": token,
        "X-Internal-Token": token,
        "X-AgentKit-Internal-Token": token,
    }


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
        return " [ACTION: writes/modifies data on external service]"
    if effect == "destructive":
        return " [ACTION: destructive action — requires explicit approval]"
    return ""


# ── Discovery ────────────────────────────────────────────────────────────────

async def _refresh_cache(target_url: Optional[str] = None, force: bool = False) -> None:
    """Fetch and cache tools + resources + prompts from {base}/api/tools.
    Silently no-ops if the URL is unset or the request fails.
    """
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    entry = _get_url_cache(base)
    ttl = settings.AGENT_TOOLS_CACHE_TTL
    if (
        not force
        and entry["tools"] is not None
        and (time.time() - entry["fetched_at"]) < ttl
    ):
        return  # still fresh

    if not base:
        entry.update({"tools": [], "resources": [], "prompts": [], "gemini_tools": [], "fetched_at": time.time()})
        return

    try:
        client = _get_shared_client()
        resp = await client.get(f"{base}/api/tools", headers=_auth_headers())
        resp.raise_for_status()
        data = resp.json()

        tools     = data.get("tools", []) if isinstance(data.get("tools"), list) else []
        resources = data.get("resources", []) if isinstance(data.get("resources"), list) else []
        prompts   = data.get("prompts", []) if isinstance(data.get("prompts"), list) else []

        entry.update({
            "tools":      tools,
            "resources":  resources,
            "prompts":    prompts,
            "gemini_tools": None,
            "fetched_at": time.time(),
        })
        log.info(
            "agent-tools discovery: %d tool(s), %d resource(s), %d prompt(s) at %s",
            len(tools), len(resources), len(prompts), base,
        )
    except Exception as exc:
        log.warning("agent-tools discovery failed at %s (%s) — continuing without tools", base, exc)
        if entry["tools"] is None:
            entry.update({"tools": [], "resources": [], "prompts": [], "gemini_tools": [], "fetched_at": time.time()})


def _build_gemini_tool_declarations_from_tools(tools: List[Dict[str, Any]]):
    """Build Gemini SDK tool objects from already-discovered tools."""
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


async def prewarm(target_url: Optional[str] = None) -> None:
    """Best-effort background discovery warmup for realtime sessions."""
    await _refresh_cache(target_url=target_url, force=True)
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    entry = _get_url_cache(base)
    try:
        entry["gemini_tools"] = _build_gemini_tool_declarations_from_tools(cached_tools_snapshot(base))
    except Exception as exc:
        log.warning("agent-tools Gemini declaration warmup failed at %s (%s)", base, exc)
        entry["gemini_tools"] = []


def cached_tools_snapshot(target_url: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return the current in-memory tools without network I/O."""
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    return _get_url_cache(base).get("tools") or []


async def discover_tools(target_url: Optional[str] = None, force: bool = False) -> List[Dict[str, Any]]:
    """Return the cached tool list. Empty list if unset or unreachable."""
    await _refresh_cache(target_url=target_url, force=force)
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    return _get_url_cache(base).get("tools") or []


async def discover_resources(target_url: Optional[str] = None, force: bool = False) -> List[Dict[str, Any]]:
    """Return the cached resource list `[{"uri", "name", "description"}, ...]`.
    Empty list if unset or unreachable.
    """
    await _refresh_cache(target_url=target_url, force=force)
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    return _get_url_cache(base).get("resources") or []


async def discover_prompts(target_url: Optional[str] = None, force: bool = False) -> List[Dict[str, Any]]:
    """Return the cached prompt list `[{"name", "description", "arguments"}, ...]`.
    Empty list if unset or unreachable.
    """
    await _refresh_cache(target_url=target_url, force=force)
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    return _get_url_cache(base).get("prompts") or []


async def discover_all(target_url: Optional[str] = None, force: bool = False) -> Dict[str, List[Dict[str, Any]]]:
    """Return all three discovery lists in one call."""
    await _refresh_cache(target_url=target_url, force=force)
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    entry = _get_url_cache(base)
    return {
        "tools":     entry.get("tools")     or [],
        "resources": entry.get("resources") or [],
        "prompts":   entry.get("prompts")   or [],
    }


# ── Realtime model tool shapes ────────────────────────────────────────────────

async def openai_tools(target_url: Optional[str] = None, force: bool = False) -> List[Dict[str, Any]]:
    """Tools in OpenAI Realtime API's `session.update` shape.

    Write/destructive tools have their effect class appended to the description
    so the model knows they cause side effects before invoking them.
    """
    tools = await discover_tools(target_url=target_url, force=force)
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


def openai_tools_from_snapshot(target_url: Optional[str] = None) -> List[Dict[str, Any]]:
    """OpenAI tool declarations from the current cache only."""
    result = []
    for t in cached_tools_snapshot(target_url):
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


async def gemini_tool_declarations(target_url: Optional[str] = None):
    """Tools as google-genai FunctionDeclaration objects for Gemini Live.

    Imports google-genai lazily so this module loads without it installed.
    Write/destructive effects are appended to descriptions.
    Returns [] if nothing to declare.
    """
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    entry = _get_url_cache(base)
    if entry.get("gemini_tools") is not None:
        return entry["gemini_tools"]

    tools = await discover_tools(target_url=target_url)
    if not tools:
        entry["gemini_tools"] = []
        return []

    try:
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
        decls = [_gtypes.Tool(function_declarations=declarations)] if declarations else []
        entry["gemini_tools"] = decls
        return decls
    except Exception as exc:
        log.warning("gemini_tool_declarations failed at %s (%s)", base, exc)
        entry["gemini_tools"] = []
        return []


def gemini_tool_declarations_from_snapshot(target_url: Optional[str] = None):
    """Gemini tool declarations from the warm cache only.

    This must stay non-blocking for `/realtime/gemini`: no network, no imports,
    no SDK object construction. `prewarm()` fills this snapshot in the
    background; if it is unavailable, the session starts tool-free instead of
    adding seconds of startup latency.
    """
    base = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    return _get_url_cache(base).get("gemini_tools") or []


# ── Tool execution ────────────────────────────────────────────────────────────

async def call_tool(
    name: str,
    arguments: Optional[Dict[str, Any]] = None,
    *,
    dry_run: bool = False,
    approval_token: Optional[str] = None,
    target_url: Optional[str] = None,
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
    tools = cached_tools_snapshot(target_url) or await discover_tools(target_url)
    spec = next((t for t in tools if t.get("name") == name), None)
    if not spec:
        return {"error": f"unknown_tool: {name}"}

    base     = (target_url or settings.AGENT_TOOLS_URL or "").strip().rstrip("/")
    endpoint = spec.get("endpoint")
    if not base or not endpoint:
        return {"error": "tool_endpoint_unavailable"}

    effect = spec.get("effect", "read")
    url    = f"{base}{endpoint}"
    # Strip control fields
    args = {
        k: v for k, v in (arguments or {}).items()
        if v is not None and k not in ("approval_token", "dry_run")
    }
    if "domain" in args:
        dom_val = str(args["domain"]).strip()
        if dom_val.lower() in ("all", "company", "global", "total", "*", "none", "null", ""):
            del args["domain"]
        else:
            args["domain"] = dom_val

    # Prune unexpected arguments not defined in spec.params (if spec defines params)
    spec_params = spec.get("params")
    if isinstance(spec_params, list) and spec_params:
        allowed_param_names = {p.get("name") for p in spec_params if isinstance(p, dict) and p.get("name")}
        if allowed_param_names:
            args = {k: v for k, v in args.items() if k in allowed_param_names}

    log.debug("agent-tool call: %r  effect=%s  dry_run=%s  base=%s", name, effect, dry_run, base)

    result_key = _cache_key(f"{base}:{name}", args)
    now = time.time()
    if effect == "read" and not dry_run:
        cached = _result_cache.get(result_key)
        if cached and now - cached["fetched_at"] < int(__import__("os").getenv("AGENT_TOOLS_RESULT_CACHE_TTL", "30")):
            return cached["value"]

    try:
        async def _request() -> httpx.Response:
            client = _get_shared_client()
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
            timeout=float(__import__("os").getenv("AGENT_TOOLS_CALL_BUDGET_SECONDS", "8.0")),
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
        return {"error": "agent_tool_timeout", "detail": f"tool exceeded {__import__('os').getenv('AGENT_TOOLS_CALL_BUDGET_SECONDS', '8.0')}s budget"}
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
        client = _get_shared_client()
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
        client = _get_shared_client()
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
