/**
 * Provisions Postgres databases inside the harness's shared pg instance.
 * Real impl talks to pg via the @prisma/adapter-pg-friendly node-postgres
 * driver; fake impl keeps an in-memory set for tests.
 */
export interface DatabaseProvisioner {
  /**
   * Creates the named database. Throws on already-exists or any pg error.
   * `name` MUST match /^[a-z0-9_]+$/ — caller is responsible for that
   * (slugToDbName guarantees the shape).
   */
  createDatabase(name: string): Promise<void>;

  /**
   * Compensating action only — drops the named database. Idempotent
   * (no-op on missing).
   */
  dropDatabase(name: string): Promise<void>;
}
