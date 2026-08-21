import { spawn as nodeSpawn } from 'node:child_process';
import { Client } from 'pg';
import { env } from '@/lib/env';

/**
 * Dump and restore for per-forge databases.
 *
 * These shell out to `docker exec` directly rather than going through
 * ContainerManager (spec §1.3): that abstraction is for forge containers, and
 * its exec surfaces only *combined* stdout/stderr — which would corrupt a dump
 * the moment pg_dump emitted a warning. Here stdout and stderr stay separate.
 *
 * The house pattern is scripts/pg-backup.sh: run the client binaries inside the
 * Postgres container. Dumping uses the container's trust socket as the
 * superuser; restoring connects over TCP as the *app role* (spec §1.3), because
 * provisionRole grants no privileges on tables the role did not create.
 */

const SAFE_DBNAME = /^[a-z0-9_]+$/;
const SAFE_HEX = /^[a-f0-9]+$/;
const SAFE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_VERSION = /^v\d+\.\d+\.\d+$/;

export type PgExecDeps = { spawnFn?: typeof nodeSpawn };

/**
 * Resolved at call time, not import time: lib/env.ts parses process.env once
 * when it loads, so a test that points these at another server after import
 * would otherwise be ignored. Mirrors lib/mode.ts, which reads
 * FORGE_DASHBOARD_MODE from process.env for the same reason.
 */
function pgSettings() {
  return {
    container: process.env.PG_CONTAINER ?? env.PG_CONTAINER,
    host: process.env.HARNESS_PG_HOST ?? env.HARNESS_PG_HOST,
    port: Number(process.env.HARNESS_PG_PORT ?? env.HARNESS_PG_PORT),
    user: process.env.HARNESS_PG_USER ?? env.HARNESS_PG_USER,
    password: process.env.HARNESS_PG_PASSWORD ?? env.HARNESS_PG_PASSWORD,
  };
}

function assertSafeDbName(name: string): void {
  if (!SAFE_DBNAME.test(name)) {
    throw new Error(`Refusing to use unsafe database name: ${JSON.stringify(name)}`);
  }
}

type ExecResult = { stdout: Buffer; stderr: string; exitCode: number };

function exec(spawnFn: typeof nodeSpawn, args: string[], stdin?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawnFn('docker', args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout?.on('data', (d: Buffer) => out.push(Buffer.from(d)));
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) =>
      resolve({ stdout: Buffer.concat(out), stderr: err, exitCode: code ?? -1 }),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** Plain-format dump of one forge database, as the container superuser. */
export async function dumpForgeDatabase(
  opts: { dbName: string },
  deps: PgExecDeps = {},
): Promise<string> {
  assertSafeDbName(opts.dbName);
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const settings = pgSettings();
  const res = await exec(spawnFn, [
    'exec', '-i', settings.container,
    'pg_dump', '-U', settings.user, '--no-owner', '--no-privileges',
    '-d', opts.dbName,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(`pg_dump ${opts.dbName} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  if (res.stdout.length === 0) {
    throw new Error(`pg_dump ${opts.dbName} produced an empty dump`);
  }
  return res.stdout.toString('utf8');
}

/**
 * Restore SQL into a forge database as the app role, atomically.
 *
 * `--single-transaction -v ON_ERROR_STOP=1` is what makes the import atomic
 * (spec §6): the data and the marker land together or the database is left
 * untouched and the action is retryable.
 */
export async function restoreForgeDatabase(
  opts: { dbName: string; role: string; password: string; sql: string },
  deps: PgExecDeps = {},
): Promise<void> {
  assertSafeDbName(opts.dbName);
  assertSafeDbName(opts.role);
  if (!SAFE_HEX.test(opts.password)) {
    throw new Error('Refusing to use a password outside the safe hex charset');
  }
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const settings = pgSettings();
  const res = await exec(
    spawnFn,
    [
      'exec', '-i', '-e', `PGPASSWORD=${opts.password}`, settings.container,
      'psql', '-h', 'localhost', '-p', '5432', '-U', opts.role, '-d', opts.dbName,
      '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ],
    opts.sql,
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `psql restore into ${opts.dbName} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
    );
  }
}

/**
 * The marker rows appended to the restore stream (spec §4).
 *
 * `CREATE TABLE` is deliberately NOT `IF NOT EXISTS`: on a second import the
 * statement fails, ON_ERROR_STOP aborts the single transaction, and the
 * once-only guard holds even against two admins clicking at the same moment.
 */
export function seedMarkerSql(bundleDigest: string, version: string): string {
  if (!SAFE_DIGEST.test(bundleDigest)) {
    throw new Error(`Refusing to record unsafe bundle digest: ${JSON.stringify(bundleDigest)}`);
  }
  if (!SAFE_VERSION.test(version)) {
    throw new Error(`Refusing to record unsafe version: ${JSON.stringify(version)}`);
  }
  return [
    'CREATE TABLE _forge_seed (',
    '  bundle_digest text PRIMARY KEY,',
    '  version       text        NOT NULL,',
    '  applied_at    timestamptz NOT NULL DEFAULT now()',
    ');',
    `INSERT INTO _forge_seed (bundle_digest, version) VALUES ('${bundleDigest}', '${version}');`,
    '',
  ].join('\n');
}

/** Superuser connection string for one database on the shared engine. */
function adminUrl(database: string): string {
  const settings = pgSettings();
  const url = new URL('postgres://placeholder/postgres');
  url.username = encodeURIComponent(settings.user);
  url.password = encodeURIComponent(settings.password);
  url.hostname = settings.host;
  url.port = String(settings.port);
  url.pathname = `/${database}`;
  return url.toString();
}

async function queryForgeDb<T>(
  dbName: string,
  fn: (client: Client) => Promise<T>,
): Promise<T | null> {
  assertSafeDbName(dbName);
  const client = new Client({ connectionString: adminUrl(dbName) });
  try {
    await client.connect();
  } catch (err) {
    // No such database yet — the caller treats this as "nothing applied".
    if (/does not exist/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Migration names recorded in the forge database, or null when the database
 * does not exist. Read as the superuser: this powers the migration-parity guard
 * (spec §2), which runs on pilot where no per-forge role login is needed.
 */
export async function readAppliedMigrations(dbName: string): Promise<string[] | null> {
  return queryForgeDb(dbName, async (client) => {
    const exists = await client.query<{ present: string | null }>(
      "SELECT to_regclass('public._prisma_migrations')::text AS present",
    );
    if (!exists.rows[0]?.present) return [];
    const res = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ' +
        'ORDER BY migration_name',
    );
    return res.rows.map((r) => r.migration_name);
  });
}

/** The seed marker, or null when the database or the table is absent. */
export async function readSeedMarker(
  dbName: string,
): Promise<{ bundleDigest: string; version: string } | null> {
  const found = await queryForgeDb(dbName, async (client) => {
    const exists = await client.query<{ present: string | null }>(
      "SELECT to_regclass('public._forge_seed')::text AS present",
    );
    if (!exists.rows[0]?.present) return null;
    const res = await client.query<{ bundle_digest: string; version: string }>(
      'SELECT bundle_digest, version FROM _forge_seed ORDER BY applied_at LIMIT 1',
    );
    const row = res.rows[0];
    return row ? { bundleDigest: row.bundle_digest, version: row.version } : null;
  });
  return found ?? null;
}
