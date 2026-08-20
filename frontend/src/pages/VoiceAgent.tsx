import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Settings, AlertTriangle } from "lucide-react";
import { PageHeader } from "../kit/AppShell";
import { Button, Card, Chip } from "../kit/primitives";

type Msg = { id: number; role: "user" | "assistant" | "tool"; text: string; interim?: boolean };

// How many consecutive auto-reconnect attempts before giving up and falling
// back to the manual "Reconnect" button. Backoff below is capped at 15s, so
// this is ~1.5 minutes of retrying a genuine network blip before asking the
// user to intervene.
const MAX_AUTO_RECONNECT_ATTEMPTS = 6;

export default function VoiceAgent() {
  const [state, setState] = useState<"connecting" | "reconnecting" | "ready" | "unconfigured" | "closed" | "error">("connecting");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [userInterim, setUserInterim] = useState("");
  const [volume, setVolume] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [sessionNotice, setSessionNotice] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  // Tracks whether THIS connection ever reached "ready". An {"type":"error"}
  // event means two very different things depending on when it arrives: before
  // ready, it's a real startup misconfiguration (missing API key etc); after
  // ready, it's a mid-session failure (e.g. the upstream realtime relay dying —
  // see api.py's _gemini_to_client) and the session was working a moment ago.
  // Both used to collapse into the same "unconfigured" state/copy ("API Key Not
  // Configured"), which is actively wrong and misleading for the second case —
  // the key IS configured, something else broke mid-call.
  const wasReadyRef = useRef(false);
  const msgsEndRef = useRef<HTMLDivElement>(null);

  // ── Conversation-history bookkeeping ────────────────────────────────────
  // Each streamed turn (agent OR user) gets one persistent id. Deltas for an
  // OPEN turn update that same msgs entry in place; once a turn closes
  // (agent: response.done: user: input_transcription.finished) the id is
  // cleared so the *next* delta opens a brand-new bubble instead of
  // overwriting/replacing the just-completed one. This replaces the old
  // "is the last message already an assistant message?" heuristic, which
  // silently clobbered the previous full turn's text the moment a new turn's
  // first delta arrived (since the previous turn's message was still last-
  // and-role-assistant at that point).
  const nextIdRef = useRef(0);
  const agentOpenIdRef = useRef<number | null>(null);
  const agentDraftRef = useRef("");
  const userOpenIdRef = useRef<number | null>(null);
  const userDraftRef = useRef("");

  const appendTurnDelta = (
    role: "assistant" | "user",
    delta: string,
    openIdRef: React.MutableRefObject<number | null>,
    draftRef: React.MutableRefObject<string>,
  ) => {
    draftRef.current += delta;
    setMsgs((old) => {
      if (openIdRef.current !== null) {
        return old.map((m) => (m.id === openIdRef.current ? { ...m, text: draftRef.current } : m));
      }
      const id = nextIdRef.current++;
      openIdRef.current = id;
      return [...old, { id, role, text: draftRef.current }];
    });
  };

  const closeTurn = (openIdRef: React.MutableRefObject<number | null>, draftRef: React.MutableRefObject<string>) => {
    openIdRef.current = null;
    draftRef.current = "";
  };

  // ── Reconnect bookkeeping ────────────────────────────────────────────────
  // socketGenRef distinguishes "the socket we just superseded" from "the
  // current socket" so a stale onmessage/onclose/onerror from an old,
  // already-replaced WebSocket can never mutate state on top of a newer
  // connection (or after unmount).
  const socketGenRef = useRef(0);
  const unmountedRef = useRef(false);
  const hadErrorRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Gemini session-resumption handle (see api.py's session_resumption_update
  // handling) — replayed as ?resume=<handle> on the next connect() so a
  // reconnect can resume the SAME underlying Gemini session (full
  // conversational context server-side), not just look continuous in the UI.
  const resumptionHandleRef = useRef<string | null>(null);

  // VAD & Playback states
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastAudioTimeRef = useRef<number>(Date.now());
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const isPlayingRef = useRef(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // resetHistory=true is a genuinely NEW logical session (first mount, or the
  // user explicitly starting over) — clears the conversation and any
  // resumption handle. resetHistory=false is a reconnect of the SAME logical
  // session (auto-retry after a network drop, or the manual Reconnect button
  // after one) — the visible conversation must survive it untouched, and if
  // we have a Gemini session-resumption handle we try to resume server-side
  // too. isAutoRetry distinguishes an internal backoff-scheduled retry from a
  // fresh connect() call, so the backoff counter only resets on a real
  // user/mount-initiated attempt, not on the retries it itself schedules.
  const connect = (resetHistory: boolean = true, isAutoRetry: boolean = false) => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    const myGen = ++socketGenRef.current;
    wasReadyRef.current = false;
    hadErrorRef.current = false;
    setErrorMsg("");
    setSessionNotice("");
    if (!isAutoRetry) { reconnectAttemptsRef.current = 0; setReconnectAttempt(0); }
    if (resetHistory) {
      setMsgs([]);
      agentOpenIdRef.current = null; agentDraftRef.current = "";
      userOpenIdRef.current = null; userDraftRef.current = "";
      resumptionHandleRef.current = null;
    }
    setState(resetHistory ? "connecting" : "reconnecting");

    let wsUrl;
    const baseEnv = import.meta.env.VITE_API_BASE_URL;
    if (baseEnv) {
      wsUrl = baseEnv.replace(/^http/, "ws") + "/realtime";
    } else {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      wsUrl = `${proto}://${location.host}/realtime`;
    }
    if (resumptionHandleRef.current) {
      wsUrl += (wsUrl.includes("?") ? "&" : "?") + "resume=" + encodeURIComponent(resumptionHandleRef.current);
    }
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    const scheduleReconnect = () => {
      if (unmountedRef.current || socketGenRef.current !== myGen) return;
      if (reconnectAttemptsRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) {
        setState(hadErrorRef.current ? "error" : "closed");
        return;
      }
      const attempt = reconnectAttemptsRef.current;
      reconnectAttemptsRef.current = attempt + 1;
      setReconnectAttempt(attempt + 1);
      const delay = Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 500;
      setState("reconnecting");
      reconnectTimerRef.current = setTimeout(() => {
        if (unmountedRef.current) return;
        connect(false, true);
      }, delay);
    };

    ws.onmessage = (m) => {
      if (unmountedRef.current || socketGenRef.current !== myGen) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(m.data); } catch { return; }
      const type = String(data.type ?? "unknown");

      if (type === "error") {
        setErrorMsg(String(data.message ?? ""));
        // Only a pre-ready error is an actual misconfiguration; a post-ready
        // error is a mid-session failure and gets its own state/copy below.
        setState(wasReadyRef.current ? "error" : "unconfigured");
        return;
      }
      if (type === "ready") {
        setState("ready");
        wasReadyRef.current = true;
        reconnectAttemptsRef.current = 0;
        setReconnectAttempt(0);
        setSessionNotice("");
        return;
      }
      if (type === "response.text.delta" || type === "response.audio_transcript.delta") {
        // NOTE: does NOT touch agentSpeaking. Text/transcript deltas and audio
        // deltas are independent event streams (see api.py's _gemini_to_client)
        // and can arrive in either order, including text-only with no audio at
        // all (e.g. a turn that gets cancelled by user barge-in before any
        // audio.delta shows up — see the response.done/cancelled handling
        // below). Setting agentSpeaking here used to have no matching reset:
        // if the stream ever produced a text/transcript delta without a
        // subsequent audio chunk actually finishing playback (which is the
        // ONLY place that clears it, in scheduleNextBuffers' onended callback
        // and stopAudioPlayback()), the "Agent is speaking…" indicator got
        // stuck true forever — most visibly after a stop/restart, where the
        // session resumes mid-turn and the first thing the client sees can be
        // a transcript delta with no accompanying audio. agentSpeaking is now
        // driven solely by actual audio playback state, with a defensive
        // reset below when a turn ends with nothing queued/playing.
        appendTurnDelta("assistant", String(data.delta ?? ""), agentOpenIdRef, agentDraftRef);
      }
      if (type === "response.user_transcript.delta") {
        // The user's own speech, transcribed server-side by Gemini
        // (input_audio_transcription in api.py) — authoritative, unlike the
        // best-effort browser SpeechRecognition interim caption below.
        appendTurnDelta("user", String(data.delta ?? ""), userOpenIdRef, userDraftRef);
        if (data.finished) closeTurn(userOpenIdRef, userDraftRef);
      }
      if (type === "response.audio.delta") {
        const base64 = String(data.delta ?? "");
        queueAudioPlayback(base64);
      }
      if (type === "response.done" || type === "response.audio.done") {
        // A turn that was interrupted mid-stream (barge-in, see api.py's
        // cancel_flag handling) closes here too, so the NEXT turn's deltas
        // always open a fresh bubble instead of appending onto whatever text
        // survived the cut — this is what previously produced garbled,
        // multi-turn-merged transcript text (old tool-call scaffolding /
        // stale partial replies glued onto the start of the next real reply).
        closeTurn(agentOpenIdRef, agentDraftRef);
        // Defensive reset: if nothing is actually queued/playing when a turn
        // ends, the speaking indicator must not be left on.
        if (playbackQueueRef.current.length === 0 && !isPlayingRef.current) {
          setAgentSpeaking(false);
        }
      }
      if (type === "session.resumption_handle") {
        resumptionHandleRef.current = String(data.handle ?? "") || null;
      }
      if (type === "session.go_away") {
        setSessionNotice("Session refreshing shortly — this will reconnect automatically and keep the conversation.");
      }
      if (type === "tool_call") {
        const name = String(data.name ?? "tool");
        setMsgs((old) => [...old, { id: nextIdRef.current++, role: "tool", text: `Calling tool: ${name}…` }]);
      }
      if (type === "tool_result") {
        const name = String(data.name ?? "tool");
        setMsgs((old) => {
          const idx = [...old].reverse().findIndex((m) => m.role === "tool" && m.text.includes(name));
          if (idx === -1) return old;
          const realIdx = old.length - 1 - idx;
          const copy = old.slice();
          copy[realIdx] = { ...copy[realIdx], text: `Tool completed: ${name}` };
          return copy;
        });
      }
    };
    ws.onclose = () => {
      if (unmountedRef.current || socketGenRef.current !== myGen) return;
      stopVoice();
      // Only a session that actually reached "ready" is worth auto-retrying —
      // a close before that is a real startup misconfiguration (bad/missing
      // key), and hammering the server with retries won't fix that. A
      // session that WAS live and dropped (network blip, Gemini-side 1008/
      // 1011 close, the session-duration-limit close production logs show)
      // gets automatic backoff retries instead of leaving the user staring
      // at a dead connection until they notice and click Reconnect.
      if (wasReadyRef.current) {
        scheduleReconnect();
      } else {
        setState(hadErrorRef.current ? "error" : "closed");
      }
    };
    ws.onerror = () => {
      if (unmountedRef.current || socketGenRef.current !== myGen) return;
      // A close event always follows an error event for a browser WebSocket —
      // onclose above is the single place state actually transitions, this
      // just records that the eventual close was error-triggered (vs a clean
      // server-initiated close) so onclose can pick "error" over "closed" copy.
      hadErrorRef.current = true;
    };
  };

  useEffect(() => {
    unmountedRef.current = false;
    connect(true);
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      stopVoice();
    };
  }, []);
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
        // This is a best-effort, browser-local LIVE CAPTION ONLY (support/
        // accuracy varies a lot by browser and isn't even connected to the
        // audio actually sent to Gemini). The authoritative user transcript
        // — the one that's actually appended to conversation history — comes
        // from the server via response.user_transcript.delta (Gemini's own
        // input_audio_transcription, see api.py), not from here. This just
        // clears the interim caption once Web Speech API considers a phrase
        // final; it never writes into msgs itself, so the two sources can't
        // race or produce duplicate bubbles.
        recognition.onresult = (event: any) => {
          let interim = "";
          let sawFinal = false;
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) sawFinal = true;
            else interim += event.results[i][0].transcript;
          }
          setUserInterim(sawFinal ? "" : interim);
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
    setUserInterim("");
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
                {errorMsg || "Please set OPENAI_API_KEY or GEMINI_API_KEY in your environment to enable the real-time agent."}
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
                  {state === "ready" ? "Agent Ready"
                    : state === "reconnecting" ? `Reconnecting… (attempt ${reconnectAttempt}/${MAX_AUTO_RECONNECT_ATTEMPTS})`
                    : state === "error" ? (errorMsg ? `Session error: ${errorMsg}` : "Session error")
                    : state === "closed" ? "Disconnected"
                    : "Connecting..."}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {(state === "error" || state === "closed") && (
                  <Button variant="secondary" onClick={() => connect(false)}>
                    Reconnect
                  </Button>
                )}
                <Button variant="secondary" onClick={isRecording ? stopVoice : startVoice} disabled={state !== "ready"}>
                  {isRecording ? <MicOff size={14} className="text-bad" /> : <Mic size={14} />}
                  {isRecording ? "Stop Session" : "Start Session"}
                </Button>
              </div>
            </div>

            {sessionNotice && (
              <div className="border-b border-line bg-warn/10 px-5 py-2 text-[12px] text-body">
                {sessionNotice}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-5 space-y-4 relative">
              {msgs.length === 0 && !userInterim && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted">
                  <Mic size={32} className="mb-2 opacity-50" />
                  <p className="text-[14px]">Click Start Session and begin speaking.</p>
                </div>
              )}
              {msgs.map((m) => (
                <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
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
