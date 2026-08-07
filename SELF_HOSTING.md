# VoiceFlow — Self-Hosting Guide

VoiceFlow is designed to be easily deployable in both standard cloud environments and air-gapped, on-premises systems. 

## 1. Deployment via Docker
The standard deployment relies on the provided `Dockerfile`. It builds a lightweight image capable of running the API server and all extraction pipelines.

```bash
docker build -t voiceflow-api .
docker run -p 8002:8002 --env-file .env voiceflow-api
```

## 2. Hardware Acceleration (GPU)
For the `LOCAL_WHISPERX` transcription provider, an NVIDIA GPU is highly recommended to achieve real-time factors (RTF) < 1.0. Set `WHISPER_DEVICE=cuda` and ensure the container has access to NVIDIA runtimes:

```bash
docker run --gpus all -p 8002:8002 --env-file .env voiceflow-api
```

## 3. External API Configurations
If you opt for cloud-based providers instead of local execution, ensure the following keys are provided in your `.env` file:
- **Groq Whisper**: `GROQ_API_KEY`
- **Deepgram**: `DEEPGRAM_API_KEY`
- **AssemblyAI**: `ASSEMBLYAI_API_KEY`
- **ElevenLabs (Premium TTS)**: `ELEVENLABS_API_KEY`
- **OpenAI / Gemini (Realtime Bridge)**: `OPENAI_API_KEY` or `GEMINI_API_KEY`
