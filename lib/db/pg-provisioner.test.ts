// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from 'pg';
import { PgDatabaseProvisioner } from './pg-provisioner';

const TEST_DB = '_test_provisioner_demo';

function adminConnectionString(): string {
  // Reuse the test process's already-rewritten DATABASE_URL but redirect to
  // the admin "postgres" db. vitest.setup.ts has already pointed
  // DATABASE_URL at <name>_test; same server, different db.
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/postgres';
  return url.toString();
}

async function databaseExists(name: string): Promise<boolean> {
  const c = new Client({ connectionString: adminConnectionString() });
  await c.connect();
  try {
    const res = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return res.rowCount === 1;
  } finally {
    await c.end();
  }
}

async function dropIfExists(name: string): Promise<void> {
  const c = new Client({ connectionString: adminConnectionString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await c.end();
  }
}

describe('PgDatabaseProvisioner (integration)', () => {
  let provisioner: PgDatabaseProvisioner;

  beforeEach(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    provisioner = new PgDatabaseProvisioner({
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await dropIfExists(TEST_DB);
  });

  afterEach(async () => {
    await dropIfExists(TEST_DB);
  });

  it('createDatabase makes the named db appear in pg_database', async () => {
    await provisioner.createDatabase(TEST_DB);
    expect(await databaseExists(TEST_DB)).toBe(true);
  });

  it('dropDatabase removes the named db', async () => {
    await provisioner.createDatabase(TEST_DB);
    expect(await databaseExists(TEST_DB)).toBe(true);
    await provisioner.dropDatabase(TEST_DB);
    expect(await databaseExists(TEST_DB)).toBe(false);
  });

  it('dropDatabase is idempotent on a missing db', async () => {
    await expect(provisioner.dropDatabase(TEST_DB)).resolves.toBeUndefined();
  });

  it('createDatabase throws when the db already exists', async () => {
    await provisioner.createDatabase(TEST_DB);
    await expect(provisioner.createDatabase(TEST_DB)).rejects.toThrow();
  });

  it('refuses unsafe names (defence-in-depth against missing upstream validation)', async () => {
    await expect(provisioner.createDatabase('Bad-Name')).rejects.toThrow(/unsafe/i);
    await expect(provisioner.dropDatabase('"; DROP TABLE--')).rejects.toThrow(/unsafe/i);
  });
});
