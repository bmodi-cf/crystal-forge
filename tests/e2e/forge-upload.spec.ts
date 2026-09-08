import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const HOME = process.env.CRYSTAL_FORGE_HOME ?? `${process.cwd()}/.test-forge-home`;
const SLUG = 'aquaflow-designer';
const FORGE_NAME = 'Aquaflow Designer';

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

/**
 * The clone fixture container-setup expects; without it the start sequence
 * fails before a runtime ever reaches 'running'. Mirrors forge-open.spec.ts.
 */
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

test('uploads a file into the forge workspace from the chat panel', async ({ page }) => {
  test.setTimeout(120_000);

  await devLogin(page, 'maya.chen@crystalfountains.com');
  await prewarm();

  await page.goto('/dashboard');
  // The forge name is static text; the card's launcher link is what opens a
  // forge (and starts it, which the stop-and-reload below then settles).
  await page.locator('article', { hasText: FORGE_NAME })
    .getByRole('link', { name: /claude code workspace/i }).click();
  await expect(page).toHaveURL(/\/forges\/[0-9a-f-]+/);

  // Reset any runtime a previous spec left running so Start is the visible control.
  const forgeId = page.url().match(/\/forges\/([0-9a-f-]+)/)?.[1];
  if (forgeId) {
    await page.request.post(`/api/forges/${forgeId}/stop`).catch(() => { /* not running */ });
    await page.reload();
    await page.waitForLoadState('networkidle');
  }

  // The paperclip is gated on a running forge, so it starts out disabled.
  await expect(page.getByRole('button', { name: /upload files/i })).toBeDisabled();

  await page.getByRole('button', { name: /start forge/i }).click();
  await expect(page.getByText(/Running/i)).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /\+ new/i }).click();
  await expect(page.getByRole('button', { name: /upload files/i })).toBeEnabled({ timeout: 10_000 });

  await page.setInputFiles('input[type=file]', {
    name: 'survey-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from the e2e suite\n'),
  });

  // The progress line reports the resolved repo-relative path. In fake runtime
  // mode there is no real PTY, so this — not the terminal — is the observable
  // contract; the path-into-prompt behaviour is a ChatPanel unit test.
  await expect(page.getByText('uploads/survey-notes.txt')).toBeVisible({ timeout: 15_000 });

  if (forgeId) await page.request.post(`/api/forges/${forgeId}/stop`).catch(() => {});
});
