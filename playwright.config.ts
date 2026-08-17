import { defineConfig, devices } from '@playwright/test';

// Launch via ./scripts/e2e.sh, which sets DATABASE_URL to an isolated "_e2e"
// database and picks the port. Never run `playwright test` directly against a
// live deployment: global-setup re-seeds, and it refuses any non-"_e2e" DB.
const PORT = process.env.E2E_PORT ?? '3300';

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
    command: `pnpm dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    // Never adopt a server we didn't start: on the pilot that was the live
    // dashboard on :80, running against the live database.
    reuseExistingServer: false,
    env: {
      // Set by scripts/e2e.sh; global-setup has already refused anything that
      // isn't an isolated "_e2e" database by the time the server boots.
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      AUTH_DEV_USERS_ENABLED: 'true',
      GITHUB_CLIENT_MODE: 'fake',
      GITHUB_REPO_OWNER: 'bmodi-cf',
      GITHUB_TEMPLATE_REPO: 'bmodi-cf/crystal-forge-template-webapp',
      GITHUB_BASE_URL: 'https://github.com',
      DB_PROVISIONER_MODE: 'fake',
      FORGE_RUNTIME_MODE: 'fake',
      CRYSTAL_FORGE_HOME: process.env.CRYSTAL_FORGE_HOME ?? `${process.cwd()}/.test-forge-home`,
      PATH: `${process.cwd()}/tests/e2e/fixtures/bin:${process.env.PATH ?? ''}`,
    },
    timeout: 120_000,
  },
});
