/**
 * Shared identifier safety and connection-string helpers for the shared
 * Postgres engine (lib/db/dump.ts and lib/db/pg-provisioner.ts).
 *
 * Both modules decide what a "safe identifier" means for the same engine —
 * database and role names get interpolated directly into SQL (double-quoted
 * identifiers can't be parameterised) and into `docker exec` argv. Keeping one
 * definition here means tightening the rule can't miss a second, divergent
 * copy.
 */

const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

/** Throws if `name` is not a safe Postgres identifier for the given `kind`. */
export function assertSafeIdentifier(name: string, kind: 'database' | 'role'): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to use unsafe ${kind} name: ${JSON.stringify(name)}`);
  }
}

/** Connection string for one database on the shared engine. */
export function buildAdminUrl(
  cfg: { host: string; port: number; user: string; password: string },
  database: string,
): string {
  const url = new URL('postgres://placeholder/postgres');
  url.username = encodeURIComponent(cfg.user);
  url.password = encodeURIComponent(cfg.password);
  url.hostname = cfg.host;
  url.port = String(cfg.port);
  url.pathname = `/${database}`;
  return url.toString();
}
