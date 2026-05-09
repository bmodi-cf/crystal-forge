# Template Web App + Forge Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every forge created by Crystal Forge land in a runnable Next.js repo backed by its own Postgres database. The template repo gets populated with a minimal Next 16 + Tailwind v4 + Prisma 7 app; the harness gains a `DatabaseProvisioner` boundary, extends `GitHubClient` to write `forge.config.json` and `.env.example` into each cloned repo, and refactors `createForge` to orchestrate repo + files + db + row atomically.

**Architecture:** Two-repo change.
1. **Template repo** (`bmodi-cf/crystal-forge-template-webapp`, currently empty) gets a complete welcome-page-only Next.js 16 app whose Server Component reads `forge.config.json` at request time.
2. **Harness repo** (this repo) adds a new `lib/db/` module holding the `DatabaseProvisioner` interface (real `pg` impl + fake), extends `lib/github/` types and clients with a `writeForgeFiles` method (two PUTs to GitHub Contents API with bounded 404 retry), and reshapes `lib/services/forges.ts:createForge` to: create repo → write files → provision database → insert DB row, with compensating `safeDeleteRepo` and `safeDropDatabase` on later-stage failures.

**Tech Stack:** Next 16.2.4, React 19.2.4, Tailwind v4, Prisma 7.8, `pg` 8.20, `@octokit/rest` 22, `@octokit/auth-app` 8, vitest 4, Playwright.

**Two working directories:**
- **Harness repo** (this checkout): `~/work/crystal-forge`. Run all harness commands here unless stated otherwise.
- **Template repo**: a fresh sibling clone of `bmodi-cf/crystal-forge-template-webapp` at `~/work/crystal-forge-template-webapp`. **Phase A only** runs commands inside this directory; the rest of the plan runs back inside the harness.

**Spec reference:** `docs/superpowers/specs/2026-05-08-template-webapp-and-forge-config-design.md`

---

## Phase A — Populate the template repo

End state: a developer can clone `bmodi-cf/crystal-forge-template-webapp`, run `pnpm install && cp .env.example .env.local && ./forge-launch.sh`, and see "Welcome to Forge Template" with the description below at `http://localhost:3000`. No harness changes yet.

### Task A1: Clone the template repo into a sibling working directory

**Files:** None — preparation only.

- [ ] **Step 1: Clone the empty template repo**

```bash
cd ~/work
git clone git@github.com:bmodi-cf/crystal-forge-template-webapp.git
cd crystal-forge-template-webapp
git status
```

Expected: clean tree, only `README.md` (or empty) checked out, `main` branch.

- [ ] **Step 2: Confirm the directory layout**

```bash
ls -la
```

Expected: at most `README.md`, `.git/`. If the directory has unrelated files, stop and ask before overwriting.

---

### Task A2: Add `package.json`

**Files:**
- Create: `~/work/crystal-forge-template-webapp/package.json`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "crystal-forge-template-webapp",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "prisma:generate": "prisma generate"
  },
  "pnpm": {
    "onlyBuiltDependencies": [
      "@prisma/engines",
      "prisma"
    ]
  },
  "dependencies": {
    "@prisma/client": "^7.8.0",
    "next": "16.2.4",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.4",
    "prisma": "^7.8.0",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd ~/work/crystal-forge-template-webapp
pnpm install
```

Expected: pnpm creates `pnpm-lock.yaml` and `node_modules/`. No script execution warnings beyond the expected `@prisma/engines`/`prisma` postinstall messages.

---

### Task A3: Add TypeScript / Next / PostCSS / ESLint configs

**Files:**
- Create: `~/work/crystal-forge-template-webapp/tsconfig.json`
- Create: `~/work/crystal-forge-template-webapp/next.config.ts`
- Create: `~/work/crystal-forge-template-webapp/postcss.config.mjs`
- Create: `~/work/crystal-forge-template-webapp/eslint.config.mjs`
- Create: `~/work/crystal-forge-template-webapp/.gitignore`

- [ ] **Step 1: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 2: `next.config.ts`**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;
```

- [ ] **Step 3: `postcss.config.mjs`**

```mjs
const config = {
  plugins: ['@tailwindcss/postcss'],
};

export default config;
```

- [ ] **Step 4: `eslint.config.mjs`**

```mjs
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import { defineConfig, globalIgnores } from 'eslint/config';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'next-env.d.ts']),
]);

export default eslintConfig;
```

- [ ] **Step 5: `.gitignore`**

```
# dependencies
/node_modules

# next.js
/.next/
/out/

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# env files
.env*.local
.env

# typescript
*.tsbuildinfo
next-env.d.ts
```

---

### Task A4: Add the Prisma scaffold

**Files:**
- Create: `~/work/crystal-forge-template-webapp/prisma/schema.prisma`

- [ ] **Step 1: Write the schema (generator + datasource only — no models)**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- [ ] **Step 2: Sanity-check `prisma generate` works without a DB**

```bash
cd ~/work/crystal-forge-template-webapp
pnpm prisma generate
```

Expected: "Generated Prisma Client" message; exits 0; `node_modules/.prisma/` populated. No DB connection is attempted because there are no models.

---

### Task A5: Add the `forge.config.json` loader

**Files:**
- Create: `~/work/crystal-forge-template-webapp/lib/forge-config.ts`

- [ ] **Step 1: Write the typed loader with shape check**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type ForgeConfig = {
  name: string;
  description: string | null;
  slug: string;
  dbName: string;
  createdAt: string;
};

export async function loadForgeConfig(): Promise<ForgeConfig> {
  const filePath = path.join(process.cwd(), 'forge.config.json');
  const raw = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`forge.config.json at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isForgeConfig(parsed)) {
    throw new Error(`forge.config.json at ${filePath} does not match the expected shape`);
  }
  return parsed;
}

function isForgeConfig(v: unknown): v is ForgeConfig {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === 'string' && o.name.length > 0 &&
    (typeof o.description === 'string' || o.description === null) &&
    typeof o.slug === 'string' && /^[a-z0-9-]+$/.test(o.slug) &&
    typeof o.dbName === 'string' && /^[a-z0-9_]+$/.test(o.dbName) &&
    typeof o.createdAt === 'string' && o.createdAt.length > 0
  );
}
```

---

### Task A6: Add the welcome page (layout + page + globals)

**Files:**
- Create: `~/work/crystal-forge-template-webapp/app/layout.tsx`
- Create: `~/work/crystal-forge-template-webapp/app/page.tsx`
- Create: `~/work/crystal-forge-template-webapp/app/globals.css`

- [ ] **Step 1: `app/globals.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 2: `app/layout.tsx`**

```tsx
import './globals.css';

export const metadata = {
  title: 'Crystal Forge App',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: `app/page.tsx`**

```tsx
import { loadForgeConfig } from '@/lib/forge-config';

export default async function Home() {
  const config = await loadForgeConfig();
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-6xl font-bold">Welcome to {config.name}</h1>
        {config.description && (
          <p className="mt-6 text-xl text-gray-600">{config.description}</p>
        )}
      </div>
    </main>
  );
}
```

---

### Task A7: Add the seed `forge.config.json` and `.env.example`

**Files:**
- Create: `~/work/crystal-forge-template-webapp/forge.config.json`
- Create: `~/work/crystal-forge-template-webapp/.env.example`

- [ ] **Step 1: `forge.config.json` with placeholder values**

```json
{
  "name": "Forge Template",
  "description": "A minimal Crystal Forge web app.",
  "slug": "forge-template",
  "dbName": "forge_template",
  "createdAt": "2026-05-09T00:00:00.000Z"
}
```

- [ ] **Step 2: `.env.example`**

```
# Postgres connection. Points at the harness's crystal-forge-pg container.
# Copy this file to .env.local before running ./forge-launch.sh.
DATABASE_URL=postgres://crystal:crystal@localhost:5433/forge_template
```

---

### Task A8: Add `forge-launch.sh`

**Files:**
- Create: `~/work/crystal-forge-template-webapp/forge-launch.sh`

- [ ] **Step 1: Write the launcher (no docker, no migrate-deploy unless migrations exist, soft pg probe)**

```bash
#!/usr/bin/env bash
# Crystal Forge template app launcher. Adapted from the harness launcher.
# Pre-checks env + node_modules + port, runs prisma generate (and migrate
# deploy if a migrations directory exists), then runs pnpm dev in the
# foreground.
#
# Standalone clone of the template? Set SKIP_PG_CHECK=1 to skip the soft
# pg connectivity probe.

set -euo pipefail
cd "$(dirname "$0")"

DEV_PORT=3000
URL="http://localhost:${DEV_PORT}"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
[[ -f package.json && -d prisma ]] \
  || fail "Run this from the template repo root."
[[ -f .env.local ]] \
  || fail ".env.local missing. Copy .env.example to .env.local first."
[[ -d node_modules ]] \
  || fail "node_modules missing. Run 'pnpm install' first."

# --- port collision --------------------------------------------------------
DEV_PID=$(lsof -nP -iTCP:${DEV_PORT} -sTCP:LISTEN -t 2>/dev/null || true)
[[ -z "$DEV_PID" ]] \
  || fail "Port ${DEV_PORT} is already in use by PID ${DEV_PID}. Stop it first."

# --- soft pg probe ---------------------------------------------------------
if [[ "${SKIP_PG_CHECK:-0}" != "1" ]]; then
  if command -v pg_isready >/dev/null 2>&1; then
    DB_HOST=$(grep -E '^DATABASE_URL=' .env.local | head -1 | sed -E 's|.*://[^@]*@([^:/]+).*|\1|')
    DB_PORT=$(grep -E '^DATABASE_URL=' .env.local | head -1 | sed -E 's|.*://[^@]*@[^:]+:([0-9]+).*|\1|')
    if ! pg_isready -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" >/dev/null 2>&1; then
      printf 'warning: cannot reach Postgres at %s:%s. ' "${DB_HOST:-localhost}" "${DB_PORT:-5432}" >&2
      printf 'Start the harness or set SKIP_PG_CHECK=1.\n' >&2
    fi
  fi
fi

# --- prisma generate -------------------------------------------------------
step "Running prisma generate"
pnpm prisma generate

# --- migrations (only if any exist) ----------------------------------------
if [[ -d prisma/migrations ]]; then
  step "Applying any pending Prisma migrations"
  pnpm prisma migrate deploy
fi

# --- banner + dev ----------------------------------------------------------
WIDTH=42
hr() { printf '%s' "$1"; printf '═%.0s' $(seq 1 $WIDTH); printf '%s\n' "$2"; }
pad() {
  local s="$1"
  printf '║%s%*s║\n' "$s" $((WIDTH - ${#s})) ""
}

echo
hr "╔" "╗"
pad ""
pad "  Crystal Forge -- starting dev server"
pad "  -> $URL"
pad ""
hr "╚" "╝"
echo
echo "Press Ctrl+C to stop the dev server."
echo

exec pnpm dev
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x ~/work/crystal-forge-template-webapp/forge-launch.sh
ls -l ~/work/crystal-forge-template-webapp/forge-launch.sh
```

Expected: `-rwxr-xr-x` mode.

---

### Task A9: Add `README.md`

**Files:**
- Modify (overwrite the empty placeholder): `~/work/crystal-forge-template-webapp/README.md`

- [ ] **Step 1: Write the README**

````markdown
# Crystal Forge Template Web App

Minimal Next.js 16 app generated by Crystal Forge for every new forge.

## What this is

This repo is the template that Crystal Forge uses to generate every new forge's GitHub repo. It ships a single welcome page that reads `forge.config.json` and renders "Welcome to {name}" with the description below.

## Local dev

After Crystal Forge generates a forge from this template, clone the resulting repo and:

```bash
pnpm install
cp .env.example .env.local
./forge-launch.sh
```

The launcher checks pre-conditions, runs `prisma generate`, and starts `next dev` on http://localhost:3000.

## Standalone clone (no Crystal Forge in the loop)

If you cloned this template directly, the placeholder `forge.config.json` ships with `name: "Forge Template"`, etc. The welcome page works against placeholders. The `.env.example` points at a Postgres at `localhost:5433/forge_template` — bring your own pg, or set `SKIP_PG_CHECK=1` to skip the soft connectivity probe.

## Files

- `forge.config.json` — forge identity. Edit and refresh; no restart needed.
- `.env.example` — copy to `.env.local`. Contains the `DATABASE_URL` for the per-forge database.
- `prisma/schema.prisma` — empty schema. The first model added produces the first migration.
- `app/page.tsx` — the welcome page (Server Component).
- `lib/forge-config.ts` — typed loader for `forge.config.json`.

## What's intentionally missing

No auth, no modules, no `Dockerfile`, no CI, no tests. This is scaffolding.
````

---

### Task A10: Manual smoke test then push the template repo

**Files:** None — verification + git operations only.

- [ ] **Step 1: Manual smoke test against the harness pg**

The harness's `crystal-forge-pg` container must be running. Start it from the harness repo if needed:

```bash
cd ~/work/crystal-forge && docker compose up -d postgres
```

Then in the template repo:

```bash
cd ~/work/crystal-forge-template-webapp
cp .env.example .env.local
./forge-launch.sh
```

Expected: launcher prints the bordered banner, `next dev` starts, and `http://localhost:3000` shows "Welcome to Forge Template" with "A minimal Crystal Forge web app." underneath.

- [ ] **Step 2: Verify hot config edit**

While the dev server is running, edit `forge.config.json` to change `name` to `"Edited Test"`. Save. Refresh the browser. The heading must update without restart.

Then revert `forge.config.json` to the original placeholder values.

- [ ] **Step 3: Stop the dev server (Ctrl+C) and verify lint + typecheck**

```bash
cd ~/work/crystal-forge-template-webapp
pnpm typecheck
pnpm lint
```

Expected: both exit 0. If `pnpm lint` warns about unused imports or formatting, fix inline.

- [ ] **Step 4: Commit and push**

```bash
cd ~/work/crystal-forge-template-webapp
git add .
git status
git commit -m "feat: minimal Next 16 + Tailwind v4 + Prisma 7 template

Welcome page reads forge.config.json and renders 'Welcome to {name}'
with the description. Includes forge-launch.sh, .env.example, Prisma
scaffold (no models), and the standalone-clone README.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 5: Mark the repo as a template on GitHub (one-time, manual)**

Open `https://github.com/bmodi-cf/crystal-forge-template-webapp/settings`. Tick the "Template repository" checkbox. Save.

This is required for the harness's `repos.createUsingTemplate` call to succeed against this repo. Without it, GitHub returns 422 "is not a template repository". If the repo was already marked as a template, this is a no-op.

---

## Phase B — Harness: slug → dbName helper

End state: a pure helper `slugToDbName` exists alongside `slugifyForgeName`, with tests. The rest of the harness will use this in Phase E.

> All tasks from this point onwards run inside `~/work/crystal-forge` (the harness repo).

### Task B1: Add `slugToDbName` and tests

**Files:**
- Modify: `~/work/crystal-forge/lib/github/slug.ts`
- Modify: `~/work/crystal-forge/lib/github/slug.test.ts`

- [ ] **Step 1: Write the failing tests**

Add the following at the end of `lib/github/slug.test.ts`:

```ts
import { slugToDbName } from './slug';

describe('slugToDbName', () => {
  it('replaces hyphens with underscores', () => {
    expect(slugToDbName('site-survey')).toBe('site_survey');
  });

  it('preserves underscores', () => {
    expect(slugToDbName('quote_builder')).toBe('quote_builder');
  });

  it('preserves digits', () => {
    expect(slugToDbName('quote-builder-2')).toBe('quote_builder_2');
  });

  it('returns single-word slug unchanged in shape', () => {
    expect(slugToDbName('aquaflow')).toBe('aquaflow');
  });

  it('handles all-hyphen edge case', () => {
    expect(slugToDbName('a-b-c-d')).toBe('a_b_c_d');
  });
});
```

Also add `slugToDbName` to the import line at the top:

```ts
import { slugifyForgeName, slugToDbName } from './slug';
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test lib/github/slug.test.ts
```

Expected: `slugToDbName is not a function` or "no exported member slugToDbName".

- [ ] **Step 3: Add the implementation**

Append to `lib/github/slug.ts`:

```ts
export function slugToDbName(slug: string): string {
  return slug.replace(/-/g, '_');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test lib/github/slug.test.ts
```

Expected: PASS — all `slugifyForgeName` and `slugToDbName` tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/github/slug.ts lib/github/slug.test.ts
git commit -m "feat(slug): add slugToDbName helper

Pure transform of forge slug to Postgres database name (hyphens to
underscores). Output matches /^[a-z0-9_]+\$/ so it can be used
unquoted in connection strings.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase C — Harness: DatabaseProvisioner boundary

End state: a `lib/db/` module exists with a `DatabaseProvisioner` interface, a `FakeDatabaseProvisioner` for tests, a `PgDatabaseProvisioner` that talks to the harness pg, a factory keyed off `DB_PROVISIONER_MODE`, and tests for all three. Env vars `HARNESS_PG_*` and `DB_PROVISIONER_MODE` are validated.

### Task C1: Add env vars

**Files:**
- Modify: `~/work/crystal-forge/lib/env.ts`
- Modify: `~/work/crystal-forge/.env.example`

- [ ] **Step 1: Add new vars to the zod schema**

Edit `lib/env.ts` — add these lines inside `baseSchema = z.object({...})`, immediately before the closing `})`:

```ts
  // Per-forge database provisioning (shared crystal-forge-pg container).
  HARNESS_PG_HOST: z.string().default('localhost'),
  HARNESS_PG_PORT: z.coerce.number().int().min(1).max(65535).default(5433),
  HARNESS_PG_USER: z.string().default('crystal'),
  HARNESS_PG_PASSWORD: z.string().default('crystal'),
  DB_PROVISIONER_MODE: z.enum(['real', 'fake']).default('real'),
```

- [ ] **Step 2: Document the new vars in `.env.example`**

Append to `.env.example`:

```
# Per-forge database provisioning (defaults match docker-compose.yml).
HARNESS_PG_HOST="localhost"
HARNESS_PG_PORT="5433"
HARNESS_PG_USER="crystal"
HARNESS_PG_PASSWORD="crystal"
DB_PROVISIONER_MODE="real"
```

- [ ] **Step 3: Verify typecheck still passes**

```bash
pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add lib/env.ts .env.example
git commit -m "feat(env): add HARNESS_PG_* and DB_PROVISIONER_MODE vars

Defaults match docker-compose.yml so no .env.local change is needed
in dev. DB_PROVISIONER_MODE mirrors GITHUB_CLIENT_MODE: 'real' for
dev/prod, 'fake' for tests.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C2: Add `DatabaseProvisioner` interface and factory

**Files:**
- Create: `~/work/crystal-forge/lib/db/types.ts`
- Create: `~/work/crystal-forge/lib/db/provisioner.ts`

- [ ] **Step 1: Write `lib/db/types.ts`**

```ts
// lib/db/types.ts

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
```

- [ ] **Step 2: Write `lib/db/provisioner.ts` (factory + re-export)**

```ts
// lib/db/provisioner.ts
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
```

> Tasks C3 and C4 create the `FakeDatabaseProvisioner` and `PgDatabaseProvisioner` files this factory imports. After C2 alone the harness will not typecheck — that's expected; C3 and C4 fix it.

---

### Task C3: Add `FakeDatabaseProvisioner` (TDD)

**Files:**
- Create: `~/work/crystal-forge/lib/db/fake-provisioner.test.ts`
- Create: `~/work/crystal-forge/lib/db/fake-provisioner.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/db/fake-provisioner.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDatabaseProvisioner } from './fake-provisioner';

describe('FakeDatabaseProvisioner', () => {
  let fake: FakeDatabaseProvisioner;

  beforeEach(() => {
    fake = new FakeDatabaseProvisioner();
  });

  it('creates a database and records its name', async () => {
    await fake.createDatabase('marketing_frufru');
    expect(fake.has('marketing_frufru')).toBe(true);
    expect(fake.list()).toEqual(['marketing_frufru']);
  });

  it('throws when the same database is created twice', async () => {
    await fake.createDatabase('a');
    await expect(fake.createDatabase('a')).rejects.toThrow(/already exists/i);
  });

  it('drops a database that exists', async () => {
    await fake.createDatabase('a');
    await fake.dropDatabase('a');
    expect(fake.has('a')).toBe(false);
  });

  it('drop is idempotent on a missing database', async () => {
    await expect(fake.dropDatabase('never-existed')).resolves.toBeUndefined();
  });

  it('failNextCall makes the next matching call throw, then resumes normal behaviour', async () => {
    fake.failNextCall('createDatabase', new Error('connection refused'));
    await expect(fake.createDatabase('a')).rejects.toThrow('connection refused');
    // Subsequent call works.
    await fake.createDatabase('a');
    expect(fake.has('a')).toBe(true);
  });

  it('list returns every recorded name in insertion order', async () => {
    await fake.createDatabase('a');
    await fake.createDatabase('b');
    expect(fake.list()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test lib/db/fake-provisioner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// lib/db/fake-provisioner.ts
import type { DatabaseProvisioner } from './types';

type Method = 'createDatabase' | 'dropDatabase';

export class FakeDatabaseProvisioner implements DatabaseProvisioner {
  private readonly databases = new Set<string>();
  private readonly nextErrors = new Map<Method, Error>();

  async createDatabase(name: string): Promise<void> {
    this.maybeFail('createDatabase');
    if (this.databases.has(name)) {
      throw new Error(`database "${name}" already exists`);
    }
    this.databases.add(name);
  }

  async dropDatabase(name: string): Promise<void> {
    this.maybeFail('dropDatabase');
    this.databases.delete(name);
  }

  // Test helpers -----------------------------------------------------------

  has(name: string): boolean {
    return this.databases.has(name);
  }

  list(): string[] {
    return [...this.databases];
  }

  failNextCall(method: Method, error: Error): void {
    this.nextErrors.set(method, error);
  }

  private maybeFail(method: Method): void {
    const err = this.nextErrors.get(method);
    if (err) {
      this.nextErrors.delete(method);
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test lib/db/fake-provisioner.test.ts
```

Expected: PASS — all six cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/db/types.ts lib/db/provisioner.ts lib/db/fake-provisioner.ts lib/db/fake-provisioner.test.ts
git commit -m "feat(db): add DatabaseProvisioner interface + fake impl

FakeDatabaseProvisioner mirrors FakeGitHubClient: in-memory set of
created names, failNextCall hook for testing rollback paths.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

> Note: `lib/db/provisioner.ts` still imports a not-yet-existing `PgDatabaseProvisioner`. The next task creates it. If you want a clean tree at this commit boundary, hold this commit and bundle it with C4. The plan keeps them separate so each task is isolated.

---

### Task C4: Add `PgDatabaseProvisioner` with integration tests

**Files:**
- Create: `~/work/crystal-forge/lib/db/pg-provisioner.test.ts`
- Create: `~/work/crystal-forge/lib/db/pg-provisioner.ts`

- [ ] **Step 1: Write the failing integration tests**

```ts
// lib/db/pg-provisioner.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from 'pg';
import { PgDatabaseProvisioner } from './pg-provisioner';

const TEST_DB = '_test_provisioner_demo';

function adminConnectionString(): string {
  // Reuse the test process's already-rewritten DATABASE_URL but redirect to
  // the admin "postgres" db. vitest.setup.ts has already pointed
  // DATABASE_URL at <name>_test; same server, different db.
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/postgres';
  return url.toString();
}

async function databaseExists(name: string): Promise<boolean> {
  const c = new Client({ connectionString: adminConnectionString() });
  await c.connect();
  try {
    const res = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return res.rowCount === 1;
  } finally {
    await c.end();
  }
}

async function dropIfExists(name: string): Promise<void> {
  const c = new Client({ connectionString: adminConnectionString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await c.end();
  }
}

describe('PgDatabaseProvisioner (integration)', () => {
  let provisioner: PgDatabaseProvisioner;

  beforeEach(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    provisioner = new PgDatabaseProvisioner({
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await dropIfExists(TEST_DB);
  });

  afterEach(async () => {
    await dropIfExists(TEST_DB);
  });

  it('createDatabase makes the named db appear in pg_database', async () => {
    await provisioner.createDatabase(TEST_DB);
    expect(await databaseExists(TEST_DB)).toBe(true);
  });

  it('dropDatabase removes the named db', async () => {
    await provisioner.createDatabase(TEST_DB);
    expect(await databaseExists(TEST_DB)).toBe(true);
    await provisioner.dropDatabase(TEST_DB);
    expect(await databaseExists(TEST_DB)).toBe(false);
  });

  it('dropDatabase is idempotent on a missing db', async () => {
    await expect(provisioner.dropDatabase(TEST_DB)).resolves.toBeUndefined();
  });

  it('createDatabase throws when the db already exists', async () => {
    await provisioner.createDatabase(TEST_DB);
    await expect(provisioner.createDatabase(TEST_DB)).rejects.toThrow();
  });

  it('refuses unsafe names (defence-in-depth against missing upstream validation)', async () => {
    await expect(provisioner.createDatabase('Bad-Name')).rejects.toThrow(/unsafe/i);
    await expect(provisioner.dropDatabase('"; DROP TABLE--')).rejects.toThrow(/unsafe/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test lib/db/pg-provisioner.test.ts
```

Expected: FAIL — `Cannot find module './pg-provisioner'`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/db/pg-provisioner.ts
import { Client } from 'pg';
import type { DatabaseProvisioner } from './types';

const SAFE_DBNAME = /^[a-z0-9_]+$/;

export class PgDatabaseProvisioner implements DatabaseProvisioner {
  private readonly adminUrl: string;

  constructor(config: {
    host: string;
    port: number;
    user: string;
    password: string;
  }) {
    const url = new URL('postgres://placeholder/postgres');
    url.username = encodeURIComponent(config.user);
    url.password = encodeURIComponent(config.password);
    url.hostname = config.host;
    url.port = String(config.port);
    this.adminUrl = url.toString();
  }

  async createDatabase(name: string): Promise<void> {
    this.assertSafe(name);
    const client = new Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE "${name}"`);
    } finally {
      await client.end();
    }
  }

  async dropDatabase(name: string): Promise<void> {
    this.assertSafe(name);
    const client = new Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await client.end();
    }
  }

  private assertSafe(name: string): void {
    if (!SAFE_DBNAME.test(name)) {
      throw new Error(`Refusing to use unsafe database name: ${JSON.stringify(name)}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test lib/db/pg-provisioner.test.ts
```

Expected: PASS. The test will connect to the harness pg via the `_test`-rewritten DATABASE_URL (vitest.setup.ts) and exercise CREATE/DROP against the admin db.

If the test fails with "connection refused", start the pg container:

```bash
docker compose up -d postgres
```

- [ ] **Step 5: Commit**

```bash
git add lib/db/pg-provisioner.ts lib/db/pg-provisioner.test.ts
git commit -m "feat(db): add PgDatabaseProvisioner with integration tests

Real impl uses node-postgres to issue CREATE/DROP DATABASE against
the harness's pg admin db. Defence-in-depth name regex rejects
anything outside /^[a-z0-9_]+\$/, even though slugToDbName already
guarantees the shape upstream.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

> **Note on factory testing.** `getDatabaseProvisioner()` reads `env.DB_PROVISIONER_MODE` once at module load. Toggling the env var at test time would require module-cache busting, which is brittle. The factory is exercised end-to-end by the service tests (E3) and the seed (F1), both of which run with `DB_PROVISIONER_MODE=fake`, plus the manual real-mode dry run (G2). The existing harness follows the same convention — `getGitHubClient()` has no unit test either. No separate factory unit test in this plan.

---

## Phase D — Harness: GitHubClient.writeForgeFiles

End state: `GitHubClient` has a `writeForgeFiles(fullName, files)` method. The fake records calls in an in-memory map; the real impl issues two PUTs to GitHub Contents API with bounded 404 retry.

### Task D1: Add `ForgeConfigPayload`, `ForgeFiles`, and `writeForgeFiles` to the interface

**Files:**
- Modify: `~/work/crystal-forge/lib/github/types.ts`

- [ ] **Step 1: Append types and method**

Replace the entire contents of `lib/github/types.ts` with:

```ts
// lib/github/types.ts
export type CreateRepoOptions = {
  /** Slugified repo name; written under the configured owner. */
  name: string;
  /** Used as the GitHub repo description on creation. */
  description: string | null;
  /** Always true in this slice; surfaced for forward-compatibility. */
  private: boolean;
};

export type CreatedRepo = {
  /** "owner/name" — canonical identifier used by the GitHub API. */
  fullName: string;
  /** Browser URL for the repo (e.g. https://github.com/owner/name). */
  htmlUrl: string;
};

/**
 * Body of forge.config.json, the source of forge identity inside a
 * cloned forge repo. Matches the spec contract — see
 * docs/superpowers/specs/2026-05-08-template-webapp-and-forge-config-design.md §3.B.
 */
export type ForgeConfigPayload = {
  name: string;
  description: string | null;
  slug: string;
  dbName: string;
  createdAt: string;
};

export type ForgeFiles = {
  forgeConfig: ForgeConfigPayload;
  /** Already-rendered .env.example body (UTF-8 text). */
  envExample: string;
};

export interface GitHubClient {
  /**
   * Generate a new repo from the configured template under the configured owner.
   * Throws on any GitHub failure (auth, rate-limit, name-taken, ...).
   */
  createRepoFromTemplate(opts: CreateRepoOptions): Promise<CreatedRepo>;

  /**
   * Idempotent. Calling on an already-archived repo is a no-op-success.
   */
  archiveRepo(fullName: string): Promise<void>;

  /**
   * Compensating action only. NOT user-facing. Used to roll back a just-created
   * repo when a downstream step fails. Permanent and unrecoverable.
   */
  deleteRepo(fullName: string): Promise<void>;

  /**
   * Commits forge.config.json AND .env.example to the default branch of
   * `fullName`. Two PUTs to /repos/{owner}/{repo}/contents/{path}, each
   * producing one commit. Throws on any failure; caller is responsible
   * for compensation.
   *
   * GitHub's template-clone is asynchronous — the new repo can return 404
   * on contents writes for a few hundred ms after createUsingTemplate
   * resolves. Each PUT retries on 404 only with bounded exponential
   * backoff (200/400/800/1600/3200ms). Any other status throws immediately.
   */
  writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void>;
}
```

- [ ] **Step 2: Verify typecheck fails meaningfully**

```bash
pnpm typecheck
```

Expected: FAIL — `OctokitGitHubClient` and `FakeGitHubClient` don't implement `writeForgeFiles` yet. The next two tasks fix this.

---

### Task D2: Implement `FakeGitHubClient.writeForgeFiles` (TDD)

**Files:**
- Modify: `~/work/crystal-forge/lib/github/fake-client.test.ts`
- Modify: `~/work/crystal-forge/lib/github/fake-client.ts`

- [ ] **Step 1: Append failing tests to `fake-client.test.ts`**

Add the following describe block at the end of the existing tests, and update the import to bring in `ForgeFiles`:

```ts
import type { ForgeFiles } from './types';

const exampleFiles = (): ForgeFiles => ({
  forgeConfig: {
    name: 'Aquaflow',
    description: 'Hydraulics tool',
    slug: 'aquaflow',
    dbName: 'aquaflow',
    createdAt: '2026-05-09T01:34:47.000Z',
  },
  envExample: 'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow\n',
});

describe('FakeGitHubClient.writeForgeFiles', () => {
  let fake: FakeGitHubClient;

  beforeEach(() => {
    fake = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
  });

  it('records the two files against the repo full name', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    const files = exampleFiles();
    await fake.writeForgeFiles('bmodi-cf/aquaflow', files);
    expect(fake.getFiles('bmodi-cf/aquaflow')).toEqual(files);
  });

  it('throws when the repo does not exist', async () => {
    await expect(
      fake.writeForgeFiles('bmodi-cf/missing', exampleFiles()),
    ).rejects.toThrow(/not found/i);
  });

  it('a second call overwrites the recorded files', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    const first = exampleFiles();
    await fake.writeForgeFiles('bmodi-cf/aquaflow', first);
    const second: ForgeFiles = {
      ...first,
      forgeConfig: { ...first.forgeConfig, description: 'changed' },
    };
    await fake.writeForgeFiles('bmodi-cf/aquaflow', second);
    expect(fake.getFiles('bmodi-cf/aquaflow')).toEqual(second);
  });

  it('failNextCall makes the next writeForgeFiles throw, then resumes', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    fake.failNextCall('writeForgeFiles', new Error('rate limited'));
    await expect(
      fake.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles()),
    ).rejects.toThrow('rate limited');
    // Subsequent call works.
    await fake.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles());
    expect(fake.getFiles('bmodi-cf/aquaflow')).toBeDefined();
  });

  it('deleteRepo also clears any recorded files for that repo', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    await fake.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles());
    await fake.deleteRepo('bmodi-cf/aquaflow');
    expect(fake.getFiles('bmodi-cf/aquaflow')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test lib/github/fake-client.test.ts
```

Expected: FAIL — `fake.writeForgeFiles is not a function` / `fake.getFiles is not a function`.

- [ ] **Step 3: Update `FakeGitHubClient` with the new method**

Replace the contents of `lib/github/fake-client.ts` with:

```ts
import type {
  CreatedRepo,
  CreateRepoOptions,
  ForgeFiles,
  GitHubClient,
} from './types';

type Repo = {
  fullName: string;
  archived: boolean;
  private: boolean;
  description: string | null;
};

type Method =
  | 'createRepoFromTemplate'
  | 'archiveRepo'
  | 'deleteRepo'
  | 'writeForgeFiles';

export class FakeGitHubClient implements GitHubClient {
  private readonly owner: string;
  private readonly baseUrl: string;
  private readonly repos = new Map<string, Repo>();
  private readonly files = new Map<string, ForgeFiles>();
  private readonly nextErrors = new Map<Method, Error>();

  constructor(config: { owner: string; baseUrl: string }) {
    this.owner = config.owner;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async createRepoFromTemplate(opts: CreateRepoOptions): Promise<CreatedRepo> {
    this.maybeFail('createRepoFromTemplate');
    const fullName = `${this.owner}/${opts.name}`;
    if (this.repos.has(fullName)) {
      throw new Error(`repo ${fullName} already exists`);
    }
    this.repos.set(fullName, {
      fullName,
      archived: false,
      private: opts.private,
      description: opts.description,
    });
    return { fullName, htmlUrl: `${this.baseUrl}/${fullName}` };
  }

  async archiveRepo(fullName: string): Promise<void> {
    this.maybeFail('archiveRepo');
    const repo = this.repos.get(fullName);
    if (repo) repo.archived = true;
    // Unknown repo: no-op success (matches spec idempotency).
  }

  async deleteRepo(fullName: string): Promise<void> {
    this.maybeFail('deleteRepo');
    this.repos.delete(fullName);
    this.files.delete(fullName);
  }

  async writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void> {
    this.maybeFail('writeForgeFiles');
    if (!this.repos.has(fullName)) {
      throw new Error(`repo ${fullName} not found`);
    }
    this.files.set(fullName, files);
  }

  // Test helpers -----------------------------------------------------------

  failNextCall(method: Method, error: Error): void {
    this.nextErrors.set(method, error);
  }

  getRepo(fullName: string): Repo | undefined {
    return this.repos.get(fullName);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  getFiles(fullName: string): ForgeFiles | undefined {
    return this.files.get(fullName);
  }

  private maybeFail(method: Method): void {
    const err = this.nextErrors.get(method);
    if (err) {
      this.nextErrors.delete(method);
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test lib/github/fake-client.test.ts
```

Expected: PASS — all existing tests green plus the five new `writeForgeFiles` cases.

- [ ] **Step 5: Commit**

```bash
git add lib/github/types.ts lib/github/fake-client.ts lib/github/fake-client.test.ts
git commit -m "feat(github): add writeForgeFiles to GitHubClient + fake impl

Records the (forgeConfig, envExample) payload per repo. deleteRepo
clears the recorded files so compensation paths leave no residue.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task D3: Implement `OctokitGitHubClient.writeForgeFiles` with bounded 404 retry

**Files:**
- Modify: `~/work/crystal-forge/lib/github/octokit-client.ts`

- [ ] **Step 1: Add the method and its private helper**

Replace the contents of `lib/github/octokit-client.ts` with:

```ts
// lib/github/octokit-client.ts
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type {
  CreatedRepo,
  CreateRepoOptions,
  ForgeFiles,
  GitHubClient,
} from './types';

const RETRY_DELAYS_MS = [200, 400, 800, 1600, 3200] as const;

export class OctokitGitHubClient implements GitHubClient {
  private readonly client: Octokit;
  private readonly owner: string;
  private readonly templateOwner: string;
  private readonly templateRepo: string;

  private readonly retryDelaysMs: readonly number[];

  constructor(config: {
    owner: string;
    templateRepo: string; // "owner/repo"
    appId: string;
    privateKey: string;
    installationId: string;
    /** Test-only override. */
    octokit?: Octokit;
    /** Test-only override of retry backoff (default RETRY_DELAYS_MS). */
    retryDelaysMs?: readonly number[];
  }) {
    const [templateOwner, templateRepo] = config.templateRepo.split('/');
    if (!templateOwner || !templateRepo) {
      throw new Error('templateRepo must be "owner/repo"');
    }
    this.owner = config.owner;
    this.templateOwner = templateOwner;
    this.templateRepo = templateRepo;
    this.client = config.octokit ?? new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      },
    });
    this.retryDelaysMs = config.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  async createRepoFromTemplate(opts: CreateRepoOptions): Promise<CreatedRepo> {
    const { data } = await this.client.repos.createUsingTemplate({
      template_owner: this.templateOwner,
      template_repo: this.templateRepo,
      owner: this.owner,
      name: opts.name,
      description: opts.description ?? undefined,
      private: opts.private,
      include_all_branches: false,
    });
    return { fullName: data.full_name, htmlUrl: data.html_url };
  }

  async archiveRepo(fullName: string): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    try {
      await this.client.repos.update({ owner, repo, archived: true });
    } catch (err: unknown) {
      if (isStatus(err, 404)) return;
      throw err;
    }
  }

  async deleteRepo(fullName: string): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    try {
      await this.client.repos.delete({ owner, repo });
    } catch (err: unknown) {
      if (isStatus(err, 404)) return;
      throw err;
    }
  }

  async writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    const forgeConfigBody = JSON.stringify(files.forgeConfig, null, 2) + '\n';
    await this.putContents(
      owner,
      repo,
      'forge.config.json',
      forgeConfigBody,
      'chore: write forge.config.json',
    );
    await this.putContents(
      owner,
      repo,
      '.env.example',
      files.envExample,
      'chore: write .env.example',
    );
  }

  /**
   * PUT /repos/{owner}/{repo}/contents/{path}. Retries on 404 only with
   * bounded exponential backoff. Any other error (401/403/422/5xx) throws
   * immediately.
   */
  private async putContents(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.client.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
        });
        return;
      } catch (err: unknown) {
        if (isStatus(err, 404) && attempt < this.retryDelaysMs.length) {
          await sleep(this.retryDelaysMs[attempt]!);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }
}

function parseFullName(fullName: string): [string, string] {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo fullName: ${fullName}`);
  }
  return [owner, repo];
}

function isStatus(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: number }).status === status
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
pnpm typecheck
```

Expected: exit 0 — both implementations now satisfy `GitHubClient`.

---

### Task D4: Test the Octokit retry behaviour with a stubbed client

**Files:**
- Create: `~/work/crystal-forge/lib/github/octokit-client.test.ts`

The constructor changes in D3 (the `octokit?` and `retryDelaysMs?` test-only options) are what make this test possible. We'll inject a fake Octokit that throws `status: 404` on demand, and pass a zero-delay retry array so each test runs in milliseconds without timer fakery.

- [ ] **Step 1: Write the test**

```ts
// lib/github/octokit-client.test.ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHubClient } from './octokit-client';
import type { ForgeFiles } from './types';

function status(code: number) {
  const e = new Error(`HTTP ${code}`) as Error & { status: number };
  e.status = code;
  return e;
}

function makeOctokitWith(
  putBehavior: (args: {
    owner: string;
    repo: string;
    path: string;
    message: string;
    content: string;
  }) => Promise<unknown>,
): Octokit {
  return {
    repos: {
      createOrUpdateFileContents: vi.fn(putBehavior),
    },
  } as unknown as Octokit;
}

function newClient(octokit: Octokit) {
  return new OctokitGitHubClient({
    owner: 'bmodi-cf',
    templateRepo: 'bmodi-cf/crystal-forge-template-webapp',
    appId: 'unused',
    privateKey: 'unused',
    installationId: 'unused',
    octokit,
    retryDelaysMs: [0, 0, 0, 0, 0], // skip real backoff in tests
  });
}

const exampleFiles: ForgeFiles = {
  forgeConfig: {
    name: 'Aquaflow',
    description: 'Hydraulics tool',
    slug: 'aquaflow',
    dbName: 'aquaflow',
    createdAt: '2026-05-09T01:34:47.000Z',
  },
  envExample: 'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow\n',
};

describe('OctokitGitHubClient.writeForgeFiles', () => {
  it('issues two PUTs (forge.config.json then .env.example) on the happy path', async () => {
    const calls: Array<{ path: string; content: string }> = [];
    const octokit = makeOctokitWith(async ({ path, content }) => {
      calls.push({ path, content });
      return { data: {} };
    });
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    expect(calls.map((c) => c.path)).toEqual(['forge.config.json', '.env.example']);
    // forge.config.json body is the JSON we passed in, base64-encoded
    const decoded = Buffer.from(calls[0]!.content, 'base64').toString('utf8');
    expect(JSON.parse(decoded)).toEqual(exampleFiles.forgeConfig);
    expect(Buffer.from(calls[1]!.content, 'base64').toString('utf8')).toBe(
      exampleFiles.envExample,
    );
  });

  it('retries on 404 and eventually succeeds', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      // Fail on the first two attempts of the first PUT (forge.config.json).
      // Third attempt of the first PUT succeeds, then the second PUT (.env.example) succeeds first try.
      if (calls < 3) throw status(404);
      return { data: {} };
    });
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    // 2 failed retries on the first PUT + 1 successful first PUT + 1 successful second PUT = 4.
    expect(calls).toBe(4);
  });

  it('throws after exhausting all retries on 404', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      throw status(404);
    });
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 404 });

    // Initial attempt + 5 retries = 6 attempts on the first PUT, never reaches the second.
    expect(calls).toBe(6);
  });

  it('does not retry on 401', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      throw status(401);
    });
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('does not retry on 422', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      throw status(422);
    });
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 422 });
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm test lib/github/octokit-client.test.ts
```

Expected: PASS — all five cases. With `retryDelaysMs: [0, 0, 0, 0, 0]` the retry loops run instantly.

- [ ] **Step 3: Commit**

```bash
git add lib/github/octokit-client.ts lib/github/octokit-client.test.ts
git commit -m "feat(github): writeForgeFiles + tests for retry behaviour

Two PUTs (forge.config.json then .env.example) to the Contents API,
each retrying on 404 only with delays 200/400/800/1600/3200ms
(~6s ceiling). Other status codes throw immediately. Constructor
gains test-only octokit and retryDelaysMs overrides.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase E — Harness: createForge orchestration

End state: `createForge` calls `writeForgeFiles` and `createDatabase` after the repo is created, with compensating delete-repo + drop-database on later failures. Existing passing tests stay green; new tests cover the new failure paths.

### Task E1: Add an exported `renderEnvExample` helper

**Files:**
- Modify: `~/work/crystal-forge/lib/services/forges.ts`

This helper is shared between `createForge` and the seed (Phase F). Putting it in `forges.ts` keeps the logic next to the `ForgeFiles` payload assembly.

- [ ] **Step 1: Add the helper near the top of `lib/services/forges.ts` (after the existing imports)**

```ts
/**
 * Renders the .env.example body the harness writes into each cloned forge
 * repo. The connection target points at the harness's shared pg container;
 * only the database name varies per forge.
 */
export function renderEnvExample(dbName: string): string {
  return [
    "# Postgres connection. Points at the harness's crystal-forge-pg container.",
    '# Copy this file to .env.local before running ./forge-launch.sh.',
    `DATABASE_URL=postgres://${env.HARNESS_PG_USER}:${env.HARNESS_PG_PASSWORD}@${env.HARNESS_PG_HOST}:${env.HARNESS_PG_PORT}/${dbName}`,
    '',
  ].join('\n');
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
pnpm typecheck
```

Expected: exit 0.

---

### Task E2: Extract `safeDeleteRepo`, add `safeDropDatabase`

**Files:**
- Modify: `~/work/crystal-forge/lib/services/forges.ts`

- [ ] **Step 1: Add the imports the new code will need**

At the top of `lib/services/forges.ts`, add:

```ts
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import type { DatabaseProvisioner } from '@/lib/db/provisioner';
import { slugifyForgeName, slugToDbName } from '@/lib/github/slug';
```

(Replace the existing `import { slugifyForgeName } from '@/lib/github/slug';` line with the line above.)

- [ ] **Step 2: Add the two helpers near the bottom of `lib/services/forges.ts`**

```ts
async function safeDeleteRepo(client: GitHubClient, fullName: string): Promise<void> {
  try {
    await client.deleteRepo(fullName);
  } catch (cleanupErr) {
    console.error(
      '[createForge] orphaned repo — cleanup failed',
      { repo: fullName, cleanupErr },
    );
  }
}

async function safeDropDatabase(
  provisioner: DatabaseProvisioner,
  dbName: string,
): Promise<void> {
  try {
    await provisioner.dropDatabase(dbName);
  } catch (cleanupErr) {
    console.error(
      '[createForge] orphaned database — cleanup failed',
      { dbName, cleanupErr },
    );
  }
}
```

- [ ] **Step 3: Replace the existing inline `try { await client.deleteRepo(...) }` block in `createForge` with a call to `safeDeleteRepo`**

In `createForge`, find this block (currently around lines 139–149):

```ts
  } catch (err) {
    // Best-effort compensating delete. Failure of compensation is logged loudly
    // but the original error is what propagates to the caller.
    try {
      await client.deleteRepo(created.fullName);
    } catch (cleanupErr) {
      console.error(
        '[createForge] orphaned repo — cleanup failed',
        { repo: created.fullName, cleanupErr },
      );
    }
    throw err;
  }
```

Replace with:

```ts
  } catch (err) {
    await safeDeleteRepo(client, created.fullName);
    throw err;
  }
```

- [ ] **Step 4: Run the existing forges tests — they must still pass**

```bash
pnpm test lib/services/forges.test.ts
```

Expected: PASS — no behaviour change yet, only refactor. The "compensates by deleting the just-created repo when the DB insert fails" case still asserts the delete was called.

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts
git commit -m "refactor(forges): extract safeDeleteRepo + safeDropDatabase helpers

Plus renderEnvExample helper used by both createForge and the seed.
Behaviour unchanged in this commit — pure extraction.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task E3: Wire `createForge` to call `writeForgeFiles` then `createDatabase` (TDD: tests first)

**Files:**
- Modify: `~/work/crystal-forge/lib/services/forges.test.ts`

- [ ] **Step 1: Add new tests covering the new flow**

Update the imports at the top of `lib/services/forges.test.ts`:

```ts
import { FakeDatabaseProvisioner } from '@/lib/db/fake-provisioner';
```

Add a new fake instance at the top of the file:

```ts
let fakeDb: FakeDatabaseProvisioner;

beforeEach(() => {
  fake = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
  fakeDb = new FakeDatabaseProvisioner();
});
```

Update the existing happy-path test ("creates a Forge AND a GitHub repo, with derived initials and defaults") to thread `fakeDb` and assert on the new artefacts:

```ts
  it('creates a Forge AND a GitHub repo AND writes forge.config.json + .env.example AND provisions the per-forge database', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom Reed', groups: ['Engineering'] });

      const forge = await createForge(
        tom,
        { name: 'Aquaflow Designer', description: 'Hydraulics tool', groups: ['Engineering'] },
        fake,
        fakeDb,
      );

      expect(forge.name).toBe('Aquaflow Designer');
      expect(forge.repoFullName).toBe('test-owner/aquaflow-designer');
      // Repo recorded in the fake.
      expect(fake.getRepo('test-owner/aquaflow-designer')?.private).toBe(true);
      // Files written to the repo.
      const files = fake.getFiles('test-owner/aquaflow-designer');
      expect(files).toBeDefined();
      expect(files!.forgeConfig).toMatchObject({
        name: 'Aquaflow Designer',
        description: 'Hydraulics tool',
        slug: 'aquaflow-designer',
        dbName: 'aquaflow_designer',
      });
      expect(files!.forgeConfig.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(files!.envExample).toContain('DATABASE_URL=postgres://');
      expect(files!.envExample).toContain('/aquaflow_designer');
      // Database provisioned.
      expect(fakeDb.has('aquaflow_designer')).toBe(true);
    });
  });
```

Then add three new tests for the new failure paths and update existing tests to pass `fakeDb` as the fourth argument:

```ts
  it('writeForgeFiles failure deletes the repo, drops nothing, and inserts no row', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      fake.failNextCall('writeForgeFiles', new Error('rate limited'));
      await expect(
        createForge(tom, { name: 'A', description: '', groups: ['Engineering'] }, fake, fakeDb),
      ).rejects.toThrow('rate limited');

      expect(fake.listRepos()).toHaveLength(0);
      expect(fakeDb.list()).toEqual([]);
      const rows = await prisma.forge.findMany();
      expect(rows).toHaveLength(0);
    });
  });

  it('createDatabase failure deletes the repo and inserts no row', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      fakeDb.failNextCall('createDatabase', new Error('connection refused'));
      await expect(
        createForge(tom, { name: 'A', description: '', groups: ['Engineering'] }, fake, fakeDb),
      ).rejects.toThrow('connection refused');

      expect(fake.listRepos()).toHaveLength(0);
      expect(fakeDb.list()).toEqual([]);
      const rows = await prisma.forge.findMany();
      expect(rows).toHaveLength(0);
    });
  });

  it('compensates by dropping the database AND deleting the repo when the DB row write fails', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      // Pre-create a Forge row holding the repoFullName slug we'll collide on,
      // so the unique-index trips inside the transaction.
      await makeForge(prisma, {
        name: 'Race Winner',
        createdById: tom.id,
        groups: ['Engineering'],
        repoFullName: 'test-owner/aquaflow',
      });
      await expect(
        createForge(tom, { name: 'Aquaflow', description: '', groups: ['Engineering'] }, fake, fakeDb),
      ).rejects.toThrow();

      // Compensating delete must have removed the repo from the fake.
      expect(fake.getRepo('test-owner/aquaflow')).toBeUndefined();
      // Compensating drop must have removed the database from the fake.
      expect(fakeDb.has('aquaflow')).toBe(false);
      const rows = await prisma.forge.findMany({ where: { name: 'Aquaflow' } });
      expect(rows).toHaveLength(0);
    });
  });
```

Update every existing `createForge(...)` call in this file that does NOT yet pass `fakeDb` to add the fourth argument: replace `..., fake)` with `..., fake, fakeDb)` everywhere. The existing tests already deliberately exercise the GitHub-failure rollback path; those `failNextCall('createRepoFromTemplate', ...)` cases work unchanged because they fail before any DB interaction.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test lib/services/forges.test.ts
```

Expected: FAIL — `createForge` only accepts 3 arguments, the new tests reference `fake.getFiles` / `fakeDb.has` and behaviour the implementation doesn't have yet.

---

### Task E4: Wire `createForge` to call `writeForgeFiles` then `createDatabase`

**Files:**
- Modify: `~/work/crystal-forge/lib/services/forges.ts`

- [ ] **Step 1: Update the `createForge` signature and orchestration**

Replace the entire `createForge` function in `lib/services/forges.ts` with:

```ts
/**
 * Create a Forge atomically with its GitHub repo, two committed files
 * (forge.config.json + .env.example), and a per-forge Postgres database.
 * Compensates with safeDeleteRepo / safeDropDatabase on later-stage failures.
 *
 * `client` and `provisioner` are injectable for tests; in production the
 * default factories return the singletons chosen by GITHUB_CLIENT_MODE and
 * DB_PROVISIONER_MODE.
 */
export async function createForge(
  currentUser: SessionUser,
  input: CreateForgeInput,
  client: GitHubClient = getGitHubClient(),
  provisioner: DatabaseProvisioner = getDatabaseProvisioner(),
): Promise<Forge> {
  // 1. Pre-check name uniqueness in DB (cheaper than going to GitHub first).
  const dup = await prisma.forge.findUnique({ where: { name: input.name } });
  if (dup) {
    throw new ValidationError('Forge name already in use', {
      name: ['A Forge with this name already exists'],
    });
  }

  // 2. Validate group names exist before any external call.
  const groupRows = await prisma.group.findMany({ where: { name: { in: input.groups } } });
  if (groupRows.length !== input.groups.length) {
    const known = new Set(groupRows.map((g) => g.name));
    const unknown = input.groups.filter((g) => !known.has(g));
    throw new ValidationError('Unknown group(s)', { groups: unknown });
  }

  // Non-admins may only assign groups they are members of.
  if (!currentUser.isAdmin) {
    const userGroups = new Set(currentUser.groups);
    const foreign = input.groups.filter((g) => !userGroups.has(g));
    if (foreign.length > 0) {
      throw new ValidationError('Cannot assign groups you are not a member of', {
        groups: foreign,
      });
    }
  }

  // 3. Compute slug + dbName + payload.
  const description = input.description?.trim() ? input.description.trim() : null;
  const slug = slugifyForgeName(input.name);
  const dbName = slugToDbName(slug);
  const createdAt = new Date().toISOString();

  // 4. Create the GitHub repo. Errors here surface unchanged.
  const created = await client.createRepoFromTemplate({
    name: slug,
    description,
    private: true,
  });

  // 5. Write forge.config.json + .env.example. On failure, delete the repo.
  try {
    await client.writeForgeFiles(created.fullName, {
      forgeConfig: { name: input.name, description, slug, dbName, createdAt },
      envExample: renderEnvExample(dbName),
    });
  } catch (err) {
    await safeDeleteRepo(client, created.fullName);
    throw err;
  }

  // 6. Provision the per-forge database. On failure, delete the repo.
  try {
    await provisioner.createDatabase(dbName);
  } catch (err) {
    await safeDeleteRepo(client, created.fullName);
    throw err;
  }

  // 7. Insert the Forge row. On failure, drop the database AND delete the repo.
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.forge.create({
        data: {
          name: input.name,
          description,
          initials: deriveInitials(input.name),
          createdById: currentUser.id,
          repoFullName: created.fullName,
          groups: { create: groupRows.map((g) => ({ groupId: g.id })) },
        },
        include: forgeInclude,
      });
      return toDto(row);
    });
  } catch (err) {
    await safeDropDatabase(provisioner, dbName);
    await safeDeleteRepo(client, created.fullName);
    throw err;
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm test lib/services/forges.test.ts
```

Expected: PASS — every existing case plus the three new failure-path cases plus the updated happy-path case.

- [ ] **Step 3: Run the full vitest suite**

```bash
pnpm test
```

Expected: PASS — everything green.

- [ ] **Step 4: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts lib/services/forges.test.ts
git commit -m "feat(forges): orchestrate writeForgeFiles + createDatabase atomically

createForge now: create repo -> write files -> create database ->
write DB row, with compensating delete-repo on writeForgeFiles or
createDatabase failure, and drop-database + delete-repo on DB row
failure. Tests cover all three new failure paths.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase F — Seed and e2e configuration

End state: the seed in real mode also writes files and provisions databases; in fake mode (used by e2e and unit tests) it stays a no-op for those external calls. Playwright config has `DB_PROVISIONER_MODE=fake` so the harness webserver and the seed both stay offline.

### Task F1: Update the seed to write files + provision databases in real mode

**Files:**
- Modify: `~/work/crystal-forge/prisma/seed.ts`

- [ ] **Step 1: Update imports and rewrite `provisionRepoFullName`**

Replace the entire `provisionRepoFullName` function in `prisma/seed.ts` and update the imports at the top:

```ts
import { PrismaClient, ForgeStatus, ForgeTone } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '@/lib/env';
import { getGitHubClient } from '@/lib/github/client';
import { slugifyForgeName, slugToDbName } from '@/lib/github/slug';
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import { renderEnvExample } from '@/lib/services/forges';
```

Then replace `provisionRepoFullName` with `provisionForgeArtifacts`:

```ts
async function provisionForgeArtifacts(
  name: string,
  description: string,
): Promise<{ repoFullName: string }> {
  const slug = slugifyForgeName(name);
  const dbName = slugToDbName(slug);

  if (env.GITHUB_CLIENT_MODE === 'fake') {
    // Fake state is per-process and resets every seed run. Just hand back
    // a deterministic repoFullName for the DB row.
    return { repoFullName: `${env.GITHUB_REPO_OWNER}/${slug}` };
  }

  const client = getGitHubClient();
  const provisioner = getDatabaseProvisioner();

  const repo = await client.createRepoFromTemplate({
    name: slug,
    description,
    private: true,
  });

  try {
    await client.writeForgeFiles(repo.fullName, {
      forgeConfig: {
        name,
        description: description.length > 0 ? description : null,
        slug,
        dbName,
        createdAt: new Date().toISOString(),
      },
      envExample: renderEnvExample(dbName),
    });
    await provisioner.createDatabase(dbName);
  } catch (err) {
    // Best-effort compensation so a re-run isn't blocked by orphans.
    try { await client.deleteRepo(repo.fullName); } catch { /* logged below */ }
    console.error(
      `❌ Failed to write files / provision database for "${name}". ` +
        `If a repo with slug "${slug}" already exists under ${env.GITHUB_REPO_OWNER}, ` +
        `or a database "${dbName}" already exists in the harness pg, archive/delete ` +
        `it manually and re-run the seed.`,
    );
    throw err;
  }

  return { repoFullName: repo.fullName };
}
```

Replace the call site in `main()`:

```ts
    let repoFullName: string;
    try {
      ({ repoFullName } = await provisionForgeArtifacts(f.name, f.description));
    } catch (err) {
      throw err;
    }
```

(Optionally drop the redundant try/catch since `provisionForgeArtifacts` already logs — but keeping it preserves the original seed structure.)

- [ ] **Step 2: Run the seed in fake mode to confirm no behaviour regression**

```bash
GITHUB_CLIENT_MODE=fake DB_PROVISIONER_MODE=fake pnpm db:seed
```

Expected: "✅ Seed complete." with the same nine forges as before. Database rows present in `forges` table.

- [ ] **Step 3: Run the full vitest suite to ensure nothing broke**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat(seed): write forge.config.json + provision databases in real mode

Renames provisionRepoFullName to provisionForgeArtifacts and extends
it to call writeForgeFiles + createDatabase after the repo is created.
Fake mode is unchanged (no external calls). Failures attempt a
best-effort deleteRepo so re-runs aren't blocked by orphans.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task F2: Pass `DB_PROVISIONER_MODE=fake` through Playwright

**Files:**
- Modify: `~/work/crystal-forge/playwright.config.ts`
- Modify: `~/work/crystal-forge/tests/e2e/global-setup.ts`

- [ ] **Step 1: Add `DB_PROVISIONER_MODE: 'fake'` to the Playwright webServer env**

In `playwright.config.ts`, update the `webServer.env` block:

```ts
    env: {
      AUTH_DEV_USERS_ENABLED: 'true',
      GITHUB_CLIENT_MODE: 'fake',
      GITHUB_REPO_OWNER: 'bmodi-cf',
      GITHUB_TEMPLATE_REPO: 'bmodi-cf/crystal-forge-template-webapp',
      GITHUB_BASE_URL: 'https://github.com',
      DB_PROVISIONER_MODE: 'fake',
    },
```

- [ ] **Step 2: Add `DB_PROVISIONER_MODE: 'fake'` to the e2e global-setup env**

In `tests/e2e/global-setup.ts`, update the `execSync` env block:

```ts
    env: {
      ...process.env,
      GITHUB_CLIENT_MODE: 'fake',
      GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER ?? 'bmodi-cf',
      GITHUB_TEMPLATE_REPO:
        process.env.GITHUB_TEMPLATE_REPO ?? 'bmodi-cf/crystal-forge-template-webapp',
      GITHUB_BASE_URL: process.env.GITHUB_BASE_URL ?? 'https://github.com',
      DB_PROVISIONER_MODE: 'fake',
    },
```

- [ ] **Step 3: Run the full e2e suite**

The pg container must be running. Then:

```bash
pnpm e2e
```

Expected: PASS — all six existing e2e tests green.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts tests/e2e/global-setup.ts
git commit -m "test(e2e): use DB_PROVISIONER_MODE=fake for webServer and seed

Mirrors GITHUB_CLIENT_MODE=fake. Without it the e2e webServer tries
to talk to real Postgres for createDatabase calls, which is both
unnecessary (fake mode is enough for the dashboard's behaviour) and
blocked in CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task F3: Run the full harness verification

**Files:** None — verification only.

- [ ] **Step 1: Typecheck, lint, vitest, e2e**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
```

Expected: each exits 0.

- [ ] **Step 2: Inspect the working tree**

```bash
git status
```

Expected: clean — every change committed in earlier tasks. If anything is left over, commit it as a fixup.

---

## Phase G — Real-mode dry run

End state: a manual smoke test against real GitHub + real Postgres has produced a working forge end-to-end: cloned repo runs `forge-launch.sh` and shows the forge's name on the welcome page.

### Task G1: Verify GitHub App permissions

**Files:** None — manual setup verification.

- [ ] **Step 1: Check the App's repository permissions**

Open `https://github.com/settings/apps/<your-app-name>/permissions` (or the org-level URL if installed at the org).

Required permissions for this slice:

| Resource | Permission | Why |
|---|---|---|
| Repository → Administration | Read & write | Existing — create + archive + delete repos |
| Repository → Contents | **Read & write** | **NEW** — `writeForgeFiles` PUTs to the Contents API |
| Repository → Metadata | Read | Default |

If Contents was previously read-only, change to "Read and write", save, and accept the resulting "permission update" notice on each installation that uses the App.

- [ ] **Step 2: Verify the template repo is marked as a template on GitHub**

Open `https://github.com/bmodi-cf/crystal-forge-template-webapp/settings`. Confirm "Template repository" is ticked. (Set during Phase A, Task A10, Step 5 — verify here.)

---

### Task G2: Real-mode dry run

**Files:** None — manual verification + cleanup.

- [ ] **Step 1: Reset the harness DB and run the seed in real mode**

This will provision nine new repos under `bmodi-cf` and nine new databases on the harness pg. Make sure none of those slugs/names are already taken on GitHub or in the harness pg before running. If they are, manually clean them up.

```bash
cd ~/work/crystal-forge
docker compose up -d postgres
pnpm db:reset       # drops + recreates the dev DB, applies migrations
GITHUB_CLIENT_MODE=real DB_PROVISIONER_MODE=real pnpm db:seed
```

Expected: "✅ Seed complete." Nine repos visible at `https://github.com/bmodi-cf?tab=repositories`. Nine databases visible from `psql`:

```bash
psql -h localhost -p 5433 -U crystal -d postgres -c "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1','crystal_forge','crystal_forge_test') ORDER BY datname"
```

- [ ] **Step 2: Inspect one of the seeded repos**

Pick `aquaflow-designer` (or any other seeded slug). On GitHub, open the repo and confirm:
- `forge.config.json` exists at the root with the expected name/description/slug/dbName/createdAt.
- `.env.example` exists at the root with `DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow_designer`.
- The other template files (app/, prisma/, package.json, forge-launch.sh, etc.) are all present.

- [ ] **Step 3: Clone the seeded repo and run it locally**

```bash
cd ~/work
git clone git@github.com:bmodi-cf/aquaflow-designer.git
cd aquaflow-designer
pnpm install
cp .env.example .env.local
./forge-launch.sh
```

Expected: launcher's bordered banner, `next dev` starts, `http://localhost:3000` shows "Welcome to Aquaflow Designer" with "Hydraulic modeling and nozzle simulation toolkit for fountain projects." underneath.

> Note: this will collide with the harness's own dev server if it's running on :3000. Stop the harness dev server (or run the seeded forge from a different machine / terminal) before this step.

- [ ] **Step 4: Connect to the per-forge database to confirm it's reachable**

```bash
psql -h localhost -p 5433 -U crystal -d aquaflow_designer -c '\dt'
```

Expected: connection succeeds; "Did not find any relations." (empty schema is correct — no models in the template yet).

- [ ] **Step 5: Tear down the dry-run artefacts**

The seed leaves real repos + real databases. To re-seed cleanly later, archive or delete them. Manually for now:

- Archive each seeded repo on GitHub (Settings → Danger Zone → Archive). Note: the seed handles archive→delete for the next run only via the deleteForge code path, which doesn't run during a seed reset. Manual is fine.
- Drop each seeded database:

```bash
psql -h localhost -p 5433 -U crystal -d postgres <<'SQL'
DROP DATABASE IF EXISTS aquaflow_designer;
DROP DATABASE IF EXISTS site_survey_pro;
DROP DATABASE IF EXISTS quotebuilder;
DROP DATABASE IF EXISTS maintenance_hub;
DROP DATABASE IF EXISTS brandkit_manager;
DROP DATABASE IF EXISTS peoplepulse;
DROP DATABASE IF EXISTS forge_labs;
DROP DATABASE IF EXISTS invoicebridge;
DROP DATABASE IF EXISTS showcase_gallery;
SQL
```

- [ ] **Step 6: Final state check**

```bash
cd ~/work/crystal-forge
git status
pnpm typecheck && pnpm lint && pnpm test
```

Expected: clean tree, every harness check green. Phase G is verification — no commits expected.

---

## Self-Review

A coverage audit against the spec sections:

- **Spec §3.A** Template repo structure — Phase A creates every file listed.
- **Spec §3.B** `forge.config.json` contract — Task A7 ships seed values, Task A5 validates the shape, Task D1 declares `ForgeConfigPayload` with the same fields.
- **Spec §3.C** `.env.example` contract — Task A7 ships the seed value; Task E1 (`renderEnvExample`) generates the per-forge variant from `HARNESS_PG_*`.
- **Spec §3.D** Welcome page data flow — Task A6 builds the page with `loadForgeConfig` (Task A5).
- **Spec §3.E** Prisma scaffold — Task A4. The `prisma generate` is wired into `forge-launch.sh` (Task A8).
- **Spec §3.F** Template `forge-launch.sh` — Task A8.
- **Spec §3.G** `DatabaseProvisioner` interface + `writeForgeFiles` — Phases C and D cover both.
- **Spec §3.H** `createForge` flow — Phase E rewrites it with the documented compensation order.
- **Spec §4** Data Model — confirmed no harness DB schema changes; `dbName` is derived (Task B1) and not stored (createForge does not pass it to prisma.forge.create).
- **Spec §5** Error handling table — covered by tests in C3, C4, D2, D4, E3 and surfaced in seed F1 / docs F1.
- **Spec §6** Testing matrix — every listed test is a task: fake-provisioner.test.ts (C3), pg-provisioner.test.ts (C4), fake-client.test.ts writeForgeFiles cases (D2), octokit-client.test.ts retry cases (D4), forges.test.ts new failure paths (E3). The factory `getDatabaseProvisioner()` is exercised end-to-end via the service tests (E3) and seed (F1); per-project convention (`getGitHubClient()` is also untested) there is no separate factory unit test. E2E tightening is intentionally skipped (cross-process fake state isn't observable from the Playwright process; spec calls it optional).
- **Spec §7** Out-of-scope — no tasks touch any of these (no forge.config.json sync on edit, no Dockerfile, no first model, no template tests, no CI, no PR-tree consolidation, no schema file, no pg_dump tooling). Confirmed.
- **Spec §8** File-by-file changes — every listed New / Modified item has a task: types.ts (D1), pg-provisioner.ts (C4), fake-provisioner.ts (C3), provisioner.ts (C2), env.ts (C1), slug.ts/slug.test.ts (B1), octokit-client.test.ts (D4), octokit-client.ts (D3), fake-client.ts and fake-client.test.ts (D2), forges.ts and forges.test.ts (E1/E2/E3/E4).
- **Spec §9** Slice sequencing — this plan is for the dependency slice. The orchestration plan (a follow-up plan) will reference everything Phases B–F deliver.

No placeholders, no "TODO" or "TBD", no naked "implement later" steps. Type names are consistent across tasks (`ForgeConfigPayload`, `ForgeFiles`, `DatabaseProvisioner`, `slugToDbName`, `renderEnvExample`, `safeDeleteRepo`, `safeDropDatabase`).

---

## Out of scope (confirm before starting any task)

- The orchestration slice (start/stop/open buttons + harness child processes) — separate plan.
- Path-based URL routing for forges (`/forges/<slug>` via Caddy) — separate slice.
- Docker-per-forge runtime — separate slice (the future "REST-only container" target).
- Real-time log streaming, SSE/WebSocket status push, auto-restart — separate slice.
- Forge name editing, forge.config.json sync on description edits, hard-delete with database drop — separate slices.
