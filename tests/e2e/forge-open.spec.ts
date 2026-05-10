import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebSocketRoute } from '@playwright/test';

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
    scripts: {
      dev: 'node server.js',
      prisma: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  await fs.writeFile(path.join(clone, 'server.js'),
    `require('http').createServer((_,res)=>res.end('Welcome to ${FORGE_NAME}')).listen(process.env.PORT||3000)\n`);
}

test('open forge → start → new conversation → message round trip → persistence', async ({ page }) => {
  test.setTimeout(120_000);

  // Intercept the Crystal Forge chat WS (ws://localhost:3100/) to inject test input.
  // server.send(msg) sends FROM the test TO the real WS server — as if the page typed it.
  let serverRoute: WebSocketRoute | null = null;
  await page.routeWebSocket(/localhost:3100/, (ws) => {
    const server = ws.connectToServer();
    serverRoute = server;
    // page → server: forward all browser messages to the real server.
    ws.onMessage((msg) => server.send(msg));
    // server → page: forward all server messages back to the browser.
    server.onMessage((msg) => ws.send(msg));
  });

  await devLogin(page, 'maya.chen@crystalfountains.com');
  await prewarm();

  await page.goto('/dashboard');
  await page.locator('article', { hasText: FORGE_NAME }).getByText(FORGE_NAME).click();
  await expect(page).toHaveURL(/\/forges\/[0-9a-f-]+/);

  // Extract forge ID and stop if already running (handles reuseExistingServer state).
  const forgeId = page.url().match(/\/forges\/([0-9a-f-]+)/)?.[1];
  if (forgeId) {
    await page.request.post(`/api/forges/${forgeId}/stop`).catch(() => {/* ignore if not running */});
    // Wait for the stop to settle so Start button is visible.
    await page.reload();
    await page.waitForLoadState('networkidle');
  }

  // Right pane shows Stopped → Start.
  await page.getByRole('button', { name: /start forge/i }).click();
  await expect(page.getByText(/Running/i)).toBeVisible({ timeout: 60_000 });

  // Iframe content reachable through the page object.
  const iframeUrl = await page.locator('iframe').first().getAttribute('src');
  expect(iframeUrl).toMatch(/^http:\/\/localhost:30\d\d$/);

  // Start a new conversation.
  await page.getByRole('button', { name: /\+ new/i }).click();

  // Wait for xterm host and terminal input textarea to be ready (Connected state).
  await expect(page.getByTestId('xterm-host')).toBeVisible();
  await page.getByRole('textbox', { name: /terminal input/i }).waitFor({ state: 'attached' });
  // Wait for the WS to be open (status shows "Connected").
  await expect(page.getByText(/^Connected$/)).toBeVisible({ timeout: 10_000 });

  // Send the prompt via the server-side WS route.
  // server.send(msg) injects the message AS IF the browser page sent it to the WS server.
  // The WS server receives `{ type: 'input', data }` and writes to the PTY stdin.
  if (serverRoute) {
    (serverRoute as WebSocketRoute).send(JSON.stringify({ type: 'input', data: 'hello\r' }));
  }

  // The stub-claude reply should land in the terminal within a few hundred ms.
  await expect(page.locator('body')).toContainText(/you said: hello/i, { timeout: 10_000 });

  // Wait for the transcript watcher to process the JSONL and write to the DB.
  // The watcher polls every 250ms; allow a full second for DB writes to settle.
  await page.waitForTimeout(1_500);

  // Reload — conversation should persist with the auto-derived title.
  await page.reload();
  await expect(page.getByText('hello', { exact: false })).toBeVisible({ timeout: 5_000 });
});
