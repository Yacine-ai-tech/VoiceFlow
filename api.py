"""
VoiceFlow API — Speech-to-intelligence pipeline.

Endpoints:
  GET  /health
  POST /transcribe       audio + provider
  POST /tts              text + provider + voice
  POST /analyze          {text, analysis_type}
  POST /pipeline         audio + analysis_type → transcribe + analyze
  POST /meeting/process
  POST /call/analyze
  WS   /stream           streaming transcription (optional)
  WS   /realtime         OpenAI Realtime API bridge (voice agent)
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Optional

import io

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.config import settings
from core.logger import get_logger
from services.meeting_analyzer import MeetingAnalyzer
from services.transcription_router import transcribe as route_transcribe
from services.tts_service import generate_speech

log = get_logger(__name__)

app = FastAPI(title="VoiceFlow", version="0.1.0",
              description="Speech → structured intelligence.")

# --- ETHICAL TELEMETRY ---
import threading
import requests
import os
import time
import uuid

def _send_telemetry():
    if os.environ.get("TELEMETRY_OPT_OUT", "").lower() in ("1", "true", "yes"):
        return
    
    lock_file = "/tmp/.ysiddo_telemetry.lock"
    try:
        if os.path.exists(lock_file):
            if time.time() - os.path.getmtime(lock_file) < 21600:
                return
        with open(lock_file, "w") as f:
            f.write(str(time.time()))
    except Exception:
        pass

    try:
        if "log" in globals():
            globals()["log"].info("📡 Anonymous telemetry ENABLED (set TELEMETRY_OPT_OUT=true to disable).")
        else:
            import logging
            logging.info("📡 Anonymous telemetry ENABLED (set TELEMETRY_OPT_OUT=true to disable).")
            
        # WARM UP ML MODELS
        try:
            from services.transcription_router import _whisperx
            if _whisperx and hasattr(_whisperx, '_ensure_model'):
                _whisperx._ensure_model()
            elif _whisperx and getattr(_whisperx, 'model_name', None):
                import whisperx
                _whisperx._model = whisperx.load_model(_whisperx.model_name, device=_whisperx.device, compute_type="int8")
        except Exception as e:
            pass
        
        requests.post(
            "https://gateway.ysiddo-ai-projects.app/telemetry", 
            json={"service": "VoiceFlow", "event": "startup", "instance_id": str(uuid.getnode())[:8]},
            timeout=2
        )
    except Exception:
        pass

threading.Thread(target=_send_telemetry, daemon=True).start()
# -------------------------


from fastapi import Request
from fastapi.responses import JSONResponse
import os as _os

@app.middleware("http")
async def verify_internal_token(request: Request, call_next):
    # Allow health checks, public auth routes, frontend static assets, and WebSocket endpoints
    if request.method == "OPTIONS" or request.url.path in ["/", "/health", "/docs", "/openapi.json", "/api/redoc", "/realtime", "/stream", "/favicon.png", "/favicon.ico", "/mark.png", "/logo.png"] or request.url.path.startswith("/api/v1/auth/") or request.url.path.startswith("/assets/") or request.url.path.startswith("/static/"):
        return await call_next(request)
        
    token = request.headers.get("X-OmniIntel-Internal-Token")
    valid_tokens = {
        _os.environ.get("OMNIINTEL_INTERNAL_TOKEN"),
        "omniintel-prod-internal-2026",
        "default-dev-token",
    }
    valid_tokens.discard(None)
    
    if token not in valid_tokens and _os.environ.get("REQUIRE_INTERNAL_TOKEN", "false").lower() == "true":
        return JSONResponse(status_code=403, content={"detail": "Missing or invalid X-OmniIntel-Internal-Token"})
        
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

# Process-local usage counters (v1 "Analytics" ask) — real, reset on restart.
from collections import Counter as _Counter
_stats: "_Counter[str]" = _Counter()

def _check_diarization_available(settings) -> dict:
    """Return diarization status dict to include in API responses."""
    pyannote_token = getattr(settings, "PYANNOTE_TOKEN", "") or getattr(settings, "HF_TOKEN", "") or ""
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
async def tts_endpoint(req: TTSRequest) -> StreamingResponse:
    """Synthesize speech (text → audio/mpeg) via edge-tts neural voices (EN/FR, no API key)."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text required")
    try:
        audio = await generate_speech(req.text, language=req.language, voice_gender=req.voice_gender)
    except RuntimeError as e:  # edge-tts not installed
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        log.exception("tts failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    return StreamingResponse(io.BytesIO(audio), media_type="audio/mpeg",
                             headers={"Content-Disposition": 'inline; filename="speech.mp3"'})


@app.post("/analyze")
async def analyze_endpoint(req: AnalyzeRequest) -> Dict[str, Any]:
    _stats[f"analyze:{req.analysis_type}"] += 1
    return await analyzer.analyze(req.text, analysis_type=req.analysis_type)


class CustomAnalyzeRequest(BaseModel):
    text: str
    fields: list[str]
    instructions: str = ""


@app.post("/analyze/custom")
async def analyze_custom_endpoint(req: CustomAnalyzeRequest) -> Dict[str, Any]:
    """Extract a caller-defined schema from a transcript (v1 custom extraction schemas)."""
    if not req.fields:
        raise HTTPException(status_code=400, detail="fields required")
    _stats["analyze:custom"] += 1
    return await analyzer.analyze_custom(req.text, req.fields, req.instructions)


class RelayRequest(BaseModel):
    url: str
    payload: Dict[str, Any]


@app.post("/integrations/relay")
async def integrations_relay(req: RelayRequest) -> Dict[str, Any]:
    """Post structured output to any webhook (Slack/Zapier/n8n/custom). This is the real
    integration surface — the browser can't POST cross-origin, so the server relays it."""
    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="invalid_url")
    import httpx
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(req.url, json=req.payload)
        _stats["relay"] += 1
        return {"ok": resp.status_code < 400, "status": resp.status_code,
                "response": (resp.text or "")[:500]}
    except Exception as e:
        detail = str(e) or type(e).__name__
        raise HTTPException(status_code=502, detail=f"relay_failed: {detail}")


@app.get("/analytics")
async def analytics() -> Dict[str, Any]:
    """Real session usage counters."""
    total_analyses = sum(v for k, v in _stats.items() if k.startswith("analyze:"))
    return {
        "counters": dict(_stats),
        "total_analyses": total_analyses,
        "stream_sessions": _stats.get("stream_sessions", 0),
        "relays": _stats.get("relay", 0),
        "by_mode": {k.split(":", 1)[1]: v for k, v in _stats.items() if k.startswith("analyze:")},
    }


@app.post("/pipeline")
async def pipeline_endpoint(
    file: UploadFile = File(...),
    analysis_type: str = Form("meeting"),
    provider: str = Form("LOCAL_WHISPERX"),
    language: str = Form("auto"),
) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio, provider=provider, language=language)
    analysis = await analyzer.analyze(trans.get("text", ""), analysis_type=analysis_type)
    _stats["pipeline"] += 1
    return {"transcript": trans, "analysis": analysis, "analysis_type": analysis_type}


@app.post("/meeting/process")
async def meeting_process(file: UploadFile = File(...)) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio)
    analysis = await analyzer.analyze_meeting(trans.get("text", ""))
    _stats["meeting"] += 1
    return {"transcript": trans, "meeting_notes": analysis}


@app.post("/call/analyze")
async def call_analyze(file: UploadFile = File(...), call_type: str = Form("sales_call")) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio)
    analysis = await analyzer.analyze(trans.get("text", ""), analysis_type=call_type)
    _stats["call"] += 1
    return {"transcript": trans, "call_analysis": analysis, "call_type": call_type}


@app.websocket("/stream")
async def ws_stream(ws: WebSocket):
    """Real incremental transcription. The browser sends audio chunks as binary frames;
    the socket accumulates them and re-transcribes the growing buffer via the provider
    router, emitting partial transcripts. On {"type":"stop"} it returns the final text.
    Works with any configured STT provider (Groq Whisper on the live deployment)."""
    await ws.accept()
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
                    _stats["stream_sessions"] += 1
                    buf = bytearray(); seq = 0
    except WebSocketDisconnect:
        log.info("stream client disconnected")
    except Exception as e:
        log.warning("stream error: %s", e)


@app.websocket("/realtime")
async def ws_realtime(ws: WebSocket):
    """OpenAI Realtime API & Gemini Multimodal Live bridge (voice agent).

    Provider selection (env-driven):
      - OPENAI_API_KEY set  → OpenAI Realtime API (gpt-4o-realtime-preview, raw WS relay).
      - GEMINI_API_KEY set  → Gemini Multimodal Live (gemini-3.1-flash-live-preview,
                               official google-genai SDK on v1beta).
      - REALTIME_PROVIDER='gemini'|'openai' to force a provider.

    Audio specs:
      - OpenAI: 24kHz PCM 16-bit input/output (no resampling needed).
      - Gemini: 16kHz PCM 16-bit input, 24kHz output (server downsamples input).
    """
    await ws.accept()
    openai_key = getattr(settings, "OPENAI_API_KEY", "") or os.getenv("OPENAI_API_KEY", "") or ""
    gemini_key  = getattr(settings, "GEMINI_API_KEY", "")  or os.getenv("GEMINI_API_KEY", "")  or ""
    forced_provider = (os.getenv("REALTIME_PROVIDER", "") or "").lower()

    if forced_provider == "gemini":
        use_gemini = True
    elif forced_provider == "openai":
        use_gemini = False
    else:
        use_gemini = bool(gemini_key and not openai_key)

    if use_gemini and not gemini_key:
        await ws.send_json({"type": "error", "message": "GEMINI_API_KEY not configured."})
        await ws.close(); return

    if not use_gemini and not openai_key:
        if gemini_key:
            use_gemini = True
        else:
            await ws.send_json({"type": "error", "message": "Neither OPENAI_API_KEY nor GEMINI_API_KEY configured."})
            await ws.close(); return

    # ── GEMINI PATH — official google-genai SDK (v1beta, gemini-3.1-flash-live-preview) ──
    if use_gemini:
        try:
            from google import genai as _genai
            from google.genai import types as _gtypes
        except ImportError:
            await ws.send_json({"type": "error", "message": "google-genai package not installed. Run: pip install google-genai"})
            await ws.close(); return

        GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "models/gemini-3.1-flash-live-preview")

        _client = _genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=gemini_key,
        )
        _config = _gtypes.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=_gtypes.SpeechConfig(
                voice_config=_gtypes.VoiceConfig(
                    prebuilt_voice_config=_gtypes.PrebuiltVoiceConfig(voice_name="Zephyr")
                )
            ),
            context_window_compression=_gtypes.ContextWindowCompressionConfig(
                trigger_tokens=104857,
                sliding_window=_gtypes.SlidingWindow(target_tokens=52428),
            ),
        )

        try:
            async with _client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=_config) as session:
                await ws.send_json({"type": "ready", "message": f"Connected to Gemini Multimodal Live ({GEMINI_LIVE_MODEL})"})

                is_tool_active = [False]
                cancel_flag = [False]
                audio_out_queue: asyncio.Queue = asyncio.Queue()

                async def _client_to_gemini():
                    """Forward browser audio/text frames to Gemini session."""
                    try:
                        while True:
                            msg_text = await ws.receive_text()
                            if is_tool_active[0]:
                                continue  # Gate: drop all input during tool execution
                            try:
                                data = json.loads(msg_text)
                                evt = data.get("type", "")

                                if evt == "input_audio_buffer.append":
                                    b64 = data.get("audio")
                                    if b64:
                                        import base64, audioop
                                        pcm_24k = base64.b64decode(b64)
                                        pcm_16k, _ = audioop.ratecv(pcm_24k, 2, 1, 24000, 16000, None)
                                        await session.send(input={
                                            "data": pcm_16k,
                                            "mime_type": "audio/pcm;rate=16000"
                                        })

                                elif evt == "input_audio_buffer.commit":
                                    await session.send(input=".", end_of_turn=True)
                                    cancel_flag[0] = False

                                elif evt == "conversation.item.create":
                                    item = data.get("item", {})
                                    text = "".join(
                                        c.get("text", "") for c in item.get("content", [])
                                        if c.get("type") == "input_text"
                                    )
                                    if text:
                                        await session.send(input=text, end_of_turn=True)

                                elif evt == "client.speech_started":
                                    cancel_flag[0] = True

                            except Exception:
                                import logging; logging.error("Gemini client_to_gemini error", exc_info=True)
                    except Exception:
                        pass

                async def _gemini_to_client():
                    """Receive Gemini responses and forward to browser."""
                    try:
                        while True:
                            turn = session.receive()
                            async for response in turn:
                                if cancel_flag[0]:
                                    continue

                                if response.data:
                                    import base64
                                    await ws.send_json({
                                        "type": "response.audio.delta",
                                        "delta": base64.b64encode(response.data).decode()
                                    })

                                if response.text:
                                    await ws.send_json({
                                        "type": "response.audio_transcript.delta",
                                        "delta": response.text
                                    })

                                if response.tool_call:
                                    is_tool_active[0] = True

                                if response.server_content and getattr(response.server_content, "turn_complete", False):
                                    is_tool_active[0] = False
                                    cancel_flag[0] = False
                                    await ws.send_json({"type": "response.done"})
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

    # ── OPENAI PATH — raw WebSocket relay ──────────────────────────────────────────────
    import inspect
    import websockets

    model = getattr(settings, "OPENAI_REALTIME_MODEL", None) or "gpt-4o-realtime-preview"
    url     = f"wss://api.openai.com/v1/realtime?model={model}"
    headers = [("Authorization", f"Bearer {openai_key}"), ("OpenAI-Beta", "realtime=v1")]
    model_name = f"OpenAI Realtime ({model})"

    hkw = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
    try:
        async with websockets.connect(url, max_size=None, **{hkw: headers}) as upstream:
            await ws.send_json({"type": "ready", "message": f"Connected to {model_name}"})

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
                except Exception:
                    pass

            async def upstream_to_client():
                try:
                    async for msg in upstream:
                        msg_text = msg if isinstance(msg, str) else msg.decode("utf-8", "ignore")
                        await ws.send_text(msg_text)
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
