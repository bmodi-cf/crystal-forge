import { env } from '@/lib/env';
import { FakeDatabaseProvisioner } from './fake-provisioner';
import { PgDatabaseProvisioner } from './pg-provisioner';
import type { DatabaseProvisioner } from './types';

let cached: DatabaseProvisioner | null = null;

export function getDatabaseProvisioner(): DatabaseProvisioner {
  if (cached) return cached;
  if (env.DB_PROVISIONER_MODE === 'fake') {
    cached = new FakeDatabaseProvisioner();
  } else {
    cached = new PgDatabaseProvisioner({
      host: env.HARNESS_PG_HOST,
      port: env.HARNESS_PG_PORT,
      user: env.HARNESS_PG_USER,
      password: env.HARNESS_PG_PASSWORD,
    });
  }
  return cached;
}

/** Test-only. Drops the cached provisioner so the next call re-reads env. */
export function resetDatabaseProvisioner(): void {
  cached = null;
}

export type { DatabaseProvisioner } from './types';
