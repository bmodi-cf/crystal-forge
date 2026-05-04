import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7's CLI (with prisma.config.ts) no longer auto-loads .env files,
// and the schema's `datasource` block can no longer hold a `url`.
// We parse .env.local ourselves so that pnpm db:migrate / prisma generate
// pick up the same DATABASE_URL the Next.js app uses.
function loadEnvLocal(filename: string): void {
  try {
    const content = readFileSync(resolve(process.cwd(), filename), 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip surrounding quotes (single or double)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env.local is optional — fall through and let any required vars fail loudly later.
  }
}

loadEnvLocal('.env.local');
loadEnvLocal('.env');

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
