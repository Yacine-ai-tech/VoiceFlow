"""
VoiceFlow API — Speech-to-intelligence pipeline.

Endpoints:
  GET  /health
  POST /transcribe       audio + provider
  POST /tts              text + provider + voice
  GET  /tts/voices       ElevenLabs voices on this account (stock + cloned)
  POST /tts/voices/clone real ElevenLabs Instant Voice Cloning from audio samples
  POST /analyze          {text, analysis_type}
  POST /pipeline         audio + analysis_type → transcribe + analyze
  POST /meeting/process
  POST /call/analyze
  WS   /stream           streaming transcription (optional)
  WS   /realtime         OpenAI/Gemini realtime voice agent. If AGENT_TOOLS_URL
                         is set, any tools that service exposes are available
                         for the model to call mid-call — see
                         services/agent_tools_bridge.py.
  WS   /realtime/gemini  optimized Gemini Live relay (binary PCM input)
  POST /realtime/session/openai  OpenAI Realtime WebRTC SDP session bootstrap
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os as _os
import threading
import time
import uuid
from collections import Counter as _Counter
from typing import Any, Dict, Optional

import httpx
from fastapi import (
    FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core import db
from core.config import settings
from core.logger import get_logger
from core.security import RateLimiter, client_ip, is_safe_public_url
from services import agent_tools_bridge, relay_formatting, scenarios
from services.meeting_analyzer import MeetingAnalyzer
from services.transcription_router import transcribe as route_transcribe
from services import tts_service
from services.tts_service import generate_speech

log = get_logger(__name__)

app = FastAPI(title="VoiceFlow", version="0.1.0",
              description="Speech → structured intelligence.")

# Per-IP sliding-window limits. This product has no user accounts and every
# endpoint below is reachable by anyone (see ARCHITECTURE.md) — a per-IP cap
# is the realistic abuse mitigation for unbounded use of paid upstream APIs
# (LLM/ASR/TTS/realtime) without requiring a login system that doesn't exist.
# Not distributed/persistent (resets on restart) — same tradeoff as the
# existing in-memory /analytics counters.
_http_limiter = RateLimiter(limit=int(_os.getenv("RATE_LIMIT_HTTP_PER_MIN", "30")), window_seconds=60)
_ws_connect_limiter = RateLimiter(limit=int(_os.getenv("RATE_LIMIT_WS_CONNECTS_PER_MIN", "10")), window_seconds=60)


def _telemetry_instance_id() -> str:
    """
    A random, locally-generated install ID — NOT derived from MAC address or any other
    hardware fingerprint. Persisted under LOGS_DIR so repeat startups/loops of the same
    install report the same ID (for dedup on the receiving end); delete the file to reset
    it. Shared by both the startup ping and the periodic usage-snapshot ping so they
    never disagree on which instance they're reporting for.
    """
    import os

    id_file = os.path.join(settings.LOGS_DIR, ".telemetry_instance_id")
    try:
        if os.path.exists(id_file):
            existing = open(id_file).read().strip()
            if existing:
                return existing
    except Exception:
        pass
    new_id = uuid.uuid4().hex[:16]
    try:
        with open(id_file, "w") as f:
            f.write(new_id)
    except Exception:
        pass
    return new_id


def _send_telemetry():
    """One anonymous startup ping per machine, at most every 6 hours.

    A no-op unless TELEMETRY_ENDPOINT is set — nothing is sent anywhere by
    default, and self-hosters who set their own TELEMETRY_ENDPOINT control
    exactly where this goes. Skipped entirely when TELEMETRY_OPT_OUT is set,
    as with the periodic usage snapshot below. Payload: {service,
    event:"startup", version, instance_id} — no user data, no per-session
    detail.
    """
    import os

    if os.environ.get("TELEMETRY_OPT_OUT", "").lower() in ("1", "true", "yes"):
        return

    endpoint = settings.TELEMETRY_ENDPOINT
    if not endpoint:
        return

    lock_file = os.path.join(settings.LOGS_DIR, ".telemetry_last_ping")
    try:
        if os.path.exists(lock_file) and time.time() - os.path.getmtime(lock_file) < 21600:
            return
        with open(lock_file, "w") as f:
            f.write(str(time.time()))
    except Exception:
        pass

    try:
        import requests
        requests.post(
            endpoint,
            json={
                "service": "voiceflow",
                "event": "startup",
                "version": app.version,
                "instance_id": _telemetry_instance_id(),
            },
            timeout=3,
        )
    except Exception:
        pass


threading.Thread(target=_send_telemetry, daemon=True).start()


@app.middleware("http")
async def verify_internal_token(request: Request, call_next):
    # Allow health checks, public auth routes, frontend static assets. Any GET is
    # also public — that's page navigation (the SPA shell + its static files) —
    # except GET routes that trigger a real paid upstream call (e.g. /tts/voices),
    # which the rate limiter below still applies to. /realtime and /stream are
    # WebSocket routes and never actually reach this HTTP-only middleware
    # regardless of this list (ASGI "websocket" scope bypasses @app.middleware
    # ("http") entirely) — their own auth/rate-limit gating lives in the WS
    # handlers themselves (see ws_realtime / ws_stream), not here.
    if (request.method == "OPTIONS"
            or request.url.path == "/health"
            or request.url.path.startswith("/api/v1/auth/")
            or request.url.path.startswith("/assets/")
            or request.url.path.startswith("/static/")):
        return await call_next(request)

    ip = client_ip(request.headers, request.client.host if request.client else "")
    if not _http_limiter.allow(ip):
        return JSONResponse(status_code=429, content={"detail": "rate_limited: too many requests, try again shortly"})

    if request.method == "GET":
        return await call_next(request)

    token = (
        request.headers.get("X-VoiceFlow-Internal-Token")
        or request.headers.get("X-Internal-Token")
        or request.headers.get("X-OmniIntel-Internal-Token")
        or (request.headers.get("Authorization", "").replace("Bearer ", "") if request.headers.get("Authorization", "").startswith("Bearer ") else "")
    )
    expected_tokens = [
        t for t in (
            _os.environ.get("VOICEFLOW_INTERNAL_TOKEN"),
            _os.environ.get("INTERNAL_TOKEN"),
            _os.environ.get("OMNIINTEL_INTERNAL_TOKEN"),
        ) if t
    ]

    if _os.environ.get("REQUIRE_INTERNAL_TOKEN", "false").lower() == "true":
        if not token or not any(hmac.compare_digest(token, exp) for exp in expected_tokens):
            return JSONResponse(status_code=403, content={"detail": "Missing or invalid X-VoiceFlow-Internal-Token"})

    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOWED_ORIGINS or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


try:
    _assets_dir = _os.path.join(_os.path.dirname(__file__), "frontend", "dist", "assets")
    if _os.path.exists(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")
except Exception as e:
    log.warning("assets mount failed: %s", e)

analyzer = MeetingAnalyzer()


# Process-local usage counters (v1 "Analytics" ask). Keyed per-session
# (X-VoiceFlow-Session, a random ID the frontend generates once and persists
# in localStorage — no account, no PII): a visitor calling GET /analytics
# only ever sees their own session's counts, never anyone else's or the
# deployment-wide total. Requests without the header (direct API/curl use)
# all share one "anonymous" bucket.
#
# In-memory reads stay the fast path either way. When POSTGRES_URL is set
# (core/db.py), every increment is also durably persisted in the background
# (never blocking the request it came from) and reloaded at startup — same
# role Postgres plays for the other projects in this portfolio. With no
# POSTGRES_URL, nothing changes: still real counters, still reset on restart.
class _PersistentCounter(_Counter):
    def __init__(self, session_id: str):
        super().__init__()
        self._session_id = session_id

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if db.DB_ENABLED:
            threading.Thread(target=db.save_counter, args=(self._session_id, key, value), daemon=True).start()


class _SessionStats(dict):
    def __missing__(self, session_id: str) -> _PersistentCounter:
        counter = _PersistentCounter(session_id)
        self[session_id] = counter
        return counter


_stats: "_SessionStats" = _SessionStats()


def _hydrate_stats_from_db():
    """Reload persisted counters at startup so a restart/redeploy doesn't
    silently zero out usage history when a database is configured. Runs in
    a background thread (like the telemetry pings above) so a slow/cold
    database connection never delays the app actually starting to serve
    requests — a few requests immediately after a cold start may not see
    older history yet; this self-heals within seconds once it completes."""
    if not db.DB_ENABLED:
        return
    for session_id, counters in db.load_all_counters().items():
        counter = _PersistentCounter(session_id)
        for key, value in counters.items():
            dict.__setitem__(counter, key, value)  # bypass the persist-on-write override — this data IS the DB
        _stats[session_id] = counter


threading.Thread(target=_hydrate_stats_from_db, daemon=True).start()


def _session_id(request: Request) -> str:
    return request.headers.get("X-VoiceFlow-Session", "anonymous").strip() or "anonymous"


def _session_stats(request: Request) -> "_Counter[str]":
    return _stats[_session_id(request)]


def _all_sessions_totals() -> "_Counter[str]":
    """Sum of every session's counters — used only for the optional
    telemetry usage snapshot below, never returned by the public
    GET /analytics (which is always scoped to the caller's own session)."""
    total: "_Counter[str]" = _Counter()
    for c in _stats.values():
        total.update(c)
    return total


def _telemetry_usage_loop():
    """Opt-outable via TELEMETRY_OPT_OUT=true, as with the startup ping above:
    if TELEMETRY_ENDPOINT is set, periodically sends one anonymous AGGREGATE
    usage snapshot —
    cumulative counters summed across every session on this instance since
    it started, plus how many distinct sessions have been seen. No session
    IDs, no per-visitor data, nothing GET /analytics doesn't already compute
    per-session. Sends nothing anywhere unless TELEMETRY_ENDPOINT is
    explicitly configured."""
    import os
    interval = int(os.environ.get("TELEMETRY_USAGE_INTERVAL_SECONDS", "1800"))
    while True:
        time.sleep(max(60, interval))
        if os.environ.get("TELEMETRY_OPT_OUT", "").lower() in ("1", "true", "yes"):
            continue
        endpoint = settings.TELEMETRY_ENDPOINT
        if not endpoint:
            continue
        totals = _all_sessions_totals()
        if not totals:
            continue  # nothing happened since startup/last check — nothing to report
        try:
            import requests
            requests.post(
                endpoint,
                json={
                    "service": "voiceflow",
                    "event": "usage_snapshot",
                    "version": app.version,
                    "instance_id": _telemetry_instance_id(),
                    "active_sessions": len(_stats),
                    "counters": dict(totals),
                },
                timeout=3,
            )
        except Exception:
            pass


threading.Thread(target=_telemetry_usage_loop, daemon=True).start()


def _prewarm_agent_tools_loop():
    """Keep tool discovery warm so realtime connect does not wait on AgentKit."""
    interval = max(30, int(_os.getenv("AGENT_TOOLS_PREWARM_INTERVAL_SECONDS", "120")))
    while True:
        try:
            asyncio.run(agent_tools_bridge.prewarm())
        except Exception as e:
            log.debug("agent-tools prewarm failed: %s", e)
        time.sleep(interval)


if settings.AGENT_TOOLS_URL:
    threading.Thread(target=_prewarm_agent_tools_loop, daemon=True).start()


class _RealtimeTrace:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.t0 = time.perf_counter()
        self.seen: set[str] = set()

    async def mark(self, event: str, **extra: Any) -> None:
        elapsed_ms = round((time.perf_counter() - self.t0) * 1000, 1)
        log.info("realtime metric %s %.1fms %s", event, elapsed_ms, extra or "")
        try:
            await self.ws.send_json({"type": "metric", "event": event, "elapsed_ms": elapsed_ms, **extra})
        except Exception:
            pass

    async def first(self, event: str, **extra: Any) -> None:
        if event in self.seen:
            return
        self.seen.add(event)
        await self.mark(event, **extra)


def _check_diarization_available(settings) -> dict:
    """Return diarization status dict to include in API responses."""
    pyannote_token = getattr(settings, "PYANNOTE_TOKEN", "")
    if not pyannote_token:
        return {
            "diarization_available": False,
            "diarization_warning": "Speaker diarization is disabled: PYANNOTE_TOKEN not set. Transcription will proceed without speaker labels.",
        }
    return {"diarization_available": True, "diarization_warning": None}


class AnalyzeRequest(BaseModel):
    text: str
    analysis_type: str = "meeting"


class TTSRequest(BaseModel):
    text: str
    language: str = "en"           # en | fr
    voice_gender: str = "default"  # default | male | female
    provider: str = "edge"
    voice_id: Optional[str] = None  # ElevenLabs only — a cloned voice ID from POST /tts/voices/clone


# ─────────────────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def dashboard():
    """Serve the accessible VoiceFlow dashboard at the root."""
    import os
    root = os.path.dirname(__file__)
    spa = os.path.join(root, "frontend", "dist", "index.html")
    if os.path.exists(spa):
        return FileResponse(spa)
    return {"service": "voiceflow", "docs": "/docs"}


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "voiceflow", "version": "0.1.0"}


class TranscribeJsonRequest(BaseModel):
    audio_b64: str
    provider: Optional[str] = None
    language: Optional[str] = None
    diarize: bool = False


@app.post("/transcribe-json")
async def transcribe_json_endpoint(req: TranscribeJsonRequest) -> Dict[str, Any]:
    import base64
    audio = base64.b64decode(req.audio_b64)
    return await route_transcribe(audio, provider=req.provider, language=req.language, diarize=req.diarize)


@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    provider: Optional[str] = Form(None),
    language: str = Form("auto"),
    diarize: bool = Form(False),
) -> Dict[str, Any]:
    audio = await file.read()
    return await route_transcribe(audio, provider=provider, language=language, diarize=diarize)


@app.post("/tts")
async def tts_endpoint(req: TTSRequest):
    """Synthesize speech via whichever provider is requested — edge (default),
    elevenlabs, openai, or kokoro. Kokoro returns WAV; everything else returns MP3."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text required")

    # On-the-fly translation (simple heuristic: if target language is 'fr', translate first using configured LLM)
    text_to_speak = req.text
    if req.language == "fr":
        try:
            from litellm import acompletion
            # settings.LLM_REASONING/LLM_DEFAULT already resolve to this project's real
            # configured tiers (e.g. anthropic/claude-sonnet-4-6) even when the matching
            # env var isn't literally set — os.getenv() against the raw env would miss
            # that code-level default and silently fall through to an unconfigured
            # "gpt-4o-mini" (no OPENAI_API_KEY here), making translation a silent no-op.
            model = settings.LLM_REASONING or settings.LLM_DEFAULT
            resp = await acompletion(
                model=model,
                messages=[
                    {"role": "system", "content": "You are a professional translator. Translate the given text to French. Only return the translated text without any quotes or explanations."},
                    {"role": "user", "content": text_to_speak}
                ],
                max_tokens=1024,
                temperature=0.3
            )
            if resp.choices and resp.choices[0].message.content:
                text_to_speak = resp.choices[0].message.content.strip()
        except Exception as e:
            log.warning("On-the-fly translation to French failed, proceeding with original text: %s", e)

    try:
        audio = await generate_speech(text_to_speak, language=req.language,
                                      voice_gender=req.voice_gender, provider=req.provider,
                                      voice_id=req.voice_id)
    except RuntimeError as e:  # edge-tts not installed
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        log.exception("tts failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

    is_wav = (req.provider or "").strip().lower() == "kokoro" and audio[:4] == b"RIFF"
    media_type = "audio/wav" if is_wav else "audio/mpeg"
    return Response(
        content=audio,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="speech.{"wav" if is_wav else "mp3"}"'}
    )


@app.get("/tts/voices")
async def tts_voices_endpoint() -> Dict[str, Any]:
    """Every ElevenLabs voice on this account — the 2 stock voices /tts
    falls back to, plus any you've cloned via POST /tts/voices/clone."""
    try:
        voices = await tts_service.list_elevenlabs_voices()
    except RuntimeError as e:
        return {"voices": [], "error": str(e)}
    return {"voices": voices}


@app.post("/tts/voices/clone")
async def tts_voices_clone_endpoint(
    name: str = Form(...),
    files: list[UploadFile] = File(...),
    description: str = Form(""),
) -> Dict[str, Any]:
    """Real ElevenLabs Instant Voice Cloning — upload one or more real audio
    samples of a voice, get back a voice_id usable via /tts's
    {"provider": "elevenlabs", "voice_id": "..."}. This is the actual
    ElevenLabs differentiator (not just picking between 2 stock voices)."""
    samples = [await f.read() for f in files]
    try:
        result = await tts_service.clone_elevenlabs_voice(name, samples, description)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@app.delete("/tts/voices/{voice_id}")
async def tts_voices_delete_endpoint(voice_id: str) -> Dict[str, Any]:
    try:
        await tts_service.delete_elevenlabs_voice(voice_id)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except httpx.HTTPStatusError as e:
        # delete_elevenlabs_voice's resp.raise_for_status() previously escaped
        # uncaught here — a nonexistent/invalid voice_id (or any other
        # ElevenLabs API error) surfaced as a bare 500 "Internal Server Error"
        # instead of a real status/message. Confirmed live 2026-09-02.
        detail = e.response.text[:300] if e.response is not None else str(e)
        status = e.response.status_code if e.response is not None else 502
        raise HTTPException(status_code=status if 400 <= status < 500 else 502, detail=detail)
    return {"ok": True, "voice_id": voice_id}


@app.post("/analyze")
async def analyze_endpoint(req: AnalyzeRequest, request: Request) -> Dict[str, Any]:
    _session_stats(request)[f"analyze:{req.analysis_type}"] += 1
    return await analyzer.analyze(req.text, analysis_type=req.analysis_type)


class CustomAnalyzeRequest(BaseModel):
    text: str
    fields: list[str]
    instructions: str = ""


@app.post("/analyze/custom")
async def analyze_custom_endpoint(req: CustomAnalyzeRequest, request: Request) -> Dict[str, Any]:
    """Extract a caller-defined schema from a transcript (v1 custom extraction schemas)."""
    if not req.fields:
        raise HTTPException(status_code=400, detail="fields required")
    _session_stats(request)["analyze:custom"] += 1
    return await analyzer.analyze_custom(req.text, req.fields, req.instructions)


class RelayRequest(BaseModel):
    url: str
    payload: Dict[str, Any]
    target: Optional[str] = None  # "slack" | "zapier" | "n8n" | "generic" — auto-detected from url if omitted
    secret: Optional[str] = None  # if set, HMAC-SHA256-signs the body — see services/relay_formatting.py
    signature_header: Optional[str] = None  # header name for the signature; default "X-Signature-256"


@app.post("/integrations/relay")
async def integrations_relay(req: RelayRequest, request: Request) -> Dict[str, Any]:
    """Post structured output to any webhook (Slack/Zapier/n8n/custom, or any receiver
    that expects an HMAC-signed body). This is the real integration surface — the
    browser can't POST cross-origin, so the server relays it.

    n8n and Zapier catch-hooks accept arbitrary JSON, so their payload goes
    through unchanged. Slack incoming webhooks don't — they need
    {"text": ...} or Block Kit, so that payload is reformatted into a
    readable Slack message first (see services/relay_formatting.py).

    If `secret` is given, the exact JSON body sent is HMAC-SHA256-signed and
    the signature is attached under `signature_header` (default
    `X-Signature-256`, value `sha256=<hex>`) — a generic capability for any
    receiver that verifies requests this way, not tied to one specific
    downstream service."""
    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="invalid_url")
    if not is_safe_public_url(req.url):
        # Blocks loopback/private/link-local/reserved/multicast destinations —
        # this server fetches whatever URL the caller supplies on their behalf,
        # which makes an unrestricted destination a server-side-request-forgery
        # vector (internal network probing, cloud metadata endpoints, etc.).
        raise HTTPException(status_code=400, detail="url_not_allowed: destination resolves to a non-public address")
    target = relay_formatting.resolve_target(req.url, req.target)
    body = relay_formatting.format_for_target(target, req.payload)
    body_bytes = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if req.secret:
        header_name = (req.signature_header or "X-Signature-256").strip() or "X-Signature-256"
        headers[header_name] = relay_formatting.sign_body(body_bytes, req.secret)
    import httpx
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(req.url, content=body_bytes, headers=headers)
        _session_stats(request)["relay"] += 1
        return {"ok": resp.status_code < 400, "status": resp.status_code,
                "response": (resp.text or "")[:500], "target": target,
                "signed": bool(req.secret)}
    except Exception as e:
        detail = str(e) or type(e).__name__
        raise HTTPException(status_code=502, detail=f"relay_failed: {detail}")


@app.get("/analytics")
async def analytics(request: Request):
    """This visitor's own usage counters — never anyone else's, never a
    deployment-wide total. Scoped by X-VoiceFlow-Session (a random ID the
    frontend generates once per browser and persists in localStorage; no
    account, no PII). A caller without that header gets the shared
    "anonymous" bucket, same as any other session would.

    Reset on restart when no database is configured; durable across
    restarts when POSTGRES_URL is set (core/db.py) — either way, reads
    here always come from the fast in-memory copy, never a live DB query.

    /analytics is also the frontend's page route for the Analytics page, so a
    plain browser navigation here (refresh, bookmark, typed URL) — as opposed
    to the SPA's own fetch() call to this same path — should get the app, not
    raw JSON. Sec-Fetch-Mode distinguishes the two: browsers send "navigate"
    for top-level loads and "cors"/"same-origin" for fetch()/XHR.
    """
    if request.headers.get("sec-fetch-mode") == "navigate":
        spa = _os.path.join(_os.path.dirname(__file__), "frontend", "dist", "index.html")
        if _os.path.exists(spa):
            return FileResponse(spa)

    stats = _session_stats(request)
    total_analyses = sum(v for k, v in stats.items() if k.startswith("analyze:"))
    return {
        "counters": dict(stats),
        "total_analyses": total_analyses,
        "stream_sessions": stats.get("stream_sessions", 0),
        "relays": stats.get("relay", 0),
        "by_mode": {k.split(":", 1)[1]: v for k, v in stats.items() if k.startswith("analyze:")},
    }


@app.post("/pipeline")
async def pipeline_endpoint(
    request: Request,
    file: UploadFile = File(...),
    analysis_type: str = Form("meeting"),
    provider: str = Form("LOCAL_WHISPERX"),
    language: str = Form("auto"),
    scenario: Optional[str] = Form(None),
) -> Dict[str, Any]:
    """scenario, if given, pins an exact provider+diarize+model combination
    from services/scenarios.py — overrides `provider` and the analysis
    model, with no fallback substitution, for reproducible comparisons.
    See GET /scenarios for the catalog and eval/run_scenario_benchmark.py
    for the comparison harness this feeds."""
    audio = await file.read()

    spec = scenarios.resolve(scenario) if scenario else None
    if scenario and not spec:
        raise HTTPException(status_code=400, detail=f"unknown_scenario: {scenario}")

    if spec:
        trans = await route_transcribe(audio, provider=spec["transcription_provider"],
                                       language=language, diarize=spec["diarize"], strict=True)
        model = scenarios.resolve_analysis_model(settings, spec)
        analysis = await analyzer.analyze(trans.get("text", ""), analysis_type=analysis_type, model=model)
    else:
        trans = await route_transcribe(audio, provider=provider, language=language)
        analysis = await analyzer.analyze(trans.get("text", ""), analysis_type=analysis_type)

    stats = _session_stats(request)
    stats["pipeline"] += 1
    if scenario:
        stats[f"scenario:{scenario}"] += 1
    return {"transcript": trans, "analysis": analysis, "analysis_type": analysis_type,
            "scenario": scenario}


@app.get("/scenarios")
async def list_scenarios() -> Dict[str, Any]:
    """Named, explicit provider/model combinations selectable via
    POST /pipeline's `scenario` field — see services/scenarios.py."""
    return scenarios.list_scenarios()


_BENCHMARK_DOCS = {
    "wer": ("ASR Word Error Rate", "WER_BENCHMARK.md"),
    "multi_provider": ("Multi-Provider ASR Latency", "MULTI_PROVIDER_BENCHMARK.md"),
    "realtime": ("Realtime WebSocket", "REALTIME_BENCHMARK.md"),
    "scenario": ("Scenario Comparison", "SCENARIO_BENCHMARK.md"),
}


@app.get("/benchmarks")
async def benchmarks_endpoint() -> Dict[str, Any]:
    """Every eval/*.md benchmark report, read fresh off disk on each request —
    so the Benchmark page always reflects whatever the eval scripts most
    recently measured, never a hardcoded snapshot that can drift out of date."""
    eval_dir = _os.path.join(_os.path.dirname(__file__), "eval")
    docs = {}
    for key, (title, filename) in _BENCHMARK_DOCS.items():
        path = _os.path.join(eval_dir, filename)
        try:
            with open(path, "r") as f:
                content = f.read()
        except FileNotFoundError:
            content = None
        docs[key] = {"title": title, "filename": filename, "content": content}
    return {"docs": docs}


@app.post("/meeting/process")
async def meeting_process(request: Request, file: UploadFile = File(...)) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio)
    analysis = await analyzer.analyze_meeting(trans.get("text", ""))
    _session_stats(request)["meeting"] += 1
    return {"transcript": trans, "meeting_notes": analysis}


@app.post("/call/analyze")
async def call_analyze(request: Request, file: UploadFile = File(...), call_type: str = Form("sales_call")) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio)
    analysis = await analyzer.analyze(trans.get("text", ""), analysis_type=call_type)
    _session_stats(request)["call"] += 1
    return {"transcript": trans, "call_analysis": analysis, "call_type": call_type}


def _ws_reject_reason(ws: WebSocket) -> Optional[str]:
    """Checked before ws.accept() on every WS connection. WebSocket traffic
    never passes through @app.middleware("http") (ASGI "websocket" scope
    bypasses it entirely) — verify_internal_token's checks silently do not
    apply here, so /realtime and /stream need their own gate, not a
    borrowed one. Returns a rejection reason, or None if the connection may
    proceed. A rejection here means the socket is closed cleanly and never
    accepted — no half-open connection, no upstream (Gemini/OpenAI/Groq)
    call is ever made for a rejected attempt."""
    ip = client_ip(ws.headers, ws.client.host if ws.client else "")
    if not _ws_connect_limiter.allow(ip):
        return "rate_limited"
    if _os.environ.get("REQUIRE_INTERNAL_TOKEN", "false").lower() == "true":
        # Browsers can't set custom headers on a WS handshake, so the token
        # travels as a query param here — same convention already used for
        # ?session= on this same endpoint.
        token = ws.query_params.get("token", "")
        expected = _os.environ.get("VOICEFLOW_INTERNAL_TOKEN", "")
        if not hmac.compare_digest(token, expected):
            return "unauthorized"
    return None


@app.websocket("/stream")
async def ws_stream(ws: WebSocket):
    """Real incremental transcription. The browser sends audio chunks as binary frames;
    the socket accumulates them and re-transcribes the growing buffer via the provider
    router, emitting partial transcripts. On {"type":"stop"} it returns the final text.
    Works with any configured STT provider (Groq Whisper on the live deployment).

    Session scoping: browsers can't set custom headers on a WebSocket
    handshake, so the session ID travels as a ?session= query param instead
    of X-VoiceFlow-Session here."""
    reason = _ws_reject_reason(ws)
    if reason:
        await ws.close(code=4429 if reason == "rate_limited" else 4403, reason=reason)
        return
    await ws.accept()
    session_stats = _stats[ws.query_params.get("session", "anonymous").strip() or "anonymous"]
    buf = bytearray()
    provider = None
    seq = 0
    try:
        await ws.send_json({"type": "ready", "provider": settings.TRANSCRIPTION_PROVIDER,
                            "message": "Send audio chunks (binary); {\"type\":\"stop\"} to finalize."})
        import asyncio
        from datetime import datetime, timezone
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=30.0)
            except asyncio.TimeoutError:
                try:
                    await ws.send_json({"type": "ping", "timestamp": datetime.now(timezone.utc).isoformat()})
                except Exception:
                    break
                continue
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            text = msg.get("text")
            if data:
                buf.extend(data)
                seq += 1
                # Re-transcribe the accumulated buffer periodically (partial result).
                if seq % 3 == 0 and len(buf) > 8000:
                    try:
                        out = await route_transcribe(bytes(buf), provider=provider)
                        await ws.send_json({"type": "partial", "text": out.get("text", ""),
                                            "seq": seq, "bytes": len(buf)})
                    except Exception as e:
                        await ws.send_json({"type": "warn", "message": f"partial failed: {e}"})
            elif text:
                try:
                    cmd = json.loads(text)
                except json.JSONDecodeError:
                    cmd = {"type": text}
                if cmd.get("type") == "config":
                    provider = cmd.get("provider") or provider
                    await ws.send_json({"type": "ack", "provider": provider or settings.TRANSCRIPTION_PROVIDER})
                elif cmd.get("type") == "stop":
                    final = await route_transcribe(bytes(buf), provider=provider) if buf else {"text": ""}
                    await ws.send_json({"type": "final", "text": final.get("text", ""),
                                        "bytes": len(buf), "language": final.get("language")})
                    session_stats["stream_sessions"] += 1
                    buf = bytearray()
                    seq = 0
    except WebSocketDisconnect:
        log.info("stream client disconnected")
    except Exception as e:
        log.warning("stream error: %s", e)


@app.get("/realtime/config")
async def realtime_config() -> Dict[str, Any]:
    provider = getattr(settings, "REALTIME_PROVIDER", "openai").lower()
    return {
        "provider": provider,
        "auth_required": _os.environ.get("REQUIRE_INTERNAL_TOKEN", "false").lower() == "true",
        "gemini_ws_path": "/realtime/gemini",
        "openai_webrtc_session_path": "/realtime/session/openai",
        "openai_webrtc_available": bool(settings.OPENAI_REALTIME_API_KEY),
        "gemini_available": bool(settings.GEMINI_API_KEY),
        "tools_cached": len(agent_tools_bridge.cached_tools_snapshot()),
    }


@app.post("/realtime/session/openai")
async def openai_webrtc_session(request: Request):
    """Create an OpenAI Realtime WebRTC session from browser SDP.

    This keeps the standard OpenAI key server-side. The browser sends its SDP
    offer here and receives OpenAI's SDP answer. Tool declarations are attached
    from the warm cache; tool execution remains on this server through the
    generic agent-tools bridge.
    """
    if _os.environ.get("REQUIRE_INTERNAL_TOKEN", "false").lower() == "true":
        token = (
            request.headers.get("X-VoiceFlow-Internal-Token")
            or request.query_params.get("token", "")
        )
        expected = _os.environ.get("VOICEFLOW_INTERNAL_TOKEN", "")
        if not hmac.compare_digest(token, expected):
            raise HTTPException(status_code=403, detail="Missing or invalid X-VoiceFlow-Internal-Token")

    openai_realtime_key = settings.OPENAI_REALTIME_API_KEY
    if not openai_realtime_key:
        raise HTTPException(status_code=503, detail="OPENAI_REALTIME_API_KEY not configured for OpenAI Realtime WebRTC")

    sdp = (await request.body()).decode("utf-8", "ignore")
    if not sdp.strip():
        raise HTTPException(status_code=400, detail="SDP offer required")

    session_config = {
        "type": "realtime",
        "model": settings.OPENAI_REALTIME_MODEL,
        "instructions": (
            "You are VoiceFlow's realtime voice agent. Keep spoken answers brief. "
            "Answer directly from what you already know whenever that's enough — "
            "only use a tool when the user is asking for their own current data, "
            "metrics, or business performance that you cannot know without looking "
            "it up. Never call a tool for small talk or a general question, never "
            "call the same tool twice for the same question, and never tell the "
            "user you are calling a tool, connecting to an agent, or checking a "
            "system — a brief natural preamble like 'Checking that now' is fine "
            "right before you use one; otherwise just speak the answer."
        ),
        "audio": {
            "input": {
                "turn_detection": {"type": "semantic_vad"},
            },
            "output": {"voice": settings.OPENAI_REALTIME_VOICE},
        },
        "tools": agent_tools_bridge.openai_tools_from_snapshot(),
        "tool_choice": "auto",
        "reasoning": {"effort": "low"},
    }

    import httpx
    files = {
        "sdp": (None, sdp, "application/sdp"),
        "session": (None, json.dumps(session_config), "application/json"),
    }
    headers = {"Authorization": f"Bearer {openai_realtime_key}"}
    session_id = request.headers.get("X-VoiceFlow-Session")
    if session_id:
        headers["OpenAI-Safety-Identifier"] = session_id

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post("https://api.openai.com/v1/realtime/calls", files=files, headers=headers)
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
    return Response(content=resp.text, media_type="application/sdp")


class RealtimeToolCallRequest(BaseModel):
    name: str
    arguments: Dict[str, Any] = {}


@app.post("/realtime/tool-call")
async def realtime_tool_call(req: RealtimeToolCallRequest, request: Request) -> Dict[str, Any]:
    if _os.environ.get("REQUIRE_INTERNAL_TOKEN", "false").lower() == "true":
        token = request.headers.get("X-VoiceFlow-Internal-Token") or request.query_params.get("token", "")
        expected = _os.environ.get("VOICEFLOW_INTERNAL_TOKEN", "")
        if not hmac.compare_digest(token, expected):
            raise HTTPException(status_code=403, detail="Missing or invalid X-VoiceFlow-Internal-Token")
    return await agent_tools_bridge.call_tool(req.name, req.arguments)


@app.websocket("/realtime/gemini")
@app.websocket("/realtime")
async def ws_realtime(ws: WebSocket):
    """OpenAI Realtime API & Gemini Multimodal Live bridge (voice agent).

    Provider selection (env-driven):
      - REALTIME_PROVIDER ('openai' or 'gemini', default: 'openai').
      - REALTIME_API_KEY (API key for selected provider).

    Audio specs:
      - OpenAI: 24kHz PCM 16-bit input/output (no resampling needed).
      - Gemini: 16kHz PCM 16-bit input, 24kHz output (server downsamples input).

    External tools: if AGENT_TOOLS_URL is set, the model on either provider
    is given whatever tools that service exposes (discovered at connect time
    — see services/agent_tools_bridge.py for the contract) and can call them
    mid-conversation. Tool calls and their results are also forwarded to the
    browser as {"type": "tool_call" | "tool_result", ...} events. If the
    service is unreachable, the model gets told that instead of the call
    hanging; if AGENT_TOOLS_URL is unset, the session just runs without tools.
    """
    reason = _ws_reject_reason(ws)
    if reason:
        await ws.close(code=4429 if reason == "rate_limited" else 4403, reason=reason)
        return
    await ws.accept()
    trace = _RealtimeTrace(ws)
    await trace.mark("transport_ready")
    explicit_gemini_route = ws.url.path.endswith("/gemini")
    provider = "gemini" if explicit_gemini_route else getattr(settings, "REALTIME_PROVIDER", "openai").lower()
    api_key = settings.GEMINI_API_KEY if explicit_gemini_route else getattr(settings, "REALTIME_API_KEY", "")

    if not api_key:
        await ws.send_json({"type": "error", "message": "REALTIME_API_KEY not configured."})
        await ws.close()
        return

    if provider == "gemini":
        gemini_key = api_key
        # ── GEMINI PATH — official google-genai SDK (v1beta, gemini-3.1-flash-live-preview) ──
        try:
            from google import genai as _genai
            from google.genai import types as _gtypes
        except ImportError:
            await ws.send_json({"type": "error", "message": "google-genai package not installed. Run: pip install google-genai"})
            await ws.close()
            return

        # gemini-3.1-flash-live-preview (the prior default) has a real, reproducible
        # bug with function calling specifically: every tool-calling turn was aborted
        # server-side (close code 1008/1011, "operation was aborted"/"internal error")
        # right around send_tool_response(), while plain conversational turns with no
        # tool call always completed cleanly — isolated via direct live A/B testing,
        # not inferred. gemini-2.5-flash-native-audio-preview-09-2025 (which, unlike
        # the 3.1 model, lists full bidiGenerateContent + countTokens support in the
        # API's own model listing) does not reproduce this: 7 of 8 live tool-calling
        # turns completed cleanly in direct testing against production, versus 0 of
        # several dozen on the prior model.
        GEMINI_LIVE_MODEL = _os.getenv("GEMINI_LIVE_MODEL", "models/gemini-2.5-flash-native-audio-preview-09-2025")

        _client = _genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=gemini_key,
        )
        try:
            _external_tools = agent_tools_bridge.gemini_tool_declarations_from_snapshot()
            if not _external_tools and settings.AGENT_TOOLS_URL:
                asyncio.create_task(agent_tools_bridge.prewarm())
        except Exception as e:
            log.warning("agent-tools declarations unavailable for Gemini Live: %s", e)
            _external_tools = []
        await trace.mark("tools_ready", count=len(_external_tools))

        # Browsers can't set custom headers on a WS handshake, so a resumption
        # handle from a *previous* connection on this same logical session
        # travels as a query param (same convention as ?session=/?token=
        # elsewhere on this endpoint). Passing handle=None below just means
        # "start a new session" — the normal case for a first connect.
        _resume_handle = ws.query_params.get("resume") or None

        # Live testing against production found the model reliably asking an
        # unnecessary clarifying question (inventing a required `domain` param
        # with made-up enum values) for open-ended questions like "check my
        # metrics" — even for get_executive_summary, whose real schema (see
        # AgentKit's TOOL_META) takes NO parameters at all. The tool call
        # itself works fine once the model is told to just make it (verified
        # live: get_executive_summary returned real data). With no
        # system_instruction at all, the model was left to guess at tool
        # shapes from sibling tools in the list instead of reading each tool's
        # actual schema — this is the fix, not a workaround in the frontend.
        _system_instruction = (
            "You are VoiceFlow's voice agent. Answer directly from what you already "
            "know whenever that's enough. Only call a tool when the user is asking "
            "for their own current data, metrics, KPIs, revenue, or business "
            "performance — something you cannot know without looking it up. Do NOT "
            "call a tool for a greeting, small talk, a question about how you are "
            "doing, a general knowledge question, or anything you can already answer "
            "conversationally. When you are unsure whether a tool applies, prefer "
            "answering conversationally over guessing and calling one anyway.\n\n"
            "Call at most one tool per distinct piece of information you need. Never "
            "call the same tool again for the same question in the same turn — if a "
            "call fails or returns nothing useful, say so plainly instead of retrying "
            "it or trying a different tool as a guess.\n\n"
            "The tools are internal plumbing, not something to narrate. Never tell "
            "the user you are 'calling a tool', 'connecting to an agent', 'checking a "
            "system', or name any tool, API, or backend service. A brief, natural "
            "preamble like 'Checking that now' is fine right before you call one; "
            "otherwise just speak the answer as if you already knew it.\n\n"
            "When a tool's own declared parameters truly require information you "
            "don't have, ask the user for it — never assume a tool needs a parameter "
            "(or an enum of allowed values) that isn't in its actual declared schema, "
            "even if a *different* tool in the list happens to take that parameter. "
            "If a parameter is optional and the user hasn't specified a value, omit "
            "it or use the most sensible default (e.g. 'all' for an optional domain) "
            "instead of stopping to ask.\n\n"
            "You are speaking out loud, not writing text. Every number you say must be "
            "pronounced the way a person would say it in conversation: read a decimal "
            "point as 'point' (e.g. 37.96 is 'thirty-seven point nine-six', never "
            "'thirty-seven ninety-six' or two separate numbers), and read percentages "
            "and currency amounts as whole phrases (e.g. '2.14 percent' is 'two point "
            "one-four percent', '$37.96 million' is 'thirty-seven point nine-six "
            "million dollars'). Never speak a raw number's digits one group at a time "
            "as if they were two unrelated figures."
        )

        _config = _gtypes.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=_system_instruction,
            **({"tools": _external_tools} if _external_tools else {}),
            speech_config=_gtypes.SpeechConfig(
                voice_config=_gtypes.VoiceConfig(
                    prebuilt_voice_config=_gtypes.PrebuiltVoiceConfig(voice_name="Zephyr")
                )
            ),
            context_window_compression=_gtypes.ContextWindowCompressionConfig(
                trigger_tokens=104857,
                sliding_window=_gtypes.SlidingWindow(target_tokens=52428),
            ),
            # response_modalities=["AUDIO"] means the model never produces a text part —
            # response.text stays empty even though audio plays fine, since it's a
            # convenience view over modelTurn's text parts. The agent's spoken reply never
            # showed up as an on-screen transcript because of exactly this: audio played,
            # nothing populated response.text. output_audio_transcription is the opt-in that
            # actually populates server_content.output_transcription below.
            output_audio_transcription=_gtypes.AudioTranscriptionConfig(),
            # Symmetric opt-in for the USER's side of the call — without this,
            # only the model's own spoken output ever gets transcribed
            # (server_content.output_transcription); the human half of the
            # conversation was never transcribed at all, let alone shown
            # on-screen. Populates server_content.input_transcription below.
            input_audio_transcription=_gtypes.AudioTranscriptionConfig(),
            # Opt in to receiving LiveServerSessionResumptionUpdate messages so a
            # dropped connection (network blip, the session-duration-limit close
            # real production logs show: "The session duration limit was reached
            # ... you may reconnect and resume this session using your
            # resumption...") can actually resume the underlying Gemini session
            # instead of just reconnecting to a brand-new one that has lost all
            # conversational context server-side.
            session_resumption=_gtypes.SessionResumptionConfig(handle=_resume_handle),
        )

        try:
            async with _client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=_config) as session:
                await trace.mark("provider_ready", provider="gemini", model=GEMINI_LIVE_MODEL)
                await ws.send_json({"type": "provider_ready", "provider": "gemini", "message": f"Connected to Gemini Multimodal Live ({GEMINI_LIVE_MODEL})"})

                is_tool_active = [False]
                cancel_flag = [False]
                # Set alongside cancel_flag[0]=True (by _client_to_gemini, on user
                # barge-in) and consumed by _gemini_to_client below. Cancelling a
                # turn used to just `continue`-skip every remaining response chunk
                # for it, INCLUDING the eventual turn_complete check that sends
                # {"type":"response.done"} — so the frontend's open turn/bubble for
                # that cancelled reply was never closed. The next real turn's
                # deltas then appended onto that dangling, half-received bubble
                # instead of starting fresh, which is what produced garbled,
                # multi-turn-merged transcript text in production (old partial
                # replies / tool-call scaffolding glued onto the front of the next
                # actual answer — reproduced live 2026-08-20 with "bonjour" /
                # "comment ça va tu"). Only _gemini_to_client sends to the browser
                # ws elsewhere in this handler; routing the notification through it
                # (rather than sending directly from _client_to_gemini) avoids a
                # second, concurrent writer on the same browser websocket.
                pending_cancel_notice = [False]
                # True from a successful commit (audio_stream_end sent) until this
                # turn's turn_complete arrives. The frontend now gates its own
                # commits on an equivalent "response pending" flag so it should
                # never send a second commit before this clears — but a client is
                # untrusted input, and live testing (feeding a continuously-looping
                # audio source) reproduced exactly this: repeated commits before
                # turn_complete, which corrupted the Gemini session into a close
                # code 1011 "Internal error" and silently dropped every reply. If a
                # commit still arrives while a turn is active, treat it the same as
                # a client barge-in (cancel the stale turn first) instead of sending
                # a second audio_stream_end into an unfinished one.
                turn_active = [False]
                # _client_to_gemini() and _gemini_to_client() run concurrently via
                # asyncio.gather() below, and BOTH write to the same upstream `session`
                # (send_realtime_input / send_client_content from the client side,
                # send_tool_response from the tool-call side) — i.e. both can call
                # session's underlying `self._ws.send(...)` at the same time. The
                # `websockets` library does not guarantee that concurrent, unlocked
                # sends from separate coroutines stay on the wire as distinct frames;
                # a genuinely interleaved write is indistinguishable from a malformed
                # message to the remote end. That lines up with what live testing
                # against production actually shows: every tool-call turn eventually
                # gets a close code 1008 ("Policy Violation") with reason "The
                # operation was aborted" from Gemini's server, right around when
                # send_tool_response() fires. This lock serializes all writes to the
                # session so no two coroutines can be mid-`send` on it at once.
                session_send_lock = asyncio.Lock()

                async def _client_to_gemini():
                    """Forward browser audio/text frames to Gemini session."""
                    try:
                        while True:
                            msg = await ws.receive()
                            msg_text = msg.get("text")
                            msg_bytes = msg.get("bytes")
                            try:
                                if msg_bytes:
                                    await trace.first("first_input_audio")
                                    async with session_send_lock:
                                        await session.send_realtime_input(
                                            audio=_gtypes.Blob(data=msg_bytes, mime_type="audio/pcm;rate=16000")
                                        )
                                    continue

                                if not msg_text:
                                    continue
                                data = json.loads(msg_text)
                                evt = data.get("type", "")

                                if evt == "input_audio_buffer.append":
                                    b64 = data.get("audio")
                                    if b64:
                                        import audioop
                                        import base64
                                        pcm_24k = base64.b64decode(b64)
                                        sample_rate = int(data.get("sample_rate") or 24000)
                                        pcm_16k = pcm_24k if sample_rate == 16000 else audioop.ratecv(pcm_24k, 2, 1, sample_rate, 16000, None)[0]
                                        # session.send(input=...) is deprecated (removal "not before
                                        # Q3 2025" per the SDK itself) and routes audio through the
                                        # legacy realtime_input.media_chunks field, which the Live API
                                        # now silently drops — the session stays open and connected but
                                        # no audio ever reaches the model. send_realtime_input(audio=...)
                                        # is the current, supported path for streamed audio chunks.
                                        async with session_send_lock:
                                            await session.send_realtime_input(
                                                audio=_gtypes.Blob(data=pcm_16k, mime_type="audio/pcm;rate=16000")
                                            )
                                        await trace.first("first_input_audio", mode="json_base64")

                                elif evt == "input_audio_buffer.commit":
                                    # Sending audio_stream_end while a previous turn is still
                                    # active is fine and expected for a genuine barge-in —
                                    # Gemini's own server-side VAD treats fresh audio input as
                                    # an interrupt of whatever it was generating and reports it
                                    # back via server_content.interrupted (handled below, in
                                    # _gemini_to_client), which is what actually closes out the
                                    # stale turn. An earlier version of this handler tried to
                                    # pre-empt that by dropping a commit whenever turn_active
                                    # was still True, but turn_active only clears once
                                    # _gemini_to_client has *processed* the interruption
                                    # asynchronously — a legitimate barge-in commit sent right
                                    # after client.speech_started routinely arrived before that
                                    # happened, so the drop silently ate real turns and left the
                                    # session hanging until it died with a 1011 Internal error
                                    # (confirmed live, 2026-09-01). Always forward the commit;
                                    # turn_active is tracked only as telemetry now.
                                    async with session_send_lock:
                                        await session.send_realtime_input(audio_stream_end=True)
                                    cancel_flag[0] = False
                                    turn_active[0] = True
                                    await trace.first("first_commit")

                                elif evt == "conversation.item.create":
                                    item = data.get("item", {})
                                    text = "".join(
                                        c.get("text", "") for c in item.get("content", [])
                                        if c.get("type") == "input_text"
                                    )
                                    if text:
                                        async with session_send_lock:
                                            await session.send_client_content(
                                                turns=_gtypes.Content(role="user", parts=[_gtypes.Part(text=text)]),
                                                turn_complete=True,
                                            )
                                        await trace.first("first_commit", mode="text")

                                elif evt == "client.speech_started":
                                    cancel_flag[0] = True
                                    pending_cancel_notice[0] = True

                            except Exception:
                                log.exception("Gemini client_to_gemini error")
                    except Exception:
                        pass

                async def _gemini_to_client():
                    """Receive Gemini responses and forward to browser."""
                    try:
                        while True:
                            turn = session.receive()
                            async for response in turn:
                                # Gemini's own server-side VAD can interrupt generation
                                # independently of our client-driven cancel_flag (e.g. it
                                # notices the user talking again before the browser's local
                                # VAD/`client.speech_started` message even arrives here) —
                                # server_content.interrupted is the authoritative signal for
                                # that. Treat it the same as a client-initiated cancel so a
                                # server-only interruption still closes the frontend's open
                                # turn instead of leaving it dangling.
                                if response.server_content and getattr(response.server_content, "interrupted", False):
                                    cancel_flag[0] = True
                                    pending_cancel_notice[0] = True
                                if cancel_flag[0]:
                                    if pending_cancel_notice[0]:
                                        pending_cancel_notice[0] = False
                                        is_tool_active[0] = False
                                        turn_active[0] = False
                                        await ws.send_json({"type": "response.done", "cancelled": True})
                                    continue

                                if response.data:
                                    import base64
                                    await trace.first("first_output_audio")
                                    await ws.send_json({
                                        "type": "response.audio.delta",
                                        "delta": base64.b64encode(response.data).decode()
                                    })

                                if response.text:
                                    await ws.send_json({
                                        "type": "response.audio_transcript.delta",
                                        "delta": response.text
                                    })

                                out_t = getattr(response.server_content, "output_transcription", None) if response.server_content else None
                                if out_t and out_t.text:
                                    await ws.send_json({
                                        "type": "response.audio_transcript.delta",
                                        "delta": out_t.text
                                    })

                                # The USER's own speech, transcribed by Gemini itself (see
                                # input_audio_transcription in the config above) — a distinct
                                # event type so the frontend can render it on the opposite side
                                # of the conversation from the agent's own transcript above.
                                # `finished` marks the end of this user turn (Transcription.finished)
                                # so the frontend knows when to stop appending to the same bubble
                                # and start a new one for the next thing the user says.
                                in_t = getattr(response.server_content, "input_transcription", None) if response.server_content else None
                                if in_t and in_t.text:
                                    await ws.send_json({
                                        "type": "response.user_transcript.delta",
                                        "delta": in_t.text,
                                        "finished": bool(getattr(in_t, "finished", False)),
                                    })

                                resumption = getattr(response, "session_resumption_update", None)
                                if resumption and resumption.resumable and resumption.new_handle:
                                    # Stashed by the browser and replayed as ?resume=<handle> on its
                                    # next connection attempt (see _resume_handle above) — lets a
                                    # reconnect actually resume this Gemini session server-side
                                    # instead of starting a context-free new one.
                                    await ws.send_json({
                                        "type": "session.resumption_handle",
                                        "handle": resumption.new_handle,
                                    })

                                go_away = getattr(response, "go_away", None)
                                if go_away:
                                    # Gemini telling us this session will be force-closed shortly
                                    # (session duration limit, etc.) — let the frontend show a
                                    # "reconnecting soon" state proactively instead of the close
                                    # arriving with no warning.
                                    await ws.send_json({
                                        "type": "session.go_away",
                                        "time_left": getattr(go_away, "time_left", None),
                                    })

                                if response.tool_call:
                                    is_tool_active[0] = True
                                    for fc in (getattr(response.tool_call, "function_calls", None) or []):
                                        fc_args = dict(fc.args or {})
                                        await trace.mark("tool_start", name=fc.name)
                                        await ws.send_json({"type": "tool_call", "name": fc.name, "arguments": fc_args})
                                        result = await agent_tools_bridge.call_tool(fc.name, fc_args)
                                        await trace.mark("tool_end", name=fc.name, ok="error" not in result)
                                        await ws.send_json({"type": "tool_result", "name": fc.name, "result": result})
                                        try:
                                            async with session_send_lock:
                                                await session.send_tool_response(
                                                    function_responses=[
                                                        _gtypes.FunctionResponse(id=fc.id, name=fc.name, response=result)
                                                    ]
                                                )
                                        except Exception as e:
                                            log.warning("Gemini send_tool_response failed: %s", e)
                                    is_tool_active[0] = False

                                if response.server_content and getattr(response.server_content, "turn_complete", False):
                                    is_tool_active[0] = False
                                    cancel_flag[0] = False
                                    turn_active[0] = False
                                    await ws.send_json({"type": "response.done"})
                    except Exception as e:
                        # This used to be a bare `except: pass` — any exception here (a
                        # malformed response, an SDK-internal error mid-stream, anything)
                        # silently killed this relay task without ever sending
                        # response.done. asyncio.gather() below doesn't surface it either,
                        # since the task returns normally instead of raising, so the outer
                        # handler's own except-block never saw it. The client was left
                        # waiting on a turn that would never complete, with no error and no
                        # sign anything had gone wrong server-side — indistinguishable from
                        # a hang until its own transport-level keepalive eventually gave up.
                        log.warning("Gemini _gemini_to_client relay died mid-turn: %s", e)
                        try:
                            await ws.send_json({"type": "error", "message": f"Gemini relay error: {e}"})
                        except Exception:
                            pass

                await asyncio.gather(_client_to_gemini(), _gemini_to_client())

        except WebSocketDisconnect:
            log.info("realtime gemini client disconnected")
        except Exception as e:
            log.warning("realtime gemini error: %s", e)
            try:
                await ws.send_json({"type": "error", "message": f"Gemini Live relay failed: {e}"})
            except Exception:
                pass
        return

    elif provider == "openai":
        openai_key = api_key
        # ── OPENAI PATH — raw WebSocket relay ──────────────────────────────────────────────
        import inspect
        import websockets

        model = getattr(settings, "OPENAI_REALTIME_MODEL", None) or "gpt-4o-realtime-preview"
        url = f"wss://api.openai.com/v1/realtime?model={model}"
        headers = [("Authorization", f"Bearer {openai_key}"), ("OpenAI-Beta", "realtime=v1")]
        model_name = f"OpenAI Realtime ({model})"

        hkw = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
        try:
            async with websockets.connect(url, max_size=None, **{hkw: headers}) as upstream:
                await upstream.send(json.dumps({
                    "type": "session.update",
                    "session": {
                        "tools": await agent_tools_bridge.openai_tools(),
                        "tool_choice": "auto",
                    },
                }))
                await trace.mark("provider_ready", provider="openai", model=model)
                await ws.send_json({"type": "provider_ready", "provider": "openai", "message": f"Connected to {model_name}"})

                async def client_to_upstream():
                    try:
                        while True:
                            msg_text = await ws.receive_text()
                            try:
                                data = json.loads(msg_text)
                                if data.get("type") == "client.speech_started":
                                    await upstream.send(json.dumps({"type": "response.cancel"}))
                                    continue
                            except Exception:
                                pass
                            await upstream.send(msg_text)
                            await trace.first("first_input_audio")
                    except Exception:
                        pass

                async def upstream_to_client():
                    try:
                        async for msg in upstream:
                            msg_text = msg if isinstance(msg, str) else msg.decode("utf-8", "ignore")
                            await ws.send_text(msg_text)

                            try:
                                data = json.loads(msg_text)
                            except Exception:
                                continue

                            if data.get("type") == "response.function_call_arguments.done":
                                call_id = data.get("call_id")
                                name = data.get("name")
                                try:
                                    fc_args = json.loads(data.get("arguments") or "{}")
                                except Exception:
                                    fc_args = {}

                                await ws.send_json({"type": "tool_call", "name": name, "arguments": fc_args})
                                await trace.mark("tool_start", name=name)
                                result = await agent_tools_bridge.call_tool(name, fc_args)
                                await trace.mark("tool_end", name=name, ok="error" not in result)
                                await ws.send_json({"type": "tool_result", "name": name, "result": result})

                                await upstream.send(json.dumps({
                                    "type": "conversation.item.create",
                                    "item": {
                                        "type": "function_call_output",
                                        "call_id": call_id,
                                        "output": json.dumps(result),
                                    },
                                }))
                                await upstream.send(json.dumps({"type": "response.create"}))
                    except Exception:
                        pass

                await asyncio.gather(client_to_upstream(), upstream_to_client())
        except WebSocketDisconnect:
            log.info("realtime openai client disconnected")
        except Exception as e:
            log.warning("realtime openai relay error: %s", e)
            try:
                await ws.send_json({"type": "error", "message": f"OpenAI Realtime relay failed: {e}"})
            except Exception:
                pass
    else:
        await ws.send_json({"type": "error", "message": f"Unsupported REALTIME_PROVIDER: {provider}"})
        await ws.close()
        return


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    """Catch-all so direct navigation, refresh, or a bookmarked/shared link to
    any frontend route (e.g. /agent, /history, /analyze) serves the SPA
    instead of a raw 404 (or, for paths that collide with a POST-only API
    route like /analyze, a 405) — React Router then resolves the route
    client-side. Declared last so every real API/WS route above still wins.

    Real static files in frontend/dist/ (favicon, logo, sw.js, ...) are
    served directly rather than falling back to index.html for them.
    """
    root = _os.path.dirname(__file__)
    dist = _os.path.realpath(_os.path.join(root, "frontend", "dist"))
    candidate = _os.path.realpath(_os.path.join(dist, full_path))
    if candidate.startswith(dist + _os.sep) and _os.path.isfile(candidate):
        return FileResponse(candidate)
    spa = _os.path.join(dist, "index.html")
    if _os.path.exists(spa):
        return FileResponse(spa)
    raise HTTPException(status_code=404, detail="Not Found")
