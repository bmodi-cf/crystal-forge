/**
 * Regression test: auth URL banner must persist across polling cycles and
 * after clicking the terminal.
 *
 * Root cause that was fixed: useChatSession returned a new object literal on
 * every render, causing the terminal useEffect (which depended on [session])
 * to fire every 2 s when useConversationMessages polled for new messages.
 * Each firing disposed and recreated the terminal and its onData handler,
 * clearing any in-flight state including the auth URL capture.
 */

import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const HOME = process.env.CRYSTAL_FORGE_HOME ?? `${process.cwd()}/.test-forge-home`;
const SLUG = 'aquaflow-designer';
const FORGE_NAME = 'Aquaflow Designer';

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

async function prewarm() {
  const clone = path.resolve(HOME, 'clones', SLUG);
  await fs.mkdir(path.join(clone, '.git'), { recursive: true });
  await fs.mkdir(path.join(clone, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(clone, '.env.example'), 'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow_designer\n');
  await fs.writeFile(path.join(clone, 'package.json'), JSON.stringify({
    name: SLUG,
    scripts: { dev: 'node server.js', prisma: 'node -e "process.exit(0)"' },
  }, null, 2));
  await fs.writeFile(
    path.join(clone, 'server.js'),
    `require('http').createServer((_,res)=>res.end('ok')).listen(+(process.env.PORT||3000));\n`,
  );
}

test.describe('auth URL banner', () => {
  test.setTimeout(120_000);

  test('banner appears and persists across polling cycles and terminal click', async ({ page }) => {
    // Capture the page-side WebSocket route so we can inject server→browser frames.
    let pageRoute: WebSocketRoute | null = null;

    await page.routeWebSocket(/localhost:\d+/, (ws) => {
      const server = ws.connectToServer();
      pageRoute = ws; // page-side: calling ws.send() pushes data TO the browser
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    await devLogin(page, 'maya.chen@crystalfountains.com');
    await prewarm();

    // Navigate to the forge page.
    await page.goto('/dashboard');
    // The forge name is static text; the card's launcher link is what opens a
    // forge (and starts it, which the stop-and-reload below then settles).
    await page.locator('article', { hasText: FORGE_NAME })
      .getByRole('link', { name: /claude code workspace/i }).click();
    await expect(page).toHaveURL(/\/forges\/[0-9a-f-]+/);

    const forgeId = page.url().match(/\/forges\/([0-9a-f-]+)/)?.[1];
    if (forgeId) {
      await page.request.post(`/api/forges/${forgeId}/stop`).catch(() => {});
      await page.reload();
      await page.waitForLoadState('networkidle');
    }

    await page.getByRole('button', { name: /start forge/i }).click();
    await expect(page.getByText(/Running/i)).toBeVisible({ timeout: 60_000 });

    // Start a new conversation and wait for the WS to open.
    await page.getByRole('button', { name: /\+ new/i }).click();
    await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^Connected$/)).toBeVisible({ timeout: 15_000 });

    // Inject a fake PTY chunk containing the Claude Code auth URL.
    // pageRoute.send() pushes a raw string from "server" to the browser.
    expect(pageRoute).not.toBeNull();
    pageRoute!.send('Please visit https://claude.ai/oauth/authorize?code=abc123 to authenticate.\r\n');

    // Banner should appear almost immediately.
    await expect(page.getByText(/Authentication required/i)).toBeVisible({ timeout: 3_000 });
    const link = page.getByRole('link', { name: /claude\.ai\/oauth/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://claude.ai/oauth/authorize?code=abc123');

    // Wait for 2+ polling cycles (useConversationMessages polls every 2 s).
    // Before the fix these cycles would destroy and recreate the terminal,
    // losing the auth URL state.
    await page.waitForTimeout(5_000);

    // Banner must still be visible — not cleared by polling.
    await expect(page.getByText(/Authentication required/i)).toBeVisible();
    await expect(link).toBeVisible();

    // Clicking the message textarea must NOT dismiss the banner.
    await page.getByRole('textbox').click();
    await expect(page.getByText(/Authentication required/i)).toBeVisible();
    await expect(link).toBeVisible();

    // Clicking the dismiss button should clear the banner.
    await page.getByRole('button', { name: /dismiss/i }).click();
    await expect(page.getByText(/Authentication required/i)).not.toBeVisible();
  });
});
