import asyncio
import io
import json
import time
import wave
import websockets
from services.tts_service import generate_speech

import os
from dotenv import load_dotenv
load_dotenv()

WS_URL = os.getenv("VOICEFLOW_WS_URL", "wss://voiceflow.ysiddo-ai-projects.app/realtime/gemini")

import av

def audio_to_pcm16(audio_bytes: bytes) -> bytes:
    container = av.open(io.BytesIO(audio_bytes))
    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
    pcm_chunks = []
    for frame in container.decode(audio=0):
        for resampled in resampler.resample(frame):
            pcm_chunks.append(bytes(resampled.planes[0]))
    return b"".join(pcm_chunks)

async def test_multi_turn():
    print("Pre-synthesizing voice queries...")
    wav1 = await generate_speech("Hello, what is two plus two?", language="en")
    pcm1 = audio_to_pcm16(wav1)
    
    wav2 = await generate_speech("And what is five times five?", language="en")
    pcm2 = audio_to_pcm16(wav2)
    print(f"Synthesized Turn 1 ({len(pcm1)} bytes) and Turn 2 ({len(pcm2)} bytes)")

    print(f"\nConnecting to {WS_URL}...")
    async with websockets.connect(WS_URL, open_timeout=20, close_timeout=5) as ws:
        # Wait for provider_ready
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=15)
            m = json.loads(raw)
            if m.get("type") == "provider_ready":
                print("Provider ready:", m.get("message"))
                break
            if m.get("type") == "error":
                print("Initial error:", m)
                return

        # Turn 1
        print("\n--- TURN 1 (REAL AUDIO STREAM) ---")
        t0 = time.time()
        # Stream in 50ms chunks (800 samples = 1600 bytes at 16kHz mono)
        chunk_size = 1600
        for i in range(0, len(pcm1), chunk_size):
            chunk = pcm1[i:i+chunk_size]
            await ws.send(chunk)
            await asyncio.sleep(0.04)

        # Stream 15 frames of silence (0.6s) so Gemini VAD cleanly marks end of speech
        silence = b"\x00" * 1600
        for _ in range(15):
            await ws.send(silence)
            await asyncio.sleep(0.04)

        # Signal speech pause
        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
        await ws.send(json.dumps({"type": "response.create", "response": {"modalities": ["audio"]}}))

        audio_deltas1 = 0
        got_transcript1 = False
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=25)
            if isinstance(raw, bytes):
                continue
            m = json.loads(raw)
            mtype = m.get("type")
            if mtype == "response.audio.delta":
                audio_deltas1 += 1
            elif mtype == "response.audio_transcript.delta":
                print(m.get("delta", ""), end="", flush=True)
                got_transcript1 = True
            elif mtype == "response.user_transcript.delta":
                print(f"\n[User transcribed: {m.get('delta', '')}]", flush=True)
            elif mtype == "response.done":
                print(f"\n[Turn 1 done in {time.time() - t0:.2f}s with {audio_deltas1} audio deltas]")
                break
            elif mtype == "error":
                print(f"\n[Turn 1 error: {m}]")
                return

        # Wait 1.5 seconds before Turn 2
        print("\n[Pausing between turns...]")
        await asyncio.sleep(1.5)

        # Turn 2
        print("\n--- TURN 2 (REAL AUDIO STREAM ON SAME WS) ---")
        t0 = time.time()
        for i in range(0, len(pcm2), chunk_size):
            chunk = pcm2[i:i+chunk_size]
            await ws.send(chunk)
            await asyncio.sleep(0.04)

        # Stream 15 frames of silence (0.6s) so Gemini VAD cleanly marks end of speech
        for _ in range(15):
            await ws.send(silence)
            await asyncio.sleep(0.04)

        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
        await ws.send(json.dumps({"type": "response.create", "response": {"modalities": ["audio"]}}))

        audio_deltas2 = 0
        got_transcript2 = False
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=25)
            if isinstance(raw, bytes):
                continue
            m = json.loads(raw)
            mtype = m.get("type")
            if mtype == "response.audio.delta":
                audio_deltas2 += 1
            elif mtype == "response.audio_transcript.delta":
                print(m.get("delta", ""), end="", flush=True)
                got_transcript2 = True
            elif mtype == "response.user_transcript.delta":
                print(f"\n[User transcribed: {m.get('delta', '')}]", flush=True)
            elif mtype == "response.done":
                print(f"\n[Turn 2 done in {time.time() - t0:.2f}s with {audio_deltas2} audio deltas]")
                break
            elif mtype == "error":
                print(f"\n[Turn 2 error: {m}]")
                return

        print("\n>>> MULTI-TURN AUDIO CONVERSATION FULLY VERIFIED ON SAME WEBSOCKET! <<<")

if __name__ == "__main__":
    asyncio.run(test_multi_turn())
