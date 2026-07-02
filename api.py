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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOWED_ORIGINS or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    app.mount("/demo", StaticFiles(directory="demo", html=True), name="demo")
except RuntimeError:
    log.warning("demo/ directory not found")

analyzer = MeetingAnalyzer()


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
    path = os.path.join(os.path.dirname(__file__), "demo", "index.html")
    if os.path.exists(path):
        return FileResponse(path)
    return {"service": "voiceflow", "docs": "/docs"}


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "voiceflow", "version": "0.1.0"}


@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    provider: str = Form("LOCAL_WHISPERX"),
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
    return await analyzer.analyze(req.text, analysis_type=req.analysis_type)


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
    return {"transcript": trans, "analysis": analysis, "analysis_type": analysis_type}


@app.post("/meeting/process")
async def meeting_process(file: UploadFile = File(...)) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio)
    analysis = await analyzer.analyze_meeting(trans.get("text", ""))
    return {"transcript": trans, "meeting_notes": analysis}


@app.post("/call/analyze")
async def call_analyze(file: UploadFile = File(...), call_type: str = Form("sales_call")) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio)
    analysis = await analyzer.analyze(trans.get("text", ""), analysis_type=call_type)
    return {"transcript": trans, "call_analysis": analysis, "call_type": call_type}


@app.websocket("/stream")
async def ws_stream(ws: WebSocket):
    """Streaming transcription scaffold. Production: integrate Whisper streaming or Deepgram WS."""
    await ws.accept()
    try:
        await ws.send_json({"type": "ready", "message": "VoiceFlow streaming socket"})
        while True:
            msg = await ws.receive_text()
            await ws.send_json({"type": "echo", "data": msg})
    except WebSocketDisconnect:
        log.info("stream client disconnected")


@app.websocket("/realtime")
async def ws_realtime(ws: WebSocket):
    """OpenAI Realtime API bridge (voice agent) — relays the browser session bidirectionally
    to wss://api.openai.com/v1/realtime. Needs OPENAI_API_KEY; degrades to an informative
    message when the key is absent so the socket never dead-ends on an echo."""
    await ws.accept()
    key = getattr(settings, "OPENAI_API_KEY", "") or ""
    if not key:
        await ws.send_json({"type": "error",
                            "message": "OPENAI_API_KEY not configured — set it to enable the realtime voice agent."})
        await ws.close()
        return
    import inspect
    import websockets
    model = getattr(settings, "OPENAI_REALTIME_MODEL", None) or "gpt-4o-realtime-preview"
    url = f"wss://api.openai.com/v1/realtime?model={model}"
    headers = [("Authorization", f"Bearer {key}"), ("OpenAI-Beta", "realtime=v1")]
    # websockets renamed extra_headers -> additional_headers around v13; support both.
    hkw = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
    try:
        async with websockets.connect(url, max_size=None, **{hkw: headers}) as upstream:
            await ws.send_json({"type": "ready", "message": f"Connected to OpenAI Realtime ({model})"})

            async def client_to_openai():
                try:
                    while True:
                        await upstream.send(await ws.receive_text())
                except Exception:
                    pass

            async def openai_to_client():
                try:
                    async for msg in upstream:
                        await ws.send_text(msg if isinstance(msg, str) else msg.decode("utf-8", "ignore"))
                except Exception:
                    pass

            await asyncio.gather(client_to_openai(), openai_to_client())
    except WebSocketDisconnect:
        log.info("realtime client disconnected")
    except Exception as e:
        log.warning("realtime relay error: %s", e)
        try:
            await ws.send_json({"type": "error", "message": f"Realtime relay failed: {e}"})
        except Exception:
            pass
