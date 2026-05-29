import { z } from 'zod';

const baseSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(16),
  NEXTAUTH_URL: z.string().url(),
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
  DB_PROVISIONER_MODE: z.enum(['real', 'fake']).default('real'),

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
