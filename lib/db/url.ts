import { env } from '@/lib/env';

/** The DATABASE_URL injected into a forge container — role creds, container-network host. */
export function buildScopedDatabaseUrl(opts: { role: string; password: string; database: string }): string {
  return `postgres://${opts.role}:${opts.password}@${env.CONTAINER_PG_HOST}:${env.CONTAINER_PG_PORT}/${opts.database}`;
}
