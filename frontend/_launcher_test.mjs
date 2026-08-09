import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('text=Start recording');

const cards = [
  { text: 'Start recording', expectedPath: '/record' },
  { text: 'Analyze a conversation', expectedPath: '/analyze' },
  { text: 'Voice agent', expectedPath: '/agent' },
  { text: 'Text to speech', expectedPath: '/speech' },
];

for (const c of cards) {
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForSelector(`text=${c.text}`);
  await page.click(`text=${c.text}`);
  await page.waitForTimeout(600);
  const url = new URL(page.url());
  const ok = url.pathname === c.expectedPath;
  console.log(`${c.text} -> ${url.pathname} (expected ${c.expectedPath}) ${ok ? 'OK' : 'FAIL'}`);
}

await browser.close();
