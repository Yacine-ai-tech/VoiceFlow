/** Typed client for the VoiceFlow API (shapes verified in GAP_REPORT.md §1). */

export type Transcript = Record<string, unknown> & { text?: string; error?: string };
export type Analysis = Record<string, unknown> & { error?: string };

export type PipelineResult = {
  transcript: Transcript;
  analysis: Analysis;
  analysis_type: string;
};

export const ANALYSIS_TYPES = [
  { value: "meeting", label: "Meeting" },
  { value: "sales_call", label: "Sales call" },
  { value: "support_call", label: "Support call" },
  { value: "interview", label: "Interview" },
  { value: "general", label: "General" },
] as const;

const BASE = import.meta.env.VITE_API_BASE_URL || "";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function req<T>(path: string, init?: RequestInit, retryCount = 0): Promise<T> {
  try {
    const res = await fetch(BASE + path, init);
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

  relay: (url: string, payload: unknown) =>
    req<{ ok: boolean; status: number; response: string }>("/integrations/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, payload }),
    }),

  analytics: () => req<{ counters: Record<string, number>; total_analyses: number; stream_sessions: number; relays: number; by_mode: Record<string, number> }>("/analytics"),

  pipeline(file: Blob, filename: string, analysisType: string, provider = "GROQ_WHISPER") {
    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("analysis_type", analysisType);
    fd.append("provider", provider);
    return req<PipelineResult>("/pipeline", { method: "POST", body: fd });
  },

  transcribe(file: Blob, filename: string, provider = "GROQ_WHISPER") {
    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("provider", provider);
    return req<Transcript>("/transcribe", { method: "POST", body: fd });
  },

  /** Returns an object URL for the synthesized MP3. */
  async tts(text: string, language: "en" | "fr", voiceGender: string): Promise<string> {
    const res = await fetch(BASE + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language, voice_gender: voiceGender }),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail ?? detail; } catch { /* keep */ }
      throw new Error(`${res.status}: ${detail}`);
    }
    return URL.createObjectURL(await res.blob());
  },
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
