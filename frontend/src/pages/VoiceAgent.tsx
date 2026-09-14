import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Layers,
  Mic,
  MicOff,
  Sparkles,
  Terminal,
  Trash2,
  User,
  Wifi,
  Wrench,
  XCircle,
} from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card } from "../kit/primitives";
import { getSessionId } from "../lib/api";

type Role = "user" | "assistant" | "tool";

export type ToolCallData = {
  name: string;
  callId?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown> | string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
};

export type Msg = {
  id: number;
  role: Role;
  text: string;
  timestamp: number;
  toolData?: ToolCallData;
  interrupted?: boolean;
  isStreaming?: boolean;
};

export type TelemetryEvent = {
  id: number;
  timestamp: number;
  type: string;
  detail?: string;
  level: "info" | "success" | "warn" | "error";
};

type Metric = { event: string; elapsed_ms: number; at: number };
type RealtimeRole = "user" | "assistant";
type LastClosedTurn = { id: number | null; text: string; at: number };

type RealtimeConfig = {
  provider: "gemini" | "openai" | string;
  auth_required: boolean;
  gemini_ws_path: string;
  openai_webrtc_session_path: string;
  openai_webrtc_available: boolean;
};

type TransportCallbacks = {
  onEvent: (data: Record<string, unknown>) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onAudio: (base64: string) => void;
};

interface RealtimeTransport {
  connect(): Promise<void>;
  attachMic(stream: MediaStream): Promise<void>;
  sendAudio(buffer: ArrayBuffer): void;
  commitTurn(): void;
  cancel(): void;
  close(): void;
}

const BASE = import.meta.env.VITE_API_BASE_URL || "";
const WS_BASE = BASE ? BASE.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const TOKEN_KEY = "voiceflow.internal_token";
const MAX_AUTO_RECONNECT_ATTEMPTS = 6;
const CLOSED_TURN_MERGE_WINDOW_MS = 3000;
const MIN_SPEECH_CONFIRM_MS = 250;

function authToken() {
  return import.meta.env.VITE_VOICEFLOW_INTERNAL_TOKEN || localStorage.getItem(TOKEN_KEY) || "";
}

function withAuth(path: string) {
  const token = authToken();
  return token ? path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : path;
}

/**
 * Robust transcript merger that handles both cumulative text replacements
 * and streaming token deltas without corrupting mid-word character boundaries.
 */
function mergeTranscriptText(current: string, delta: string): string {
  if (!delta) return current;
  if (!current) return delta.trimStart();

  const normCurrent = current;
  const normDelta = delta;

  // 1. If delta is an extension of current (cumulative ASR rewrite)
  if (normDelta.startsWith(normCurrent)) {
    return normDelta;
  }
  // 2. If current already covers delta (stale chunk)
  if (normCurrent.startsWith(normDelta) && normCurrent.length > normDelta.length) {
    return normCurrent;
  }

  // 3. Check for word-level overlap to avoid duplicate words
  const currentWords = normCurrent.trimEnd().split(/\s+/);
  const deltaWords = normDelta.trimStart().split(/\s+/);

  const maxOverlap = Math.min(currentWords.length, deltaWords.length, 6);
  for (let k = maxOverlap; k > 0; k--) {
    const currentTail = currentWords.slice(-k).join(" ").toLowerCase();
    const deltaHead = deltaWords.slice(0, k).join(" ").toLowerCase();
    if (currentTail === deltaHead) {
      const remainingDelta = deltaWords.slice(k).join(" ");
      return remainingDelta ? `${normCurrent.trimEnd()} ${remainingDelta}` : normCurrent;
    }
  }

  // 4. Clean token append
  if (normCurrent.endsWith(" ") || normDelta.startsWith(" ")) {
    return normCurrent + normDelta;
  }
  return `${normCurrent} ${normDelta}`;
}

class GeminiWebSocketTransport implements RealtimeTransport {
  private ws: WebSocket | null = null;
  private resumeHandle: string | null = null;

  constructor(private cfg: RealtimeConfig, private cb: TransportCallbacks) {}

  async connect() {
    const resume = this.resumeHandle ? `?resume=${encodeURIComponent(this.resumeHandle)}` : "";
    this.ws = new WebSocket(WS_BASE + withAuth(this.cfg.gemini_ws_path + resume));
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (m) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(m.data);
      } catch {
        return;
      }
      if (data.type === "session.resumption_handle") {
        this.resumeHandle = String(data.handle || "") || null;
      }
      if (data.type === "response.audio.delta") {
        this.cb.onAudio(String(data.delta || ""));
      }
      this.cb.onEvent(data);
    };
    this.ws.onclose = this.cb.onClose;
    this.ws.onerror = () => this.cb.onError("Gemini WebSocket connection failed");
  }

  async attachMic() {}
  sendAudio(buffer: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buffer);
  }
  commitTurn() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this.ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
      this.cb.onEvent({ type: "input_audio_buffer.committed" });
    }
  }
  cancel() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "client.speech_started" }));
      this.cb.onEvent({ type: "assistant.cancelled" });
    }
  }
  close() {
    this.ws?.close();
    this.ws = null;
  }
}

class OpenAIWebRTCTransport implements RealtimeTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;

  constructor(private cfg: RealtimeConfig, private cb: TransportCallbacks) {}

  async connect() {
    this.pc = new RTCPeerConnection();
    this.dc = this.pc.createDataChannel("oai-events");
    this.dc.onmessage = async (m) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(m.data);
      } catch {
        return;
      }
      await this.handleToolCall(data);
      this.cb.onEvent(data);
    };
    this.pc.ontrack = (event) => {
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = event.streams[0];
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === "failed" || this.pc?.connectionState === "closed") {
        this.cb.onClose();
      }
    };
    this.cb.onEvent({ type: "metric", event: "transport_ready", elapsed_ms: 0 });
  }

  async attachMic(stream: MediaStream) {
    if (!this.pc) throw new Error("OpenAI transport not connected");
    this.stream = stream;
    stream.getAudioTracks().forEach((track) => this.pc!.addTrack(track, stream));
    this.pc.addTransceiver("audio", { direction: "recvonly" });
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const headers: HeadersInit = { "Content-Type": "application/sdp", "X-VoiceFlow-Session": getSessionId() };
    const token = authToken();
    if (token) headers["X-VoiceFlow-Internal-Token"] = token;
    const res = await fetch(BASE + withAuth(this.cfg.openai_webrtc_session_path), {
      method: "POST",
      headers,
      body: offer.sdp || "",
    });
    if (!res.ok) throw new Error(await res.text());
    await this.pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    this.cb.onEvent({ type: "provider_ready", provider: "openai", message: "Connected to OpenAI Realtime WebRTC" });
  }

  sendAudio() {}
  commitTurn() {
    this.dc?.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
    this.cb.onEvent({ type: "input_audio_buffer.committed" });
  }
  cancel() {
    this.dc?.send(JSON.stringify({ type: "response.cancel" }));
    this.cb.onEvent({ type: "assistant.cancelled" });
  }
  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    this.pc = null;
  }

  private async handleToolCall(data: Record<string, unknown>) {
    if (data.type !== "response.function_call_arguments.done" || !this.dc) return;
    const name = String(data.name || "");
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(data.arguments || "{}"));
    } catch {
      args = {};
    }
    this.cb.onEvent({ type: "tool_call", name, arguments: args });
    // Gate microphone track during tool execution to prevent acoustic feedback / false interruptions
    const audioTracks = this.stream?.getAudioTracks() || [];
    audioTracks.forEach((t) => { t.enabled = false; });
    try {
      const headers: HeadersInit = { "Content-Type": "application/json", "X-VoiceFlow-Session": getSessionId() };
      const token = authToken();
      if (token) headers["X-VoiceFlow-Internal-Token"] = token;
      const res = await fetch(BASE + withAuth("/realtime/tool-call"), {
        method: "POST",
        headers,
        body: JSON.stringify({ name, arguments: args }),
      });
      const result = await res.json();
      this.cb.onEvent({ type: "tool_result", name, result });
      this.dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: data.call_id, output: JSON.stringify(result) },
        })
      );
      this.dc.send(JSON.stringify({ type: "response.create" }));
    } finally {
      audioTracks.forEach((t) => { t.enabled = true; });
    }
  }
}

const workletCode = `
const MIN_SPEECH_CONFIRM_MS = ${MIN_SPEECH_CONFIRM_MS};
class VADProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isSilent = true;
    this.lastAudioTime = Date.now();
    this.aboveThresholdSince = null;
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channelData = input[0];
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) sum += channelData[i] * channelData[i];
    const vol = Math.sqrt(sum / channelData.length);
    this.port.postMessage({ type: 'volume', vol });
    const now = Date.now();
    if (vol > 0.032) {
      this.lastAudioTime = now;
      if (this.aboveThresholdSince === null) this.aboveThresholdSince = now;
      if (this.isSilent && now - this.aboveThresholdSince >= MIN_SPEECH_CONFIRM_MS) {
        this.isSilent = false;
        this.port.postMessage({ type: 'speech_started' });
      }
    } else {
      this.aboveThresholdSince = null;
      if (!this.isSilent && now - this.lastAudioTime > 350) {
        this.isSilent = true;
        this.port.postMessage({ type: 'speech_stopped' });
      }
    }
    if (!this.isSilent) {
      const outLen = Math.max(1, Math.floor(channelData.length / this.ratio));
      const pcm16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const sample = channelData[Math.min(channelData.length - 1, Math.floor(i * this.ratio))];
        pcm16[i] = Math.max(-1, Math.min(1, sample)) * 32767;
      }
      this.port.postMessage({ type: 'audio', buffer: pcm16.buffer }, [pcm16.buffer]);
    }
    return true;
  }
}
registerProcessor('vad-processor', VADProcessor);
`;

export default function VoiceAgent() {
  const [state, setState] = useState<"connecting" | "provider_connecting" | "ready" | "unconfigured" | "closed" | "error">("connecting");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [volume, setVolume] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [activeTool, setActiveTool] = useState<string | null>(null);

  const cfgRef = useRef<RealtimeConfig | null>(null);
  const transportRef = useRef<RealtimeTransport | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextIdRef = useRef(0);
  const nextEventIdRef = useRef(0);

  const agentOpenIdRef = useRef<number | null>(null);
  const agentDraftRef = useRef("");
  const userOpenIdRef = useRef<number | null>(null);
  const userDraftRef = useRef("");

  const lastClosedRef = useRef<Record<RealtimeRole, LastClosedTurn>>({
    user: { id: null, text: "", at: 0 },
    assistant: { id: null, text: "", at: 0 },
  });

  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const wasReadyRef = useRef(false);
  const responsePendingRef = useRef(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const addTelemetryLog = (type: string, detail?: string, level: "info" | "success" | "warn" | "error" = "info") => {
    setEvents((old) => [
      ...old.slice(-49),
      {
        id: nextEventIdRef.current++,
        timestamp: Date.now(),
        type,
        detail,
        level,
      },
    ]);
  };

  const appendTurnDelta = (
    role: RealtimeRole,
    delta: string,
    openIdRef: React.MutableRefObject<number | null>,
    draftRef: React.MutableRefObject<string>,
    allowClosedMerge = false
  ) => {
    if (!delta) return;
    setMsgs((old) => {
      if (openIdRef.current !== null) {
        draftRef.current = mergeTranscriptText(draftRef.current, delta);
        return old.map((m) => (m.id === openIdRef.current ? { ...m, text: draftRef.current, isStreaming: true } : m));
      }
      const last = lastClosedRef.current[role];
      if (allowClosedMerge && last.id !== null && Date.now() - last.at <= CLOSED_TURN_MERGE_WINDOW_MS) {
        openIdRef.current = last.id;
        draftRef.current = mergeTranscriptText(last.text, delta);
        return old.map((m) => (m.id === last.id ? { ...m, text: draftRef.current, isStreaming: true } : m));
      }
      const id = nextIdRef.current++;
      openIdRef.current = id;
      draftRef.current = delta.trimStart();
      return [
        ...old,
        {
          id,
          role,
          text: draftRef.current,
          timestamp: Date.now(),
          isStreaming: true,
        },
      ];
    });
  };

  const closeTurn = (
    role: RealtimeRole,
    openIdRef: React.MutableRefObject<number | null>,
    draftRef: React.MutableRefObject<string>,
    interrupted = false
  ) => {
    if (openIdRef.current !== null) {
      const turnId = openIdRef.current;
      lastClosedRef.current[role] = { id: turnId, text: draftRef.current, at: Date.now() };
      setMsgs((old) =>
        old.map((m) =>
          m.id === turnId
            ? {
                ...m,
                isStreaming: false,
                interrupted: interrupted || m.interrupted,
              }
            : m
        )
      );
    }
    openIdRef.current = null;
    draftRef.current = "";
  };

  const handleEvent = (data: Record<string, unknown>) => {
    const type = String(data.type || "");

    if (type === "metric") {
      const eventName = String(data.event || "metric");
      const elapsed = Number(data.elapsed_ms || 0);
      setMetrics((old) => [...old.slice(-7), { event: eventName, elapsed_ms: elapsed, at: Date.now() }]);
      addTelemetryLog(`metric:${eventName}`, `${elapsed}ms`, "info");
      if (eventName === "transport_ready") setState("provider_connecting");
      return;
    }

    if (type === "provider_ready" || type === "ready") {
      wasReadyRef.current = true;
      reconnectAttemptsRef.current = 0;
      setReconnectAttempt(0);
      setState("ready");
      addTelemetryLog("provider_ready", String(data.message || "Provider connected"), "success");
      return;
    }

    if (type === "error") {
      responsePendingRef.current = false;
      const msg = String(data.message || "Unknown error");
      const errCode = String(data.error_code || "");
      if (errCode === "quota_exceeded") {
        wasReadyRef.current = false;
      }
      setErrorMsg(msg);
      setState(wasReadyRef.current ? "error" : "unconfigured");
      addTelemetryLog("error", msg, "error");
      return;
    }

    if (type === "response.text.delta" || type === "response.audio_transcript.delta") {
      closeTurn("user", userOpenIdRef, userDraftRef);
      appendTurnDelta("assistant", String(data.delta || ""), agentOpenIdRef, agentDraftRef, true);
    }

    if (type === "response.user_transcript.delta") {
      appendTurnDelta("user", String(data.delta || ""), userOpenIdRef, userDraftRef, false);
      if (data.finished) {
        addTelemetryLog("user_transcript.finished", undefined, "info");
        closeTurn("user", userOpenIdRef, userDraftRef);
      }
    }

    if (type === "input_audio_buffer.committed") {
      addTelemetryLog("audio_buffer.committed", undefined, "info");
      // Seal user turn so each spoken input creates its own distinct message box
      closeTurn("user", userOpenIdRef, userDraftRef);
    }

    if (type === "assistant.cancelled") {
      responsePendingRef.current = false;
      addTelemetryLog("assistant.interrupted", "Speech barge-in triggered", "warn");
      closeTurn("assistant", agentOpenIdRef, agentDraftRef, true);
    }

    if (type === "response.done" || type === "response.audio.done") {
      responsePendingRef.current = false;
      addTelemetryLog("response.completed", undefined, "success");
      closeTurn("assistant", agentOpenIdRef, agentDraftRef);
      if (!isPlayingRef.current && playbackQueueRef.current.length === 0) setAgentSpeaking(false);
    }

    if (type === "tool_call") {
      const toolName = String(data.name || "tool");
      setActiveTool(toolName);
      addTelemetryLog("tool_call:start", toolName, "info");
      const toolData: ToolCallData = {
        name: toolName,
        callId: String(data.call_id || ""),
        args: (data.arguments as Record<string, unknown>) || {},
        status: "running",
        startedAt: Date.now(),
      };
      setMsgs((old) => [
        ...old,
        {
          id: nextIdRef.current++,
          role: "tool",
          text: `Executing ${toolName}`,
          timestamp: Date.now(),
          toolData,
        },
      ]);
    }

    if (type === "tool_result") {
      const toolName = String(data.name || "tool");
      setActiveTool(null);
      addTelemetryLog("tool_call:done", toolName, "success");
      const completedAt = Date.now();
      setMsgs((old) => {
        const idx = [...old].reverse().findIndex((m) => m.role === "tool" && m.toolData?.name === toolName);
        if (idx === -1) return old;
        const targetIdx = old.length - 1 - idx;
        const copy = old.slice();
        const existing = copy[targetIdx].toolData;
        const startedAt = existing?.startedAt || completedAt;
        copy[targetIdx] = {
          ...copy[targetIdx],
          text: `Completed ${toolName}`,
          toolData: {
            ...existing!,
            name: toolName,
            result: data.result as Record<string, unknown>,
            status: "completed",
            completedAt,
            durationMs: completedAt - startedAt,
          },
        };
        return copy;
      });
    }
  };

  const ensurePlaybackContext = () => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) throw new Error("Audio playback is not supported in this browser.");
    if (!playbackCtxRef.current || playbackCtxRef.current.state === "closed") {
      playbackCtxRef.current = new AudioCtx();
      nextPlayTimeRef.current = playbackCtxRef.current.currentTime;
    }
    if (playbackCtxRef.current.state === "suspended") {
      playbackCtxRef.current.resume().catch((err) => setErrorMsg(err.message || String(err)));
    }
    return playbackCtxRef.current;
  };

  const queueAudioPlayback = (base64: string) => {
    try {
      ensurePlaybackContext();
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
      playbackQueueRef.current.push(float32);
      scheduleNextBuffers();
    } catch (err: any) {
      setErrorMsg(err.message || String(err));
      setState("error");
    }
  };

  const scheduleNextBuffers = () => {
    const audioCtx = playbackCtxRef.current;
    if (!audioCtx || playbackQueueRef.current.length === 0) return;
    isPlayingRef.current = true;
    setAgentSpeaking(true);
    nextPlayTimeRef.current = Math.max(audioCtx.currentTime + 0.15, nextPlayTimeRef.current);
    while (playbackQueueRef.current.length > 0) {
      const float32 = playbackQueueRef.current.shift()!;
      const audioBuffer = audioCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start(nextPlayTimeRef.current);
      activeSourcesRef.current.push(source);
      nextPlayTimeRef.current += audioBuffer.duration;
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
        if (activeSourcesRef.current.length === 0 && playbackQueueRef.current.length === 0) {
          isPlayingRef.current = false;
          setAgentSpeaking(false);
        }
      };
    }
  };

  const stopAudioPlayback = () => {
    playbackQueueRef.current = [];
    activeSourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    activeSourcesRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;
    setAgentSpeaking(false);
  };

  const stopVoice = () => {
    responsePendingRef.current = false;
    closeTurn("assistant", agentOpenIdRef, agentDraftRef);
    closeTurn("user", userOpenIdRef, userDraftRef);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    playbackCtxRef.current?.close();
    playbackCtxRef.current = null;
    setIsRecording(false);
    setVolume(0);
    stopAudioPlayback();
    addTelemetryLog("session.stopped", "Microphone audio capture ended", "info");
  };

  const scheduleReconnect = () => {
    stopVoice();
    if (!wasReadyRef.current || reconnectAttemptsRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) {
      setState("closed");
      addTelemetryLog("session.closed", "Connection terminated", "warn");
      return;
    }
    const attempt = reconnectAttemptsRef.current++;
    setReconnectAttempt(attempt + 1);
    setState("connecting");
    addTelemetryLog("session.reconnecting", `Attempt ${attempt + 1}/${MAX_AUTO_RECONNECT_ATTEMPTS}`, "warn");
    reconnectTimerRef.current = setTimeout(() => connect(false), Math.min(1000 * 2 ** attempt, 15000));
  };

  const connect = async (reset = false) => {
    setErrorMsg("");
    if (reset) {
      setMsgs([]);
      setMetrics([]);
      setEvents([]);
      closeTurn("assistant", agentOpenIdRef, agentDraftRef);
      closeTurn("user", userOpenIdRef, userDraftRef);
      lastClosedRef.current = {
        user: { id: null, text: "", at: 0 },
        assistant: { id: null, text: "", at: 0 },
      };
    }
    setState("connecting");
    addTelemetryLog("transport.connecting", "Negotiating realtime session", "info");
    try {
      const cfg = await fetch(BASE + "/realtime/config", { headers: { "X-VoiceFlow-Session": getSessionId() } }).then((r) => r.json());
      cfgRef.current = cfg;
      if (cfg.auth_required && !authToken()) {
        setErrorMsg("This deployment requires a WebSocket token. Set VITE_VOICEFLOW_INTERNAL_TOKEN or voiceflow.internal_token in localStorage.");
        setState("unconfigured");
        return;
      }
      transportRef.current?.close();
      transportRef.current =
        cfg.provider === "openai" && cfg.openai_webrtc_available
          ? new OpenAIWebRTCTransport(cfg, {
              onEvent: handleEvent,
              onClose: scheduleReconnect,
              onError: setErrorMsg,
              onAudio: queueAudioPlayback,
            })
          : new GeminiWebSocketTransport(cfg, {
              onEvent: handleEvent,
              onClose: scheduleReconnect,
              onError: setErrorMsg,
              onAudio: queueAudioPlayback,
            });
      await transportRef.current.connect();
    } catch (err: any) {
      setErrorMsg(err.message || String(err));
      setState("error");
      addTelemetryLog("transport.error", err.message || String(err), "error");
    }
  };

  useEffect(() => {
    connect(true);
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      transportRef.current?.close();
      stopVoice();
    };
  }, []);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [msgs]);

  const startVoice = async () => {
    setErrorMsg("");
    let stream: MediaStream | null = null;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) throw new Error("Audio capture is not supported in this browser.");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available in this browser.");

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;
      ensurePlaybackContext();

      if (cfgRef.current?.provider === "openai" && transportRef.current instanceof OpenAIWebRTCTransport) {
        await transportRef.current.attachMic(stream);
        setIsRecording(true);
        addTelemetryLog("audio.started", "OpenAI WebRTC bidirectional audio stream active", "success");
        return;
      }

      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") await audioCtx.resume();
      if (!audioCtx.audioWorklet) throw new Error("AudioWorklet is not supported in this browser.");

      const blob = new Blob([workletCode], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await audioCtx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const source = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, "vad-processor");
      workletNode.port.onmessage = (e) => {
        const data = e.data;
        if (data.type === "volume") setVolume(data.vol);
        if (data.type === "speech_started") {
          lastClosedRef.current.user = { id: null, text: "", at: 0 };
          lastClosedRef.current.assistant = { id: null, text: "", at: 0 };
          closeTurn("assistant", agentOpenIdRef, agentDraftRef);
          closeTurn("user", userOpenIdRef, userDraftRef);
          // Only trigger cancellation/barge-in when the assistant is actively playing audio
          if (isPlayingRef.current) {
            stopAudioPlayback();
            responsePendingRef.current = false;
            transportRef.current?.cancel();
          }
        }
        if (data.type === "speech_stopped" && !responsePendingRef.current) {
          responsePendingRef.current = true;
          transportRef.current?.commitTurn();
        }
        if (data.type === "audio") transportRef.current?.sendAudio(data.buffer);
      };
      const silent = audioCtx.createGain();
      silent.gain.value = 0;
      source.connect(workletNode);
      workletNode.connect(silent);
      silent.connect(audioCtx.destination);
      setIsRecording(true);
      addTelemetryLog("audio.started", "16kHz PCM VAD worklet initialized", "success");
    } catch (err: any) {
      stream?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
      playbackCtxRef.current?.close();
      playbackCtxRef.current = null;
      setIsRecording(false);
      let userNotice = err.message || String(err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        userNotice = "Microphone access was denied. On mobile, tap the lock/settings icon in your browser address bar to enable microphone permissions for this site, then try again.";
      }
      setErrorMsg(userNotice);
      setState("error");
      addTelemetryLog("audio.error", userNotice, "error");
    }
  };

  const clearSessionHistory = () => {
    setMsgs([]);
    setEvents([]);
    addTelemetryLog("history.cleared", "Cleared conversation timeline", "info");
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Live Voice Agent"
        sub="Full-duplex multimodal speech with streaming transcripts and dynamic agent tool calling."
      />

      {state === "unconfigured" ? (
        <Card>
          <div className="flex items-center gap-3 py-4 text-bad">
            <AlertTriangle size={24} />
            <div>
              <div className="font-semibold text-[15px]">Realtime Backend Not Configured</div>
              <div className="text-[13px] opacity-80">{errorMsg || "Set GEMINI_API_KEY or OPENAI_API_KEY to activate."}</div>
            </div>
          </div>
        </Card>
      ) : (
        <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
          {/* Main Chat & Voice Interaction Area */}
          <Card className="flex flex-1 flex-col p-0 overflow-hidden shadow-card">
            {/* Session Status Header */}
            <div className="flex items-center justify-between border-b border-line px-5 py-3 bg-surface">
              <div className="flex items-center gap-3">
                <div
                  className={`h-2.5 w-2.5 rounded-full ${
                    state === "ready"
                      ? "bg-ok ring-4 ring-ok/20"
                      : state === "error" || state === "closed"
                      ? "bg-bad ring-4 ring-bad/20"
                      : "bg-warn animate-pulse ring-4 ring-warn/20"
                  }`}
                />
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-body">
                      {state === "ready"
                        ? "Live Agent Ready"
                        : state === "provider_connecting"
                        ? "Connecting to Model..."
                        : state === "closed"
                        ? "Session Disconnected"
                        : state === "error"
                        ? errorMsg || "Session Error"
                        : reconnectAttempt
                        ? `Reconnecting (${reconnectAttempt}/${MAX_AUTO_RECONNECT_ATTEMPTS})`
                        : "Initializing Transport..."}
                    </span>
                    {cfgRef.current?.provider && (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-dim border border-line">
                        {cfgRef.current.provider === "gemini" ? "Gemini 2.5 Live" : "OpenAI Realtime"}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  className="px-2.5 py-1.5 text-xs text-muted hover:text-body"
                  onClick={() => setShowTelemetry((v) => !v)}
                  title="Toggle Telemetry Drawer"
                >
                  <Activity size={14} className={showTelemetry ? "text-[var(--accent)]" : ""} />
                  <span className="hidden sm:inline">Telemetry</span>
                </Button>

                {msgs.length > 0 && (
                  <Button
                    variant="ghost"
                    className="px-2.5 py-1.5 text-xs text-muted hover:text-bad"
                    onClick={clearSessionHistory}
                    title="Clear Conversation History"
                  >
                    <Trash2 size={14} />
                  </Button>
                )}

                {(state === "error" || state === "closed") && (
                  <Button variant="secondary" onClick={() => connect(false)}>
                    Reconnect
                  </Button>
                )}

                <Button
                  variant={isRecording ? "danger" : "primary"}
                  onClick={isRecording ? stopVoice : startVoice}
                  disabled={state !== "ready"}
                  className="px-4 py-1.5"
                >
                  {isRecording ? <MicOff size={14} /> : <Mic size={14} />}
                  <span>{isRecording ? "End Call" : "Start Live Voice"}</span>
                </Button>
              </div>
            </div>

            {/* Active Tool Execution Banner */}
            {activeTool && (
              <div className="flex items-center gap-2 bg-[var(--accent)]/10 border-b border-[var(--accent)]/20 px-5 py-2 text-[12px] text-body animate-pulse">
                <Wrench size={14} className="text-[var(--accent)]" />
                <span className="font-medium">Executing Tool:</span>
                <code className="font-mono text-[var(--accent)] font-semibold">{activeTool}</code>
              </div>
            )}

            {/* Message Timeline */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-5 space-y-4 relative bg-surface-2/30">
              {msgs.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted select-none p-6 text-center">
                  <div className="rounded-full bg-surface-2 p-4 border border-line mb-3 shadow-inner">
                    <Sparkles size={28} className="text-[var(--accent)] opacity-80" />
                  </div>
                  <h3 className="font-semibold text-body text-[15px]">Bidirectional Voice Agent</h3>
                  <p className="text-[13px] text-muted max-w-sm mt-1 leading-relaxed">
                    Click <strong>Start Live Voice</strong> to begin. Speak naturally in English to query metrics, KPIs, or converse with the AI model.
                  </p>
                </div>
              )}

              {msgs.map((m) => {
                if (m.role === "tool") {
                  return <ToolMessageCard key={m.id} msg={m} />;
                }

                const isUser = m.role === "user";
                return (
                  <div key={m.id} className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                    {!isUser && (
                      <div className="h-8 w-8 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center shrink-0 text-[var(--accent)] mt-0.5">
                        <Bot size={16} />
                      </div>
                    )}

                    <div className={`flex flex-col max-w-[78%] ${isUser ? "items-end" : "items-start"}`}>
                      <div className="flex items-center gap-2 mb-1 px-1">
                        <span className="text-[11px] font-medium text-muted">{isUser ? "You" : "VoiceFlow Assistant"}</span>
                        <span className="text-[10px] text-dim">{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                        {m.interrupted && (
                          <span className="rounded bg-bad/10 border border-bad/20 px-1.5 py-0.2 text-[9px] text-bad font-medium">
                            Interrupted
                          </span>
                        )}
                      </div>

                      <div
                        className={`rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed shadow-sm transition-all ${
                          isUser
                            ? "bg-[var(--accent)] text-white rounded-tr-sm"
                            : "bg-surface text-body border border-line rounded-tl-sm shadow-card"
                        }`}
                      >
                        <p className="whitespace-pre-wrap">{m.text}</p>
                        {m.isStreaming && !isUser && (
                          <span className="inline-block w-1.5 h-3.5 bg-[var(--accent)] ml-1 animate-pulse align-middle" />
                        )}
                      </div>
                    </div>

                    {isUser && (
                      <div className="h-8 w-8 rounded-full bg-surface border border-line flex items-center justify-center shrink-0 text-muted mt-0.5 shadow-sm">
                        <User size={16} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bottom Audio Activity & Live Visualizer Bar */}
            <div className="border-t border-line bg-surface px-5 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {/* Visualizer bars */}
                <div className="flex gap-1 h-4 items-end">
                  {[...Array(6)].map((_, i) => {
                    const active = agentSpeaking || volume > 0.03;
                    const h = active ? Math.max(15, (agentSpeaking ? 0.3 + Math.random() * 0.7 : volume * 1.5) * 100) : 12;
                    return (
                      <div
                        key={i}
                        className="w-1.5 bg-[var(--accent)] rounded-t-sm transition-all duration-75"
                        style={{
                          height: `${Math.min(100, h)}%`,
                          opacity: active ? 1 : 0.25,
                        }}
                      />
                    );
                  })}
                </div>

                <span className="text-[12px] font-medium text-body">
                  {agentSpeaking ? (
                    <span className="text-[var(--accent)] flex items-center gap-1.5">
                      <Sparkles size={13} className="animate-spin" />
                      Agent Speaking
                    </span>
                  ) : activeTool ? (
                    <span className="text-warn flex items-center gap-1.5">
                      <Wrench size={13} />
                      Calling Agent Tool
                    </span>
                  ) : volume > 0.03 ? (
                    <span className="text-ok flex items-center gap-1.5">
                      <Mic size={13} />
                      Listening to you...
                    </span>
                  ) : isRecording ? (
                    <span className="text-muted">Listening</span>
                  ) : (
                    <span className="text-dim">Voice Idle</span>
                  )}
                </span>
              </div>

              {/* Quick Telemetry Pill */}
              <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted">
                <Clock size={12} className="text-dim" />
                <span className="truncate font-mono">
                  {metrics.length > 0
                    ? metrics
                        .slice(-3)
                        .map((m) => `${m.event}: ${m.elapsed_ms}ms`)
                        .join(" · ")
                    : "No latency metrics yet"}
                </span>
              </div>
            </div>
          </Card>

          {/* Collapsible Telemetry & Event Inspector Panel */}
          {showTelemetry && (
            <Card className="w-80 flex flex-col p-0 overflow-hidden shadow-card border-line animate-in slide-in-from-right duration-200">
              <div className="flex items-center justify-between border-b border-line px-4 py-3 bg-surface">
                <div className="flex items-center gap-2">
                  <Terminal size={15} className="text-[var(--accent)]" />
                  <span className="text-[13px] font-semibold text-body">Live Telemetry & Logs</span>
                </div>
                <Button variant="ghost" className="p-1 h-6 w-6 text-muted hover:text-body" onClick={() => setShowTelemetry(false)}>
                  ✕
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4 text-[12px]">
                {/* Session Config */}
                <div className="space-y-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted flex items-center gap-1">
                    <Wifi size={11} /> Connection Metadata
                  </div>
                  <div className="rounded-lg bg-surface-2 p-2.5 border border-line font-mono text-[11px] space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted">Provider:</span>
                      <span className="text-body font-semibold">{cfgRef.current?.provider || "gemini"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Session ID:</span>
                      <span className="text-body truncate max-w-[120px]">{getSessionId()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">State:</span>
                      <span className={state === "ready" ? "text-ok" : "text-warn"}>{state}</span>
                    </div>
                  </div>
                </div>

                {/* Latency Benchmarks */}
                <div className="space-y-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted flex items-center gap-1">
                    <Activity size={11} /> Latency Breakdown
                  </div>
                  <div className="rounded-lg bg-surface-2 p-2.5 border border-line font-mono text-[11px] space-y-1">
                    {metrics.length === 0 ? (
                      <div className="text-muted text-[11px] py-1 text-center">Awaiting turn metrics...</div>
                    ) : (
                      metrics.slice(-6).map((m, i) => (
                        <div key={i} className="flex justify-between">
                          <span className="text-muted">{m.event}:</span>
                          <span className="text-body font-medium">{m.elapsed_ms}ms</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Live Event Stream */}
                <div className="space-y-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted flex items-center gap-1">
                    <Layers size={11} /> Event Stream ({events.length})
                  </div>
                  <div className="rounded-lg bg-surface-2 p-2 border border-line font-mono text-[10px] space-y-1.5 max-h-64 overflow-y-auto">
                    {events.length === 0 ? (
                      <div className="text-muted text-center py-2">No events recorded</div>
                    ) : (
                      events.map((e) => {
                        const color =
                          e.level === "success"
                            ? "text-ok"
                            : e.level === "warn"
                            ? "text-warn"
                            : e.level === "error"
                            ? "text-bad"
                            : "text-muted";
                        return (
                          <div key={e.id} className="border-b border-line/50 pb-1 last:border-0 last:pb-0">
                            <div className="flex justify-between items-center">
                              <span className={`font-semibold ${color}`}>{e.type}</span>
                              <span className="text-[9px] text-dim">{new Date(e.timestamp).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })}</span>
                            </div>
                            {e.detail && <div className="text-dim truncate">{e.detail}</div>}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Dedicated structured card for tool execution events in the chat timeline.
 */
function ToolMessageCard({ msg }: { msg: Msg }) {
  const [expanded, setExpanded] = useState(false);
  const tool = msg.toolData;
  if (!tool) return null;

  const isCompleted = tool.status === "completed";
  const isFailed = tool.status === "failed";

  return (
    <div className="flex justify-center my-2">
      <div className="w-full max-w-lg rounded-xl border border-line bg-surface p-3 shadow-sm text-[12px]">
        <div className="flex items-center justify-between cursor-pointer select-none" onClick={() => setExpanded((v) => !v)}>
          <div className="flex items-center gap-2.5">
            <div
              className={`h-6 w-6 rounded-lg flex items-center justify-center ${
                isCompleted ? "bg-ok/10 text-ok" : isFailed ? "bg-bad/10 text-bad" : "bg-[var(--accent)]/10 text-[var(--accent)] animate-pulse"
              }`}
            >
              {isCompleted ? <CheckCircle2 size={14} /> : isFailed ? <XCircle size={14} /> : <Wrench size={14} />}
            </div>

            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-body">Tool Execution:</span>
                <code className="font-mono font-bold text-[var(--accent)]">{tool.name}</code>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {tool.durationMs !== undefined && (
              <span className="rounded bg-surface-2 border border-line px-1.5 py-0.5 text-[10px] font-mono text-muted">
                {tool.durationMs}ms
              </span>
            )}
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                isCompleted
                  ? "bg-ok/10 text-ok"
                  : isFailed
                  ? "bg-bad/10 text-bad"
                  : "bg-warn/10 text-warn animate-pulse"
              }`}
            >
              {tool.status}
            </span>
            {expanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
          </div>
        </div>

        {/* Collapsible Arguments & Output Inspector */}
        {expanded && (
          <div className="mt-3 pt-2.5 border-t border-line space-y-2 font-mono text-[11px]">
            {tool.args && Object.keys(tool.args).length > 0 && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted font-sans font-bold">Arguments</span>
                <pre className="mt-1 rounded bg-surface-2 p-2 text-dim overflow-x-auto border border-line">
                  {JSON.stringify(tool.args, null, 2)}
                </pre>
              </div>
            )}

            {tool.result !== undefined && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted font-sans font-bold">Output Result</span>
                <pre className="mt-1 rounded bg-surface-2 p-2 text-body overflow-x-auto border border-line max-h-48">
                  {typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
