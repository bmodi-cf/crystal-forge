// Runs once before any test workers start. Creates a dedicated test database
// (derived by appending "_test" to the configured DATABASE_URL's db name),
// applies Prisma migrations, and runs the seed. The per-worker
// vitest.setup.ts then rewrites DATABASE_URL so all test code targets this
// database — never the configured dev/prod database, regardless of its name.
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import { Client } from 'pg';

const SAFE_DBNAME = /^[A-Za-z0-9_]+$/;

export default async function setup(): Promise<void> {
  dotenv.config({ path: '.env.local' });
  const original = process.env.DATABASE_URL;
  if (!original) throw new Error('DATABASE_URL is not set; cannot bootstrap test DB.');

  const parsed = new URL(original);
  const baseDbName = parsed.pathname.replace(/^\//, '');
  if (!baseDbName) throw new Error('DATABASE_URL has no database name.');
  const testDbName = baseDbName.endsWith('_test') ? baseDbName : `${baseDbName}_test`;
  if (!SAFE_DBNAME.test(testDbName)) {
    throw new Error(`Refusing to create database with unsafe name "${testDbName}".`);
  }

  // Connect to the admin "postgres" db on the same server to create the test
  // db if it doesn't exist yet. Database names cannot be parameterised, so
  // we whitelist the name above before interpolating.
  const adminUrl = new URL(original);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [testDbName],
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${testDbName}"`);
    }
  } finally {
    await admin.end();
  }

  // Run migrations + seed against the test DB. Prisma reads DATABASE_URL
  // from env, so we override it for these child processes only — the
  // current process keeps the original (the per-worker setup file does
  // its own rewrite for tests).
  const testUrl = new URL(original);
  testUrl.pathname = `/${testDbName}`;
  const testEnv = { ...process.env, DATABASE_URL: testUrl.toString() };

  execSync('pnpm prisma migrate deploy', { env: testEnv, stdio: 'inherit' });
  execSync('pnpm db:seed', { env: testEnv, stdio: 'inherit' });
}
