"""
Unit tests for services.transcription_adapter
"""
from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch
import pytest

from core.config import settings
from services.transcription_adapter import transcribe, _local_whisper, _remote_huggingface, _remote_openai


@pytest.mark.asyncio
async def test_transcribe_local_mode():
    with patch.object(settings, "TRANSCRIPTION_MODE", "local"):
        with patch("services.transcription_adapter._local_whisper") as mock_local:
            mock_local.return_value = {
                "text": "Hello local",
                "language": "en",
                "segments": [],
                "method": "local-whisperx-base",
                "diarized": False,
            }
            res = await transcribe(b"dummy_audio", language="en")
            assert res["text"] == "Hello local"
            assert res["method"] == "local-whisperx-base"
            assert res["diarized"] is False
            mock_local.assert_called_once()


@pytest.mark.asyncio
async def test_transcribe_remote_huggingface_mode():
    with patch.object(settings, "TRANSCRIPTION_MODE", "remote"), \
         patch.object(settings, "TRANSCRIPTION_ENDPOINT", "https://api-inference.huggingface.co/models/openai/whisper-large-v3"):
        with patch("services.transcription_adapter._remote_huggingface") as mock_hf:
            mock_hf.return_value = {
                "text": "Hello HF",
                "language": "en",
                "segments": [],
                "method": "huggingface-remote",
                "diarized": False,
            }
            res = await transcribe(b"dummy_audio")
            assert res["text"] == "Hello HF"
            assert res["method"] == "huggingface-remote"
            mock_hf.assert_called_once()


@pytest.mark.asyncio
async def test_transcribe_remote_openai_mode():
    with patch.object(settings, "TRANSCRIPTION_MODE", "remote"), \
         patch.object(settings, "TRANSCRIPTION_ENDPOINT", "https://api.openai.com/v1"):
        with patch("services.transcription_adapter._remote_openai") as mock_oai:
            mock_oai.return_value = {
                "text": "Hello OpenAI",
                "language": "en",
                "segments": [],
                "method": "openai-remote-base",
                "diarized": False,
            }
            res = await transcribe(b"dummy_audio")
            assert res["text"] == "Hello OpenAI"
            assert res["method"] == "openai-remote-base"
            mock_oai.assert_called_once()


def test_remote_openai_function_signature():
    with patch("openai.OpenAI") as mock_client_cls:
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_result = MagicMock()
        mock_result.text = "Testing OpenAI"
        mock_result.language = "en"
        mock_result.segments = []
        mock_client.audio.transcriptions.create.return_value = mock_result

        with patch.object(settings, "TRANSCRIPTION_ENDPOINT", "https://custom-openai-endpoint.com/v1"), \
             patch.object(settings, "TRANSCRIPTION_TOKEN", "token123"), \
             patch.object(settings, "WHISPER_MODEL", "whisper-1"):
            res = _remote_openai(b"test_bytes", "https://custom-openai-endpoint.com/v1")
            assert res["text"] == "Testing OpenAI"
            assert res["diarized"] is False
            mock_client_cls.assert_called_once_with(
                base_url="https://custom-openai-endpoint.com/v1",
                api_key="token123"
            )
