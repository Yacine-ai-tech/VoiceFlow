import { useEffect, useRef, useState } from "react";
import { Plug, PlugZap, Mic, MicOff, Settings, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type Msg = { role: "user" | "assistant"; text: string; interim?: boolean };

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
      if (type === "response.done" || type === "response.audio.done") {
        setAgentSpeaking(false);
        draft.current = "";
      }
    };
    ws.onclose = () => { setState((s) => (s === "unconfigured" ? s : "closed")); stopVoice(); };
    ws.onerror = () => { setState((s) => (s === "unconfigured" ? s : "error")); stopVoice(); };
  };

  useEffect(() => { connect(); return () => { wsRef.current?.close(); stopVoice(); }; }, []);
  useEffect(() => { msgsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, userInterim]);

  const startVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        let sum = 0;
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
          pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
        }
        setVolume(Math.sqrt(sum / inputData.length));

        const buffer = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < buffer.byteLength; i++) { binary += String.fromCharCode(buffer[i]); }
        const base64 = btoa(binary);
        
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
        }
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
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
    if (audioCtxRef.current) audioCtxRef.current.close();
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; }
    if (userInterim) {
      setMsgs(m => [...m, { role: "user", text: userInterim }]);
      setUserInterim("");
    }
    setIsRecording(false);
    setVolume(0);
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
    }
  };

  const orbScale = isRecording ? 1 + volume * 5 : agentSpeaking ? 1.1 : 1;
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
              <p className="text-2xl font-light tracking-wide text-white/40">Tap the microphone and start speaking.</p>
            </motion.div>
          )}

          <AnimatePresence>
            {msgs.map((m, i) => (
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
            {state !== "ready" ? "Initializing..." : isRecording ? "Listening" : agentSpeaking ? "Speaking" : "Ready"}
          </span>
        </div>
      </div>
    </div>
  );
}
