// Runs once before the Playwright suite. Creates a dedicated e2e database
// (derived by appending "_e2e" to the configured DATABASE_URL's db name),
// applies migrations, and seeds it.
//
// The seed is deliberate: vitest's withCleanDb truncates everything, so
// back-to-back `pnpm test && ./scripts/e2e.sh` would otherwise leave the suite
// with an empty DB. It used to run against the inherited DATABASE_URL, which on
// a machine where the working copy IS the live deployment (the pilot) wiped the
// real dashboard DB. Hence the hard refusal below: this file will not seed
// anything that isn't an explicit "_e2e" database, no matter how it was
// invoked. ./scripts/e2e.sh sets that up; running `pnpm exec playwright test`
// directly fails here instead of destroying data.
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import { Client } from 'pg';

const SAFE_DBNAME = /^[A-Za-z0-9_]+$/;

export default async function globalSetup(): Promise<void> {
  dotenv.config({ path: '.env.local' });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; cannot bootstrap the e2e DB.');

  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_e2e')) {
    throw new Error(
      `Refusing to seed "${dbName}": the e2e suite only runs against a database ` +
        `whose name ends in "_e2e" (it re-seeds, which destroys existing data). ` +
        `Use ./scripts/e2e.sh, which points DATABASE_URL at "${dbName}_e2e".`,
    );
  }
  if (!SAFE_DBNAME.test(dbName)) {
    throw new Error(`Refusing to create database with unsafe name "${dbName}".`);
  }

  // Create the e2e db if it doesn't exist yet, via the admin "postgres" db on
  // the same server. Database names cannot be parameterised, so the name is
  // whitelisted above before interpolating.
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  const env = {
    ...process.env,
    DATABASE_URL: url,
    GITHUB_CLIENT_MODE: 'fake',
    GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER ?? 'bmodi-cf',
    GITHUB_TEMPLATE_REPO:
      process.env.GITHUB_TEMPLATE_REPO ?? 'bmodi-cf/crystal-forge-template-webapp',
    GITHUB_BASE_URL: process.env.GITHUB_BASE_URL ?? 'https://github.com',
    DB_PROVISIONER_MODE: 'fake',
  };

  console.log(`[e2e setup] Migrating + seeding ${dbName} with fake GitHub mode...`);
  execSync('pnpm prisma migrate deploy', { stdio: 'inherit', env });
  execSync('pnpm db:seed', { stdio: 'inherit', env });
}
