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

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.config import settings
from core.logger import get_logger
from services.meeting_analyzer import MeetingAnalyzer
from services.transcription_router import transcribe as route_transcribe

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
    voice: str = "en-US-AriaNeural"
    provider: str = "edge"


# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "voiceflow", "version": "0.1.0"}


@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    provider: str = Form("LOCAL_WHISPERX"),
    diarize: bool = Form(False),
) -> Dict[str, Any]:
    audio = await file.read()
    return await route_transcribe(audio, provider=provider, diarize=diarize)


@app.post("/tts")
async def tts_endpoint(req: TTSRequest) -> Dict[str, Any]:
    """Synthesize speech (text → audio).

    For brevity, returns a stub. To wire properly, use edge-tts:
        from edge_tts import Communicate
        Communicate(req.text, req.voice).save(path)
    """
    return {
        "voice": req.voice,
        "provider": req.provider,
        "text_length": len(req.text),
        "note": "TTS audio synthesis stub — wire edge-tts/ElevenLabs at deploy time",
    }


@app.post("/analyze")
async def analyze_endpoint(req: AnalyzeRequest) -> Dict[str, Any]:
    return await analyzer.analyze(req.text, analysis_type=req.analysis_type)


@app.post("/pipeline")
async def pipeline_endpoint(
    file: UploadFile = File(...),
    analysis_type: str = Form("meeting"),
    provider: str = Form("LOCAL_WHISPERX"),
) -> Dict[str, Any]:
    audio = await file.read()
    trans = await route_transcribe(audio, provider=provider)
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
    """OpenAI Realtime API bridge scaffold. Production: relay to api.openai.com/v1/realtime."""
    await ws.accept()
    try:
        await ws.send_json({
            "type": "ready",
            "message": "VoiceFlow realtime bridge — wire to OpenAI Realtime API at deploy time",
        })
        while True:
            msg = await ws.receive_text()
            await ws.send_json({"type": "echo", "data": msg})
    except WebSocketDisconnect:
        log.info("realtime client disconnected")
