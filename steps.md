# VoiceFlow — STEPS LOG (living document)

> Continuous engineering log of **every** action on VoiceFlow from Week 0 to now. Append newest at
> the bottom. Absolute dates. Branch model: feature branch → PR → merge into `develop`. Secrets
> live only in `.env`/`secrets.md` (gitignored) — never here.

## Project in one line
Speech-to-intelligence: WhisperX/faster-whisper local transcription (+ forced alignment &
diarization), premium STT providers (Deepgram, AssemblyAI), multi-LLM meeting analysis, TTS.
Port 8002.

## Week 0 — scaffold & split (2026-05-20 → 06-05)
- `41d1466` initial scaffold from the OmniIntelOS split. Services present:
  `whisperx_service.py`, `transcription_router.py`, `tts_service.py`, `voice_service.py`,
  `meeting_analyzer.py`; `api.py`.
- `bd06111` CI pytest; `e3e12f6` heavy ML deps (whisperx) → `requirements-ml.txt`
  (`faster-whisper` in core); `9bdbe18` finalize Week 0; `e75864f` `docker-compose.dev.yml`.
- Status: **scaffold** — services wired, 1 smoke test, Phase 4 feature work pending.

## New-account Studio provisioning + .env hardening (2026-06-16)
- Cloned onto `upwork_new` Studio; `.env` recreated with real secrets (Anthropic, Groq),
  `TRANSCRIPTION_PROVIDER=LOCAL_WHISPERX`, `WHISPER_MODEL=base`, `WHISPER_DEVICE=cpu`, optional
  HF_TOKEN/Deepgram/AssemblyAI left blank; synced local ↔ Studio.

## GPU validation (T4, 2026-06-16)
- **Local STT validated on the T4** with `faster-whisper` (the engine behind WhisperX):
  installed `faster-whisper`, transcribed the JFK sample on **CUDA float16** →
  `[whisper cuda] 1.7s lang=en`, text: *"And so, my fellow Americans, ask not what your country
  can do for you, ask what you can do for your country."* — exact. Confirms the local
  transcription path works GPU-accelerated. Switched Studio back to CPU after (billing).

## Current state
Scaffold + validated local transcription engine. Phase 4 feature build (diarization fallback
chain, premium providers, meeting-analysis LLM layer, realtime demo, TTS upgrades) is the next
major work per EXECUTION_PLAN.

---

## Next — industry & research-standard improvements (planned)
1. **WER benchmark**: evaluate transcription on LibriSpeech test-clean (report WER) + a noisy
   set; pick model size per accuracy/latency.
2. **Diarization DER**: implement the pyannote → NeMo → skip fallback chain and report Diarization
   Error Rate on AMI/VoxConverse samples (needs HF_TOKEN for pyannote).
3. **Forced alignment** (WhisperX) for word-level timestamps; validate on the sample set.
4. **Meeting-analysis eval**: action-item / decision extraction scored against a labeled set
   (route via RAGeval).
5. **Realtime demo** (streaming STT) + TTS provider A/B (Kokoro / ElevenLabs / OpenAI).
