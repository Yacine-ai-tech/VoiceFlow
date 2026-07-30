#!/usr/bin/env python3
"""
Test VoiceFlow deployed service with real audio transcription
Tests the speech-to-text endpoint
"""
import httpx
import io
import wave
import struct
import random

# Deployed service URL
VOICEFLOW_URL = "https://voiceflow.ysiddo-ai-projects.app"

def create_test_audio():
    """Create a simple test WAV file with some audio data"""
    # Create a simple WAV file with some audio data
    sample_rate = 16000
    duration = 2  # seconds
    num_samples = sample_rate * duration
    
    # Generate some random audio data (simulating speech)
    audio_data = []
    for i in range(num_samples):
        # Generate a simple sine wave at 440 Hz (A4)
        value = int(32767 * 0.1 * (i % 100) / 100)  # Very simple pattern
        audio_data.append(value)
    
    # Create WAV file in memory
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav_file:
        wav_file.setnchannels(1)  # Mono
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(struct.pack('<' + 'h' * len(audio_data), *audio_data))
    
    buffer.seek(0)
    return buffer.read()

def test_transcription():
    """Test audio transcription endpoint"""
    print("Testing VoiceFlow Transcription...")
    
    try:
        with httpx.Client(timeout=30.0) as client:
            audio_content = create_test_audio()
            
            files = {
                'file': ('test.wav', audio_content, 'audio/wav')
            }
            data = {
                'provider': 'LOCAL_WHISPERX',
                'language': 'auto',
                'diarize': 'false'
            }
            
            response = client.post(f"{VOICEFLOW_URL}/transcribe", files=files, data=data)
            print(f"Status: {response.status_code}")
            print(f"Response: {response.text[:500]}")
            
            if response.status_code == 200:
                result = response.json()
                print(f"✅ Transcription Success: {result.get('text', 'no text')}")
                return True
            else:
                print(f"❌ Transcription Failed: {response.status_code}")
                return False
                
    except Exception as e:
        print(f"❌ Transcription Error: {e}")
        return False

def test_health():
    """Test health endpoint"""
    print("Testing VoiceFlow Health...")
    
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(f"{VOICEFLOW_URL}/health")
            print(f"Status: {response.status_code}")
            print(f"Response: {response.text}")
            
            if response.status_code == 200:
                result = response.json()
                print(f"✅ Health Check Success: {result.get('service', 'unknown')}")
                return True
            else:
                print(f"❌ Health Check Failed: {response.status_code}")
                return False
                
    except Exception as e:
        print(f"❌ Health Check Error: {e}")
        return False

if __name__ == "__main__":
    print("=" * 60)
    print("VoiceFlow Testing Against Deployed Service")
    print("=" * 60)
    
    results = {
        "Health Check": test_health(),
        "Audio Transcription": test_transcription()
    }
    
    print("\n" + "=" * 60)
    print("Test Results Summary:")
    print("=" * 60)
    for test_name, result in results.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{test_name}: {status}")
    
    print("=" * 60)