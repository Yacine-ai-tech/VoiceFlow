import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `VITE_PROXY_TARGET=http://localhost:8000 npm run dev` proxies API calls to a
// running backend (local uvicorn or the live Render URL). Prod build is same-origin —
// FastAPI serves dist/ itself.
const target = process.env.VITE_PROXY_TARGET || "http://localhost:8000";
const apiPaths = ["/health", "/transcribe", "/tts", "/analyze", "/pipeline", "/meeting", "/call", "/stream", "/realtime", "/docs", "/openapi.json", "/analytics", "/integrations", "/scenarios", "/benchmarks"];

// /analyze, /analytics, /integrations are both page routes (React Router)
// and API paths (POST /analyze, GET /analytics, POST /integrations/relay) —
// same collision the backend's own Sec-Fetch-Mode check resolves for
// /analytics in production. In dev, Vite's proxy has no such check by
// default, so a full page load/refresh on these routes would get proxied
// straight to the backend (which — via its own SPA-fallback route — serves
// the *production* dist/index.html, referencing hashed build assets that
// don't exist in dev). bypass() opts those navigations back out of the
// proxy so Vite serves its own dev index.html instead; XHR/fetch() calls
// from already-loaded page JS (Sec-Fetch-Mode: cors/same-origin) still
// proxy through normally.
const pageRouteCollisions = new Set(["/analyze", "/analytics", "/integrations"]);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      apiPaths.map((p) => [p, {
        target, changeOrigin: true, secure: false, ws: true,
        bypass: pageRouteCollisions.has(p)
          ? (req: any) => (req.headers["sec-fetch-mode"] === "navigate" ? req.url : undefined)
          : undefined,
      }]),
    ),
  },
  build: {
    chunkSizeWarningLimit: 900,

  },
});
