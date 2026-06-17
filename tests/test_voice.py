"""voice_service + whisperx_service tests — import-safe (no model download at import)."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def test_voice_service_imports_without_loading_models():
    # Must not download/load a Whisper model just by importing.
    import services.voice_service as vs
    assert asyncio.iscoroutinefunction(vs.transcribe_audio)
    assert asyncio.iscoroutinefunction(vs.detect_language)


def test_whisperx_service_stub_safe():
    from services.whisperx_service import WhisperXService
    svc = WhisperXService()
    out = svc.transcribe(b"not-real-audio")
    assert isinstance(out, dict) and "method" in out  # stub or real, never raises


def test_transcription_router_providers():
    import services.transcription_router as tr
    assert asyncio.iscoroutinefunction(tr.transcribe)
