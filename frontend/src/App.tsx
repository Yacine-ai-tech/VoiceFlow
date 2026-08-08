import UserGuidePage from './pages/UserGuidePage';
import BenchmarkPage from './pages/BenchmarkPage';
import ApiDocs from './pages/ApiDocs';
import { Component, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { LayoutGrid, Mic, Sparkles, AudioLines, Volume2, History as HistoryIcon, Cpu, Webhook, BarChart3, Code2, BookOpen } from "lucide-react";
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
import Integrations from "./pages/Integrations";
import Analytics from "./pages/Analytics";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  resetKey?: string;
}

class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: { resetKey?: string }, state: ErrorBoundaryState) {
    if (props.resetKey !== state.resetKey) {
      return { hasError: false, error: null, resetKey: props.resetKey };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error("VoiceFlow UI Error caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center text-red-400 bg-red-950/30 rounded-xl border border-red-800/50 m-4">
          <h2 className="text-xl font-bold mb-2">Component Error</h2>
          <p className="text-sm opacity-80 mb-4">{this.state.error?.message || "An unexpected error occurred."}</p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg text-sm transition"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

const NAV = [
  { to: "/", label: "Workspace", icon: LayoutGrid },
  { to: "/record", label: "Record", icon: Mic },
  { to: "/analyze", label: "Analyze", icon: Sparkles },
  { to: "/agent", label: "Voice Agent", icon: AudioLines },
  { to: "/speech", label: "Text to Speech", icon: Volume2 },
  { to: "/integrations", label: "Integrations", icon: Webhook },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/history", label: "History", icon: HistoryIcon },
  { to: "/models", label: "Models", icon: Cpu },
  { to: "/api-docs", label: "API Docs", icon: Code2 },
  { to: "/user-guide", label: "User Guide", icon: BookOpen }
];

export default function App() {
  const [health, setHealth] = useState<"ok" | "down" | "checking">("checking");
  const [attempts, setAttempts] = useState(0);
  const everConnected = useRef(false);

  const check = useCallback(() => {
    setHealth("checking");
    api.health().then(() => { everConnected.current = true; setHealth("ok"); }).catch(() => setHealth("down"));
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
        {health === "down" && attempts >= 6 && !everConnected.current ? (
          <WakingBackend waking={attempts < 6} onRetry={() => setAttempts(0)} />
        ) : (
          <RouteErrorBoundary>
            <Routes>
              <Route path="/" element={<Workspace />} />
              <Route path="/record" element={<Record />} />
              <Route path="/analyze" element={<Analyze />} />
              <Route path="/agent" element={<VoiceAgent />} />
              <Route path="/speech" element={<Speech />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/history" element={<History />} />
              <Route path="/models" element={<Models />} />
              <Route path="/api-docs" element={<ApiDocs />} />
              <Route path="/benchmark" element={<BenchmarkPage />} />
              <Route path="/user-guide" element={<UserGuidePage />} />
              <Route path="*" element={<Workspace />} />
            </Routes>
          </RouteErrorBoundary>
        )}
      </AppShell>
    </BrowserRouter>
  );
}
