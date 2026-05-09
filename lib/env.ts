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
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    '❌ Invalid environment variables:',
    parsed.error.flatten().fieldErrors,
  );
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
