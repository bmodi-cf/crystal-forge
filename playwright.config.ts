import { defineConfig, devices } from '@playwright/test';

// Launch via ./scripts/e2e.sh, which sets DATABASE_URL to an isolated "_e2e"
// database and picks the port. Never run `playwright test` directly against a
// live deployment: global-setup re-seeds, and it refuses any non-"_e2e" DB.
const PORT = process.env.E2E_PORT ?? '3300';
// The runtime WS server needs its own port too, or the suite collides with a
// live dashboard on the default 3100 (this working copy IS the pilot). Derived
// from PORT so one E2E_PORT isolates the whole stack.
const WS_PORT = String(Number(PORT) + 1);

export default defineConfig({
  testDir: './tests/e2e',
  // Migrate + seed a dedicated e2e DB before any test runs. Unit tests use
  // withCleanDb which truncates everything, so back-to-back
  // `pnpm test && ./scripts/e2e.sh` would otherwise leave E2E with an empty DB.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // `pnpm dev` is `tsx server.ts`, which reads PORT and does NOT parse a `-p`
    // flag — passing one silently left the server on its 3030 default while
    // Playwright polled ${PORT} and timed out. Set the env var it reads.
    command: 'pnpm dev',
    // `port`, not `url`: webServer starts BEFORE globalSetup (it is a plugin
    // task, and plugin setup runs first), so at readiness-check time the e2e
    // database does not exist yet and every page 500s — a status Playwright
    // refuses, deadlocking the run. Waiting on the TCP socket lets globalSetup
    // create, migrate and seed the database before the first test.
    port: Number(PORT),
    // Never adopt a server we didn't start: on the pilot that was the live
    // dashboard on :80, running against the live database.
    reuseExistingServer: false,
    env: {
      // Set by scripts/e2e.sh; global-setup has already refused anything that
      // isn't an isolated "_e2e" database by the time the server boots.
      PORT,
      CRYSTAL_FORGE_WS_PORT: WS_PORT,
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      AUTH_DEV_USERS_ENABLED: 'true',
      GITHUB_CLIENT_MODE: 'fake',
      GITHUB_REPO_OWNER: 'bmodi-cf',
      GITHUB_TEMPLATE_REPO: 'bmodi-cf/crystal-forge-template-webapp',
      GITHUB_BASE_URL: 'https://github.com',
      DB_PROVISIONER_MODE: 'fake',
      FORGE_RUNTIME_MODE: 'fake',
      // The sampler would otherwise write real rows during the suite; the seed
      // supplies deterministic history instead.
      FORGE_USAGE_SAMPLE_MS: '0',
      CRYSTAL_FORGE_HOME: process.env.CRYSTAL_FORGE_HOME ?? `${process.cwd()}/.test-forge-home`,
      PATH: `${process.cwd()}/tests/e2e/fixtures/bin:${process.env.PATH ?? ''}`,
    },
    timeout: 120_000,
  },
});
