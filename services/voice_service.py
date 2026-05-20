"""
OmniIntelOS Voice Service — Hardware-optimized STT and TTS.
Hardware: Core i7 (6th Gen) / no GPU.
Patterns: Fallback-first (Groq Cloud -> Faster-Whisper CPU).
"""
import io
import os
import time
import logging
import asyncio
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

# TTS: Edge-TTS (Free, High Quality, CPU-friendly)
import edge_tts

# STT: Faster-Whisper (CPU-optimized candidate)
try:
    from faster_whisper import WhisperModel
    _WHISPER_MODEL = "tiny" # For Core i7 6th gen, tiny/base is ideal
    stt_model = WhisperModel(_WHISPER_MODEL, device="cpu", compute_type="int8")
    HAS_LOCAL_STT = True
except ImportError:
    HAS_LOCAL_STT = False
    
# External Groq config fallback (if keys passed locally or through proxy)
import requests

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice-service")

app = FastAPI(title="OmniIntelOS Voice Service", version="1.0.0")

cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {
        "status": "healthy", 
        "service": "voice", 
        "local_stt": HAS_LOCAL_STT,
        "timestamp": time.time()
    }

# ─── TEXT TO SPEECH (TTS) ───────────────────

@app.post("/tts")
async def text_to_speech(
    text: str = Form(...), 
    voice: str = Form("en-US-AndrewNeural"), # Microsoft high-quality voices
    language: str = Form("en")
):
    """Generate high-quality speech from text using Microsoft Edge TTS."""
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    
    start_time = time.time()
    try:
        # Resolve voice based on language if not specified
        if language == "fr":
            voice = "fr-FR-HenriNeural"
            
        communicate = edge_tts.Communicate(text, voice)
        
        # Stream the output directly
        # Use an async generator to stream chunks for lowest latency
        async def stream_tts():
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    yield chunk["data"]
        
        latency = time.time() - start_time
        logger.info(f"TTS generated in {latency:.3f}s for {len(text)} chars")
        
        return StreamingResponse(stream_tts(), media_type="audio/mpeg")
    except Exception as e:
        logger.error(f"TTS mismatch: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ─── SPEECH TO TEXT (STT) ───────────────────

@app.post("/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None)
):
    """Transcribe audio to text. Pattern: Local Faster-Whisper (CPU)."""
    if not file.content_type.startswith("audio/"):
        logger.warning(f"File skip: {file.content_type} not audio")
    
    start_time = time.time()
    try:
        content = await file.read()
        
        if not HAS_LOCAL_STT:
            raise HTTPException(status_code=501, detail="Local STT model not loaded")

        # Save to temp for faster-whisper (optional, it supports binary)
        # For simplicity in CPU env, tiny model is used
        segments, info = stt_model.transcribe(io.BytesIO(content), language=language)
        
        text = " ".join([seg.text for seg in segments])
        
        latency = time.time() - start_time
        logger.info(f"STT transcribed in {latency:.3f}s ({info.language_probability*100:.1f}%)")
        
        return {
            "text": text.strip(),
            "language": info.language,
            "latency_seconds": latency,
            "method": f"faster-whisper-{_WHISPER_MODEL}"
        }
    except Exception as e:
        logger.error(f"STT mismatch: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
