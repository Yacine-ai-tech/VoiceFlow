# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: voiceflow_specialized.spec.ts >> Phase 4.2 — VoiceFlow API Validation >> WebSocket /ws/voice endpoint is reachable (connection upgrade)
- Location: e2e/voiceflow_specialized.spec.ts:127:3

# Error details

```
Error: expect(received).not.toBe(expected) // Object.is equality

Expected: not "exception"
```

# Test source

```ts
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
  140 |         }
  141 |       });
  142 |     }, wsUrl);
  143 |     // connected = WebSocket works; error/timeout = endpoint down (warn but don't fail hard)
  144 |     console.log(`VoiceFlow WebSocket result: ${result}`);
  145 |     // Any result except 'exception' indicates the server is at least running
> 146 |     expect(result).not.toBe('exception');
      |                        ^ Error: expect(received).not.toBe(expected) // Object.is equality
  147 |   });
  148 | });
  149 | 
  150 | // ─────────────────────────────────────────────────────────────────────────────
  151 | // Phase 7 — VoiceFlow Edge Cases
  152 | // ─────────────────────────────────────────────────────────────────────────────
  153 | test.describe('Phase 7 — VoiceFlow Edge Cases', () => {
  154 | 
  155 |   test('Upload zero-byte audio file: graceful error', async ({ request }) => {
  156 |     const token = await getAuthToken(request);
  157 |     if (!token) { test.skip(); return; }
  158 | 
  159 |     const emptyBuffer = Buffer.alloc(0);
  160 |     const resp = await request.post(`${API_URL}/api/transcribe`, {
  161 |       headers: { Authorization: `Bearer ${token}` },
  162 |       multipart: {
  163 |         audio: { name: 'empty.wav', mimeType: 'audio/wav', buffer: emptyBuffer }
  164 |       }
  165 |     }).catch(() => null);
  166 |     if (resp) {
  167 |       // 400/422 = validation error, 500 = crash (not allowed)
  168 |       expect(resp.status()).not.toBe(500);
  169 |     }
  170 |   });
  171 | 
  172 |   test('Upload non-audio file as audio: graceful rejection', async ({ request }) => {
  173 |     const token = await getAuthToken(request);
  174 |     if (!token) { test.skip(); return; }
  175 | 
  176 |     const pdfBuffer = Buffer.from('%PDF-1.4 fake content', 'utf-8');
  177 |     const resp = await request.post(`${API_URL}/api/transcribe`, {
  178 |       headers: { Authorization: `Bearer ${token}` },
  179 |       multipart: {
  180 |         audio: { name: 'evil.pdf', mimeType: 'application/pdf', buffer: pdfBuffer }
  181 |       }
  182 |     }).catch(() => null);
  183 |     if (resp) expect(resp.status()).not.toBe(500);
  184 |   });
  185 | });
  186 | 
  187 | // ─────────────────────────────────────────────────────────────────────────────
  188 | // Phase 4.2 — VoiceFlow Mocked Transcription Feature Test
  189 | // ─────────────────────────────────────────────────────────────────────────────
  190 | test.describe('Phase 4.2 — VoiceFlow Mocked Features', () => {
  191 | 
  192 |   test('Mock voice transcription via websocket/API', async ({ page }) => {
  193 |     // Intercept transcribe API to return fake transcription
  194 |     await page.route('**/api/transcribe', async route => {
  195 |       const json = { transcript: 'Hello world, this is VoiceFlow live!', duration: 2.5, confidence: 0.98 };
  196 |       await route.fulfill({ json, status: 200, contentType: 'application/json' });
  197 |     });
  198 | 
  199 |     await page.goto(`${BASE_URL}/speech`);
  200 |     await page.waitForLoadState('domcontentloaded');
  201 | 
  202 |     const micEl = page.locator('button:has-text("Record"), button:has-text("Start"), [data-testid="mic"]').first();
  203 |     if (await micEl.isVisible({ timeout: 5000 }).catch(() => false)) {
  204 |       // Start recording
  205 |       await micEl.click();
  206 |       await page.waitForTimeout(1000);
  207 |       
  208 |       // Stop recording (triggering the upload/API call)
  209 |       const stopEl = page.locator('button:has-text("Stop"), [data-testid="stop-mic"]').first();
  210 |       if (await stopEl.isVisible().catch(() => false)) {
  211 |         await stopEl.click();
  212 |       } else {
  213 |         await micEl.click(); // toggle
  214 |       }
  215 |       
  216 |       await page.waitForTimeout(2000);
  217 |       await assertNoReactCrash(page);
  218 |       
  219 |       // Look for the injected text
  220 |       const transcriptEl = page.locator('text=/Hello world/i').first();
  221 |       if (await transcriptEl.isVisible({ timeout: 5000 }).catch(() => false)) {
  222 |         await expect(transcriptEl).toBeVisible();
  223 |       }
  224 |     }
  225 |   });
  226 | });
  227 | 
  228 | // ─────────────────────────────────────────────────────────────────────────────
  229 | // Phase 4.3 — VoiceFlow Deep Interactivity & Mocked Features
  230 | // ─────────────────────────────────────────────────────────────────────────────
  231 | test.describe('Phase 4.3 — Deep Interactivity', () => {
  232 | 
  233 |   test('Setting up third-party integrations (Twilio) mock', async ({ page }) => {
  234 |     await page.route('**/api/integrations', async route => {
  235 |       if (route.request().method() === 'POST') {
  236 |         await route.fulfill({ json: { success: true, id: 'twilio-1' }, status: 200 });
  237 |       } else {
  238 |         await route.fulfill({ json: [], status: 200 });
  239 |       }
  240 |     });
  241 | 
  242 |     await page.goto(`${BASE_URL}/integrations`);
  243 |     await page.waitForLoadState('domcontentloaded');
  244 |     
  245 |     // Check for add integration button
  246 |     const addBtn = page.locator('button:has-text("Add"), button:has-text("Twilio")').first();
```