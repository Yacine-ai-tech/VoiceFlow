# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: voiceflow_specialized.spec.ts >> Phase 4.2 — VoiceFlow UI Workflows >> All main navigation pages render without crash
- Location: e2e/voiceflow_specialized.spec.ts:35:3

# Error details

```
Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://analytics/
Call log:
  - navigating to "https://analytics/", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect, Page } from '@playwright/test';
  2   | 
  3   | /**
  4   |  * VoiceFlow — Comprehensive E2E Suite
  5   |  * Phase 4.2: VoiceFlow Agent Workflows (Audio, STT, WebSocket)
  6   |  * Phase 6: Extended UI/UX
  7   |  * Phase 7: Deep Component Integration
  8   |  */
  9   | 
  10  | const BASE_URL = process.env.VOICEFLOW_URL    || process.env.TEST_BASE_URL || '/';
  11  | const API_URL  = process.env.VOICEFLOW_API_URL || '/';
  12  | const AUTH_URL = process.env.INTELAI_API_URL   || '/';
  13  | 
  14  | async function getAuthToken(request: any): Promise<string> {
  15  |   const resp = await request.post(`${AUTH_URL}/api/login`, {
  16  |     data: { username: 'admin', password: 'fLNtwDH2VaQLbO' }
  17  |   }).catch(() => null);
  18  |   if (resp && resp.ok()) {
  19  |     const body = await resp.json();
  20  |     return body.access_token || body.token || '';
  21  |   }
  22  |   return '';
  23  | }
  24  | 
  25  | async function assertNoReactCrash(page: Page) {
  26  |   const crash = page.locator('text=/An unexpected error occurred|Something went wrong/i');
  27  |   await expect(crash).toHaveCount(0);
  28  | }
  29  | 
  30  | // ─────────────────────────────────────────────────────────────────────────────
  31  | // Phase 4.2 — VoiceFlow UI Workflows
  32  | // ─────────────────────────────────────────────────────────────────────────────
  33  | test.describe('Phase 4.2 — VoiceFlow UI Workflows', () => {
  34  | 
  35  |   test('All main navigation pages render without crash', async ({ page }) => {
  36  |     await page.goto(`${BASE_URL}/`);
  37  |     const routes = ['/analytics', '/analyze', '/history', '/integrations', '/models', '/record', '/speech', '/workspace'];
  38  |     for (const route of routes) {
> 39  |       await page.goto(`${'/'}${route}`);
      |                  ^ Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://analytics/
  40  |       await page.waitForLoadState('domcontentloaded');
  41  |       await assertNoReactCrash(page);
  42  |       console.log(`✅ VoiceFlow ${route} — OK`);
  43  |     }
  44  |   });
  45  | 
  46  |   test('VoiceAgent page renders microphone UI elements', async ({ page }) => {
  47  |     await page.goto(`${BASE_URL}/`);
  48  |     await page.waitForLoadState('domcontentloaded');
  49  |     await assertNoReactCrash(page);
  50  | 
  51  |     // Look for mic button, start recording, or audio visualizer
  52  |     const micEl = page.locator(
  53  |       'button:has-text("Record"), button:has-text("Start"), [data-testid="mic"], [aria-label*="microphone" i], .record-btn'
  54  |     ).first();
  55  | 
  56  |     if (await micEl.isVisible({ timeout: 5000 }).catch(() => false)) {
  57  |       await expect(micEl).toBeVisible();
  58  |       // Click should not crash (in CI with fake mic this is safe)
  59  |       await micEl.click().catch(() => {});
  60  |       await page.waitForTimeout(1500);
  61  |       await assertNoReactCrash(page);
  62  |     }
  63  |   });
  64  | 
  65  |   test('History page shows conversation history table or empty state', async ({ page }) => {
  66  |     await page.goto(`${BASE_URL}/history`);
  67  |     await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  68  |     await assertNoReactCrash(page);
  69  | 
  70  |     const historyEl = page.locator('table, .history-list, text=/no history|no conversations|empty/i').first();
  71  |     if (await historyEl.isVisible({ timeout: 5000 }).catch(() => false)) {
  72  |       await expect(historyEl).toBeVisible();
  73  |     }
  74  |   });
  75  | 
  76  |   test('Analytics page renders chart or empty state', async ({ page }) => {
  77  |     await page.goto(`${BASE_URL}/analytics`);
  78  |     await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  79  |     await assertNoReactCrash(page);
  80  |     const chart = page.locator('canvas, svg, .recharts-responsive-container, .chart').first();
  81  |     if (await chart.isVisible({ timeout: 8000 }).catch(() => false)) {
  82  |       await expect(chart).toBeVisible();
  83  |     }
  84  |   });
  85  | });
  86  | 
  87  | // ─────────────────────────────────────────────────────────────────────────────
  88  | // Phase 4.2 — VoiceFlow API Tests
  89  | // ─────────────────────────────────────────────────────────────────────────────
  90  | test.describe('Phase 4.2 — VoiceFlow API Validation', () => {
  91  | 
  92  |   test('GET /health returns < 500', async ({ request }) => {
  93  |     const resp = await request.get(`${API_URL}/health`).catch(() => null);
  94  |     if (resp) expect(resp.status()).toBeLessThan(500);
  95  |   });
  96  | 
  97  |   test('POST /api/transcribe requires authentication', async ({ request }) => {
  98  |     const audioBuffer = Buffer.alloc(1024, 0); // Minimal fake audio
  99  |     const resp = await request.post(`${API_URL}/api/transcribe`, {
  100 |       multipart: {
  101 |         audio: { name: 'test.wav', mimeType: 'audio/wav', buffer: audioBuffer }
  102 |       }
  103 |     }).catch(() => null);
  104 |     if (resp) expect([401, 403, 422, 404]).toContain(resp.status());
  105 |   });
  106 | 
  107 |   test('POST /api/transcribe with auth token returns non-500', async ({ request }) => {
  108 |     const token = await getAuthToken(request);
  109 |     if (!token) { test.skip(); return; }
  110 | 
  111 |     const audioBuffer = Buffer.alloc(2048, 0);
  112 |     const resp = await request.post(`${API_URL}/api/transcribe`, {
  113 |       headers: { Authorization: `Bearer ${token}` },
  114 |       multipart: {
  115 |         audio: { name: 'test.wav', mimeType: 'audio/wav', buffer: audioBuffer }
  116 |       },
  117 |       timeout: 30000,
  118 |     }).catch(() => null);
  119 |     if (resp) expect(resp.status()).not.toBe(500);
  120 |   });
  121 | 
  122 |   test('GET /api/sessions returns list or auth error', async ({ request }) => {
  123 |     const resp = await request.get(`${API_URL}/api/sessions`).catch(() => null);
  124 |     if (resp) expect([200, 401, 403, 404]).toContain(resp.status());
  125 |   });
  126 | 
  127 |   test('WebSocket /ws/voice endpoint is reachable (connection upgrade)', async ({ page }) => {
  128 |     // Attempt to establish WebSocket via browser page
  129 |     const wsUrl = API_URL.replace('http', 'ws') + '/ws/voice';
  130 |     const result = await page.evaluate(async (wsUrl: string) => {
  131 |       return new Promise<string>((resolve) => {
  132 |         try {
  133 |           const ws = new WebSocket(wsUrl);
  134 |           const timeout = setTimeout(() => { ws.close(); resolve('timeout'); }, 5000);
  135 |           ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve('connected'); };
  136 |           ws.onerror = () => { clearTimeout(timeout); resolve('error'); };
  137 |           ws.onclose = (e) => { clearTimeout(timeout); resolve(`closed:${e.code}`); };
  138 |         } catch (e) {
  139 |           resolve('exception');
```