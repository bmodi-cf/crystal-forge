// Runs once per worker before test files load. Two jobs:
//   1. Load .env.local so DATABASE_URL etc. are populated.
//   2. Rewrite DATABASE_URL so the database name ends with "_test". This is
//      what makes integration tests safe — even if .env.local points at the
//      live dev database, tests transparently use a dedicated test database.
//      The bootstrap (create / migrate / seed) is handled by
//      vitest.global-setup.ts.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

(function rewriteDatabaseUrlToTest() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; cannot run tests.');
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName) throw new Error('DATABASE_URL has no database name.');
  if (dbName.endsWith('_test')) return;
  parsed.pathname = `/${dbName}_test`;
  process.env.DATABASE_URL = parsed.toString();
})();

import '@testing-library/jest-dom/vitest';

// jsdom does not implement Element.prototype.scrollIntoView. Components that
// auto-scroll (e.g. MessageHistory) call it inside effects, which throws under
// jsdom. Stub it globally so those effects are no-ops in tests.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
