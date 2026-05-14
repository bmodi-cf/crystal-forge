import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['**/node_modules/**', '**/tests/e2e/**', '**/.next/**'],
    // Service tests share one Postgres instance and call withCleanDb to truncate.
    // Running test files in parallel races on the same tables and produces
    // intermittent FK violations. Serialise via a single fork.
    pool: 'forks',
    fileParallelism: false,
    // In CI emit a JUnit XML (consumed by dorny/test-reporter for the
    // Checks-tab drill-down) and use the github-actions reporter for
    // inline failure annotations. Local runs keep the default reporter only.
    reporters: process.env.CI ? ['default', 'junit', 'github-actions'] : ['default'],
    outputFile: {
      junit: './test-results/junit.xml',
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
