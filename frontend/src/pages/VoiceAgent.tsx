import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Mic, MicOff } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card } from "../kit/primitives";
import { getSessionId } from "../lib/api";

type Msg = { id: number; role: "user" | "assistant" | "tool"; text: string };
type Metric = { event: string; elapsed_ms: number };
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
const USER_CLOSE_DELAY_MS = 650;
const ASSISTANT_CLOSE_DELAY_MS = 900;
const CLOSED_TURN_MERGE_WINDOW_MS = 1800;
// A response is "pending" from the moment we commit a turn until the
// provider reports it done/cancelled. Committing again — or treating a VAD
// blip as a fresh turn — while one is already pending is what produced the
// overlapping commit/response.create pairs that corrupted the Gemini
// session into a 1011 "Internal error" and silently ate every reply before
// it could ever play. Speech detected while a response is pending is only
// ever a deliberate barge-in (cancel), never a new commit.
const MIN_SPEECH_CONFIRM_MS = 200;

function authToken() {
  return import.meta.env.VITE_VOICEFLOW_INTERNAL_TOKEN || localStorage.getItem(TOKEN_KEY) || "";
}

function withAuth(path: string) {
  const token = authToken();
  return token ? path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : path;
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
      try { data = JSON.parse(m.data); } catch { return; }
      if (data.type === "session.resumption_handle") this.resumeHandle = String(data.handle || "") || null;
      if (data.type === "response.audio.delta") this.cb.onAudio(String(data.delta || ""));
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
      try { data = JSON.parse(m.data); } catch { return; }
      await this.handleToolCall(data);
      this.cb.onEvent(data);
    };
    this.pc.ontrack = (event) => {
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = event.streams[0];
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === "failed" || this.pc?.connectionState === "closed") this.cb.onClose();
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
    try { args = JSON.parse(String(data.arguments || "{}")); } catch { args = {}; }
    this.cb.onEvent({ type: "tool_call", name, arguments: args });
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
    this.dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: data.call_id, output: JSON.stringify(result) },
    }));
    this.dc.send(JSON.stringify({ type: "response.create" }));
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
    if (vol > 0.025) {
      this.lastAudioTime = now;
      // Require ~200ms of continuous voice-level energy before declaring
      // speech_started, not a single loud frame. A single transient (a
      // click, a cough, speaker bleed picked up by the mic) used to fire
      // speech_started instantly, which the app treats as a deliberate
      // barge-in and uses to cancel an in-flight reply — so one bad frame
      // could kill a response before it was ever heard.
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
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const cfgRef = useRef<RealtimeConfig | null>(null);
  const transportRef = useRef<RealtimeTransport | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextIdRef = useRef(0);
  const agentOpenIdRef = useRef<number | null>(null);
  const agentDraftRef = useRef("");
  const userOpenIdRef = useRef<number | null>(null);
  const userDraftRef = useRef("");
  const closeTimersRef = useRef<Record<RealtimeRole, ReturnType<typeof setTimeout> | null>>({ user: null, assistant: null });
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
  // True from the moment we commit a turn (send commit + response.create)
  // until the provider reports it done/cancelled. See MIN_SPEECH_CONFIRM_MS
  // above for why: while this is true, new speech is a barge-in (cancel),
  // never a second commit.
  const responsePendingRef = useRef(false);

  const clearCloseTimer = (role: RealtimeRole) => {
    const timer = closeTimersRef.current[role];
    if (timer) clearTimeout(timer);
    closeTimersRef.current[role] = null;
  };

  const mergeText = (current: string, delta: string) => {
    if (!delta) return current;
    if (!current) return delta;
    if (delta.startsWith(current)) return delta;
    if (current.endsWith(delta)) return current;
    const maxOverlap = Math.min(current.length, delta.length);
    for (let i = maxOverlap; i > 0; i--) {
      if (current.slice(-i) === delta.slice(0, i)) return current + delta.slice(i);
    }
    return current + delta;
  };

  const appendTurnDelta = (
    role: RealtimeRole,
    delta: string,
    openIdRef: React.MutableRefObject<number | null>,
    draftRef: React.MutableRefObject<string>,
    allowClosedMerge = false,
  ) => {
    if (!delta) return;
    clearCloseTimer(role);
    setMsgs((old) => {
      if (openIdRef.current !== null) {
        draftRef.current = mergeText(draftRef.current, delta);
        return old.map((m) => (m.id === openIdRef.current ? { ...m, text: draftRef.current } : m));
      }
      const last = lastClosedRef.current[role];
      if (allowClosedMerge && last.id !== null && Date.now() - last.at <= CLOSED_TURN_MERGE_WINDOW_MS) {
        openIdRef.current = last.id;
        draftRef.current = mergeText(last.text, delta);
        return old.map((m) => (m.id === last.id ? { ...m, text: draftRef.current } : m));
      }
      const id = nextIdRef.current++;
      openIdRef.current = id;
      draftRef.current = delta;
      return [...old, { id, role, text: draftRef.current }];
    });
  };

  const closeTurn = (role: RealtimeRole, openIdRef: React.MutableRefObject<number | null>, draftRef: React.MutableRefObject<string>) => {
    clearCloseTimer(role);
    if (openIdRef.current !== null) {
      lastClosedRef.current[role] = { id: openIdRef.current, text: draftRef.current, at: Date.now() };
    }
    openIdRef.current = null;
    draftRef.current = "";
  };

  const scheduleCloseTurn = (role: RealtimeRole, openIdRef: React.MutableRefObject<number | null>, draftRef: React.MutableRefObject<string>, delayMs: number) => {
    clearCloseTimer(role);
    closeTimersRef.current[role] = setTimeout(() => closeTurn(role, openIdRef, draftRef), delayMs);
  };

  const handleEvent = (data: Record<string, unknown>) => {
    const type = String(data.type || "");
    if (type === "metric") {
      setMetrics((old) => [...old.slice(-7), { event: String(data.event || "metric"), elapsed_ms: Number(data.elapsed_ms || 0) }]);
      if (data.event === "transport_ready") setState("provider_connecting");
      return;
    }
    if (type === "provider_ready" || type === "ready") {
      wasReadyRef.current = true;
      reconnectAttemptsRef.current = 0;
      setReconnectAttempt(0);
      setState("ready");
      return;
    }
    if (type === "error") {
      responsePendingRef.current = false;
      setErrorMsg(String(data.message || ""));
      setState(wasReadyRef.current ? "error" : "unconfigured");
      return;
    }
    if (type === "response.text.delta" || type === "response.audio_transcript.delta") appendTurnDelta("assistant", String(data.delta || ""), agentOpenIdRef, agentDraftRef, true);
    if (type === "response.user_transcript.delta") {
      appendTurnDelta("user", String(data.delta || ""), userOpenIdRef, userDraftRef, true);
      if (data.finished) scheduleCloseTurn("user", userOpenIdRef, userDraftRef, 0);
    }
    if (type === "input_audio_buffer.committed") scheduleCloseTurn("user", userOpenIdRef, userDraftRef, USER_CLOSE_DELAY_MS);
    if (type === "assistant.cancelled") {
      responsePendingRef.current = false;
      closeTurn("assistant", agentOpenIdRef, agentDraftRef);
    }
    if (type === "response.done" || type === "response.audio.done") {
      responsePendingRef.current = false;
      scheduleCloseTurn("assistant", agentOpenIdRef, agentDraftRef, ASSISTANT_CLOSE_DELAY_MS);
      if (!isPlayingRef.current && playbackQueueRef.current.length === 0) setAgentSpeaking(false);
    }
    if (type === "tool_call") setMsgs((old) => [...old, { id: nextIdRef.current++, role: "tool", text: `Calling tool: ${String(data.name || "tool")}...` }]);
    if (type === "tool_result") {
      const name = String(data.name || "tool");
      setMsgs((old) => {
        const idx = [...old].reverse().findIndex((m) => m.role === "tool" && m.text.includes(name));
        if (idx === -1) return old;
        const copy = old.slice();
        copy[old.length - 1 - idx] = { ...copy[old.length - 1 - idx], text: `Tool completed: ${name}` };
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
    nextPlayTimeRef.current = Math.max(audioCtx.currentTime + 0.1, nextPlayTimeRef.current);
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
    activeSourcesRef.current.forEach((s) => { try { s.stop(); } catch {} });
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
  };

  const scheduleReconnect = () => {
    stopVoice();
    if (!wasReadyRef.current || reconnectAttemptsRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) {
      setState("closed");
      return;
    }
    const attempt = reconnectAttemptsRef.current++;
    setReconnectAttempt(attempt + 1);
    setState("connecting");
    reconnectTimerRef.current = setTimeout(() => connect(false), Math.min(1000 * 2 ** attempt, 15000));
  };

  const connect = async (reset = false) => {
    setErrorMsg("");
    if (reset) {
      setMsgs([]);
      setMetrics([]);
      closeTurn("assistant", agentOpenIdRef, agentDraftRef);
      closeTurn("user", userOpenIdRef, userDraftRef);
      lastClosedRef.current = {
        user: { id: null, text: "", at: 0 },
        assistant: { id: null, text: "", at: 0 },
      };
    }
    setState("connecting");
    try {
      const cfg = await fetch(BASE + "/realtime/config", { headers: { "X-VoiceFlow-Session": getSessionId() } }).then((r) => r.json());
      cfgRef.current = cfg;
      if (cfg.auth_required && !authToken()) {
        setErrorMsg("This deployment requires a WebSocket token. Set VITE_VOICEFLOW_INTERNAL_TOKEN or voiceflow.internal_token in localStorage.");
        setState("unconfigured");
        return;
      }
      transportRef.current?.close();
      transportRef.current = cfg.provider === "openai" && cfg.openai_webrtc_available
        ? new OpenAIWebRTCTransport(cfg, { onEvent: handleEvent, onClose: scheduleReconnect, onError: setErrorMsg, onAudio: queueAudioPlayback })
        : new GeminiWebSocketTransport(cfg, { onEvent: handleEvent, onClose: scheduleReconnect, onError: setErrorMsg, onAudio: queueAudioPlayback });
      await transportRef.current.connect();
    } catch (err: any) {
      setErrorMsg(err.message || String(err));
      setState("error");
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
        if (data.type === "speech_started" && (isPlayingRef.current || responsePendingRef.current)) {
          // Genuine barge-in: the agent is either speaking or still
          // generating a reply, and the user started talking again over it.
          // Cancel it instead of letting a second commit pile onto the
          // still-pending one (that overlap is what corrupted the Gemini
          // session and produced the 1011 crash).
          stopAudioPlayback();
          responsePendingRef.current = false;
          transportRef.current?.cancel();
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
    } catch (err: any) {
      stream?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
      playbackCtxRef.current?.close();
      playbackCtxRef.current = null;
      setIsRecording(false);
      setErrorMsg(err.message || String(err));
      setState("error");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Live Agent" sub="Low-latency realtime voice with provider-specific transports and tool calling." />

      {state === "unconfigured" ? (
        <Card>
          <div className="flex items-center gap-3 py-4 text-bad">
            <AlertTriangle size={24} />
            <div>
              <div className="font-semibold text-[15px]">Realtime Not Configured</div>
              <div className="text-[13px] opacity-80">{errorMsg || "Set GEMINI_API_KEY or a real OpenAI Realtime key."}</div>
            </div>
          </div>
        </Card>
      ) : (
        <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
          <Card className="flex flex-1 flex-col p-0 overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${state === "ready" ? "bg-ok" : state === "error" || state === "closed" ? "bg-bad" : "bg-warn animate-pulse"}`} />
                <span className="text-[13px] font-medium text-body">
                  {state === "ready" ? "Agent Ready" : state === "provider_connecting" ? "Provider connecting..." : state === "closed" ? "Disconnected" : state === "error" ? errorMsg || "Session error" : reconnectAttempt ? `Reconnecting (${reconnectAttempt}/${MAX_AUTO_RECONNECT_ATTEMPTS})` : "Connecting..."}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {(state === "error" || state === "closed") && <Button variant="secondary" onClick={() => connect(false)}>Reconnect</Button>}
                <Button variant="secondary" onClick={isRecording ? stopVoice : startVoice} disabled={state !== "ready"}>
                  {isRecording ? <MicOff size={14} className="text-bad" /> : <Mic size={14} />}
                  {isRecording ? "Stop Session" : "Start Session"}
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 relative">
              {msgs.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted">
                  <Mic size={32} className="mb-2 opacity-50" />
                  <p className="text-[14px]">Click Start Session and begin speaking.</p>
                </div>
              )}
              {msgs.map((m) => (
                <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] rounded-xl px-4 py-2 text-[14px] leading-relaxed shadow-sm ${m.role === "user" ? "bg-[var(--accent)] text-white rounded-br-sm" : m.role === "tool" ? "bg-surface-2 text-dim border border-line rounded-bl-sm text-[12px] italic" : "bg-surface-2 text-body border border-line rounded-bl-sm"}`}>
                    {m.text}
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-line bg-surface-2 px-5 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex gap-1 h-3 items-end">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="w-1 bg-[var(--accent)] rounded-t-sm transition-all duration-75" style={{ height: `${Math.max(20, (agentSpeaking ? Math.random() : volume) * 100)}%`, opacity: agentSpeaking || volume > 0.05 ? 1 : 0.3 }} />
                  ))}
                </div>
                <span className="text-[12px] text-muted font-medium">{agentSpeaking ? "Agent speaking" : volume > 0.03 ? "You are speaking" : isRecording ? "Listening" : "Idle"}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted">
                <Activity size={13} />
                <span className="truncate">{metrics.slice(-4).map((m) => `${m.event}: ${m.elapsed_ms}ms`).join(" | ") || "Waiting for metrics"}</span>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
