import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  FileText,
  Globe,
  Layers,
  Mic,
  MicOff,
  RefreshCw,
  Settings2,
  Sparkles,
  Table,
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
  openai_ws_path?: string;
  openai_webrtc_session_path: string;
  openai_webrtc_available: boolean;
  openai_available?: boolean;
  voice?: string;
  agent_tools_url?: string;
  tools_cached?: number;
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
const WS_BASE = BASE
  ? (location.protocol === "https:" ? BASE.replace(/^https?:\/\//, "wss://") : BASE.replace(/^http:\/\//, "ws://"))
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const TOKEN_KEY = "voiceflow.internal_token";
const MAX_AUTO_RECONNECT_ATTEMPTS = 6;
const CLOSED_TURN_MERGE_WINDOW_MS = 3000;
const MIN_SPEECH_CONFIRM_MS = 250;

const DEFAULT_INTERNAL_TOKEN = "omx-nVMjHTpqRJAzNNDw5kyHpMjB4JHakfex";

function authToken() {
  return import.meta.env.VITE_VOICEFLOW_INTERNAL_TOKEN || import.meta.env.VITE_INTERNAL_TOKEN || localStorage.getItem(TOKEN_KEY) || DEFAULT_INTERNAL_TOKEN;
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
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(private cfg: RealtimeConfig, private cb: TransportCallbacks, private customWsPath?: string) {}

  async connect() {
    this.intentionalClose = false;
    const params = new URLSearchParams();
    if (this.resumeHandle) params.set("resume", this.resumeHandle);
    if (this.cfg.voice) params.set("voice", this.cfg.voice);
    if (this.cfg.agent_tools_url) params.set("agent_tools_url", this.cfg.agent_tools_url);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const targetPath = this.customWsPath || this.cfg.gemini_ws_path || "/realtime/gemini";
    this.ws = new WebSocket(WS_BASE + withAuth(targetPath + qs));
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "ping" }));
          if (this.pongTimeout) clearTimeout(this.pongTimeout);
          this.pongTimeout = setTimeout(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.close();
            }
          }, 15000);
        }
      }, 20000);
    };

    this.ws.onmessage = (m) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(m.data);
      } catch {
        return;
      }
      if (data.type === "pong") {
        if (this.pongTimeout) clearTimeout(this.pongTimeout);
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
    this.ws.onclose = () => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.pongTimeout) clearTimeout(this.pongTimeout);
      if (this.intentionalClose) return;
      this.cb.onClose();
    };
    this.ws.onerror = () => {
      if (this.intentionalClose) return;
      this.cb.onError("Gemini WebSocket connection failed");
    };
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
    this.intentionalClose = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.pongTimeout) clearTimeout(this.pongTimeout);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

class OpenAIWebRTCTransport implements RealtimeTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private intentionalClose = false;

  constructor(private cfg: RealtimeConfig, private cb: TransportCallbacks) {}

  async connect() {
    this.intentionalClose = false;
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
      if (this.intentionalClose) return;
      if (this.pc?.connectionState === "failed" || this.pc?.connectionState === "closed") {
        this.cb.onClose();
      }
    };
    this.cb.onEvent({ type: "metric", event: "transport_ready", elapsed_ms: 0 });
  }

  async attachMic(stream: MediaStream) {
    if (!this.pc) throw new Error("OpenAI transport not connected");
    this.stream = stream;
    // addTrack() alone creates one sendrecv audio transceiver (mic out, model's
    // voice back on the same m-line via ontrack). A separate addTransceiver()
    // here used to add a second, recvonly-only audio m-line to the same offer —
    // two audio sections in one SDP offer instead of one bidirectional one.
    stream.getAudioTracks().forEach((track) => this.pc!.addTrack(track, stream));
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
    this.intentionalClose = true;
    if (this.dc) {
      this.dc.onmessage = null;
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
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
      if (this.cfg.agent_tools_url) headers["X-Agent-Tools-Url"] = this.cfg.agent_tools_url;
      const res = await fetch(BASE + withAuth("/realtime/tool-call"), {
        method: "POST",
        headers,
        body: JSON.stringify({ name, arguments: args, agent_tools_url: this.cfg.agent_tools_url }),
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
class VADProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isSilent = true;
    this.isPlaying = false;
    this.bargeInStreak = 0;
    this.lastAudioTime = Date.now();
    this.lastVolumePost = 0;
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.preBuffer = [];
    this.preBufferMaxFrames = Math.ceil(0.3 * (sampleRate / 128));
    this.CHUNK_SIZE = 800; // 50ms at 16kHz
    this.accumulatedSamples = new Int16Array(this.CHUNK_SIZE);
    this.accumulatedCount = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'playback_state') {
        this.isPlaying = !!e.data.isPlaying;
        if (!this.isPlaying) {
          this.bargeInStreak = 0;
        }
      }
    };
  }

  flushAccumulated() {
    if (this.accumulatedCount > 0) {
      const slice = this.accumulatedSamples.slice(0, this.accumulatedCount);
      this.port.postMessage({ type: 'audio', buffer: slice.buffer }, [slice.buffer]);
      this.accumulatedCount = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channelData = input[0];
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) sum += channelData[i] * channelData[i];
    const vol = Math.sqrt(sum / channelData.length);
    const now = Date.now();

    // Throttle volume events to ~20Hz to prevent saturating React render loop
    if (now - this.lastVolumePost > 50) {
      this.lastVolumePost = now;
      this.port.postMessage({ type: 'volume', vol });
    }

    const SPEECH_THRESHOLD = 0.015;
    const BARGE_IN_THRESHOLD = 0.085;
    const BARGE_IN_REQUIRED_FRAMES = 50;
    const PAUSE_THRESHOLD_MS = 600;

    const outLen = Math.max(1, Math.floor(channelData.length / this.ratio));
    const pcm16 = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const sample = channelData[Math.min(channelData.length - 1, Math.floor(i * this.ratio))];
      pcm16[i] = Math.max(-1, Math.min(1, sample)) * 32767;
    }

    if (this.isPlaying) {
      // Audio playback is active through device speakers.
      // Suppress normal sensitive speech detection to prevent acoustic echo self-interruption.
      // Require sustained high-volume energy for intentional barge-in.
      if (vol > BARGE_IN_THRESHOLD) {
        this.bargeInStreak++;
      } else {
        this.bargeInStreak = Math.max(0, this.bargeInStreak - 3);
      }

      if (this.bargeInStreak >= BARGE_IN_REQUIRED_FRAMES) {
        // Confirmed intentional user barge-in
        this.isPlaying = false;
        this.isSilent = false;
        this.bargeInStreak = 0;
        this.lastAudioTime = now;
        this.port.postMessage({ type: 'speech_started', bargeIn: true });
        while (this.preBuffer.length > 0) {
          const pre = this.preBuffer.shift();
          this.port.postMessage({ type: 'audio', buffer: pre.buffer }, [pre.buffer]);
        }
        for (let i = 0; i < pcm16.length; i++) {
          this.accumulatedSamples[this.accumulatedCount++] = pcm16[i];
          if (this.accumulatedCount >= this.CHUNK_SIZE) {
            this.flushAccumulated();
          }
        }
      } else {
        // Playback active, no confirmed barge-in. Keep rolling prebuffer but do not stream echo audio.
        this.preBuffer.push(pcm16);
        if (this.preBuffer.length > this.preBufferMaxFrames) {
          this.preBuffer.shift();
        }
      }
      return true;
    }

    // Normal listening mode (no assistant audio playing)
    if (vol > SPEECH_THRESHOLD) {
      this.lastAudioTime = now;
      if (this.isSilent) {
        this.isSilent = false;
        this.port.postMessage({ type: 'speech_started', bargeIn: false });
        while (this.preBuffer.length > 0) {
          const pre = this.preBuffer.shift();
          this.port.postMessage({ type: 'audio', buffer: pre.buffer }, [pre.buffer]);
        }
      }
      for (let i = 0; i < pcm16.length; i++) {
        this.accumulatedSamples[this.accumulatedCount++] = pcm16[i];
        if (this.accumulatedCount >= this.CHUNK_SIZE) {
          this.flushAccumulated();
        }
      }
    } else {
      if (!this.isSilent) {
        for (let i = 0; i < pcm16.length; i++) {
          this.accumulatedSamples[this.accumulatedCount++] = pcm16[i];
          if (this.accumulatedCount >= this.CHUNK_SIZE) {
            this.flushAccumulated();
          }
        }
        if (now - this.lastAudioTime > PAUSE_THRESHOLD_MS) {
          this.isSilent = true;
          this.flushAccumulated();
          this.port.postMessage({ type: 'speech_stopped' });
        }
      } else {
        this.preBuffer.push(pcm16);
        if (this.preBuffer.length > this.preBufferMaxFrames) {
          this.preBuffer.shift();
        }
      }
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
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>(
    () => localStorage.getItem("voiceflow.selected_provider") || "gemini"
  );
  const [selectedVoice, setSelectedVoice] = useState<string>(
    () => localStorage.getItem("voiceflow.selected_voice") || localStorage.getItem("voiceflow.gemini_voice") || "Zephyr"
  );
  const [agentToolsUrl, setAgentToolsUrl] = useState<string>(
    () => localStorage.getItem("voiceflow.agent_tools_url") || ""
  );
  const [customAgentInput, setCustomAgentInput] = useState(agentToolsUrl);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [testingAgent, setTestingAgent] = useState(false);
  const [agentTestResult, setAgentTestResult] = useState<{ status: string; count?: number; message?: string; error?: string; url?: string } | null>(null);

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
  const responseDoneReceivedRef = useRef(false);
  const playbackEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioRemainderRef = useRef<Uint8Array | null>(null);

  const updatePlaybackState = (playing: boolean) => {
    isPlayingRef.current = playing;
    setAgentSpeaking(playing);
    try {
      workletNodeRef.current?.port.postMessage({
        type: "playback_state",
        isPlaying: playing,
      });
    } catch {}
  };

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

  const playToolLatencyCue = () => {
    try {
      const ctx = ensurePlaybackContext();
      if (!ctx || ctx.state === "closed") return;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc1.type = "sine";
      osc2.type = "sine";
      osc1.frequency.setValueAtTime(440, ctx.currentTime);
      osc2.frequency.setValueAtTime(554.37, ctx.currentTime);

      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.1);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc1.start(ctx.currentTime);
      osc2.start(ctx.currentTime);
      osc1.stop(ctx.currentTime + 0.6);
      osc2.stop(ctx.currentTime + 0.6);
    } catch (e) {
      // Ignore audio errors for cue
    }
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
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
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

    if (type === "response.audio.delta") {
      // Audio delta received — keep turn active while streaming
    }

    if (type === "response.user_transcript.delta") {
      appendTurnDelta("user", String(data.delta || ""), userOpenIdRef, userDraftRef, false);
      if (data.finished) {
        addTelemetryLog("user_transcript.finished", undefined, "info");
        closeTurn("user", userOpenIdRef, userDraftRef);
      }
    }

    if (type === "input_audio_buffer.committed") {
      responsePendingRef.current = true;
      responseDoneReceivedRef.current = false;
      addTelemetryLog("audio_buffer.committed", undefined, "info");
      // Seal user turn so each spoken input creates its own distinct message box
      closeTurn("user", userOpenIdRef, userDraftRef);
    }

    if (type === "assistant.cancelled") {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      responsePendingRef.current = false;
      responseDoneReceivedRef.current = false;
      addTelemetryLog("assistant.interrupted", "Speech barge-in triggered", "warn");
      closeTurn("assistant", agentOpenIdRef, agentDraftRef, true);
    }

    if (type === "response.done" || type === "response.audio.done") {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      responseDoneReceivedRef.current = true;
      addTelemetryLog("response.completed", undefined, "success");
      closeTurn("assistant", agentOpenIdRef, agentDraftRef);
      if (!isPlayingRef.current && playbackQueueRef.current.length === 0 && activeSourcesRef.current.length === 0) {
        responsePendingRef.current = false;
        setAgentSpeaking(false);
      }
    }

    if (type === "tool_call") {
      const toolName = String(data.name || "tool");
      setActiveTool(toolName);
      addTelemetryLog("tool_call:start", toolName, "info");
      playToolLatencyCue();
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
    try {
      const silentBuf = playbackCtxRef.current.createBuffer(1, 1, 24000);
      const src = playbackCtxRef.current.createBufferSource();
      src.buffer = silentBuf;
      src.connect(playbackCtxRef.current.destination);
      src.start();
    } catch (_) {}
    return playbackCtxRef.current;
  };

  const queueAudioPlayback = (base64: string) => {
    try {
      ensurePlaybackContext();
      const binary = atob(base64);
      const rawLen = binary.length;
      const rem = audioRemainderRef.current;
      const totalLen = (rem ? rem.length : 0) + rawLen;
      const bytes = new Uint8Array(totalLen);
      let offset = 0;
      if (rem && rem.length > 0) {
        bytes.set(rem, 0);
        offset += rem.length;
        audioRemainderRef.current = null;
      }
      for (let i = 0; i < rawLen; i++) {
        bytes[offset + i] = binary.charCodeAt(i);
      }

      // Ensure 16-bit PCM alignment (multiple of 2)
      const alignedBytes = bytes.length - (bytes.length % 2);
      if (bytes.length % 2 !== 0) {
        audioRemainderRef.current = bytes.slice(alignedBytes);
      }
      if (alignedBytes === 0) return;

      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, alignedBytes / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
      playbackQueueRef.current.push(float32);
      scheduleNextBuffers();
    } catch (err: any) {
      console.error("Audio playback queue error:", err);
    }
  };

  const scheduleNextBuffers = () => {
    const audioCtx = playbackCtxRef.current;
    if (!audioCtx || playbackQueueRef.current.length === 0) return;
    if (playbackEndTimerRef.current) {
      clearTimeout(playbackEndTimerRef.current);
      playbackEndTimerRef.current = null;
    }
    updatePlaybackState(true);
    nextPlayTimeRef.current = Math.max(audioCtx.currentTime + 0.025, nextPlayTimeRef.current);
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
          if (playbackEndTimerRef.current) clearTimeout(playbackEndTimerRef.current);
          playbackEndTimerRef.current = setTimeout(() => {
            if (activeSourcesRef.current.length === 0 && playbackQueueRef.current.length === 0) {
              updatePlaybackState(false);
              responsePendingRef.current = false;
              responseDoneReceivedRef.current = false;
              setAgentSpeaking(false);
            }
          }, 250);
        }
      };
    }
  };

  const stopAudioPlayback = () => {
    if (playbackEndTimerRef.current) {
      clearTimeout(playbackEndTimerRef.current);
      playbackEndTimerRef.current = null;
    }
    audioRemainderRef.current = null;
    playbackQueueRef.current = [];
    activeSourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    responsePendingRef.current = false;
    responseDoneReceivedRef.current = false;
    updatePlaybackState(false);
  };

  const stopVoice = () => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    setReconnectAttempt(0);
    responsePendingRef.current = false;
    closeTurn("assistant", agentOpenIdRef, agentDraftRef);
    closeTurn("user", userOpenIdRef, userDraftRef);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    playbackCtxRef.current?.close();
    playbackCtxRef.current = null;
    workletNodeRef.current = null;
    audioRemainderRef.current = null;
    setIsRecording(false);
    setVolume(0);
    stopAudioPlayback();
    addTelemetryLog("session.stopped", "Microphone audio capture ended", "info");
  };

  const scheduleReconnect = () => {
    // Note: Do NOT terminate the microphone or audio context if the user is in an active live call!
    // Keeping streamRef and audioCtxRef alive allows seamless background reconnection without
    // forcing the caller to re-click "Start Live Voice" every turn.
    if (!wasReadyRef.current || reconnectAttemptsRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) {
      stopVoice();
      setState("closed");
      addTelemetryLog("session.closed", "Connection terminated", "warn");
      return;
    }
    const attempt = reconnectAttemptsRef.current++;
    setReconnectAttempt(attempt + 1);
    setState("connecting");
    addTelemetryLog("session.reconnecting", `Attempt ${attempt + 1}/${MAX_AUTO_RECONNECT_ATTEMPTS}`, "warn");
    reconnectTimerRef.current = setTimeout(() => connect(false), Math.min(1000 * 2 ** attempt, 8000));
  };

  const connect = async (reset = false, overrideVoice?: string, overrideAgentUrl?: string, overrideProvider?: string) => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setErrorMsg("");
    if (reset) {
      reconnectAttemptsRef.current = 0;
      setReconnectAttempt(0);
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
      const activeProvider = overrideProvider !== undefined ? overrideProvider : selectedProvider;
      const activeAgent = (overrideAgentUrl !== undefined ? overrideAgentUrl : agentToolsUrl).trim();
      const params = new URLSearchParams();
      if (activeAgent) params.set("agent_tools_url", activeAgent);
      if (activeProvider) params.set("provider", activeProvider === "openai_webrtc" ? "openai" : activeProvider);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const cfg = await fetch(BASE + withAuth("/realtime/config" + qs), { headers: { "X-VoiceFlow-Session": getSessionId() } }).then((r) => r.json());
      const voiceToUse = overrideVoice || selectedVoice;
      const cfgWithVoice: RealtimeConfig = {
        ...cfg,
        provider: activeProvider,
        voice: voiceToUse,
        agent_tools_url: activeAgent || cfg.agent_tools_url || "",
      };
      cfgRef.current = cfgWithVoice;
      if (cfg.auth_required && !authToken()) {
        setErrorMsg("This deployment requires a WebSocket token. Set VITE_VOICEFLOW_INTERNAL_TOKEN or voiceflow.internal_token in localStorage.");
        setState("unconfigured");
        return;
      }
      transportRef.current?.close();
      if (activeProvider === "openai_webrtc" && cfgWithVoice.openai_webrtc_available) {
        transportRef.current = new OpenAIWebRTCTransport(cfgWithVoice, {
          onEvent: handleEvent,
          onClose: scheduleReconnect,
          onError: setErrorMsg,
          onAudio: queueAudioPlayback,
        });
      } else if (activeProvider === "openai" || activeProvider === "openai_ws") {
        transportRef.current = new GeminiWebSocketTransport(
          cfgWithVoice,
          {
            onEvent: handleEvent,
            onClose: scheduleReconnect,
            onError: setErrorMsg,
            onAudio: queueAudioPlayback,
          },
          cfgWithVoice.openai_ws_path || "/realtime/openai"
        );
      } else {
        transportRef.current = new GeminiWebSocketTransport(
          cfgWithVoice,
          {
            onEvent: handleEvent,
            onClose: scheduleReconnect,
            onError: setErrorMsg,
            onAudio: queueAudioPlayback,
          },
          cfgWithVoice.gemini_ws_path || "/realtime/gemini"
        );
      }
      await transportRef.current.connect();
    } catch (err: any) {
      setErrorMsg(err.message || String(err));
      setState("error");
      addTelemetryLog("transport.error", err.message || String(err), "error");
    }
  };

  const handleProviderChange = (newProvider: string) => {
    setSelectedProvider(newProvider);
    localStorage.setItem("voiceflow.selected_provider", newProvider);
    const defaultVoice = newProvider === "gemini" ? "Zephyr" : "alloy";
    setSelectedVoice(defaultVoice);
    localStorage.setItem("voiceflow.selected_voice", defaultVoice);
    if (isRecording || state === "ready" || state === "connecting" || state === "provider_connecting") {
      connect(false, defaultVoice, undefined, newProvider);
    } else if (cfgRef.current) {
      cfgRef.current = {
        ...cfgRef.current,
        provider: newProvider,
        voice: defaultVoice,
      };
    }
  };

  const handleVoiceChange = (newVoice: string) => {
    setSelectedVoice(newVoice);
    localStorage.setItem("voiceflow.selected_voice", newVoice);
    if (isRecording || state === "ready" || state === "connecting" || state === "provider_connecting") {
      connect(false, newVoice);
    } else if (cfgRef.current) {
      cfgRef.current = {
        ...cfgRef.current,
        voice: newVoice,
      };
    }
  };

  const handleSaveAgentUrl = (newUrl: string) => {
    const trimmed = newUrl.trim();
    setAgentToolsUrl(trimmed);
    localStorage.setItem("voiceflow.agent_tools_url", trimmed);
    setShowAgentModal(false);
    if (isRecording || state === "ready" || state === "connecting" || state === "provider_connecting") {
      connect(false, undefined, trimmed);
    } else if (cfgRef.current) {
      cfgRef.current = {
        ...cfgRef.current,
        agent_tools_url: trimmed,
      };
    }
  };

  const handleResetAgentUrl = () => {
    setAgentToolsUrl("");
    setCustomAgentInput("");
    localStorage.removeItem("voiceflow.agent_tools_url");
    setShowAgentModal(false);
    if (isRecording || state === "ready" || state === "connecting" || state === "provider_connecting") {
      connect(false, undefined, "");
    } else if (cfgRef.current) {
      cfgRef.current = {
        ...cfgRef.current,
        agent_tools_url: "",
      };
    }
  };

  const testAgentEndpoint = async (urlToTest: string) => {
    setTestingAgent(true);
    setAgentTestResult(null);
    try {
      const res = await fetch(BASE + withAuth(`/api/agent-tools/test?url=${encodeURIComponent(urlToTest.trim())}`));
      const data = await res.json();
      setAgentTestResult(data);
    } catch (err: any) {
      setAgentTestResult({ status: "error", error: err.message || "Failed to reach endpoint" });
    } finally {
      setTestingAgent(false);
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
      // Synchronously prepare and unlock playback context on user gesture
      ensurePlaybackContext();

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) throw new Error("Audio capture is not supported in this browser.");
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is unavailable. Please ensure you are connected securely over HTTPS.");
      }

      // First attempt full audio constraints, fallback to basic audio if mobile browser rejects strict config
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch (constraintErr) {
        console.warn("Advanced audio constraints failed, falling back to basic audio stream:", constraintErr);
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      streamRef.current = stream;

      if (cfgRef.current?.provider === "openai" && transportRef.current instanceof OpenAIWebRTCTransport) {
        await transportRef.current.attachMic(stream);
        setIsRecording(true);
        addTelemetryLog("audio.started", "OpenAI WebRTC bidirectional audio stream active", "success");
        return;
      }

      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      if (!audioCtx.audioWorklet) throw new Error("AudioWorklet is not supported in this browser.");

      const blob = new Blob([workletCode], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await audioCtx.audioWorklet.addModule(workletUrl);
      } finally {
        // Crucial for iOS Safari WebKit: Delay URL revocation so the asynchronous audio thread finishes loading the script
        setTimeout(() => {
          try {
            URL.revokeObjectURL(workletUrl);
          } catch (_) {}
        }, 10000);
      }
      const source = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, "vad-processor");
      workletNodeRef.current = workletNode;
      workletNode.port.postMessage({ type: "playback_state", isPlaying: isPlayingRef.current });
      workletNode.port.onmessage = (e) => {
        const data = e.data;
        if (data.type === "volume") setVolume(data.vol);
        if (data.type === "speech_started") {
          lastClosedRef.current.user = { id: null, text: "", at: 0 };
          lastClosedRef.current.assistant = { id: null, text: "", at: 0 };
          if (data.bargeIn) {
            // Explicit user barge-in detected with high volume energy during playback
            stopAudioPlayback();
            transportRef.current?.cancel();
            closeTurn("assistant", agentOpenIdRef, agentDraftRef, true);
            if (watchdogTimerRef.current) {
              clearTimeout(watchdogTimerRef.current);
              watchdogTimerRef.current = null;
            }
            responsePendingRef.current = false;
            responseDoneReceivedRef.current = false;
            closeTurn("user", userOpenIdRef, userDraftRef);
          } else {
            // Normal speech detection while agent is NOT actively playing
            if (isPlayingRef.current) {
              // Ignore acoustic bleed or room noise while assistant is speaking
              return;
            }
            responsePendingRef.current = false;
            closeTurn("assistant", agentOpenIdRef, agentDraftRef, false);
            closeTurn("user", userOpenIdRef, userDraftRef);
          }
        }
        if (data.type === "speech_stopped" && !isPlayingRef.current) {
          responsePendingRef.current = true;
          responseDoneReceivedRef.current = false;
          transportRef.current?.commitTurn();
          if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
          watchdogTimerRef.current = setTimeout(() => {
            if (responsePendingRef.current) {
              responsePendingRef.current = false;
              addTelemetryLog("turn.watchdog_reset", "Watchdog reset ready state after 8s", "info");
            }
          }, 8000);
        }
        if (data.type === "audio") {
          // Double safety gate: do not stream mic audio to server during active playback unless barging in
          if (!isPlayingRef.current) {
            transportRef.current?.sendAudio(data.buffer);
          }
        }
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
      workletNodeRef.current = null;
      audioRemainderRef.current = null;
      setIsRecording(false);
      let userNotice = err.message || String(err);
      const isDenied =
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError" ||
        (err.message && err.message.toLowerCase().includes("permission")) ||
        (err.message && err.message.toLowerCase().includes("denied"));

      if (isDenied) {
        userNotice = "Microphone access was denied. Tap here to grant permission.";
        setShowPermissionModal(true);
      }
      setErrorMsg(userNotice);
      // If the transport connection was already established, keep state as "ready" so the user can retry
      if (wasReadyRef.current) {
        setState("ready");
      } else {
        setState("error");
      }
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
        <div className="flex flex-1 flex-col md:flex-row gap-3 sm:gap-4 overflow-hidden min-h-0 relative">
          {/* Main Chat & Voice Interaction Area */}
          <Card className="flex flex-1 flex-col p-0 overflow-hidden shadow-card">
            {/* Session Status Header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-line px-3.5 py-2.5 sm:px-5 sm:py-3 gap-2.5 bg-surface">
              <div className="flex items-center gap-3">
                <div
                  className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                    state === "ready"
                      ? "bg-ok ring-4 ring-ok/20"
                      : state === "error" || state === "closed"
                      ? "bg-bad ring-4 ring-bad/20"
                      : "bg-warn animate-pulse ring-4 ring-warn/20"
                  }`}
                />
                <div className="flex flex-col">
                  <div className="flex items-center gap-2 flex-wrap">
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
                    {/* Realtime Provider Selector */}
                    <div className="flex items-center gap-1.5 ml-1">
                      <span className="text-[11px] text-muted hidden sm:inline">Provider:</span>
                      <select
                        value={selectedProvider}
                        onChange={(e) => handleProviderChange(e.target.value)}
                        className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-body border border-line outline-none cursor-pointer focus:border-[var(--accent)]"
                        title="Select Realtime Voice AI Provider"
                      >
                        <option value="gemini">Gemini 2.5 Live</option>
                        <option value="openai">OpenAI Realtime (WebSocket)</option>
                        <option value="openai_webrtc">OpenAI Realtime (WebRTC)</option>
                      </select>
                    </div>

                    {/* Spoken Voice Selector */}
                    <div className="flex items-center gap-1.5 ml-1">
                      <span className="text-[11px] text-muted hidden sm:inline">Voice:</span>
                      <select
                        value={selectedVoice}
                        onChange={(e) => handleVoiceChange(e.target.value)}
                        className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-body border border-line outline-none cursor-pointer focus:border-[var(--accent)]"
                        title="Select AI Spoken Voice"
                      >
                        {selectedProvider === "gemini" ? (
                          <>
                            <option value="Zephyr">Zephyr (Warm)</option>
                            <option value="Puck">Puck (Energetic)</option>
                            <option value="Charon">Charon (Calm)</option>
                            <option value="Kore">Kore (Clear)</option>
                            <option value="Fenrir">Fenrir (Deep)</option>
                            <option value="Aoede">Aoede (Expressive)</option>
                          </>
                        ) : (
                          <>
                            <option value="alloy">Alloy (Neutral)</option>
                            <option value="echo">Echo (Warm)</option>
                            <option value="shimmer">Shimmer (Clear)</option>
                            <option value="ash">Ash (Conversational)</option>
                            <option value="ballad">Ballad (Smooth)</option>
                            <option value="coral">Coral (Friendly)</option>
                            <option value="sage">Sage (Calm)</option>
                            <option value="verse">Verse (Dynamic)</option>
                          </>
                        )}
                      </select>
                    </div>

                    {/* Dynamic Agent Bridge Selector */}
                    <button
                      type="button"
                      onClick={() => {
                        setCustomAgentInput(agentToolsUrl);
                        setAgentTestResult(null);
                        setShowAgentModal(true);
                      }}
                      className="flex items-center gap-1.5 rounded bg-surface-2 hover:bg-surface px-2 py-0.5 text-[11px] font-medium text-body border border-line transition-colors ml-1"
                      title="Configure external agent tools endpoint"
                    >
                      <Wrench size={11} className={agentToolsUrl ? "text-[var(--accent)]" : "text-muted"} />
                      <span className="hidden sm:inline text-muted">Agent:</span>
                      <span className="truncate max-w-[110px]">
                        {agentToolsUrl ? "Custom" : cfgRef.current?.tools_cached ? `${cfgRef.current.tools_cached} tools` : "Default"}
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
                <Button
                  variant="ghost"
                  className="px-2.5 py-1.5 text-xs text-muted hover:text-body"
                  onClick={() => setShowTelemetry((v) => !v)}
                  title="Toggle Telemetry Drawer"
                >
                  <Activity size={14} className={showTelemetry ? "text-[var(--accent)]" : ""} />
                  <span className="hidden xs:inline sm:inline">Telemetry</span>
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
                  <Button variant="secondary" onClick={() => connect(false)} className="text-xs py-1.5 px-3">
                    Reconnect
                  </Button>
                )}

                <Button
                  variant={isRecording ? "danger" : "primary"}
                  onClick={isRecording ? stopVoice : startVoice}
                  disabled={state !== "ready" && state !== "error"}
                  className="px-3.5 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold shadow-sm"
                >
                  {isRecording ? <MicOff size={15} /> : <Mic size={15} />}
                  <span>{isRecording ? "End Call" : "Start Live Voice"}</span>
                </Button>
              </div>
            </div>

            {/* Tap-to-fix Permission & Warning Banner */}
            {errorMsg && !isRecording && (
              <div
                onClick={() => setShowPermissionModal(true)}
                className="flex items-center justify-between gap-2 bg-warn/10 border-b border-warn/25 px-3.5 sm:px-5 py-2 text-[12px] text-body cursor-pointer hover:bg-warn/15 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AlertTriangle size={14} className="text-warn shrink-0" />
                  <span className="truncate">{errorMsg}</span>
                </div>
                <span className="text-[11px] font-semibold text-warn shrink-0 underline ml-2">Tap for setup</span>
              </div>
            )}

            {/* Active Tool Execution Banner */}
            {activeTool && (
              <div className="flex items-center gap-2 bg-[var(--accent)]/10 border-b border-[var(--accent)]/20 px-3.5 sm:px-5 py-2 text-[12px] text-body animate-pulse">
                <Wrench size={14} className="text-[var(--accent)]" />
                <span className="font-medium">Executing Tool:</span>
                <code className="font-mono text-[var(--accent)] font-semibold">{activeTool}</code>
              </div>
            )}

            {/* Message Timeline */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3.5 sm:p-5 space-y-3 sm:space-y-4 relative bg-surface-2/30">
              {msgs.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted select-none p-4 sm:p-6 text-center">
                  <div className="rounded-full bg-surface-2 p-3 sm:p-4 border border-line mb-3 shadow-inner">
                    <Sparkles size={26} className="text-[var(--accent)] opacity-80" />
                  </div>
                  <h3 className="font-semibold text-body text-[15px]">Bidirectional Voice Agent</h3>
                  <p className="text-[13px] text-muted max-w-sm mt-1 leading-relaxed">
                    Click <strong>Start Live Voice</strong> to begin. Speak naturally in your preferred language to converse in real time with the AI voice agent.
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
            <div className="border-t border-line bg-surface px-3.5 sm:px-5 py-2.5 sm:py-3 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 sm:gap-4">
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
              <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted overflow-hidden">
                <Clock size={12} className="text-dim shrink-0" />
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
            <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm md:static md:z-auto md:bg-transparent md:flex-row md:w-80 md:shrink-0 animate-in fade-in">
              <Card className="w-full max-h-[85vh] md:max-h-none md:w-80 flex flex-col p-0 overflow-hidden shadow-2xl md:shadow-card border-line rounded-t-2xl md:rounded-xl">
                <div className="flex items-center justify-between border-b border-line px-4 py-3 bg-surface">
                  <div className="flex items-center gap-2">
                    <Terminal size={15} className="text-[var(--accent)]" />
                    <span className="text-[13px] font-semibold text-body">Live Telemetry & Logs</span>
                  </div>
                  <Button variant="ghost" className="p-1 h-7 w-7 text-muted hover:text-body rounded-full" onClick={() => setShowTelemetry(false)}>
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
            </div>
          )}
        </div>
      )}

      {/* Interactive Microphone Permission Modal */}
      {showPermissionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl bg-surface border border-line shadow-2xl p-5 sm:p-6 text-body space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-warn/15 border border-warn/30 flex items-center justify-center text-warn shrink-0">
                  <Mic size={22} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-body">Microphone Access Needed</h3>
                  <p className="text-xs text-muted">Grant permission to enable live voice conversation</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPermissionModal(false)}
                className="text-muted hover:text-body p-1 rounded-lg text-lg leading-none"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Your browser blocked microphone access. To talk with the voice agent in real time, please tap the button below to allow access or follow the instructions for your device.
            </p>

            {/* Direct Action Button (user tap initiates getUserMedia) */}
            <div className="pt-1">
              <Button
                variant="primary"
                onClick={() => {
                  setShowPermissionModal(false);
                  startVoice();
                }}
                className="w-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 shadow-lg"
              >
                <Mic size={16} />
                <span>Grant Permission & Start Call</span>
              </Button>
            </div>

            {/* Mobile Browser Step-by-Step Instructions */}
            <div className="rounded-xl bg-surface-2 p-3.5 border border-line space-y-2.5 text-xs">
              <div className="flex items-center gap-2 border-b border-line pb-2">
                <span className="font-semibold text-body text-[11px] uppercase tracking-wider">How to enable on mobile:</span>
              </div>

              <div className="space-y-2.5 text-dim text-[11px] leading-relaxed">
                <div>
                  <strong className="text-body block mb-0.5">📱 Apple iOS Safari (iPhone / iPad):</strong>
                  1. Tap the <span className="font-mono bg-surface px-1 py-0.5 rounded border border-line">aA</span> or <span className="font-mono bg-surface px-1 py-0.5 rounded border border-line">Website Settings</span> button in the address bar.<br/>
                  2. Tap <strong>Website Settings</strong> &gt; <strong>Microphone</strong> &gt; choose <strong>Allow</strong>.<br/>
                  3. Tap <strong>Done</strong>, then tap <strong>Grant Permission & Start Call</strong> above.
                </div>

                <div className="pt-2 border-t border-line/60">
                  <strong className="text-body block mb-0.5">🤖 Android Chrome / Edge:</strong>
                  1. Tap the <strong>Lock 🔒 / Tune</strong> icon next to the address bar.<br/>
                  2. Tap <strong>Permissions</strong> &gt; <strong>Microphone</strong> &gt; choose <strong>Allow</strong>.<br/>
                  3. Tap <strong>Grant Permission & Start Call</strong> above.
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <Button
                variant="ghost"
                onClick={() => setShowPermissionModal(false)}
                className="text-xs text-muted hover:text-body py-1.5 px-3"
              >
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Agent Tools Bridge Modal */}
      {showAgentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-lg rounded-2xl bg-surface border border-line shadow-2xl p-5 sm:p-6 text-body space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)] shrink-0">
                  <Wrench size={22} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-body">Agent Tools Bridge</h3>
                  <p className="text-xs text-muted">Dynamically connect any external agent service</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAgentModal(false)}
                className="text-muted hover:text-body p-1 rounded-lg text-lg leading-none"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              VoiceFlow is completely agent-agnostic. Point this session to any service implementing the discovery contract (<code>/api/tools</code>). Its tools, resources, and actions will be dynamically exposed to the live voice agent.
            </p>

            <div className="space-y-2">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted block">
                Agent Service Base URL
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="url"
                  value={customAgentInput}
                  onChange={(e) => setCustomAgentInput(e.target.value)}
                  placeholder={cfgRef.current?.agent_tools_url || "https://api-agentkit.ysiddo-ai-projects.app"}
                  className="flex-1 rounded-xl bg-surface-2 px-3 py-2 text-xs font-mono text-body border border-line outline-none focus:border-[var(--accent)]"
                />
                <Button
                  variant="secondary"
                  onClick={() => testAgentEndpoint(customAgentInput || cfgRef.current?.agent_tools_url || "")}
                  disabled={testingAgent}
                  className="text-xs px-3 py-2 flex items-center gap-1.5 shrink-0"
                >
                  <RefreshCw size={12} className={testingAgent ? "animate-spin" : ""} />
                  <span>Test</span>
                </Button>
              </div>
              <div className="text-[10px] text-dim flex justify-between">
                <span>Default: <code className="font-mono">{cfgRef.current?.agent_tools_url || "Default server agent"}</code></span>
                <span>Active: <code className="font-mono">{agentToolsUrl || "Default"}</code></span>
              </div>
            </div>

            {/* Test Results Output */}
            {agentTestResult && (
              <div
                className={`p-3 rounded-xl border text-xs font-mono space-y-1.5 ${
                  agentTestResult.status === "ok"
                    ? "bg-ok/10 text-ok border-ok/30"
                    : "bg-bad/10 text-bad border-bad/30"
                }`}
              >
                <div className="flex items-center justify-between font-bold">
                  <span>Status: {agentTestResult.status.toUpperCase()}</span>
                  {agentTestResult.count !== undefined && (
                    <span>{agentTestResult.count} tool(s) discovered</span>
                  )}
                </div>
                {agentTestResult.error && (
                  <div className="text-[11px] text-bad font-sans">{agentTestResult.error}</div>
                )}
                {agentTestResult.message && (
                  <div className="text-[11px] font-sans">{agentTestResult.message}</div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-line">
              <Button
                variant="ghost"
                onClick={handleResetAgentUrl}
                className="text-xs text-muted hover:text-bad py-1.5 px-3"
              >
                Reset to Default
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setShowAgentModal(false)}
                  className="text-xs py-1.5 px-3"
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleSaveAgentUrl(customAgentInput)}
                  className="text-xs py-1.5 px-4 font-semibold shadow-sm"
                >
                  Save & Connect
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Dedicated structured card for tool execution events in the chat timeline.
 */
/**
 * Dedicated structured card for tool execution events in the chat timeline.
 */
function ToolMessageCard({ msg }: { msg: Msg }) {
  const [showJson, setShowJson] = useState(false);
  const tool = msg.toolData;
  if (!tool) return null;

  const isCompleted = tool.status === "completed";
  const isFailed = tool.status === "failed";

  return (
    <div className="flex justify-center my-2.5">
      <div className="w-full max-w-xl rounded-xl border border-line bg-surface p-3.5 shadow-sm text-[12px] space-y-3">
        <div className="flex items-center justify-between select-none">
          <div className="flex items-center gap-2.5">
            <div
              className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${
                isCompleted ? "bg-ok/10 text-ok" : isFailed ? "bg-bad/10 text-bad" : "bg-[var(--accent)]/10 text-[var(--accent)] animate-pulse"
              }`}
            >
              {isCompleted ? <CheckCircle2 size={15} /> : isFailed ? <XCircle size={15} /> : <Wrench size={15} />}
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
          </div>
        </div>

        {/* Visualized Structured Results */}
        {isCompleted && tool.result !== undefined && (
          <div className="pt-2 border-t border-line/60">
            <DynamicToolResultVisualizer result={tool.result} toolName={tool.name} />
          </div>
        )}

        {/* Inspector Accordion Toggle for Raw JSON */}
        <div className="pt-1 border-t border-line/40 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-muted hover:text-body transition-colors"
          >
            {showJson ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{showJson ? "Hide Raw Payload" : "View Raw JSON Payload"}</span>
          </button>
        </div>

        {/* Raw Arguments & Output Inspector */}
        {showJson && (
          <div className="pt-2 border-t border-line space-y-2 font-mono text-[11px] animate-in fade-in">
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

/**
 * Helper to format keys into clean readable titles.
 */
function formatKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format scalar values (numbers, currencies, percentages, dates, booleans) dynamically.
 */
function formatScalar(val: any, keyName = ""): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "True" : "False";
  if (typeof val === "number") {
    const lower = keyName.toLowerCase();
    if (
      lower.includes("revenue") ||
      lower.includes("amount") ||
      lower.includes("cost") ||
      lower.includes("cogs") ||
      lower.includes("arr") ||
      lower.includes("price") ||
      lower.includes("spend") ||
      lower.includes("budget") ||
      lower.includes("balance")
    ) {
      if (Math.abs(val) >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
      if (Math.abs(val) >= 1_000) return `$${(val / 1_000).toFixed(1)}k`;
      return `$${val.toFixed(2)}`;
    }
    if (lower.includes("percent") || lower.includes("rate") || lower.includes("ratio") || lower.endsWith("%")) {
      return `${val.toFixed(1)}%`;
    }
    if (lower.includes("months")) return `${val.toFixed(1)} mo`;
    if (lower.includes("days")) return `${val.toFixed(1)} days`;
    return Number.isInteger(val) ? val.toLocaleString() : val.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof val === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
      return new Date(val).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    return val;
  }
  return JSON.stringify(val);
}

/**
 * Returns dynamic color tokens based on status/state strings.
 */
function getStatusStyle(statusStr: string): string {
  const s = statusStr.toLowerCase();
  if (["ok", "healthy", "success", "completed", "active", "up", "true", "resolved", "passed"].includes(s)) {
    return "bg-ok/10 text-ok border-ok/30";
  }
  if (["warn", "warning", "pending", "in_progress", "medium", "moderate"].includes(s)) {
    return "bg-warn/10 text-warn border-warn/30";
  }
  if (["bad", "error", "failed", "critical", "high", "down", "false", "anomalous"].includes(s)) {
    return "bg-bad/10 text-bad border-bad/30";
  }
  return "bg-surface-2 text-dim border-line";
}

/**
 * Domain-Agnostic Dynamic Tool Result Visualizer.
 * Intelligently visualizes ANY structured tool output:
 * - Arrays/lists of entities (KPIs, tickets, tasks, messages, events, search hits, logs)
 * - Single entity records with attributes and nested sub-objects
 * - Numeric gauges / scores / health indexes
 * - Status alerts (success, error, warning)
 * - Markdown / plain text blocks
 * - Interactive raw JSON payload inspector
 */
function DynamicToolResultVisualizer({ result, toolName }: { result: any; toolName?: string }) {
  if (result === undefined || result === null) {
    return <div className="text-dim text-[12px] italic">No output returned.</div>;
  }

  if (typeof result !== "object") {
    return (
      <div className="rounded-lg bg-surface-2/60 p-2.5 text-[12px] text-body leading-relaxed whitespace-pre-wrap font-sans border border-line">
        {String(result)}
      </div>
    );
  }

  // 1. Check for error output
  if (result.error) {
    return (
      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-bad/10 text-bad text-[12px] border border-bad/25">
        <XCircle size={15} className="shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold capitalize">{String(result.error).replace(/_/g, " ")}</span>
          {result.detail && <p className="text-[11px] text-dim mt-0.5 font-mono">{String(result.detail)}</p>}
        </div>
      </div>
    );
  }

  // 2. Helper to detect if an array contains objects
  const isObjectArray = (arr: any[]): boolean => arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null;

  // 3. Find primary array property if not a direct array
  let itemsArray: any[] | null = null;
  let arrayKeyName = "";

  if (Array.isArray(result)) {
    itemsArray = result;
    arrayKeyName = toolName || "Items";
  } else {
    const candidateKeys = [
      "items", "records", "results", "data", "kpis", "tasks", "users",
      "tickets", "anomalies", "events", "files", "entries", "rows", "documents", "hits"
    ];
    for (const key of candidateKeys) {
      if (Array.isArray(result[key])) {
        itemsArray = result[key];
        arrayKeyName = key;
        break;
      }
    }
    // If not found in candidate keys, check any key with an array value
    if (!itemsArray) {
      for (const [k, v] of Object.entries(result)) {
        if (Array.isArray(v)) {
          itemsArray = v;
          arrayKeyName = k;
          break;
        }
      }
    }
  }

  // 4. Render Array of Items (Universal Cards Grid)
  if (itemsArray !== null) {
    if (itemsArray.length === 0) {
      return (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-surface-2 text-muted text-[12px] border border-line">
          <CheckCircle2 size={14} className="text-ok shrink-0" />
          <span>No {arrayKeyName.replace(/_/g, " ") || "records"} returned.</span>
        </div>
      );
    }

    if (isObjectArray(itemsArray)) {
      return (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted flex items-center gap-1.5">
              <Table size={12} className="text-[var(--accent)]" />
              <span>{formatKey(arrayKeyName || "Results")}</span>
            </span>
            <span className="rounded-full bg-[var(--accent)]/10 text-[var(--accent)] px-2 py-0.5 text-[10px] font-mono font-medium">
              {result.total || itemsArray.length} {itemsArray.length === 1 ? "entry" : "entries"}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {itemsArray.map((item: Record<string, any>, idx: number) => {
              // Extract smart fields
              const titleKey = ["name", "title", "metric", "subject", "label", "id", "filename", "code"].find(
                (k) => item[k] !== undefined && typeof item[k] !== "object"
              );
              const title = titleKey ? String(item[titleKey]) : `Item #${idx + 1}`;

              const badgeKey = ["status", "state", "category", "type", "priority", "severity", "direction", "level"].find(
                (k) => item[k] !== undefined && typeof item[k] !== "object"
              );
              const badgeVal = badgeKey ? String(item[badgeKey]) : null;

              const valKey = ["value", "amount", "score", "price", "total", "count", "balance", "cost"].find(
                (k) => item[k] !== undefined && typeof item[k] === "number"
              );
              const primaryValue = valKey !== undefined ? item[valKey] : null;

              const descKey = ["description", "summary", "text", "detail", "message", "snippet"].find(
                (k) => item[k] !== undefined && typeof item[k] === "string" && k !== titleKey
              );
              const description = descKey ? String(item[descKey]) : null;

              const secondaryKeys = Object.keys(item).filter(
                (k) => ![titleKey, badgeKey, valKey, descKey].includes(k) && typeof item[k] !== "object"
              ).slice(0, 3);

              return (
                <div
                  key={idx}
                  className="rounded-lg border border-line bg-surface-2/60 p-2.5 flex flex-col justify-between hover:border-[var(--accent)]/40 transition-colors"
                >
                  <div>
                    <div className="flex items-start justify-between gap-1 mb-1">
                      <span className="text-[12px] font-semibold text-body truncate" title={title}>
                        {title}
                      </span>
                      {badgeVal && (
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium border shrink-0 ${getStatusStyle(badgeVal)}`}>
                          {badgeVal}
                        </span>
                      )}
                    </div>

                    {description && (
                      <p className="text-[11px] text-dim line-clamp-2 mt-0.5 mb-1.5 leading-relaxed">
                        {description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-baseline justify-between mt-1 pt-1 border-t border-line/40">
                    {primaryValue !== null ? (
                      <div className="flex items-baseline gap-1">
                        <span className="text-[14px] font-bold text-body font-mono">
                          {formatScalar(primaryValue, valKey)}
                        </span>
                        {item.unit && (
                          <span className="text-[10px] text-muted">{item.unit}</span>
                        )}
                      </div>
                    ) : (
                      <div className="text-[10px] text-muted font-mono">
                        {item.period || item.date || item.created_at || ""}
                      </div>
                    )}

                    {secondaryKeys.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        {secondaryKeys.map((sk) => (
                          <span key={sk} className="text-[10px] text-dim font-mono bg-surface px-1 py-0.5 rounded border border-line/60">
                            {formatScalar(item[sk], sk)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
  }

  // 5. Check for Score / Health Index
  const scoreVal = ["score", "health", "rating", "health_score", "index"].find(
    (k) => typeof result[k] === "number"
  );
  if (scoreVal) {
    const score = Number(result[scoreVal]);
    const interp = result.interpretation || result.status || (score >= 75 ? "Optimal" : score >= 50 ? "Stable" : "Attention Needed");
    const statusColor =
      score >= 75 ? "text-ok bg-ok/10 border-ok/30" : score >= 50 ? "text-warn bg-warn/10 border-warn/30" : "text-bad bg-bad/10 border-bad/30";

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between p-3 rounded-xl bg-surface-2 border border-line">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted font-bold flex items-center gap-1">
              <Activity size={12} className="text-[var(--accent)]" />
              <span>{formatKey(scoreVal)}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-bold font-mono text-body">
                {Number.isInteger(score) ? score : score.toFixed(1)}
              </span>
              <span className="text-xs text-muted">/ 100</span>
            </div>
          </div>
          <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${statusColor}`}>
            {interp}
          </span>
        </div>

        {/* Sub-components if present */}
        {result.components && typeof result.components === "object" && Object.keys(result.components).length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {Object.entries(result.components).map(([k, v]: [string, any]) => (
              <div key={k} className="rounded-lg bg-surface border border-line p-2 text-center">
                <div className="text-[10px] text-muted capitalize truncate">{k.replace(/_/g, " ")}</div>
                <div className="text-[13px] font-bold font-mono text-body mt-0.5">
                  {typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : String(v)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // 6. Generic Structured Object View (Clean Key-Value & Summary)
  const summaryKey = ["summary", "overview", "message", "text", "content"].find(
    (k) => typeof result[k] === "string" && result[k].length > 15
  );

  const scalarEntries = Object.entries(result).filter(
    ([k, v]) => k !== summaryKey && typeof v !== "object" && v !== undefined && v !== null
  );

  const objectEntries = Object.entries(result).filter(
    ([k, v]) => k !== summaryKey && typeof v === "object" && v !== null && !Array.isArray(v)
  );

  return (
    <div className="space-y-2.5">
      {summaryKey && (
        <div className="rounded-lg bg-surface-2/80 border border-line p-2.5 text-[12px] text-body leading-relaxed">
          {String(result[summaryKey])}
        </div>
      )}

      {scalarEntries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {scalarEntries.map(([k, v]) => (
            <div key={k} className="flex justify-between items-center px-2.5 py-1.5 rounded-lg bg-surface-2/40 border border-line/50 text-[12px]">
              <span className="text-muted truncate capitalize">{k.replace(/_/g, " ")}:</span>
              <span className="font-semibold text-body font-mono truncate max-w-[180px] ml-2">
                {formatScalar(v, k)}
              </span>
            </div>
          ))}
        </div>
      )}

      {objectEntries.map(([k, v]: [string, any]) => (
        <div key={k} className="rounded-lg bg-surface-2/40 border border-line/60 p-2.5 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{formatKey(k)}</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {Object.entries(v).slice(0, 6).map(([subK, subV]: [string, any]) => (
              <div key={subK} className="p-1.5 rounded bg-surface border border-line/50 text-[11px]">
                <div className="text-[9px] text-muted truncate capitalize">{subK.replace(/_/g, " ")}</div>
                <div className="font-mono font-medium text-body truncate">{formatScalar(subV, subK)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
