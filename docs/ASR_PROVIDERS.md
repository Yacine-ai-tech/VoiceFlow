# VoiceFlow ASR Provider Reference

This is a configuration reference, not benchmark results — for actual
measured numbers see `eval/WER_BENCHMARK.md` and `eval/SCENARIO_BENCHMARK.md`.

## Two ways to pick a provider

**1. Environment-driven priority chain** (`ASR_PROVIDER`) — the production
default. Comma-separated, tried in order, falls through on failure:

```bash
# Groq primary, falls back through the rest
ASR_PROVIDER=groq,remote,deepgram,assemblyai

# Your own remote WhisperX+diarization endpoint primary
ASR_PROVIDER=remote,groq,deepgram,assemblyai

# Deepgram primary
ASR_PROVIDER=deepgram,groq,remote,assemblyai
```

**2. Per-request override** (`provider` field on `POST /transcribe` or
`/pipeline`) — forces that engine to the front of the chain for one call:

```json
POST /transcribe
{"audio_b64": "<base64>", "provider": "groq", "language": "en"}
```

**3. Named scenarios** (`scenario` field on `POST /pipeline`) — for
reproducible comparisons, this goes further than (2): it pins the provider
with `strict=True`, so there's no fallback substitution at all — a failure
is reported honestly instead of quietly running on a different provider
than the one asked for. See `services/scenarios.py` and `GET /scenarios`.
This is what `eval/run_scenario_benchmark.py` uses.

## Provider identifiers

- `groq` — Groq LPU, `whisper-large-v3-turbo` (fast, cheap)
- `remote` — your own remote WhisperX + pyannote.audio endpoint, set via `VOICEFLOW_REMOTE_ENDPOINT`
- `deepgram` — Deepgram `nova-3` (best diarization among the cloud providers; pass `diarize=true`)
- `assemblyai` — AssemblyAI Universal-2 (native diarization, strong streaming)
- `local` — WhisperX or NeMo Canary, whichever `LOCAL_ASR_ENGINE` selects (below)

## Local vs. remote — how to actually decide

Groq/Deepgram/AssemblyAI are plain HTTP API calls — no local install, no GPU
concern, cost is per-request. `local` and `remote` are different: they're
about where a *heavy self-hosted model* actually runs, and the choice is
per-capability, not one global switch.

**Run it locally (`VOICEFLOW_TRANSCRIPTION_MODE=local`) when:** this app's
own host has real hardware — enough RAM/CPU for WhisperX, or a GPU if you
also want NeMo Canary or pyannote diarization at reasonable speed. Then
`pip install -r requirements-ml.txt` (uncommenting whichever of Kokoro/NeMo
you actually want — they're independent, heavy, opt-in blocks in that file)
directly on this host.

**Delegate to remote (`VOICEFLOW_TRANSCRIPTION_MODE=remote` +
`VOICEFLOW_REMOTE_ENDPOINT`) when:** this host is resource-constrained (a
small/free-tier container on whatever platform you deploy to is the common
case). `VOICEFLOW_REMOTE_ENDPOINT` is a black box you control: point it at
your own GPU box, an on-demand cloud worker, whatever — VoiceFlow only
knows its `/whisper` contract, not what's running behind it. This is
engine-agnostic: your remote endpoint could be running WhisperX, NeMo
Canary, or anything else that speaks the same contract.

**`LOCAL_ASR_ENGINE` / `LOCAL_DIARIZATION_ENGINE`** only matter in local
mode — they pick which engine runs *on this host specifically*:

| Setting | Options | Notes |
|---|---|---|
| `LOCAL_ASR_ENGINE` | `whisperx` (default), `nemo_canary` | Canary is NVIDIA's research-SOTA model — GPU strongly recommended, CPU works but slowly enough to be a benchmarking tool, not a production path |
| `LOCAL_DIARIZATION_ENGINE` | `pyannote` (default), `nemo` | pyannote needs `PYANNOTE_TOKEN` and a GPU for speed; NeMo's `ClusteringDiarizer` is the CPU-capable option |

Same idea applies to TTS: `provider=kokoro` runs locally by default, or set
`VOICEFLOW_TTS_REMOTE_ENDPOINT` to delegate it instead of installing
Kokoro's dependencies on this host. See `.env.example`.
