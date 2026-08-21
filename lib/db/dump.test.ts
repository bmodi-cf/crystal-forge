// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from 'pg';
import { dumpForgeDatabase, restoreForgeDatabase, seedMarkerSql } from './dump';
import { PgDatabaseProvisioner } from './pg-provisioner';
import { readAppliedMigrations, readSeedMarker } from './dump';

/** A spawn stub that records argv and drives a scripted child process. */
function fakeSpawn(script: { stdout?: string; stderr?: string; exitCode?: number }): {
  spawnFn: never;
  calls: { cmd: string; args: string[] }[];
  stdin: () => string;
} {
  const calls: { cmd: string; args: string[] }[] = [];
  let written = '';
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { written += d.toString('utf8'); });
    setImmediate(() => {
      if (script.stdout) child.stdout.write(script.stdout);
      if (script.stderr) child.stderr.write(script.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', script.exitCode ?? 0);
    });
    return child;
  }) as never;
  return { spawnFn, calls, stdin: () => written };
}

describe('dumpForgeDatabase', () => {
  it('runs pg_dump in the pg container with --no-owner --no-privileges', async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: 'CREATE TABLE x();\n' });
    const sql = await dumpForgeDatabase({ dbName: 'second_set_of_eyes' }, { spawnFn });

    expect(sql).toBe('CREATE TABLE x();\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('docker');
    expect(calls[0]!.args).toEqual([
      'exec', '-i', 'crystal-forge-pg',
      'pg_dump', '-U', 'crystal', '--no-owner', '--no-privileges',
      '-d', 'second_set_of_eyes',
    ]);
  });

  it('keeps stderr out of the dump text', async () => {
    const { spawnFn } = fakeSpawn({
      stdout: 'CREATE TABLE x();\n',
      stderr: 'pg_dump: warning: something\n',
    });
    const sql = await dumpForgeDatabase({ dbName: 'sse' }, { spawnFn });
    expect(sql).not.toMatch(/warning/);
  });

  it('rejects when pg_dump exits non-zero, quoting stderr', async () => {
    const { spawnFn } = fakeSpawn({ stderr: 'database "nope" does not exist', exitCode: 1 });
    await expect(dumpForgeDatabase({ dbName: 'nope' }, { spawnFn })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects an empty dump rather than shipping a bundle with no data', async () => {
    const { spawnFn } = fakeSpawn({ stdout: '' });
    await expect(dumpForgeDatabase({ dbName: 'sse' }, { spawnFn })).rejects.toThrow(/empty/i);
  });

  it('refuses an unsafe database name', async () => {
    const { spawnFn } = fakeSpawn({ stdout: 'x' });
    await expect(
      dumpForgeDatabase({ dbName: 'sse"; DROP DATABASE x' }, { spawnFn }),
    ).rejects.toThrow(/unsafe/i);
  });
});

describe('restoreForgeDatabase', () => {
  it('runs psql as the app role in one transaction, SQL on stdin', async () => {
    const { spawnFn, calls, stdin } = fakeSpawn({});
    await restoreForgeDatabase(
      { dbName: 'sse', role: 'sse_app', password: 'deadbeef', sql: 'SELECT 1;' },
      { spawnFn },
    );

    expect(calls[0]!.args).toEqual([
      'exec', '-i', '-e', 'PGPASSWORD=deadbeef', 'crystal-forge-pg',
      'psql', '-h', 'localhost', '-p', '5432', '-U', 'sse_app', '-d', 'sse',
      '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ]);
    expect(stdin()).toBe('SELECT 1;');
  });

  it('rejects when psql exits non-zero so the caller knows nothing landed', async () => {
    const { spawnFn } = fakeSpawn({ stderr: 'ERROR:  relation already exists', exitCode: 3 });
    await expect(
      restoreForgeDatabase(
        { dbName: 'sse', role: 'sse_app', password: 'deadbeef', sql: 'x' },
        { spawnFn },
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses a password outside the safe hex charset', async () => {
    const { spawnFn } = fakeSpawn({});
    await expect(
      restoreForgeDatabase(
        { dbName: 'sse', role: 'sse_app', password: "x'; rm -rf /", sql: 'x' },
        { spawnFn },
      ),
    ).rejects.toThrow(/hex/i);
  });
});

describe('seedMarkerSql', () => {
  it('creates the marker table unconditionally so a re-import aborts the transaction', () => {
    const sql = seedMarkerSql('sha256:' + 'a'.repeat(64), 'v1.0.0');
    expect(sql).toMatch(/CREATE TABLE _forge_seed/);
    expect(sql).not.toMatch(/IF NOT EXISTS/);
    expect(sql).toMatch(/INSERT INTO _forge_seed/);
    expect(sql).toContain('a'.repeat(64));
    expect(sql).toContain('v1.0.0');
  });

  it('refuses values outside the shapes it can safely inline', () => {
    expect(() => seedMarkerSql("sha256:'; DROP TABLE x; --", 'v1.0.0')).toThrow();
    expect(() => seedMarkerSql('sha256:' + 'a'.repeat(64), "v1'; DROP")).toThrow();
  });
});

describe('restoreForgeDatabase (integration)', () => {
  const DB = '_test_bundle_restore';
  const ROLE = '_test_bundle_restore_app';
  const PASSWORD = 'abcdef0123456789abcdef01';
  let provisioner: PgDatabaseProvisioner;

  function pgConfig() {
    const url = new URL(process.env.DATABASE_URL!);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  /** Connect to `database` as the superuser. */
  async function asAdmin<T>(database: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }

  beforeEach(async () => {
    // dump.ts reads env.HARNESS_PG_* / env.PG_CONTAINER; point them at the test
    // server, which is the same container on the same host port.
    const cfg = pgConfig();
    process.env.HARNESS_PG_HOST = cfg.host;
    process.env.HARNESS_PG_PORT = String(cfg.port);
    process.env.HARNESS_PG_USER = cfg.user;
    process.env.HARNESS_PG_PASSWORD = cfg.password;

    provisioner = new PgDatabaseProvisioner(cfg);
    await provisioner.dropDatabase(DB);
    await provisioner.dropRole(ROLE);
    await provisioner.createDatabase(DB);
    await provisioner.provisionRole(DB, ROLE);
    await provisioner.setRolePassword(ROLE, PASSWORD);
  });

  afterEach(async () => {
    await provisioner.dropDatabase(DB);
    await provisioner.dropRole(ROLE);
  });

  it('restores as the app role, which then owns and can write the tables', async () => {
    const sql =
      'CREATE TABLE "ReviewDocument" (id text PRIMARY KEY, name text NOT NULL);\n' +
      "INSERT INTO \"ReviewDocument\" (id, name) VALUES ('doc-1', 'A1.pdf');\n" +
      'CREATE TABLE _prisma_migrations (migration_name text PRIMARY KEY, finished_at timestamptz);\n' +
      "INSERT INTO _prisma_migrations VALUES ('20260801120000_init', now());\n";

    await restoreForgeDatabase({
      dbName: DB, role: ROLE, password: PASSWORD,
      sql: sql + seedMarkerSql('sha256:' + 'b'.repeat(64), 'v1.0.0'),
    });

    const owners = await asAdmin(DB, (c) =>
      c.query<{ tablename: string; tableowner: string }>(
        "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
      ),
    );
    expect(owners.rows.length).toBeGreaterThan(0);
    expect(owners.rows.every((r) => r.tableowner === ROLE)).toBe(true);

    // The role can ALTER its own tables — what a later migration needs.
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${DB}`;
    url.username = ROLE;
    url.password = PASSWORD;
    const asRole = new Client({ connectionString: url.toString() });
    await asRole.connect();
    try {
      await asRole.query('ALTER TABLE "ReviewDocument" ADD COLUMN relative_path text');
      const rows = await asRole.query('SELECT id FROM "ReviewDocument"');
      expect(rows.rows).toEqual([{ id: 'doc-1' }]);
    } finally {
      await asRole.end();
    }

    expect(await readAppliedMigrations(DB)).toEqual(['20260801120000_init']);
    expect(await readSeedMarker(DB)).toEqual({
      bundleDigest: 'sha256:' + 'b'.repeat(64),
      version: 'v1.0.0',
    });
  });

  it('leaves the database untouched when any statement fails', async () => {
    await expect(
      restoreForgeDatabase({
        dbName: DB, role: ROLE, password: PASSWORD,
        sql: 'CREATE TABLE ok (id int);\nTHIS IS NOT SQL;\n',
      }),
    ).rejects.toThrow();

    const tables = await asAdmin(DB, (c) =>
      c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"),
    );
    expect(tables.rows).toEqual([]);
  });

  it('a second restore of the marker aborts the whole transaction', async () => {
    const marker = seedMarkerSql('sha256:' + 'c'.repeat(64), 'v1.0.0');
    await restoreForgeDatabase({ dbName: DB, role: ROLE, password: PASSWORD, sql: marker });

    await expect(
      restoreForgeDatabase({
        dbName: DB, role: ROLE, password: PASSWORD,
        sql: 'CREATE TABLE second_import (id int);\n' + marker,
      }),
    ).rejects.toThrow(/already exists/i);

    const tables = await asAdmin(DB, (c) =>
      c.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' " +
          "AND tablename = 'second_import'",
      ),
    );
    expect(tables.rows).toEqual([]);
  });

  it('readAppliedMigrations is null for a database that does not exist', async () => {
    expect(await readAppliedMigrations('_test_bundle_absent')).toBeNull();
  });
});
