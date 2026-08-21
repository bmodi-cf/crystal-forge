// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
      // Real Node emits 'close' only after stdio is fully drained — this fake
      // just emits it right after 'exit' since dump.ts's exec() now waits on
      // 'close', not 'exit' (see fakeSpawnTruncating for the case that
      // actually separates the two).
      child.emit('close', script.exitCode ?? 0);
    });
    return child;
  }) as never;
  return { spawnFn, calls, stdin: () => written };
}

/**
 * A spawn stub that reproduces the real pg_dump/docker hazard: the child
 * process's 'exit' event can fire before all of its stdout has been drained
 * to us (the OS pipe can still hold unread bytes). Only 'close' is guaranteed
 * to fire after stdio is fully flushed. child.stdout/stderr are plain
 * EventEmitters here (not real streams) so the test controls ordering
 * exactly, rather than relying on Node's stream-scheduling internals.
 */
function fakeSpawnTruncating(payload: string): {
  spawnFn: never;
} {
  const splitPoint = Math.floor(payload.length / 2);
  const first = payload.slice(0, splitPoint);
  const second = payload.slice(splitPoint);
  const spawnFn = ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: PassThrough;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new PassThrough();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(first));
      // The child has terminated, but (per the real docker/pg_dump hazard)
      // the second half of its output has not been delivered to us yet.
      child.emit('exit', 0);
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(second));
        child.stdout.emit('end');
        child.stderr.emit('end');
        child.emit('close', 0);
      });
    });
    return child;
  }) as never;
  return { spawnFn };
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

  it('waits for stdio to close before resolving, so a large dump is not truncated', async () => {
    // Comfortably larger than a pipe buffer (64KB on Linux) so a resolve on
    // 'exit' would race the second half of the data and return a prefix.
    const payload = 'A'.repeat(2 * 1024 * 1024);
    const { spawnFn } = fakeSpawnTruncating(payload);
    const sql = await dumpForgeDatabase({ dbName: 'sse' }, { spawnFn });
    expect(sql).toBe(payload);
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

  it('refuses an unsafe role name', async () => {
    const { spawnFn } = fakeSpawn({});
    await expect(
      restoreForgeDatabase(
        { dbName: 'sse', role: 'sse_app"; DROP ROLE x', password: 'deadbeef', sql: 'x' },
        { spawnFn },
      ),
    ).rejects.toThrow(/unsafe/i);
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
    // dump.ts reads env.HARNESS_PG_* / env.PG_CONTAINER (via process.env at
    // call time) — point them at the test server, which is the same
    // container on the same host port. vi.stubEnv/unstubAllEnvs, not direct
    // assignment: vitest reuses the worker process (pool: 'forks',
    // fileParallelism: false), so a plain assignment here would leak into
    // every test file that runs afterwards in the same worker.
    const cfg = pgConfig();
    vi.stubEnv('HARNESS_PG_HOST', cfg.host);
    vi.stubEnv('HARNESS_PG_PORT', String(cfg.port));
    vi.stubEnv('HARNESS_PG_USER', cfg.user);
    vi.stubEnv('HARNESS_PG_PASSWORD', cfg.password);

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
    vi.unstubAllEnvs();
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

  it('rejects (rather than crashing) when psql aborts on the first statement of an oversized restore', async () => {
    // psql under ON_ERROR_STOP=1 aborts as soon as it hits the bad first
    // statement and stops reading stdin. The filler after it pushes the
    // total payload well past a pipe buffer (64KB on Linux), so our pending
    // write is still in flight when that happens and fails with EPIPE.
    const bogus = 'THIS IS NOT VALID SQL AT ALL;\n';
    const filler = '-- padding line to exceed the pipe buffer\n'.repeat(50_000); // ~2.1MB
    await expect(
      restoreForgeDatabase({ dbName: DB, role: ROLE, password: PASSWORD, sql: bogus + filler }),
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
