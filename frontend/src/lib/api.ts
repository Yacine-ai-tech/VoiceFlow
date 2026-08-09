export class ApiError extends Error { constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; } }

/** Typed client for the VoiceFlow API. */

export type Transcript = Record<string, unknown> & { text?: string; error?: string };
export type Analysis = Record<string, unknown> & { error?: string };

export type PipelineResult = {
  transcript: Transcript;
  analysis: Analysis;
  analysis_type: string;
  scenario?: string | null;
};

export const ANALYSIS_TYPES = [
  { value: "meeting", label: "Meeting" },
  { value: "sales_call", label: "Sales call" },
  { value: "support_call", label: "Support call" },
  { value: "interview", label: "Interview" },
  { value: "general", label: "General" },
] as const;

export type Scenario = {
  description: string;
  transcription_provider: string;
  diarize: boolean;
  analysis_model_setting: string;
  est_cost_per_min_usd: number;
  notes: string;
};

const BASE = import.meta.env.VITE_API_BASE_URL || "";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A random ID this browser generates once and keeps in localStorage — not
 * an account, not PII. Sent as X-VoiceFlow-Session so GET /analytics can
 * scope counters to this visitor and never show anyone else's usage. */
const SESSION_KEY = "voiceflow.session_id";
export function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function withSessionHeader(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("X-VoiceFlow-Session", getSessionId());
  return { ...init, headers };
}

async function req<T>(path: string, init?: RequestInit, retryCount = 0): Promise<T> {
  try {
    const res = await fetch(BASE + path, withSessionHeader(init));
    if (!res.ok) {
      if (res.status >= 500 && retryCount < 5) {
        await delay(2000 * (retryCount + 1));
        return req<T>(path, init, retryCount + 1);
      }
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail ?? JSON.stringify(body);
      } catch { /* keep statusText */ }
      throw new ApiError(res.status, detail);
    }
    return res.json() as Promise<T>;
  } catch (err: any) {
    if ((err instanceof TypeError || err.message === 'Failed to fetch') && retryCount < 5) {
      await delay(2000 * (retryCount + 1));
      return req<T>(path, init, retryCount + 1);
    }
    throw err;
  }
}

export const api = {
  health: () => req<{ status: string }>("/health"),

  analyze: (text: string, analysisType: string) =>
    req<Analysis>("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, analysis_type: analysisType }),
    }),

  analyzeCustom: (text: string, fields: string[], instructions = "") =>
    req<Analysis>("/analyze/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, fields, instructions }),
    }),

  relay: (url: string, payload: unknown, target?: string, secret?: string, signatureHeader?: string) =>
    req<{ ok: boolean; status: number; response: string; target: string; signed: boolean }>("/integrations/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, payload, target, secret: secret || null, signature_header: signatureHeader || null }),
    }),

  analytics: () => req<{ counters: Record<string, number>; total_analyses: number; stream_sessions: number; relays: number; by_mode: Record<string, number> }>("/analytics"),

  scenarios: () => req<Record<string, Scenario>>("/scenarios"),

  /** Every eval/*.md benchmark report, read fresh off disk server-side on
   * each call — never a hardcoded snapshot baked into the frontend bundle. */
  benchmarks: () =>
    req<{ docs: Record<string, { title: string; filename: string; content: string | null }> }>("/benchmarks"),

  pipeline(file: Blob, filename: string, analysisType: string, provider = "GROQ_WHISPER", scenario?: string) {
    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("analysis_type", analysisType);
    fd.append("provider", provider);
    if (scenario) fd.append("scenario", scenario);
    return req<PipelineResult>("/pipeline", { method: "POST", body: fd });
  },

  transcribe(file: Blob, filename: string, provider = "GROQ_WHISPER") {
    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("provider", provider);
    return req<Transcript>("/transcribe", { method: "POST", body: fd });
  },

  /** Returns an object URL for the synthesized audio, plus the *actual*
   * format used — read from the real response, not assumed from what was
   * requested, since a provider can silently fall back to edge-tts (MP3)
   * server-side even if you asked for kokoro (WAV). */
  async tts(text: string, language: "en" | "fr", voiceGender: string, provider = "edge", voiceId?: string): Promise<{ url: string; isWav: boolean }> {
    const res = await fetch(BASE + "/tts", withSessionHeader({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language, voice_gender: voiceGender, provider, voice_id: voiceId || null }),
    }));
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail ?? detail; } catch { /* keep */ }
      throw new Error(`${res.status}: ${detail}`);
    }
    const isWav = (res.headers.get("Content-Type") || "").includes("audio/wav");
    return { url: URL.createObjectURL(await res.blob()), isWav };
  },

  /** Every ElevenLabs voice on this account — 2 stock premade voices plus
   * any real cloned ones. { error } is set (voices: []) when
   * ELEVENLABS_API_KEY isn't configured — never a silent empty list. */
  ttsVoices: () => req<{ voices: ElevenLabsVoice[]; error?: string }>("/tts/voices"),

  /** Real ElevenLabs Instant Voice Cloning — upload one or more real audio
   * samples of a voice, get back a voice_id usable as /tts's voice_id.
   * Requires an ElevenLabs plan that supports voice cloning; the error
   * message from ElevenLabs (e.g. a free-plan restriction) is surfaced
   * verbatim rather than a generic failure. */
  cloneVoice(name: string, samples: Blob[], description = "") {
    const fd = new FormData();
    fd.append("name", name);
    samples.forEach((s, i) => fd.append("files", s, `sample_${i}.wav`));
    if (description) fd.append("description", description);
    return req<{ voice_id: string; name: string }>("/tts/voices/clone", { method: "POST", body: fd });
  },

  deleteVoice: (voiceId: string) =>
    req<{ ok: boolean; voice_id: string }>(`/tts/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" }),
};

export type ElevenLabsVoice = {
  voice_id: string;
  name: string;
  category: string | null;
  description: string | null;
};

/* ---------- session-local history (real results only) ---------- */
export type HistoryItem = {
  ts: number;
  kind: string; // analysis_type
  title: string;
  durationSec?: number;
  result: PipelineResult | { analysis: Analysis; analysis_type: string; transcript?: Transcript };
};

const KEY = "voiceflow.history";

export function saveHistory(item: HistoryItem) {
  const list: HistoryItem[] = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  list.unshift(item);
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
}

export function readHistory(): HistoryItem[] {
  return JSON.parse(localStorage.getItem(KEY) ?? "[]");
}

export function clearHistory() {
  localStorage.removeItem(KEY);
}
