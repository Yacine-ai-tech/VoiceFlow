# VoiceFlow — Speech-to-Intelligence Pipeline

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![CI](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml)

VoiceFlow is a research-grade, production-ready speech-to-intelligence framework. It provides a robust, multi-provider pipeline for audio transcription, speaker diarization, synthesized speech, and LLM-driven structured extraction.

> 🔗 **Live demo (record in your browser):** https://voiceflow.ysiddo-ai-projects.app/demo  
> *Note: On-demand backend. The first request may take ~30–60 seconds to wake from a cold start.*

## System Architecture

VoiceFlow executes a deterministic pipeline mapping unstructured audio to domain-specific JSON structures. The architecture abstracts provider-specific implementations, allowing seamless degradation from frontier models to local on-premise execution.

```text
            ┌──────────┐
            │  Audio   │
            └────┬─────┘
                 ▼
   ┌─────────────────────────┐
   │  TranscriptionRouter    │ ← Provider: Local WhisperX (default), TRANSCRIPTION_ENDPOINT
   │  (+ Diarization Layer)  │ ← Fallback Chain: PyAnnote 3.x → NeMo → No-Diarization
   └────┬────────────────────┘
        ▼
   ┌─────────────────────────┐
   │   MeetingAnalyzer       │ ← Analysis Types: meeting, sales_call, support_call, interview
   │   (Multi-LLM Router)    │
   └────┬────────────────────┘
        ▼
   Structured JSON Payload
```

## Core Capabilities

- **Abstracted Transcription Routing**: Dynamically routes requests between local `WhisperX` (forced alignment and batching), and a standard `TRANSCRIPTION_ENDPOINT` based on availability and latency constraints.
- **Robust Diarization Fallback**: Implements an enterprise-grade speaker diarization pipeline cascading from HuggingFace PyAnnote to NVIDIA NeMo, degrading gracefully to raw transcription if hardware constraints emerge.
- **Text-to-Speech (TTS) Synthesis**: Supports synchronous and asynchronous TTS via `edge-tts` (Microsoft Edge neural voices) and premium high-fidelity generation via ElevenLabs.
- **Real-Time Voice Agent Bridge**: Implements a bidirectional WebSocket relay for the OpenAI Realtime API (`/realtime`), natively supporting Gemini Multimodal Live translation layers.
- **Persona-Routed Structured Extraction**: Routes transcript analysis to the optimal LLM tier (Claude Sonnet 4.6, Claude Haiku 4.5, or Llama 3.3) based on the cognitive complexity of the defined task.

## Extraction Schemas

| Analysis Type   | Target LLM Tier         | Output Schema |
|-----------------|-------------------------|---------------|
| Meeting Notes   | Configured LLM          | `action_items`, `decisions`, `next_steps` |
| Sales Call CRM  | Configured LLM          | `pain_points`, `objections`, `deal_stage` |
| Support QA      | Configured LLM          | `severity`, `escalation`, `follow_ups` |
| Interview       | Configured LLM          | `strengths`, `gaps`, `recommendation` |

## Benchmarks & Evaluation

We maintain rigorous standard ASR evaluations on the **LibriSpeech test-clean** (Panayotov et al., 2015) dataset. For complete methodology and reproduction steps, refer to [eval/WER_BENCHMARK.md](eval/WER_BENCHMARK.md).

| Model Config          | Hardware    | N (Samples)| WER (%) | CER (%) |
|-----------------------|-------------|------------|---------|---------|
| faster-whisper `base` | CPU         | 20         | 2.9     | 0.9     |
| faster-whisper `large-v3` | T4 GPU  | 150        | 2.2     | 0.8     |

*Achieved WER of 2.2% approaches the published large-v3 state-of-the-art of ~1.8% on the full test-clean split.*

## Quick Start (Development)

```bash
# 1. Prepare environment
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Configure variables (Add GROQ_API_KEY, ELEVENLABS_API_KEY, etc.)
cp .env.example .env

# 3. Initialize server
uvicorn api:app --port 8002
```
Access the interactive evaluation interface at `http://localhost:8002/demo`.
For deployment strategies, see [SELF_HOSTING.md](SELF_HOSTING.md).

## Dual-Licensing & Enterprise

This framework is open-source under the **AGPL-3.0 License**, ensuring it remains free for academic research and non-commercial hobbyist deployments. 

> **Commercial Usage:** The AGPLv3 license mandates that any proprietary network service modifying or integrating this code must open-source its entire backend. 
> To deploy VoiceFlow in a closed-source commercial environment, or to access **Enterprise configurations** (Custom VPC, Strict RBAC, SSO), a **Commercial License** is required. 

## Anonymous Telemetry
This repository utilizes lightweight, GDPR-compliant telemetry to measure baseline framework utilization.
* **Scope:** Captures isolated project initiation events. Zero PII, network payloads, or operational secrets are transmitted.
* **Opt-Out:** We rigidly respect operational privacy. Append `TELEMETRY_OPT_OUT=true` to your `.env` configuration to silently disable all telemetry.
