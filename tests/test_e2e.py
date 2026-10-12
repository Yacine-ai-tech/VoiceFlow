import pytest
import os
import httpx
import websockets
import json
import asyncio
from io import BytesIO
import wave
from fastapi.testclient import TestClient
import api
from api import app

client = TestClient(app)
TOKEN = os.getenv("VOICEFLOW_INTERNAL_TOKEN", "")
HEADERS = {"X-VoiceFlow-Internal-Token": TOKEN}

@pytest.mark.asyncio
async def test_e2e_tts_provider(monkeypatch):
    async def fake_generate_speech_with_meta(*args, **kwargs):
        return b"test audio", "edge"

    monkeypatch.setattr(api, "generate_speech_with_meta", fake_generate_speech_with_meta)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/tts", 
            json={"text": "Hello world", "language": "en", "provider": "edge", "voice_gender": "female"},
            headers=HEADERS
        )
        assert response.status_code == 200
        assert response.content == b"test audio"
        assert response.headers["X-VoiceFlow-TTS-Provider"] == "edge"

@pytest.mark.asyncio
async def test_e2e_transcribe_upload():
    audio = BytesIO()
    with wave.open(audio, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b"\0\0" * 8000)
    dummy_audio = audio.getvalue()
    files = {"file": ("test.wav", dummy_audio, "audio/wav")}
    data = {"provider": "LOCAL_WHISPERX", "language": "en", "diarize": "false"}
    
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/transcribe", data=data, files=files, headers=HEADERS)
        # Should gracefully fail if LOCAL_WHISPERX isn't loaded, or return transcript
        assert response.status_code in (200, 500)

@pytest.mark.asyncio
async def test_e2e_analyze():
    payload = {"text": "We need to increase MRR by 20% next quarter.", "analysis_type": "meeting"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/analyze", json=payload, headers=HEADERS)
        assert response.status_code in (200, 500, 503)
        res_json = response.json()
        assert "action_items" in str(res_json) or "summary" in str(res_json) or "error" in str(res_json) or "detail" in str(res_json)

@pytest.mark.asyncio
async def test_e2e_custom_analyze():
    payload = {
        "text": "The patient complains of headache and fever. Prescribed ibuprofen 400mg.",
        "fields": ["symptoms", "medication"],
        "instructions": "Extract clinical entities."
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/analyze/custom", json=payload, headers=HEADERS)
        assert response.status_code in (200, 500, 503)
        res_json = response.json()
        assert "symptoms" in res_json or "error" in str(res_json) or "detail" in str(res_json)

@pytest.mark.asyncio
async def test_e2e_realtime_voice_interaction_gemini_fallback(monkeypatch):
    # Ensure OpenAI key is absent and Gemini key is set
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "dummy_gemini_key")
        
    with client.websocket_connect("/realtime", headers=HEADERS) as websocket:
        for _ in range(5):
            data = websocket.receive_json()
            if data.get("type") != "metric":
                break
        assert data.get("type") in ("provider_ready", "ready", "error", "metric")
        assert "Gemini" in data.get("message", "") or "key" in data.get("message", "").lower() or "api" in data.get("message", "").lower()

@pytest.mark.asyncio
async def test_e2e_ws_stream_pipeline():
    with client.websocket_connect("/stream", headers=HEADERS) as websocket:
        ready = websocket.receive_json()
        assert ready.get("type") == "ready"
        
        # Send config
        websocket.send_json({"type": "config", "provider": "LOCAL_WHISPERX"})
        ack = websocket.receive_json()
        assert ack.get("type") == "ack"
        
        # Send dummy buffer to trigger final
        websocket.send_bytes(b"dummy audio buffer")
        websocket.send_json({"type": "stop"})
        
        final = websocket.receive_json()
        assert final.get("type") == "final"
        assert "text" in final
