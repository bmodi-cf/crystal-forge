/**
 * Minimal vitest config for running pure unit tests without the global DB
 * setup. Used when Postgres is not available (e.g., in a git worktree without
 * a running dev environment).
 *
 * Usage: npx vitest run <file> --config vitest.unit.config.ts
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    exclude: ['**/node_modules/**', '**/tests/e2e/**', '**/.next/**'],
    pool: 'forks',
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
    // No globalSetup — avoids the Postgres bootstrap for pure unit tests.
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
