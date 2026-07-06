import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { LayoutGrid, Mic, Sparkles, AudioLines, Volume2, History as HistoryIcon, Cpu } from "lucide-react";
import { AppShell } from "./kit/AppShell";
import { WakingBackend } from "./kit/misc";
import { api } from "./lib/api";
import Workspace from "./pages/Workspace";
import Record from "./pages/Record";
import Analyze from "./pages/Analyze";
import VoiceAgent from "./pages/VoiceAgent";
import Speech from "./pages/Speech";
import History from "./pages/History";
import Models from "./pages/Models";

const NAV = [
  { to: "/", label: "Workspace", icon: LayoutGrid },
  { to: "/record", label: "Record", icon: Mic },
  { to: "/analyze", label: "Analyze", icon: Sparkles },
  { to: "/agent", label: "Voice Agent", icon: AudioLines },
  { to: "/speech", label: "Text to Speech", icon: Volume2 },
  { to: "/history", label: "History", icon: HistoryIcon },
  { to: "/models", label: "Models", icon: Cpu },
];

export default function App() {
  const [health, setHealth] = useState<"ok" | "down" | "checking">("checking");
  const [attempts, setAttempts] = useState(0);

  const check = useCallback(() => {
    setHealth("checking");
    api.health().then(() => setHealth("ok")).catch(() => setHealth("down"));
  }, []);

  useEffect(() => { check(); }, [check, attempts]);

  useEffect(() => {
    if (health === "down" && attempts < 6) {
      const t = setTimeout(() => setAttempts((a) => a + 1), 8000);
      return () => clearTimeout(t);
    }
  }, [health, attempts]);

  return (
    <BrowserRouter>
      <AppShell product="VoiceFlow" tagline="AI Speech Intelligence" nav={NAV} health={health}>
        {health !== "ok" && !(health === "checking" && attempts === 0) ? (
          <WakingBackend waking={attempts < 6} onRetry={() => setAttempts(0)} />
        ) : (
          <Routes>
            <Route path="/" element={<Workspace />} />
            <Route path="/record" element={<Record />} />
            <Route path="/analyze" element={<Analyze />} />
            <Route path="/agent" element={<VoiceAgent />} />
            <Route path="/speech" element={<Speech />} />
            <Route path="/history" element={<History />} />
            <Route path="/models" element={<Models />} />
            <Route path="*" element={<Workspace />} />
          </Routes>
        )}
      </AppShell>
    </BrowserRouter>
  );
}
