import { spawn as nodeSpawn } from 'node:child_process';
import { Client } from 'pg';
import { env } from '@/lib/env';
import { assertSafeIdentifier, buildAdminUrl } from './identifiers';

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

const SAFE_HEX = /^[a-f0-9]+$/;
const SAFE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_VERSION = /^v\d+\.\d+\.\d+$/;

export type PgExecDeps = { spawnFn?: typeof nodeSpawn };

/**
 * Resolved at call time, not import time: lib/env.ts parses process.env once
 * when it loads, so a test that points these at another server after import
 * would otherwise be ignored. Mirrors lib/mode.ts, which reads
 * FORGE_DASHBOARD_MODE from process.env for the same reason.
 *
 * `||` rather than `??`: an empty-string override (e.g. `PG_CONTAINER=""`)
 * must fall through to the default too, not become `docker exec -i "" …`.
 * The port is guarded separately since `Number('')` is 0 and `Number(bogus)`
 * is NaN — either would otherwise silently win over the validated env value.
 */
function pgSettings() {
  const port = Number(process.env.HARNESS_PG_PORT);
  return {
    container: process.env.PG_CONTAINER || env.PG_CONTAINER,
    host: process.env.HARNESS_PG_HOST || env.HARNESS_PG_HOST,
    port: Number.isFinite(port) && port > 0 ? port : env.HARNESS_PG_PORT,
    user: process.env.HARNESS_PG_USER || env.HARNESS_PG_USER,
    password: process.env.HARNESS_PG_PASSWORD || env.HARNESS_PG_PASSWORD,
  };
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
    // 'close', not 'exit': 'exit' fires as soon as the child process
    // terminates, which can race ahead of unread bytes still sitting in the
    // stdout/stderr pipes for a large dump. 'close' fires only once stdio is
    // fully drained, so Buffer.concat(out) below is guaranteed complete.
    child.once('close', (code) =>
      resolve({ stdout: Buffer.concat(out), stderr: err, exitCode: code ?? -1 }),
    );
    if (stdin !== undefined) {
      // If the child aborts early (e.g. psql under ON_ERROR_STOP hitting the
      // first bad statement) it stops reading stdin. For SQL bigger than the
      // pipe buffer the pending write then fails with EPIPE, emitted as
      // 'error' on the stdin stream — not on `child` — with no listener that
      // is an unhandled stream error that crashes the process. The child's
      // exit code already carries the real failure, so just swallow it here.
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    }
  });
}

/** Plain-format dump of one forge database, as the container superuser. */
export async function dumpForgeDatabase(
  opts: { dbName: string },
  deps: PgExecDeps = {},
): Promise<string> {
  assertSafeIdentifier(opts.dbName, 'database');
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
  assertSafeIdentifier(opts.dbName, 'database');
  assertSafeIdentifier(opts.role, 'role');
  if (!SAFE_HEX.test(opts.password)) {
    throw new Error('Refusing to use a password outside the safe hex charset');
  }
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const settings = pgSettings();
  const res = await exec(
    spawnFn,
    [
      // The password is visible for the duration of this docker exec in the
      // host's process list (/proc/<pid>/cmdline) via the `-e` assignment.
      // Avoiding that would need a PGPASSFILE written inside the container,
      // but stdin here is already occupied by the SQL stream — not worth it
      // for a per-forge password that is rotated on every forge start.
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

async function queryForgeDb<T>(
  dbName: string,
  fn: (client: Client) => Promise<T>,
): Promise<T | null> {
  assertSafeIdentifier(dbName, 'database');
  const settings = pgSettings();
  const client = new Client({ connectionString: buildAdminUrl(settings, dbName) });
  try {
    await client.connect();
  } catch (err) {
    // 3D000 = invalid_catalog_name ("database ... does not exist"): the
    // caller treats this as "nothing applied". Checked by SQLSTATE, not a
    // message regex, so a misconfigured HARNESS_PG_USER (which fails with a
    // different code, e.g. 28P01/28000) is never misread as an absent
    // database — that would make the migration-parity guard see a false
    // "nothing applied" instead of surfacing the real auth failure.
    if ((err as { code?: string } | undefined)?.code === '3D000') return null;
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
  return queryForgeDb(dbName, async (client) => {
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
}
