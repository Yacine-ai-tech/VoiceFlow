# GAP_REPORT — VoiceFlow (redesign v2 — 2026-07-06)

## 1. API inventory (api.py + services/, verified)

| Route | Notes |
|---|---|
| `GET /health` | `{status, service, version}` |
| `POST /transcribe` (file, provider, language, diarize) | router: GROQ_WHISPER / DEEPGRAM / ASSEMBLYAI when keys present, else WhisperX stub carrying a clear error; returns `{text, ...provider fields}` |
| `POST /tts` `{text, language en\|fr, voice_gender, provider}` | REAL audio/mpeg stream via edge-tts (501 when lib missing) |
| `POST /analyze` `{text, analysis_type}` | LLM extraction — types: meeting, sales_call, support_call, interview, general (schemas in services/meeting_analyzer.py PROMPTS) |
| `POST /pipeline` (file, analysis_type, provider, language) | `{transcript:{text,...}, analysis:{...}, analysis_type}` |
| `POST /meeting/process` (file) | `{transcript, meeting_notes}` |
| `POST /call/analyze` (file, call_type) | `{transcript, call_analysis, call_type}` |
| `WS /stream` | **echo scaffold only** (docstring says so) — NOT streaming transcription |
| `WS /realtime` | REAL bidirectional relay to OpenAI Realtime; without OPENAI_API_KEY sends `{type:"error"}` and closes |

Analysis schemas (verified): meeting → meeting_summary, action_items[{owner,action,due,priority}],
decisions, key_numbers, open_questions, next_steps, sentiment, topics_covered.
sales_call → call_summary, prospect_*, pain_points, objections[{type,content}], buying_signals,
budget_mentioned, deal_stage, crm_notes, overall_sentiment, likelihood_to_close.

## 2. P0 mapping & honesty decisions

- Record: mic via MediaRecorder + REAL live waveform (WebAudio AnalyserNode, client-side)
  + elapsed time; on stop → real `POST /pipeline`. **No fake live transcript** — WS /stream
  is an echo scaffold, so live-STT UI is CUT until real streaming lands (moderate gap, logged).
- Analyze: paste text → `/analyze`, or upload audio → `/pipeline`; all 5 real analysis types;
  structured output as Cards / JSON / raw API tabs.
- Voice Agent: real WS `/realtime` connection with honest states — "not configured" card when
  the deployment has no OPENAI_API_KEY (current prod state), event console + text-mode
  conversation when connected. No fabricated audio demo.
- TTS: real `/tts` playground with audio player (501 handled).
- History: session-local (localStorage). Models: factual provider cards.

## 3. Approved minor extensions — none (api.py: additive SPA serving only)

## 4. Moderate gaps logged (NOT implemented here)

- Real streaming STT behind WS /stream (Deepgram WS or whisper-streaming) would enable the
  live-transcript experience the v1 prompt described.

## 5. Real-vs-Demo

| Element | Source |
|---|---|
| Record→pipeline, Analyze, TTS | real endpoints |
| Live waveform / levels | real, client-side WebAudio |
| Voice Agent | real WS relay; honest unconfigured state |
| History | real session-local |
| Models page | factual (config + router code) |
