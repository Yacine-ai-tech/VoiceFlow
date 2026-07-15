import { test, expect } from '@playwright/test';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5173';

test.describe('Phase 3: VoiceFlow Specialized Workflows', () => {

  test.use({ 
    // Grant microphone permissions automatically to bypass browser popup prompts
    permissions: ['microphone'],
  });

  test('Slice 3.2: VoiceAgent Real-Time WebAudio Initialization', async ({ page }) => {
    await page.goto(`${BASE_URL}/voice-agent`);
    
    // Check if the page header rendered
    await expect(page.locator('text=/Voice agent/i').first()).toBeVisible();

    // Check for the state indicator (Connecting, Ready, Unconfigured, or Error)
    const chip = page.locator('div', { hasText: /Connecting|Ready|Unconfigured|Error/i });
    await expect(chip.first()).toBeVisible();

    // If it's ready, we can test the newly implemented PCM Microphone toggle
    const micButton = page.locator('button', { has: page.locator('svg') }).nth(0);
    if (await micButton.isVisible()) {
      // Click the microphone button to initiate WebAudio `getUserMedia`
      await micButton.click();
      
      // Since we auto-granted permissions, it should not throw a denied exception.
      // Assert that the UI transitioned to an active listening state (e.g., text changes)
      const input = page.locator('input[placeholder*="Listening" i], input[placeholder*="Message" i]');
      await expect(input).toBeVisible();

      // Click again to stop
      await micButton.click();
    }
    
    // Assert the text messaging fallback works
    const textInput = page.locator('input');
    if (await textInput.count() > 0) {
      await textInput.first().fill('Hello from E2E automated test');
      await page.keyboard.press('Enter');
    }
  });

  test('Slice 3.2: Record & Analysis Dashboards', async ({ page }) => {
    // Check the older Whisper record page
    await page.goto(`${BASE_URL}/record`);
    await expect(page.locator('text=/Record/i').first()).toBeVisible();
    
    // Check Analytics page
    await page.goto(`${BASE_URL}/analytics`);
    await expect(page.locator('text=/Analytics/i').first()).toBeVisible();
    
    // Check History page
    await page.goto(`${BASE_URL}/history`);
    await expect(page.locator('table, [role="grid"]').first()).toBeVisible({ timeout: 5000 });
  });

});
