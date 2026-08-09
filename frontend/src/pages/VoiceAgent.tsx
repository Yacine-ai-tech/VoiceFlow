import { useEffect, useRef, useState } from "react";
import { Plug, PlugZap, Mic, MicOff, Settings, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

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
        setMsgs((old) => [...old, { role: "tool", text: `Calling a tool — ${name}…` }]);
      }
      if (type === "tool_result") {
        const name = String(data.name ?? "tool");
        setMsgs((old) => {
          const idx = [...old].reverse().findIndex((m) => m.role === "tool" && m.text.includes(name));
          if (idx === -1) return old;
          const realIdx = old.length - 1 - idx;
          const copy = old.slice();
          copy[realIdx] = { role: "tool", text: `Tool responded — ${name}` };
          return copy;
        });
      }
    };
    ws.onclose = () => { setState((s) => (s === "unconfigured" ? s : "closed")); stopVoice(); };
    ws.onerror = () => { setState((s) => (s === "unconfigured" ? s : "error")); stopVoice(); };
  };

  useEffect(() => { connect(); return () => { wsRef.current?.close(); stopVoice(); }; }, []);
  useEffect(() => { msgsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, userInterim, agentSpeaking]);

  // Audio Playback Engine
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
        // Remove from active sources
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
        // Send audio chunks ONLY when actively speaking (VAD gating)
        this.port.postMessage({ type: 'audio', buffer: pcm16.buffer }, [pcm16.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('vad-processor', VADProcessor);
`;

  const startVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;
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
      alert("Microphone access denied.");
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

  const orbScale = isRecording && !agentSpeaking ? 1 + volume * 5 : agentSpeaking ? 1.1 + Math.random() * 0.1 : 1;
  const orbColor = agentSpeaking ? "rgba(124, 58, 237, 0.8)" : isRecording ? "rgba(16, 185, 129, 0.8)" : "rgba(255, 255, 255, 0.1)";
  const bgGradient = agentSpeaking 
    ? "radial-gradient(circle at center, rgba(124, 58, 237, 0.15) 0%, rgba(9,9,11,1) 60%)" 
    : isRecording 
    ? "radial-gradient(circle at center, rgba(16, 185, 129, 0.1) 0%, rgba(9,9,11,1) 60%)" 
    : "radial-gradient(circle at center, rgba(255,255,255,0.02) 0%, rgba(9,9,11,1) 50%)";

  if (state === "unconfigured") {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center p-8 bg-[#09090b] text-white">
        <div className="max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 text-center shadow-2xl backdrop-blur-md">
          <Settings size={32} className="mx-auto mb-4 text-rose-400" />
          <h2 className="mb-2 text-xl font-bold">Not Configured</h2>
          <p className="text-sm text-white/50">Set OPENAI_API_KEY or GEMINI_API_KEY in your environment to enable the real-time agent.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-[calc(100vh-64px)] w-full flex-col overflow-hidden bg-[#09090b] text-white">
      <motion.div 
        className="absolute inset-0 z-0 pointer-events-none"
        animate={{ background: bgGradient }}
        transition={{ duration: 0.8 }}
      />

      <header className="relative z-10 flex items-center justify-between p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5 backdrop-blur-xl border border-white/10 shadow-lg">
            {state === "ready" ? <PlugZap size={18} className="text-emerald-400" /> : <Loader2 size={18} className="text-white/50 animate-spin" />}
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white/90">OmniVoice</h1>
            <p className="text-[12px] text-white/40">{state === "ready" ? "Secure WebSocket connected" : "Connecting to relay..."}</p>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col overflow-y-auto px-6 pb-32 pt-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col justify-end space-y-8">
          {msgs.length === 0 && !userInterim && state === "ready" && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center mt-32">
              <p className="text-2xl font-light tracking-wide text-white/40">Tap the microphone and leave it open. Start speaking.</p>
            </motion.div>
          )}

          <AnimatePresence>
            {msgs.map((m, i) => (
              m.role === "tool" ? (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-center"
                >
                  <div className="text-[13px] font-medium tracking-wide text-white/40 uppercase bg-white/5 rounded-full px-3 py-1">
                    {m.text}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div className={`max-w-[80%] text-[24px] font-medium leading-[1.3] tracking-tight ${m.role === "user" ? "text-white/70" : "text-white/95"}`}>
                    {m.text}
                  </div>
                </motion.div>
              )
            ))}
            
            {userInterim && (
              <motion.div 
                key="interim"
                initial={{ opacity: 0 }} 
                animate={{ opacity: 1 }} 
                className="flex justify-end"
              >
                <div className="max-w-[80%] text-[24px] font-medium leading-[1.3] tracking-tight text-white/40 italic">
                  {userInterim} <span className="animate-pulse">_</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div ref={msgsEndRef} className="h-10" />
        </div>
      </main>

      <div className="absolute bottom-0 left-0 right-0 z-20 flex flex-col items-center pb-12 pt-24 bg-gradient-to-t from-[#09090b] via-[#09090b]/90 to-transparent pointer-events-none">
        <div className="relative flex items-center justify-center pointer-events-auto">
          <motion.div 
            className="absolute -z-10 rounded-full blur-3xl"
            animate={{ scale: orbScale, backgroundColor: orbColor, opacity: isRecording || agentSpeaking ? 0.5 : 0.15 }}
            transition={{ type: "spring", stiffness: 100, damping: 10 }}
            style={{ width: '160px', height: '160px' }}
          />
          
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={isRecording ? stopVoice : startVoice}
            disabled={state !== "ready"}
            className={`flex h-[72px] w-[72px] items-center justify-center rounded-full shadow-[0_8px_32px_rgba(0,0,0,0.4)] backdrop-blur-2xl border transition-all duration-300 ${
              isRecording 
                ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400" 
                : "bg-white/10 border-white/20 text-white hover:bg-white/15"
            } disabled:opacity-30`}
          >
            {isRecording ? <MicOff size={28} /> : <Mic size={28} />}
          </motion.button>
        </div>

        <div className="mt-8 flex h-7 items-center rounded-full bg-white/5 px-4 backdrop-blur-xl border border-white/10 pointer-events-auto">
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">
            {state !== "ready" ? "Initializing..." : agentSpeaking ? "Speaking" : isRecording ? "Listening" : "Ready"}
          </span>
        </div>
      </div>
    </div>
  );
}
