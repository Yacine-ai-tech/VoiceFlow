"""
VoiceFlow Transcription Adapter
================================
Unified adapter for speech-to-text. Two modes:

  local   — WhisperX on the machine running this process (needs >= 4GB RAM + ffmpeg).
  remote  — Forward to a remote ASR endpoint.

Default fallback chain (tried in this order; `provider` moves one to the
front; a failure falls through to the next):
  1. Remote inference host  [VOICEFLOW_REMOTE_ENDPOINT] — a WhisperX+diarization
     endpoint you point this at yourself (self-hosted GPU box, on-demand cloud
     worker, whatever you run behind that URL). Optional — leave it unset to skip.
     Routes to {endpoint}/nemo instead of {endpoint}/whisper when
     LOCAL_ASR_ENGINE=nemo_canary — the engine choice applies whether it runs
     on this host or a remote one, so NeMo Canary is usable via a remote
     endpoint without installing nemo_toolkit locally.
  2. Groq Whisper                      [GROQ_API_KEY]
  3. Deepgram nova-3                   [DEEPGRAM_API_KEY] — best diarization of the cloud options
  4. AssemblyAI                        [ASSEMBLYAI_API_KEY] — native diarization, strong streaming
  5. Local WhisperX, as a last resort, even in remote mode
  6. None of the above worked → empty transcript with error info

Set `strict=True` (what named scenarios in services/scenarios.py use) to
turn off the fallback entirely: only the requested `provider` is tried, and
a failure returns an honest error instead of a different provider's result.
This matters for benchmarking — "accurate" silently running on whatever
answered first isn't a comparable trial.

`diarize=True` is honored by local WhisperX (needs HF_TOKEN), the remote
endpoint, Deepgram, and AssemblyAI. Groq has no diarization support.

Env vars:
  VOICEFLOW_TRANSCRIPTION_MODE=local|remote  (default: remote if VOICEFLOW_REMOTE_ENDPOINT set)
  VOICEFLOW_REMOTE_ENDPOINT=                  (your remote inference endpoint URL)
  VOICEFLOW_REMOTE_TOKEN=                     (bearer token for that endpoint's /whisper route)
  ASR_PROVIDER=remote|groq|deepgram|assemblyai  (remote mode priority)
  WHISPER_MODEL=base                          (for local or remote mode)
  WHISPER_DEVICE=cpu
  GROQ_API_KEY=
  DEEPGRAM_API_KEY=
  ASSEMBLYAI_API_KEY=
  VOICEFLOW_ASR_TIMEOUT=60
"""
from __future__ import annotations

import asyncio
import base64
import json as _json
import logging
import os
import urllib.request
from typing import Any, Dict, Optional

from core.config import settings
from services.nemo_canary_service import NeMoCanaryService
from services.whisperx_service import WhisperXService

log = logging.getLogger(__name__)

# One shared instance of each local engine — construction is cheap (the
# model itself loads lazily on first use), so this just avoids reloading
# per request. Which one actually runs is picked at call time by
# settings.LOCAL_ASR_ENGINE.
_whisperx_service = WhisperXService()
_nemo_canary_service = NeMoCanaryService()


def _remote_endpoint() -> str:
    return os.getenv("VOICEFLOW_REMOTE_ENDPOINT", "").strip().rstrip("/")


def _remote_token() -> str:
    return (os.getenv("VOICEFLOW_REMOTE_TOKEN", "")
            or os.getenv("INFERENCE_TOKEN", "")).strip()


def _use_local() -> bool:
    mode = os.getenv("VOICEFLOW_TRANSCRIPTION_MODE", "").strip().lower()
    if mode == "local":
        return True
    if mode == "remote":
        return False
    # Auto: local if faster_whisper or whisperx is installed
    try:
        import faster_whisper  # type: ignore  # noqa
        return True
    except ImportError:
        pass
    try:
        import whisperx  # type: ignore  # noqa
        return True
    except ImportError:
        return False


def _error_result(msg: str) -> Dict[str, Any]:
    return {
        "text": "",
        "diarized_text": "",
        "language": "unknown",
        "segments": [],
        "speakers": [],
        "method": "error",
        "diarized": False,
        "error": msg,
    }


def _format_diarized_text(segments: list[dict[str, Any]]) -> str:
    """Format structured segments into standard timestamped speaker turn transcripts."""
    lines = []
    for seg in segments:
        speaker = seg.get("speaker") or "Speaker 0"
        start = float(seg.get("start", 0.0) or 0.0)
        end = float(seg.get("end", 0.0) or 0.0)
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start_min, start_sec = int(start // 60), int(start % 60)
        end_min, end_sec = int(end // 60), int(end % 60)
        lines.append(f"[{start_min:02d}:{start_sec:02d} - {end_min:02d}:{end_sec:02d}] {speaker}: {text}")
    return "\n".join(lines)


def _enrich_diarization_if_needed(text: str, segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str, list[str]]:
    """Ensure every segment has a speaker label ('Speaker 0', 'Speaker 1', etc.),
    enriching via LLM if segments exist without speaker attribution."""
    if not segments:
        if text.strip():
            seg = [{"speaker": "Speaker 0", "start": 0.0, "end": 0.0, "text": text.strip()}]
            return seg, f"[00:00 - 00:00] Speaker 0: {text.strip()}", ["Speaker 0"]
        return [], "", []

    has_speakers = any(bool(s.get("speaker") and s.get("speaker") != "Speaker 0") for s in segments)
    if has_speakers:
        clean_segs = []
        for s in segments:
            spk = s.get("speaker") or "Speaker 0"
            if not str(spk).lower().startswith("speaker"):
                spk = f"Speaker {spk}"
            clean_segs.append({
                "speaker": spk,
                "start": round(float(s.get("start", 0.0) or 0.0), 2),
                "end": round(float(s.get("end", 0.0) or 0.0), 2),
                "text": (s.get("text") or "").strip()
            })
        d_text = _format_diarized_text(clean_segs)
        speakers = sorted(list({s["speaker"] for s in clean_segs}))
        return clean_segs, d_text, speakers

    norm_segs = []
    for s in segments:
        norm_segs.append({
            "speaker": "Speaker 0",
            "start": round(float(s.get("start", 0.0) or 0.0), 2),
            "end": round(float(s.get("end", 0.0) or 0.0), 2),
            "text": (s.get("text") or "").strip()
        })

    # Try LLM turn attribution if multiple segments exist
    if len(norm_segs) > 1:
        try:
            groq_key = os.getenv("GROQ_API_KEY", "").strip() or getattr(settings, "GROQ_API_KEY", "")
            if groq_key:
                from groq import Groq
                client = Groq(api_key=groq_key)
                turns_summary = [{"i": i, "text": s["text"]} for i, s in enumerate(norm_segs[:40])]
                prompt = (
                    "Assign a speaker label ('Speaker 0', 'Speaker 1', etc.) to each dialogue turn based on conversational shifts. "
                    "Respond ONLY with valid JSON: {\"turns\": [{\"i\": 0, \"speaker\": \"Speaker 0\"}, ...]}"
                )
                comp = client.chat.completions.create(
                    model="openai/gpt-oss-120b",
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": _json.dumps(turns_summary)},
                    ],
                    temperature=0.1,
                    max_tokens=600,
                    response_format={"type": "json_object"},
                    timeout=5.0,
                )
                raw_json = _json.loads(comp.choices[0].message.content or "{}")
                assigned = {t.get("i"): t.get("speaker") for t in raw_json.get("turns", []) if "i" in t and "speaker" in t}
                for i, s in enumerate(norm_segs):
                    if i in assigned:
                        s["speaker"] = assigned[i]
        except Exception as e:
            log.debug("LLM speaker enrichment pass skipped: %s", e)

    d_text = _format_diarized_text(norm_segs)
    speakers = sorted(list({s["speaker"] for s in norm_segs}))
    return norm_segs, d_text, speakers



# Accepts the handful of spellings actually in use across the API and UI
# ("GROQ_WHISPER", "groq", "LOCAL_WHISPERX", ...) and maps them to the
# canonical provider name used by the routing chain below.
_PROVIDER_ALIASES = {
    "local": "local", "local_whisperx": "local", "local_whisper": "local", "whisperx": "local", "faster_whisper": "local",
    "groq": "groq", "groq_whisper": "groq",
    "deepgram": "deepgram", "deepgram_nova2": "deepgram",
    "assemblyai": "assemblyai",
    "remote": "remote",
}


def _normalize_provider(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    key = name.strip().lower()
    return _PROVIDER_ALIASES.get(key, key)


# ─── Remote /whisper ──────────────────────────────────────────────────────────

def _remote_whisper(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
) -> Optional[Dict[str, Any]]:
    url = _remote_endpoint()
    if not url:
        return None
    ep = url.lower()
    if "groq.com" in ep or "deepgram.com" in ep or "assemblyai.com" in ep:
        return None  # not a compatible remote inference endpoint
    timeout = int(os.getenv("VOICEFLOW_ASR_TIMEOUT", "120"))
    try:
        audio_b64 = base64.b64encode(audio_bytes).decode()
        payload: Dict[str, Any] = {"audio_b64": audio_b64, "diarize": diarize}
        if language:
            payload["language"] = language
        h = {"Content-Type": "application/json"}
        tk = _remote_token()
        if tk:
            h["Authorization"] = f"Bearer {tk}"
        req = urllib.request.Request(url + "/whisper", data=_json.dumps(payload).encode(), headers=h)
        resp = _json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        resp.setdefault("method", "remote-whisperx")
        return resp
    except Exception as e:
        log.warning("remote /whisper failed: %s", e)
        return None


def _remote_nemo(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
) -> Optional[Dict[str, Any]]:
    """Same black-box remote contract as _remote_whisper, at {endpoint}/nemo
    instead of {endpoint}/whisper — for hosts running NeMo Canary rather
    than (or in addition to) WhisperX. Selected automatically when
    LOCAL_ASR_ENGINE=nemo_canary, so the remote engine choice mirrors what
    you'd get running the same setting locally, without needing
    nemo_toolkit installed on this host."""
    url = _remote_endpoint()
    if not url:
        return None
    ep = url.lower()
    if "groq.com" in ep or "deepgram.com" in ep or "assemblyai.com" in ep:
        return None
    timeout = int(os.getenv("VOICEFLOW_ASR_TIMEOUT", "120"))
    try:
        audio_b64 = base64.b64encode(audio_bytes).decode()
        payload: Dict[str, Any] = {"audio_b64": audio_b64, "diarize": diarize}
        if language:
            payload["language"] = language
        h = {"Content-Type": "application/json"}
        tk = _remote_token()
        if tk:
            h["Authorization"] = f"Bearer {tk}"
        req = urllib.request.Request(url + "/nemo", data=_json.dumps(payload).encode(), headers=h)
        resp = _json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        resp.setdefault("method", "remote-nemo")
        return resp
    except Exception as e:
        log.warning("remote /nemo failed: %s", e)
        return None


async def _remote_transcribe(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = False,
    strict: bool = False,
) -> Optional[Dict[str, Any]]:
    """Dispatches to whichever remote route matches LOCAL_ASR_ENGINE — the
    same engine-selection principle _local_whisper already applies for
    on-host execution, just delegated instead of run in-process, so
    LOCAL_ASR_ENGINE=nemo_canary picks nemo whether it runs here or on a
    remote host you point at.

    Non-strict: a /nemo failure falls through to /whisper (the
    better-established route) rather than failing the whole request — same
    graceful-degradation spirit as the rest of non-strict mode.

    Strict (services/scenarios.py's "remote" provider): no such fallback —
    if LOCAL_ASR_ENGINE says nemo, only /nemo is tried, and a failure is
    reported honestly rather than silently handing back whisper's output
    for what was asked to be a nemo run.

    _remote_whisper/_remote_nemo are synchronous (urllib) and can block for
    up to VOICEFLOW_ASR_TIMEOUT (120s default) — run off the event loop via
    asyncio.to_thread so one slow/cold remote call can't stall every other
    concurrent request this process is handling (single-worker deployment;
    see Dockerfile)."""
    if settings.LOCAL_ASR_ENGINE == "nemo_canary":
        result = await asyncio.to_thread(_remote_nemo, audio_bytes, language, diarize)
        if result or strict:
            return result
    return await asyncio.to_thread(_remote_whisper, audio_bytes, language, diarize)


# ─── Groq Whisper ─────────────────────────────────────────────────────────────

def _groq_whisper_sync(audio_bytes: bytes, language: Optional[str] = None, diarize: bool = True) -> Optional[Dict[str, Any]]:
    key = os.getenv("GROQ_API_KEY", "").strip() or getattr(settings, "GROQ_API_KEY", "") or ""
    if not key:
        return None
    try:
        import io
        from groq import Groq  # type: ignore
        client = Groq(api_key=key)
        kwargs: Dict[str, Any] = {
            "file": ("audio.wav", io.BytesIO(audio_bytes)),
            "model": "whisper-large-v3-turbo",
            "response_format": "verbose_json",
        }
        if language and language != "auto":
            kwargs["language"] = language
        result = client.audio.transcriptions.create(**kwargs)
        raw_segments = getattr(result, "segments", []) or []
        segments = []
        for s in raw_segments:
            s_dict = s if isinstance(s, dict) else s.__dict__ if hasattr(s, "__dict__") else {}
            segments.append({
                "speaker": "Speaker 0",
                "start": round(float(s_dict.get("start", 0.0) or 0.0), 2),
                "end": round(float(s_dict.get("end", 0.0) or 0.0), 2),
                "text": (s_dict.get("text") or "").strip(),
            })

        text = result.text or ""
        diarized_text = ""
        speakers = ["Speaker 0"] if segments else []
        is_diarized = False
        if diarize and segments:
            segments, diarized_text, speakers = _enrich_diarization_if_needed(text, segments)
            is_diarized = bool(speakers)
        elif segments:
            diarized_text = _format_diarized_text(segments)

        return {
            "text": text,
            "diarized_text": diarized_text if diarized_text else text,
            "language": getattr(result, "language", language or "unknown"),
            "segments": segments,
            "speakers": speakers,
            "method": "groq-whisper",
            "diarized": is_diarized,
        }
    except Exception as e:
        log.warning("groq whisper failed: %s", e)
        return None


async def _groq_whisper(audio_bytes: bytes, language: Optional[str] = None, diarize: bool = True) -> Optional[Dict[str, Any]]:
    """The Groq SDK call is synchronous network I/O — offloaded to a thread
    so it can't block this process's single event loop (see Dockerfile:
    --workers 1) for the duration of a real transcription call."""
    return await asyncio.to_thread(_groq_whisper_sync, audio_bytes, language, diarize)


# ─── Deepgram REST ────────────────────────────────────────────────────────────

def _deepgram_whisper_sync(audio_bytes: bytes, diarize: bool = True) -> Optional[Dict[str, Any]]:
    key = os.getenv("DEEPGRAM_API_KEY", "").strip() or getattr(settings, "DEEPGRAM_API_KEY", "") or ""
    if not key:
        return None
    try:
        url = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true"
        if diarize:
            url += "&diarize=true&paragraphs=true"
        req = urllib.request.Request(
            url,
            data=audio_bytes,
            headers={
                "Authorization": f"Token {key}",
                "Content-Type": "audio/wav"
            }
        )
        resp = _json.loads(urllib.request.urlopen(req, timeout=30).read())
        results = resp.get("results", {}).get("channels", [{}])[0].get("alternatives", [{}])[0]
        transcript = results.get("transcript") or ""
        words = results.get("words", [])
        raw_paragraphs = results.get("paragraphs", {}).get("paragraphs", [])

        segments = []
        if raw_paragraphs:
            for p in raw_paragraphs:
                spk_id = p.get("speaker", 0)
                text_content = " ".join(s.get("text", "") for s in p.get("sentences", [])).strip()
                if not text_content and "words" in p:
                    text_content = " ".join(w.get("punctuated_word", w.get("word", "")) for w in p.get("words", [])).strip()
                if not text_content:
                    continue
                segments.append({
                    "speaker": f"Speaker {spk_id}",
                    "start": round(float(p.get("start", 0.0)), 2),
                    "end": round(float(p.get("end", 0.0)), 2),
                    "text": text_content,
                })
        elif words and any("speaker" in w for w in words):
            curr_spk = None
            curr_start = 0.0
            curr_end = 0.0
            curr_words = []
            for w in words:
                spk = f"Speaker {w.get('speaker', 0)}"
                if curr_spk is None:
                    curr_spk = spk
                    curr_start = float(w.get("start", 0.0))
                elif spk != curr_spk:
                    if curr_words:
                        segments.append({
                            "speaker": curr_spk,
                            "start": round(curr_start, 2),
                            "end": round(curr_end, 2),
                            "text": " ".join(curr_words).strip(),
                        })
                    curr_spk = spk
                    curr_start = float(w.get("start", 0.0))
                    curr_words = []
                w_text = w.get("punctuated_word") or w.get("word") or ""
                if w_text:
                    curr_words.append(w_text)
                curr_end = float(w.get("end", 0.0))
            if curr_words and curr_spk is not None:
                segments.append({
                    "speaker": curr_spk,
                    "start": round(curr_start, 2),
                    "end": round(curr_end, 2),
                    "text": " ".join(curr_words).strip(),
                })
        else:
            for w in words:
                segments.append({
                    "speaker": "Speaker 0",
                    "start": round(float(w.get("start", 0.0)), 2),
                    "end": round(float(w.get("end", 0.0)), 2),
                    "text": w.get("punctuated_word") or w.get("word") or "",
                })

        diarized_text = _format_diarized_text(segments)
        speakers = sorted(list({s["speaker"] for s in segments}))

        return {
            "text": transcript,
            "diarized_text": diarized_text if diarized_text else transcript,
            "language": "en",
            "segments": segments,
            "speakers": speakers,
            "method": "deepgram-nova3",
            "diarized": bool(speakers),
        }
    except Exception as e:
        log.warning("deepgram rest failed: %s", e)
        return None


async def _deepgram_whisper(audio_bytes: bytes, diarize: bool = True) -> Optional[Dict[str, Any]]:
    """urllib.request.urlopen is blocking — offloaded to a thread; see
    _groq_whisper's docstring for why this matters on a single worker."""
    return await asyncio.to_thread(_deepgram_whisper_sync, audio_bytes, diarize)


# ─── AssemblyAI REST ──────────────────────────────────────────────────────────

def _assemblyai_whisper_sync(audio_bytes: bytes) -> Optional[Dict[str, Any]]:
    key = os.getenv("ASSEMBLYAI_API_KEY", "").strip() or getattr(settings, "ASSEMBLYAI_API_KEY", "") or ""
    if not key:
        return None
    try:
        # Step 1: Upload audio
        up_req = urllib.request.Request(
            "https://api.assemblyai.com/v2/upload",
            data=audio_bytes,
            headers={"Authorization": key}
        )
        up_res = _json.loads(urllib.request.urlopen(up_req, timeout=30).read())
        audio_url = up_res.get("upload_url")
        if not audio_url:
            return None

        # Step 2: Request transcription
        tx_req = urllib.request.Request(
            "https://api.assemblyai.com/v2/transcript",
            data=_json.dumps({"audio_url": audio_url, "speaker_labels": True}).encode(),
            headers={"Authorization": key, "Content-Type": "application/json"}
        )
        tx_res = _json.loads(urllib.request.urlopen(tx_req, timeout=30).read())
        tx_id = tx_res.get("id")

        # Step 3: Poll for completion (max 15 sec). This function runs inside
        # a worker thread (see _assemblyai_whisper below) — time.sleep here
        # blocks only that thread, not the event loop.
        for _ in range(15):
            import time
            time.sleep(1)
            poll_req = urllib.request.Request(
                f"https://api.assemblyai.com/v2/transcript/{tx_id}",
                headers={"Authorization": key}
            )
            poll_res = _json.loads(urllib.request.urlopen(poll_req, timeout=10).read())
            status = poll_res.get("status")
            if status == "completed":
                utterances = poll_res.get("utterances", []) or []
                segments = []
                for utt in utterances:
                    spk = utt.get("speaker", "0")
                    segments.append({
                        "speaker": f"Speaker {spk}",
                        "start": round(float(utt.get("start", 0)) / 1000.0, 2),
                        "end": round(float(utt.get("end", 0)) / 1000.0, 2),
                        "text": (utt.get("text") or "").strip(),
                    })
                text = poll_res.get("text") or ""
                diarized_text = _format_diarized_text(segments)
                speakers = sorted(list({s["speaker"] for s in segments}))
                return {
                    "text": text,
                    "diarized_text": diarized_text if diarized_text else text,
                    "language": poll_res.get("language_code", "en"),
                    "segments": segments,
                    "speakers": speakers,
                    "method": "assemblyai",
                    "diarized": bool(speakers),
                }
            elif status == "error":
                break
        return None
    except Exception as e:
        log.warning("assemblyai rest failed: %s", e)
        return None


async def _assemblyai_whisper(audio_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Offloaded to a thread — see _groq_whisper's docstring. This one
    matters most: the sync body includes a blocking time.sleep(1) polling
    loop (up to 15s) that would otherwise stall the event loop outright."""
    return await asyncio.to_thread(_assemblyai_whisper_sync, audio_bytes)


# ─── Local WhisperX ───────────────────────────────────────────────────────────

def _local_whisper(
    audio_bytes: bytes,
    language: Optional[str] = None,
    diarize: bool = True,
) -> Optional[Dict[str, Any]]:
    """Transcribe on this host, via whichever engine LOCAL_ASR_ENGINE selects
    (default: WhisperX — alignment + optional pyannote diarization in one
    pass; "nemo_canary" for NVIDIA's research-SOTA model, GPU-recommended).
    Returns None if the selected engine isn't installed or the attempt
    fails, so the caller can fall through to remote providers."""
    engine = settings.LOCAL_ASR_ENGINE
    if engine == "nemo_canary":
        result = _nemo_canary_service.transcribe(audio_bytes, language=language)
        if diarize and result.get("method", "").startswith("nemo-canary"):
            result = _apply_local_diarization(audio_bytes, result)
    else:
        result = _whisperx_service.transcribe(audio_bytes, language=language, diarize=diarize)
    if not result or result.get("method") in ("stub", "error"):
        return None
    segs = result.get("segments", [])
    for s in segs:
        if "speaker" in s and not str(s["speaker"]).lower().startswith("speaker"):
            s["speaker"] = f"Speaker {s['speaker']}"
    result["diarized_text"] = _format_diarized_text(segs) if segs else result.get("text", "")
    result["speakers"] = sorted(list({s["speaker"] for s in segs if "speaker" in s}))
    return result


def _apply_local_diarization(audio_bytes: bytes, transcription: Dict[str, Any]) -> Dict[str, Any]:
    """Attach speaker labels to an already-transcribed result — used by
    engines (like Canary) that don't do diarization themselves. Delegates
    to whisperx_service's diarization pipeline, which honors
    LOCAL_DIARIZATION_ENGINE (pyannote default, or nemo)."""
    try:
        from services.whisperx_service import diarize_only
        return diarize_only(audio_bytes, transcription)
    except Exception as e:
        log.warning("post-hoc diarization failed: %s — returning transcript without speaker labels", e)
        return transcription


# ─── Public API ───────────────────────────────────────────────────────────────

async def transcribe(
    audio_bytes: bytes,
    provider: Optional[str] = None,
    language: Optional[str] = None,
    diarize: bool = True,
    strict: bool = False,
) -> Dict[str, Any]:
    """
    Transcribe audio using the configured mode and fallback chain.

    Args:
        audio_bytes: Raw audio (mp3, wav, m4a, ogg, etc.)
        provider: Optional engine to try first — "local", "remote", "groq",
            "deepgram", or "assemblyai". Leave unset to use the environment-
            configured order (ASR_PROVIDER / VOICEFLOW_TRANSCRIPTION_MODE). If
            the requested engine fails, the rest of that order still runs —
            unless `strict` is set.
        language: 2-letter code ('en', 'fr') or None for auto-detect.
        diarize: Speaker diarization (default True). Supported natively by
            Deepgram, AssemblyAI, and local WhisperX (with pyannote), and enriched
            via conversational analysis for Groq Whisper.
        strict: If True and `provider` is set, use *only* that provider —
            no fallback to the rest of the chain, no local-as-last-resort.
            A failure returns an honest error instead of a result from a
            different provider than the one asked for. This is what named
            scenarios (services/scenarios.py) use: a benchmark comparing
            "accurate" vs "fast" is meaningless if "accurate" can silently
            run on whatever provider actually answered.

    Returns:
        {text, diarized_text, language, segments, speakers, method, diarized}
    """
    lang = (language or "").strip().lower() or None
    if lang == "auto":
        lang = None

    requested = _normalize_provider(provider)

    if strict:
        if not requested:
            return _error_result("strict_requires_provider")
        if requested == "local":
            return await asyncio.to_thread(_local_whisper, audio_bytes, lang, diarize) or _error_result("provider_failed:local")
        if requested == "remote":
            return await _remote_transcribe(audio_bytes, lang, diarize, strict=True) or _error_result("provider_failed:remote")
        if requested == "groq":
            return await _groq_whisper(audio_bytes, lang, diarize) or _error_result("provider_failed:groq")
        if requested == "deepgram":
            return await _deepgram_whisper(audio_bytes, diarize) or _error_result("provider_failed:deepgram")
        if requested == "assemblyai":
            return await _assemblyai_whisper(audio_bytes) or _error_result("provider_failed:assemblyai")
        return _error_result(f"unknown_provider:{requested}")

    tried_local = False

    if requested == "local" or (requested is None and _use_local()):
        tried_local = True
        result = await asyncio.to_thread(_local_whisper, audio_bytes, lang, diarize)
        if result:
            return result
        # Local unavailable or failed — fall through to the remote chain.

    default_priority = [p.strip() for p in
                        os.getenv("ASR_PROVIDER", "remote,groq,deepgram,assemblyai").split(",")
                        if p.strip()]
    if requested and requested != "local":
        priority = [requested] + [p for p in default_priority if p != requested]
    elif diarize and not requested:
        # Prioritize providers with native acoustic diarization support when diarization is active
        diar_preferred = ["deepgram", "assemblyai", "groq", "remote"]
        priority = [p for p in diar_preferred if p in default_priority] + [p for p in default_priority if p not in diar_preferred]
    else:
        priority = default_priority

    for name in priority:
        result = None
        if name == "remote":
            result = await _remote_transcribe(audio_bytes, lang, diarize)
        elif name == "groq":
            result = await _groq_whisper(audio_bytes, lang, diarize)
        elif name == "deepgram":
            result = await _deepgram_whisper(audio_bytes, diarize)
        elif name == "assemblyai":
            result = await _assemblyai_whisper(audio_bytes)
        if result and result.get("text") is not None:
            if not result.get("diarized_text") and result.get("segments"):
                result["diarized_text"] = _format_diarized_text(result["segments"])
            if not result.get("speakers") and result.get("segments"):
                result["speakers"] = sorted(list({s["speaker"] for s in result["segments"] if "speaker" in s}))
            return result

    # Every remote provider failed — try local as a last resort if it wasn't already tried.
    # Set ALLOW_LOCAL_ASR_FALLBACK=false on memory-constrained hosts, where loading a
    # multi-GB WhisperX model on demand risks an out-of-memory crash loop.
    if not tried_local and os.getenv("ALLOW_LOCAL_ASR_FALLBACK", "true").strip().lower() != "false":
        result = await asyncio.to_thread(_local_whisper, audio_bytes, lang, diarize)
        if result:
            log.info("All remote ASR providers failed — used local WhisperX as last resort")
            return result

    return _error_result("all_providers_failed")

