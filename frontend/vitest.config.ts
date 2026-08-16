import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm test` (vitest run) was failing because vitest's default file glob
// also matched frontend/e2e/*.spec.ts — real Playwright specs written
// against @playwright/test's own test.describe(), which vitest can't
// collect. Scoping `include` to the actual unit-test directory (and
// `exclude` explicitly for clarity) fixes that without touching the e2e
// suite, which is run separately via `npm run test:e2e` (playwright test).
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
