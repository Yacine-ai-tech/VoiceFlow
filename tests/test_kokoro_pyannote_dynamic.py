"""
Unit tests for dynamic Kokoro TTS and Pyannote diarization resolution.
"""
import os
from unittest.mock import MagicMock, patch
import pytest

from core.config import settings
from services import tts_service, whisperx_service, transcription_adapter


def test_hf_token_and_pyannote_token_resolution():
    with patch.dict(os.environ, {"PYANNOTE_TOKEN": "test_pyannote_token", "HF_TOKEN": ""}):
        assert settings.PYANNOTE_TOKEN == "test_pyannote_token"
        assert settings.HF_TOKEN == "test_pyannote_token"

    with patch.dict(os.environ, {"PYANNOTE_TOKEN": "", "HF_TOKEN": "test_hf_token"}):
        assert settings.PYANNOTE_TOKEN == "test_hf_token"
        assert settings.HF_TOKEN == "test_hf_token"


def test_dynamic_models_configuration():
    with patch.dict(
        os.environ,
        {
            "PYANNOTE_MODEL": "custom/diarization-v4",
            "DEEPGRAM_MODEL": "nova-3-medical",
            "GROQ_WHISPER_MODEL": "whisper-large-v3",
            "KOKORO_MODEL_PATH": "/models/kokoro.onnx",
        },
    ):
        assert settings.PYANNOTE_MODEL == "custom/diarization-v4"
        assert settings.DEEPGRAM_MODEL == "nova-3-medical"
        assert settings.GROQ_WHISPER_MODEL == "whisper-large-v3"
        assert settings.KOKORO_MODEL_PATH == "/models/kokoro.onnx"


@pytest.mark.asyncio
async def test_kokoro_voice_id_forwarding():
    with patch("services.tts_service._generate_kokoro_sync") as mock_sync:
        mock_sync.return_value = b"RIFFtestwavcontent"
        audio = await tts_service._generate_kokoro("Hello world", "en", "female", voice_id="af_bella")
        assert audio == b"RIFFtestwavcontent"
        mock_sync.assert_called_once()
        args, kwargs = mock_sync.call_args
        assert args[0] == "Hello world"
        assert args[1] == "female"
        assert args[2] == "af_bella"


def test_faster_whisper_path_invokes_diarization():
    service = whisperx_service.WhisperXService()
    mock_model = MagicMock()
    # Mock segments returned by faster-whisper
    seg = MagicMock()
    seg.start = 0.0
    seg.end = 2.0
    seg.text = "Testing faster whisper."
    info = MagicMock()
    info.language = "en"
    mock_model.transcribe.return_value = ([seg], info)
    service._model = mock_model

    with patch("services.whisperx_service._WHISPERX", False), \
         patch("services.whisperx_service._FASTER_WHISPER", True), \
         patch("services.whisperx_service._run_diarization") as mock_diarize:
        mock_diarize.return_value = [{"start": 0.0, "end": 2.0, "speaker": "Speaker 1"}]

        res = service.transcribe(b"fakeaudiobytes", language="en", diarize=True)
        assert res["diarized"] is True
        assert res["segments"][0]["speaker"] == "Speaker 1"
        mock_diarize.assert_called_once()
