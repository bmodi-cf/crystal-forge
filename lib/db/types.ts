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

  /**
   * Idempotently create a LOGIN role, grant it privileges on `database`, and
   * REVOKE CONNECT on that database FROM PUBLIC so only this role (and
   * superusers) can connect. Safe to call repeatedly.
   */
  provisionRole(database: string, role: string): Promise<void>;

  /** Set (rotate) the login password for an existing role. */
  setRolePassword(role: string, password: string): Promise<void>;

  /** Drop the role if it exists (compensating action / on forge delete). */
  dropRole(role: string): Promise<void>;
}
