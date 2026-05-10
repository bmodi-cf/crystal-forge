import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const HOME = process.env.CRYSTAL_FORGE_HOME ?? './.test-forge-home';
const SLUG = 'aquaflow-designer';
const FORGE_NAME = 'Aquaflow Designer';

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

async function prewarmCloneFixture() {
  const clone = path.resolve(HOME, 'clones', SLUG);
  await fs.mkdir(path.join(clone, '.git'), { recursive: true });
  await fs.mkdir(path.join(clone, 'node_modules'), { recursive: true });
  await fs.writeFile(
    path.join(clone, '.env.example'),
    'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow_designer\n',
  );
  // server.js: a tiny HTTP server that reads PORT from env and responds 200.
  // Written as a file (not node -e) so that pnpm's arg passthrough of
  // --port <N> doesn't get treated as a node CLI flag.
  await fs.writeFile(
    path.join(clone, 'server.js'),
    `require('http').createServer(function(_,res){res.end('Welcome to ${FORGE_NAME}')}).listen(+(process.env.PORT||3000));\n`,
  );
  // package.json: dev script invokes server.js; prisma script is a no-op so
  // ensureClone's `pnpm prisma generate` step exits 0 without needing the CLI.
  await fs.writeFile(
    path.join(clone, 'package.json'),
    JSON.stringify(
      {
        name: SLUG,
        scripts: {
          dev: 'node server.js',
          prisma: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
  );
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  // Wipe any previous run's runtime state + clones.
  await fs.rm(HOME, { recursive: true, force: true });
});

test('start, open, stop a forge', async ({ page, request }) => {
  await devLogin(page, 'maya.chen@crystalfountains.com');

  await prewarmCloneFixture();

  await page.goto('/dashboard');

  const card = page.locator('article', { hasText: FORGE_NAME });
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: /^start$/i }).click();
  await expect(card.getByText(/Running/i)).toBeVisible({ timeout: 60_000 });

  const open = card.getByRole('link', { name: /^open$/i });
  const href = await open.getAttribute('href');
  expect(href).toMatch(/^http:\/\/localhost:30\d\d$/);

  const child = await request.get(href!);
  expect(child.status()).toBe(200);
  expect(await child.text()).toContain(`Welcome to ${FORGE_NAME}`);

  await card.getByRole('button', { name: /^stop$/i }).click();
  await expect(card.getByText(/Stopped/i)).toBeVisible({ timeout: 30_000 });
});
