import { z } from 'zod';

const baseSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(16),
  // Optional. When set, Auth.js pins every redirect (e.g. post-logout) to this
  // origin, overriding the per-request host. Leave it unset so `trustHost: true`
  // infers the origin from the request — correct on any local port (:3030, :80)
  // and behind the TLS reverse proxy (via X-Forwarded-Host). Only set it to
  // force a fixed public origin. Read directly by next-auth from process.env;
  // declared here only so env validation doesn't reject it.
  NEXTAUTH_URL: z.string().url().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().default(''),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().default(''),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z
    .string()
    .url()
    .default('https://login.microsoftonline.com/common/v2.0'),
  AUTH_DEV_USERS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // GitHub integration
  GITHUB_CLIENT_MODE: z.enum(['real', 'fake']).default('real'),
  GITHUB_REPO_OWNER: z.string().min(1, 'GITHUB_REPO_OWNER is required'),
  GITHUB_TEMPLATE_REPO: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'GITHUB_TEMPLATE_REPO must be "owner/repo"'),
  GITHUB_BASE_URL: z.string().url().default('https://github.com'),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),

  // Per-forge database provisioning (shared crystal-forge-pg container).
  HARNESS_PG_HOST: z.string().default('localhost'),
  HARNESS_PG_PORT: z.coerce.number().int().min(1).max(65535).default(5433),
  HARNESS_PG_USER: z.string().default('crystal'),
  HARNESS_PG_PASSWORD: z.string().default('crystal'),
  // Name of the shared Postgres container. Dump/restore run `docker exec` into
  // it (see lib/db/dump.ts), matching scripts/pg-backup.sh's PG_CONTAINER.
  PG_CONTAINER: z.string().default('crystal-forge-pg'),
  DB_PROVISIONER_MODE: z.enum(['real', 'fake']).default('real'),

  // Production dashboard mode. `prod` runs the declarative reconcile loop and
  // disables all edit-mode surfaces; `dev` is the pilot dashboard unchanged.
  FORGE_DASHBOARD_MODE: z.enum(['dev', 'prod']).default('dev'),
  // On-prem registry host that prod pulls pinned forge images from. Also read
  // directly by lib/registry and lib/services/promotions.
  REGISTRY_HOST: z.string().default('registry.crystalfountains.com'),
  // Reconcile-loop cadence in prod mode.
  FORGE_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
  // Host usage sampler (see lib/host/sampler.ts). 0 disables it — set that way
  // in the e2e suite, which seeds deterministic rows instead of waiting 5 min
  // for a real sample.
  FORGE_USAGE_SAMPLE_MS: z.coerce.number().int().min(0).default(300000),
  FORGE_USAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  // Host directory holding per-forge env files (`<slug>.env`), bind-mounted
  // read-only at /app/.env. Prod-host only — forge config never travels in the
  // image. Read at call time by lib/runtime/prod/forge-env-file.ts, mirroring
  // REGISTRY_HOST; declared here so it is documented and validated.
  FORGE_ENV_DIR: z.string().default('/etc/crystal-forge/forge-env'),

  // Forge runtime: where forges run. `docker` spawns per-forge containers;
  // `fake` uses the in-memory ContainerManager (tests/e2e/offline).
  FORGE_RUNTIME_MODE: z.enum(['docker', 'fake']).default('docker'),
  FORGE_RUNTIME_IMAGE: z.string().default('crystal-forge-runtime:latest'),
  FORGE_NETWORK: z.string().default('crystal-forge-net'),
  // Comma-separated hostnames the forge dev server trusts for cross-origin dev
  // requests (Next allowedDevOrigins). Must include the dashboard/pilot host(s).
  FORGE_DEV_ORIGINS: z.string().default('localhost'),
  // How a forge container reaches the shared pg engine (service name on the
  // dedicated docker network — NOT the host-published 5433).
  CONTAINER_PG_HOST: z.string().default('crystal-forge-pg'),
  CONTAINER_PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),

  // Runtime orchestration root. Defaults to ~/.crystal-forge.
  CRYSTAL_FORGE_HOME: z.string().optional(),

  // Runtime WebSocket server (for the embedded Claude Code session).
  CRYSTAL_FORGE_WS_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  CRYSTAL_FORGE_WS_SECRET: z.string().optional(),
  // Public WebSocket URL advertised to browsers. When set (e.g. behind a TLS
  // reverse proxy that exposes the WS on the same origin under a path), the
  // connect route returns this verbatim instead of building a host:port URL.
  // Should be the externally reachable wss:// origin + trailing-slash path.
  CRYSTAL_FORGE_WS_PUBLIC_URL: z.string().url().optional(),
});

const schema = baseSchema.superRefine((val, ctx) => {
  if (val.GITHUB_CLIENT_MODE === 'real') {
    for (const key of [
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_INSTALLATION_ID',
    ] as const) {
      if (!val[key] || val[key]!.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when GITHUB_CLIENT_MODE=real`,
        });
      }
    }
  }

  if (val.NODE_ENV === 'production') {
    const sec = val.CRYSTAL_FORGE_WS_SECRET;
    if (!sec || sec.length < 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['CRYSTAL_FORGE_WS_SECRET'],
        message: 'CRYSTAL_FORGE_WS_SECRET must be at least 16 chars in production',
      });
    }
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    '❌ Invalid environment variables:',
    parsed.error.flatten().fieldErrors,
  );
  throw new Error('Invalid environment configuration');
}

const data = parsed.data;
if (!data.CRYSTAL_FORGE_WS_SECRET) {
  data.CRYSTAL_FORGE_WS_SECRET = 'dev-only-' + 'x'.repeat(16);
}
export const env = data as typeof data & { CRYSTAL_FORGE_WS_SECRET: string };
