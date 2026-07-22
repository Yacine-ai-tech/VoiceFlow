# VoiceFlow

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)


[![CI](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Yacine-ai-tech/VoiceFlow/actions/workflows/ci.yml) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**Speech → structured intelligence. Complete web dashboard. 4 providers, 5 analysis types, real-time voice agent.**
> 🔗 **Live web dashboard (record in your browser):** https://voiceflow.ysiddo-ai-projects.app/
> On-demand backend (first request ~30–60 s to wake).
> Self-hosting: see [SELF_HOSTING.md](SELF_HOSTING.md).

## What It Does

- **Transcription router**: local WhisperX (default), Groq Whisper, Deepgram, AssemblyAI
- **5 analysis types** with per-type LLM routing:
  - `meeting` → Groq Llama 3.3
  - `sales_call` → Claude Sonnet 4.6
  - `support_call` → Claude Haiku 4.5
  - `interview` → Claude Sonnet 4.6
  - `general` → Groq Llama 3.3
- **Diarization fallback chain**: pyannote 3.x → NeMo → no-diarization
- **TTS**: `POST /tts` with configurable voice and provider
- **Full web dashboard** at `/`
- **OpenAI Realtime API bridge** at `WS /realtime` (primary: OpenAI; fallback: Gemini Multimodal Live when only `GEMINI_API_KEY` is set)
- **38 tests** across smoke, API, analyzer, voice, e2e, and realtime

## Quick Start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # add GROQ_API_KEY at minimum
uvicorn api:app --port 8002
```

Open http://localhost:8002/

## Architecture

```
            ┌──────────┐
            │  Audio   │
            └────┬─────┘
                 ▼
   ┌─────────────────────────┐
   │  TranscriptionRouter    │ ← provider (local | groq | deepgram | assemblyai)
   └────┬────────────────────┘
        ▼
   ┌─────────────────────────┐
   │   MeetingAnalyzer       │ ← analysis_type (meeting | sales_call | …)
   │   (multi-LLM via tier)  │
   └────┬────────────────────┘
        ▼
        Structured JSON
```

## Use Cases

| Analysis        | Model           | Output                                       |
|-----------------|-----------------|----------------------------------------------|
| Meeting notes   | Groq Llama 3.3  | action_items, decisions, next_steps          |
| Sales call CRM  | Claude Sonnet   | pain_points, objections, deal_stage          |
| Support QA      | Claude Haiku    | severity, escalation, follow_ups             |
| Interview       | Claude Sonnet   | strengths, gaps, recommendation              |

## Tests

38 test functions across smoke, API, analyzer, voice, e2e, WebSocket, and realtime:

```bash
pytest tests/ -q
```

## License

AGPL-3.0

## ⚖️ License & Enterprise Use (Dual-License)

This project is open-source under the **AGPL-3.0 License**. It is completely free for researchers, students, and open-source hobbyists.

> **Commercial Use:** The AGPLv3 license requires that any proprietary network service (SaaS, internal corporate tools) that uses or modifies this code must also open-source its entire backend. 
> 
> If you wish to use this framework in a closed-source commercial environment, or require **Enterprise features** (SSO, Active Directory, Custom VPC Deployment, Strict RBAC), you must obtain a **Commercial License**. 
> Please reach out to discuss commercial licensing and integration consulting.

## 📡 Anonymous Telemetry
This project collects anonymous, GDPR-compliant startup pings to help the author understand usage volume and prioritize development. 
* **What is collected:** A startup event timestamp and anonymized deployment origin. No API keys, no user prompts, and no sensitive application data is ever collected.
* **How to disable:** We respect your privacy and development environment. To opt-out, simply set `TELEMETRY_OPT_OUT=true` in your `.env` file.


<!-- Project Analytics -->
<img src="https://gateway.ysiddo-ai-projects.app/pixel/VoiceFlow" width="1" height="1" style="display:none;" alt="">

## Licensing
This project is licensed under the [AGPL-3.0 License](LICENSE).

**Commercial Use:** If you wish to use this software commercially without releasing your own source code, please see [COMMERCIAL.md](COMMERCIAL.md) to obtain a commercial license.

**Telemetry:** See [TELEMETRY.md](TELEMETRY.md) for our privacy-first data practices.
