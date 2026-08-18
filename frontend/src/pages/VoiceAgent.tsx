import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Settings, AlertTriangle } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip } from "../kit/primitives";

type Msg = { role: "user" | "assistant" | "tool"; text: string; interim?: boolean };

export default function VoiceAgent() {
  const [state, setState] = useState<"connecting" | "ready" | "unconfigured" | "closed" | "error">("connecting");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [userInterim, setUserInterim] = useState("");
  const [volume, setVolume] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const draft = useRef("");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const msgsEndRef = useRef<HTMLDivElement>(null);

  // VAD & Playback states
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastAudioTimeRef = useRef<number>(Date.now());
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const isPlayingRef = useRef(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const connect = () => {
    setState("connecting"); setMsgs([]);
    let wsUrl;
    const baseEnv = import.meta.env.VITE_API_BASE_URL;
    if (baseEnv) {
      wsUrl = baseEnv.replace(/^http/, "ws") + "/realtime";
    } else {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      wsUrl = `${proto}://${location.host}/realtime`;
    }
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    
    ws.onmessage = (m) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(m.data); } catch { return; }
      const type = String(data.type ?? "unknown");

      if (type === "error") {
        setState("unconfigured"); return;
      }
      if (type === "ready") { setState("ready"); return; }
      if (type === "response.text.delta" || type === "response.audio_transcript.delta") {
        setAgentSpeaking(true);
        draft.current += String(data.delta ?? "");
        setMsgs((old) => {
          const rest = old[old.length - 1]?.role === "assistant" ? old.slice(0, -1) : old;
          return [...rest, { role: "assistant", text: draft.current }];
        });
      }
      if (type === "response.audio.delta") {
        const base64 = String(data.delta ?? "");
        queueAudioPlayback(base64);
      }
      if (type === "response.done" || type === "response.audio.done") {
        draft.current = "";
      }
      if (type === "tool_call") {
        const name = String(data.name ?? "tool");
        setMsgs((old) => [...old, { role: "tool", text: `Calling tool: ${name}…` }]);
      }
      if (type === "tool_result") {
        const name = String(data.name ?? "tool");
        setMsgs((old) => {
          const idx = [...old].reverse().findIndex((m) => m.role === "tool" && m.text.includes(name));
          if (idx === -1) return old;
          const realIdx = old.length - 1 - idx;
          const copy = old.slice();
          copy[realIdx] = { role: "tool", text: `Tool completed: ${name}` };
          return copy;
        });
      }
    };
    ws.onclose = () => { setState((s) => (s === "unconfigured" ? s : "closed")); stopVoice(); };
    ws.onerror = () => { setState((s) => (s === "unconfigured" ? s : "error")); stopVoice(); };
  };

  useEffect(() => { connect(); return () => { wsRef.current?.close(); stopVoice(); }; }, []);
  useEffect(() => { msgsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, userInterim, agentSpeaking]);

  const queueAudioPlayback = (base64: string) => {
    if (!audioCtxRef.current) return;
    try {
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }
      
      playbackQueueRef.current.push(float32);
      scheduleNextBuffers();
    } catch (e) {
      console.error("Audio decode error", e);
    }
  };

  const scheduleNextBuffers = () => {
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;

    if (playbackQueueRef.current.length === 0) return;

    isPlayingRef.current = true;
    setAgentSpeaking(true);

    while (playbackQueueRef.current.length > 0) {
      const float32 = playbackQueueRef.current.shift()!;
      const audioBuffer = audioCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);
      
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      
      const currTime = audioCtx.currentTime;
      const startTime = Math.max(currTime, nextPlayTimeRef.current);
      
      source.start(startTime);
      activeSourcesRef.current.push(source);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
      
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
        setTimeout(() => {
          if (playbackQueueRef.current.length === 0 && audioCtxRef.current && audioCtxRef.current.currentTime >= nextPlayTimeRef.current - 0.1) {
            isPlayingRef.current = false;
            setAgentSpeaking(false);
          }
        }, 100);
      };
    }
  };

  const stopAudioPlayback = () => {
    playbackQueueRef.current = [];
    nextPlayTimeRef.current = 0;
    isPlayingRef.current = false;
    setAgentSpeaking(false);
    activeSourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    activeSourcesRef.current = [];
  };

const workletCode = `
class VADProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isSilent = true;
    this.lastAudioTime = Date.now();
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      let sum = 0;
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        sum += channelData[i] * channelData[i];
        pcm16[i] = Math.max(-1, Math.min(1, channelData[i])) * 32767;
      }
      const vol = Math.sqrt(sum / channelData.length);
      
      this.port.postMessage({ type: 'volume', vol });
      
      const now = Date.now();
      if (vol > 0.03) {
        this.lastAudioTime = now;
        if (this.isSilent) {
          this.isSilent = false;
          this.port.postMessage({ type: 'speech_started' });
        }
      } else {
        if (!this.isSilent && now - this.lastAudioTime > 1200) {
          this.isSilent = true;
          this.port.postMessage({ type: 'speech_stopped' });
        }
      }
      
      if (!this.isSilent) {
        this.port.postMessage({ type: 'audio', buffer: pcm16.buffer }, [pcm16.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('vad-processor', VADProcessor);
`;

  const startVoice = async () => {
    // FIX FOR IOS/SAFARI: Create AudioContext synchronously inside the user gesture handler
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AudioCtx({ sampleRate: 24000 });
    audioCtxRef.current = audioCtx;

    // getUserMedia is split into its own try/catch: everything after this point
    // (AudioWorklet, WebSocket, SpeechRecognition) can also throw, and lumping all of
    // it under one catch mislabeled every failure as "Microphone access denied" —
    // including e.g. AudioWorklet being unsupported in the current browser, which has
    // nothing to do with mic permission and sent people down the wrong troubleshooting
    // path (checking app permissions instead of the actual failure).
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException(
          'This browser (or embedded webview) does not expose microphone access — try opening this page in Chrome or Safari directly instead of an in-app browser, and make sure the page is loaded over HTTPS.',
          'NotSupportedError'
        );
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      console.error(err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert('Microphone permission was denied. Check this browser\'s site settings and allow microphone access for this page, then try again.');
      } else if (err.name === 'NotFoundError') {
        alert('No microphone was found on this device.');
      } else {
        alert(`Microphone access failed: ${err.message || err.name || err}`);
      }
      return;
    }
    streamRef.current = stream;

    try {
      nextPlayTimeRef.current = audioCtx.currentTime;

      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, 'vad-processor');
      
      workletNode.port.onmessage = (e) => {
        const data = e.data;
        const ws = wsRef.current;
        const isWsReady = ws && ws.readyState === 1;

        if (data.type === 'volume') {
          setVolume(data.vol);
        } else if (data.type === 'speech_started') {
          if (isPlayingRef.current) {
            stopAudioPlayback();
            if (isWsReady) ws.send(JSON.stringify({ type: "client.speech_started" }));
          }
        } else if (data.type === 'speech_stopped') {
          if (isWsReady) {
            ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
          }
        } else if (data.type === 'audio' && isWsReady) {
          const buffer = new Uint8Array(data.buffer);
          let binary = '';
          for (let i = 0; i < buffer.byteLength; i++) { binary += String.fromCharCode(buffer[i]); }
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(binary) }));
        }
      };
      
      source.connect(workletNode);
      workletNode.connect(audioCtx.destination);
      setIsRecording(true);
      
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (event: any) => {
          let interim = "";
          let final = "";
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) final += event.results[i][0].transcript;
            else interim += event.results[i][0].transcript;
          }
          if (final) {
            setMsgs(m => [...m, { role: "user", text: final }]);
            setUserInterim("");
          } else {
            setUserInterim(interim);
          }
        };
        recognition.start();
        recognitionRef.current = recognition;
      }
    } catch (err) {
      console.error(err);
      alert("Microphone access denied or unsupported.");
    }
  };

  const stopVoice = () => {
    if (!isRecording) return;
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; }
    if (userInterim) {
      setMsgs(m => [...m, { role: "user", text: userInterim }]);
      setUserInterim("");
    }
    setIsRecording(false);
    setVolume(0);
    stopAudioPlayback();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Live Agent"
        sub="Talk to the real-time AI agent. The agent supports tool calls and low-latency audio processing."
      />
      
      {state === "unconfigured" ? (
        <Card>
          <div className="flex items-center gap-3 text-bad py-4">
            <AlertTriangle size={24} />
            <div>
              <div className="font-semibold text-[15px]">API Key Not Configured</div>
              <div className="text-[13px] opacity-80">
                Please set OPENAI_API_KEY or GEMINI_API_KEY in your environment to enable the real-time agent.
              </div>
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
                  {state === "ready" ? "Agent Ready" : state === "error" || state === "closed" ? "Disconnected" : "Connecting..."}
                </span>
              </div>
              <Button variant="secondary" onClick={isRecording ? stopVoice : startVoice} disabled={state !== "ready"}>
                {isRecording ? <MicOff size={14} className="text-bad" /> : <Mic size={14} />}
                {isRecording ? "Stop Session" : "Start Session"}
              </Button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-4 relative">
              {msgs.length === 0 && !userInterim && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted">
                  <Mic size={32} className="mb-2 opacity-50" />
                  <p className="text-[14px]">Click Start Session and begin speaking.</p>
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] rounded-xl px-4 py-2 text-[14px] leading-relaxed shadow-sm ${
                    m.role === "user" 
                      ? "bg-[var(--accent)] text-white rounded-br-sm" 
                      : m.role === "tool"
                      ? "bg-surface-2 text-dim border border-line rounded-bl-sm text-[12px] italic"
                      : "bg-surface-2 text-body border border-line rounded-bl-sm"
                  }`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {userInterim && (
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-xl px-4 py-2 text-[14px] leading-relaxed bg-[var(--accent)]/50 text-white/70 italic rounded-br-sm">
                    {userInterim}...
                  </div>
                </div>
              )}
              <div ref={msgsEndRef} className="h-2" />
            </div>
            
            {isRecording && (
              <div className="border-t border-line bg-surface-2 px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex gap-1 h-3 items-end">
                    {[...Array(5)].map((_, i) => (
                      <div 
                        key={i} 
                        className="w-1 bg-[var(--accent)] rounded-t-sm transition-all duration-75"
                        style={{ height: `${Math.max(20, (agentSpeaking ? Math.random() : volume) * 100)}%`, opacity: agentSpeaking || volume > 0.05 ? 1 : 0.3 }}
                      />
                    ))}
                  </div>
                  <span className="text-[12px] text-muted font-medium">
                    {agentSpeaking ? "Agent is speaking..." : volume > 0.03 ? "You are speaking..." : "Listening..."}
                  </span>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
