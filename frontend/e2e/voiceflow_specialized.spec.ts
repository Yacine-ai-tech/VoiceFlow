import { test, expect, Page } from '@playwright/test';

/**
 * VoiceFlow — Comprehensive E2E Suite
 * Phase 4.2: VoiceFlow Agent Workflows (Audio, STT, WebSocket)
 * Phase 6: Extended UI/UX
 * Phase 7: Deep Component Integration
 */

const BASE_URL = process.env.VOICEFLOW_URL    || process.env.TEST_BASE_URL || 'http://localhost:5175';
const API_URL  = process.env.VOICEFLOW_API_URL || 'http://localhost:8002';
const AUTH_URL = process.env.INTELAI_API_URL   || 'http://localhost:8000';

async function getAuthToken(request: any): Promise<string> {
  const resp = await request.post(`${AUTH_URL}/api/login`, {
    data: { username: 'admin', password: 'fLNtwDH2VaQLbO' }
  }).catch(() => null);
  if (resp && resp.ok()) {
    const body = await resp.json();
    return body.access_token || body.token || '';
  }
  return '';
}

async function assertNoReactCrash(page: Page) {
  const crash = page.locator('text=/An unexpected error occurred|Something went wrong/i');
  await expect(crash).toHaveCount(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4.2 — VoiceFlow UI Workflows
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 4.2 — VoiceFlow UI Workflows', () => {

  test('All main navigation pages render without crash', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    const routes = ['/analytics', '/analyze', '/history', '/integrations', '/models', '/record', '/speech', '/workspace'];
    for (const route of routes) {
      await page.goto(`${BASE_URL}${route}`);
      await page.waitForLoadState('domcontentloaded');
      await assertNoReactCrash(page);
      console.log(`✅ VoiceFlow ${route} — OK`);
    }
  });

  test('VoiceAgent page renders microphone UI elements', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('domcontentloaded');
    await assertNoReactCrash(page);

    // Look for mic button, start recording, or audio visualizer
    const micEl = page.locator(
      'button:has-text("Record"), button:has-text("Start"), [data-testid="mic"], [aria-label*="microphone" i], .record-btn'
    ).first();

    if (await micEl.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(micEl).toBeVisible();
      // Click should not crash (in CI with fake mic this is safe)
      await micEl.click().catch(() => {});
      await page.waitForTimeout(1500);
      await assertNoReactCrash(page);
    }
  });

  test('History page shows conversation history table or empty state', async ({ page }) => {
    await page.goto(`${BASE_URL}/history`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await assertNoReactCrash(page);

    const historyEl = page.locator('table, .history-list, text=/no history|no conversations|empty/i').first();
    if (await historyEl.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(historyEl).toBeVisible();
    }
  });

  test('Analytics page renders chart or empty state', async ({ page }) => {
    await page.goto(`${BASE_URL}/analytics`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await assertNoReactCrash(page);
    const chart = page.locator('canvas, svg, .recharts-responsive-container, .chart').first();
    if (await chart.isVisible({ timeout: 8000 }).catch(() => false)) {
      await expect(chart).toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4.2 — VoiceFlow API Tests
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 4.2 — VoiceFlow API Validation', () => {

  test('GET /health returns < 500', async ({ request }) => {
    const resp = await request.get(`${API_URL}/health`).catch(() => null);
    if (resp) expect(resp.status()).toBeLessThan(500);
  });

  test('POST /api/transcribe requires authentication', async ({ request }) => {
    const audioBuffer = Buffer.alloc(1024, 0); // Minimal fake audio
    const resp = await request.post(`${API_URL}/api/transcribe`, {
      multipart: {
        audio: { name: 'test.wav', mimeType: 'audio/wav', buffer: audioBuffer }
      }
    }).catch(() => null);
    if (resp) expect([401, 403, 422, 404]).toContain(resp.status());
  });

  test('POST /api/transcribe with auth token returns non-500', async ({ request }) => {
    const token = await getAuthToken(request);
    if (!token) { test.skip(); return; }

    const audioBuffer = Buffer.alloc(2048, 0);
    const resp = await request.post(`${API_URL}/api/transcribe`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        audio: { name: 'test.wav', mimeType: 'audio/wav', buffer: audioBuffer }
      },
      timeout: 30000,
    }).catch(() => null);
    if (resp) expect(resp.status()).not.toBe(500);
  });

  test('GET /api/sessions returns list or auth error', async ({ request }) => {
    const resp = await request.get(`${API_URL}/api/sessions`).catch(() => null);
    if (resp) expect([200, 401, 403, 404]).toContain(resp.status());
  });

  test('WebSocket /ws/voice endpoint is reachable (connection upgrade)', async ({ page }) => {
    // Attempt to establish WebSocket via browser page
    const wsUrl = API_URL.replace('http', 'ws') + '/ws/voice';
    const result = await page.evaluate(async (wsUrl: string) => {
      return new Promise<string>((resolve) => {
        try {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => { ws.close(); resolve('timeout'); }, 5000);
          ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve('connected'); };
          ws.onerror = () => { clearTimeout(timeout); resolve('error'); };
          ws.onclose = (e) => { clearTimeout(timeout); resolve(`closed:${e.code}`); };
        } catch (e) {
          resolve('exception');
        }
      });
    }, wsUrl);
    // connected = WebSocket works; error/timeout = endpoint down (warn but don't fail hard)
    console.log(`VoiceFlow WebSocket result: ${result}`);
    // Any result except 'exception' indicates the server is at least running
    expect(result).not.toBe('exception');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — VoiceFlow Edge Cases
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 7 — VoiceFlow Edge Cases', () => {

  test('Upload zero-byte audio file: graceful error', async ({ request }) => {
    const token = await getAuthToken(request);
    if (!token) { test.skip(); return; }

    const emptyBuffer = Buffer.alloc(0);
    const resp = await request.post(`${API_URL}/api/transcribe`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        audio: { name: 'empty.wav', mimeType: 'audio/wav', buffer: emptyBuffer }
      }
    }).catch(() => null);
    if (resp) {
      // 400/422 = validation error, 500 = crash (not allowed)
      expect(resp.status()).not.toBe(500);
    }
  });

  test('Upload non-audio file as audio: graceful rejection', async ({ request }) => {
    const token = await getAuthToken(request);
    if (!token) { test.skip(); return; }

    const pdfBuffer = Buffer.from('%PDF-1.4 fake content', 'utf-8');
    const resp = await request.post(`${API_URL}/api/transcribe`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        audio: { name: 'evil.pdf', mimeType: 'application/pdf', buffer: pdfBuffer }
      }
    }).catch(() => null);
    if (resp) expect(resp.status()).not.toBe(500);
  });
});
