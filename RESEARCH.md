# VoiceFlow — Research Notes & Benchmarking

This document does two things: places VoiceFlow honestly against the real,
current state of speech-AI research and industry practice (not a marketing
comparison), and points to VoiceFlow's own real, reproducible measurements
rather than restating them here. It is a set of engineering/research notes,
not a paper draft, and makes no claim to novel algorithmic contribution
unless stated as such below.

For actual measured results, see the `eval/` benchmark suite and its
generated reports (`WER_BENCHMARK.md`, `MULTI_PROVIDER_BENCHMARK.md`,
`REALTIME_BENCHMARK.md`, `SCENARIO_BENCHMARK.md`, `ACTION_ITEM_BENCHMARK.md`)
— each states plainly what it does and doesn't measure, and every one is
reproducible by running the matching script yourself against live provider
APIs, not a canned result.

## 1. Where the field actually stands (2026)

A brief, honest literature/industry check, so the claims below aren't made
in a vacuum:

**ASR.** Whisper (OpenAI) remains a strong, widely-deployed baseline —
large-v3 is commonly reported around 2.7-2.8% WER on LibriSpeech
test-clean, with `large-v3-turbo` trading a small accuracy cost (~0.3
points) for roughly 4x faster inference. As of 2026, the open-model
leaderboard (Hugging Face's Open ASR Leaderboard) is actually topped by
NVIDIA's Canary-Qwen-2.5B at ~1.6% WER on the same set, not by a Whisper
variant — a materially different model family from anything VoiceFlow
ships by default. VoiceFlow's own "NeMo Canary" option
(`nvidia/canary-180m-flash`) is the smallest published Canary checkpoint,
not the leaderboard-topping 2.5B one — offered as a lighter-weight research
option, explicitly documented as such, not presented as SOTA.

**Diarization.** pyannote.audio 3.1 (the version VoiceFlow uses by
default) is commonly reported around 11-14% Diarization Error Rate (DER)
on the AMI meeting benchmark, roughly 9-11% on VoxConverse, and
higher (17-19%) on the harder DIHARD III set — in the same range as
commercial diarization APIs (Deepgram, AssemblyAI, Rev.ai-class services
report roughly 8-14% DER on comparable meeting audio), not a clear win or
loss either way. A newer community model (pyannote 4.0-era work,
late 2025) reportedly improves further on speaker-confusion errors;
VoiceFlow has not been re-validated against it.

**Realtime multimodal voice.** Both of the two backends VoiceFlow bridges
to — OpenAI's Realtime API and Google's Gemini Live API — moved from
preview/beta into general-availability, production-SLA infrastructure
during 2026. This is now mature, widely-adopted infrastructure, not an
emerging technique. Worth noting honestly: WebRTC-based agent frameworks
(rather than a raw WebSocket relay, which is what VoiceFlow implements)
have become a common 2026 default for shaving further end-to-end latency
in production voice-agent stacks — a real architectural tradeoff VoiceFlow
makes for simplicity, not something it should be presented as having
optimized past.

**LLM-based structured extraction from transcripts** (meeting notes,
action items, CRM fields) doesn't have one dominant public benchmark the
way ASR has LibriSpeech — evaluation in practice is done the way
`eval/run_action_item_benchmark.py` does it here: greedy-matching a
model's structured output against a labeled ground truth and reporting
precision/recall/F1, the standard information-extraction evaluation
pattern. There is no shortcut around needing labeled data for this.

## 2. What VoiceFlow actually is, honestly positioned

VoiceFlow is an **integration and reliability-engineering project**, not a
research project proposing a new model or algorithm. Its real, defensible
contribution is in how it combines existing SOTA components:

- A transcription router across six real backends (local WhisperX, local
  NeMo Canary, remote-delegated compute, Groq Whisper, Deepgram Nova-3,
  AssemblyAI Universal-2) with an explicit, non-silent fallback chain, and
  a `strict` mode that turns fallback off entirely for reproducible
  benchmarking — see `services/transcription_adapter.py` and
  `services/scenarios.py`.
- Diarization that degrades honestly: `diarized: false` is a real,
  truthful response field when speaker labels aren't available, never a
  fabricated result — checked directly against source, not assumed.
- Per-analysis-type LLM routing (Groq `openai/gpt-oss-120b` for
  meeting/general, Claude Sonnet 4.6 for sales/interview, Claude Haiku 4.5
  for support) — a reasonable, defensible cost/quality tradeoff, though
  VoiceFlow does not claim to have derived these assignments from a
  systematic cost-quality study; they're a sensible default, not an
  empirically optimized one (see §4). The meeting/general tier's model has
  changed once already in this project's life: Groq deprecated the
  previous default (`llama-3.3-70b-versatile`) for free/developer-tier
  accounts in mid-2026, confirmed by a real API call returning
  `model_not_found`; the current default was chosen after verifying live
  that it produces clean, directly-parseable JSON with the existing
  extraction prompt, unlike Groq's other suggested replacement, which
  emitted an unstoppable chain-of-thought block instead.
- A provider-agnostic realtime voice bridge (`REALTIME_PROVIDER` switches
  OpenAI/Gemini with no code fork) with two specific implementation
  details worth being concrete about:
  - **Input-frame gating during tool calls.** When the model is
    mid-tool-call (`is_tool_active` in `api.py`'s `ws_realtime`), new
    microphone frames stop being forwarded until the call resolves —
    otherwise speaker output bleeding back into an open mic during a tool
    call reads to the model as the user interrupting its own turn. The
    fix is a single conditional (`if is_tool_active: continue` before any
    frame is forwarded); correctness follows from that code structure
    directly rather than needing a runtime measurement, and it's exercised
    by the realtime tests in `tests/test_e2e.py`.
  - **Server-side 24kHz→16kHz resampling** for the Gemini path, via the
    standard-library `audioop.ratecv` — a browser's `MediaRecorder`/Web
    Audio pipeline commonly captures at 24kHz, while Gemini Multimodal
    Live's input side expects 16kHz. The ratio is a straightforward 3:2
    linear decimation (3 input samples → 2 output samples):
    $$y[n] = x\left[\left\lfloor \frac{3n}{2} \right\rfloor\right]$$
    which cuts the raw payload bitrate by exactly 33.3% (384 kbps → 256
    kbps for 16-bit mono PCM) while staying well above the ~4kHz bandwidth
    that matters for intelligible speech. This is standard, well-understood
    signal processing, not a novel technique — real measured latency for
    the actual `audioop.ratecv` call (not a simulated stand-in) is in
    `eval/run_benchmarks.py` / its generated `eval/benchmark_results.json`;
    on typical hardware it runs in tens of microseconds per 20ms chunk,
    not a meaningful contributor next to real network round-trip time.
- Production-reliability work that's real and worth stating plainly: every
  ASR provider call runs off the main event loop rather than blocking it;
  LLM analysis calls are bounded by a real timeout instead of hanging
  indefinitely on a rate-limited provider; the webhook relay validates
  destinations resolve to public addresses before fetching them; every
  non-static endpoint is rate-limited per IP.

None of this is a new algorithm. All of it is real, checked-against-source
engineering, which is a different — and honestly smaller — kind of claim
than a research contribution, and this document doesn't pretend otherwise.

## 3. Real measured results (summary, not a substitute for the reports)

Pulled directly from the current `eval/*.md` reports at time of writing —
treat those files, not this table, as the source of truth, since they get
regenerated by re-running the scripts:

| What | Result | Source |
|---|---|---|
| ASR WER, faster-whisper `base`, N=20, CPU | 2.9% (LibriSpeech test-clean) | `WER_BENCHMARK.md` |
| ASR WER, Whisper `large-v3`, N=150, T4 GPU | 2.2% | `WER_BENCHMARK.md` |
| Action-item extraction, Claude Sonnet 4.6, N=38 real meetings | P=0.502, R=0.518, F1=0.506 | `ACTION_ITEM_BENCHMARK.md` |
| Action-item extraction, Groq Llama 3.3 70B *(deprecated by Groq since, see §2)* | N=2 scored (quota-limited mid-run) — not a reliable read | `ACTION_ITEM_BENCHMARK.md` |
| Realtime audio downsampling (24kHz→16kHz, real `audioop.ratecv` call) | tens of microseconds/20ms chunk | `eval/benchmark_results.json` |

That Groq row is a historical record of what was actually tested at the
time, on the model that was VoiceFlow's default then — it hasn't been
re-run against the current default (`openai/gpt-oss-120b`) yet, and the
number was already unreliable on its own terms (2 of 38 meetings scored
before a real Groq quota ceiling was hit mid-run). A fresh run against the
current model is one of the natural next steps in §5, not something this
document backfills with an unmeasured guess.

The action-item benchmark's own honesty note matters: the 50 source
meetings are LLM-generated synthetic scripts, not real recorded meetings —
real audio synthesis, real transcription, and real LLM extraction all run
on top of that synthetic source text, but a synthetic script is not the
same evidentiary weight as a real recorded meeting corpus with human
annotation. Treat the numbers above as what they are: a real, reproducible
measurement on a fully disclosed, synthetic-source benchmark — useful for
tracking regressions and comparing configurations, not as a claim about
real-world meeting accuracy.

## 4. Honest limitations

- No systematic cost-quality curve has been derived for the LLM routing
  choices in §2 — they're reasonable defaults, not the output of a formal
  study.
- No diarization error rate (DER) has been measured for VoiceFlow's own
  pyannote/NeMo integration specifically — §1's DER figures are the
  published model numbers, not a VoiceFlow-run evaluation.
- The action-item benchmark's source corpus is synthetic (see §3).
- No end-to-end realtime-latency breakdown (mic → network → provider →
  speaker) has been measured and published for VoiceFlow's own deployment;
  `REALTIME_BENCHMARK.md` currently has no committed numbers for exactly
  this reason — it's written to report only what it actually measures.

## 5. Natural next steps

None of the following is committed or scheduled — listed as honest,
sensible directions given the gaps in §4, not a roadmap:

- A larger, human-annotated (not synthetic-script) benchmark corpus for
  action-item/meeting-notes extraction, closing the main gap in §3.
- A systematic cost-quality comparison across the available LLM tiers per
  analysis type, to replace the current reasonable-but-unvalidated routing
  defaults with empirically justified ones.
- A direct DER measurement of VoiceFlow's own pyannote/NeMo diarization
  paths against a labeled multi-speaker set, rather than citing published
  model-card numbers as a proxy.
- An end-to-end realtime-latency study (mic capture → network → provider
  → speaker output) broken down by stage, to identify where time actually
  goes in the realtime voice path.
