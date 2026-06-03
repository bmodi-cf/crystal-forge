import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Seed the dev DB before any test runs. Unit tests use withCleanDb which
  // truncates everything, so back-to-back `pnpm test && pnpm e2e` would
  // otherwise leave E2E with an empty DB.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm dev -p 80',
    url: 'http://localhost',
    reuseExistingServer: !process.env.CI,
    env: {
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
