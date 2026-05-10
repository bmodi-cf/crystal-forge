import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7's CLI (with prisma.config.ts) no longer auto-loads .env files,
// and the schema's `datasource` block can no longer hold a `url`.
// dotenv handles multi-line quoted values (e.g. PEM keys) — a hand-rolled
// line-splitter does not. override:false preserves the precedence we want:
// shell-exported vars beat .env.local, which beats .env.
loadDotenv({ path: resolve(process.cwd(), '.env.local'), override: false });
loadDotenv({ path: resolve(process.cwd(), '.env'),       override: false });

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
