import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(16),
  NEXTAUTH_URL: z.string().url(),
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().default(''),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().default(''),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z.string().url().default('https://login.microsoftonline.com/common/v2.0'),
  AUTH_DEV_USERS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
