# Crystal Forge — Template Web App + Forge Config Design

- **Date:** 2026-05-08
- **Status:** Draft, awaiting user review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Populate `bmodi-cf/crystal-forge-template-webapp` with a minimal runnable Next.js app, have the harness write `forge.config.json` + `.env.example` into each cloned repo, and provision a per-forge database inside the harness's existing Postgres instance. Builds on `2026-05-08-forge-github-repo-provisioning-design.md`.

## 1. Summary

Today the template repo is empty (just a README). When Crystal Forge generates a new repo from the template, the cloned repo isn't a runnable app, has no record of which forge it belongs to, and has no database to point at.

This slice does three things:

1. **Populates the template repo** with a minimal Next.js 16 app: Tailwind v4, Prisma 7 with an empty schema, a single welcome page that reads `forge.config.json` and renders "Welcome to {name}" with the description below. No auth, no modules, no `docker-compose.yml` — the template app does not own its database.
2. **Provisions one database per forge inside the harness's existing Postgres container.** The harness has a `crystal-forge-pg` container running on host port 5433 today. Every forge gets its own database inside that single instance (e.g. forge "Marketing Fru Fru" → database `marketing_frufru`). Many forges, one Postgres process, one set of credentials.
3. **The harness writes two files into the cloned repo** at create time: `forge.config.json` (the forge's identity) and `.env.example` (with `DATABASE_URL` already pointing at the freshly-created database). After clone the developer runs `pnpm install && cp .env.example .env.local && ./forge-launch.sh` and sees a working welcome page.

Future migration target (out of scope here): each forge becomes a self-contained docker stack (app + its own pg) where REST is the only ingress. Today's choice keeps that door open — the only thing that changes for that migration is `DATABASE_URL` and the addition of a `Dockerfile`.

## 2. Goals & Non-Goals

### Goals
- Cloning a forge from Crystal Forge produces a repo a developer can `git clone && pnpm install && cp .env.example .env.local && ./forge-launch.sh` and see "Welcome to {Forge Name}" with the description below.
- Standalone clones of the template repo (without Crystal Forge in the loop) also run — they ship with placeholder `forge.config.json` and `.env.example` values pointing at a local pg that the developer brings.
- A single `crystal-forge-pg` Postgres container hosts every forge's database. Forge "Marketing Fru Fru" → database `marketing_frufru`.
- The template's stack and version pinning track the harness exactly for shared bits (Next 16, React 19, Prisma 7, Tailwind v4) so the two apps don't drift.
- The harness writes `forge.config.json` and `.env.example` atomically with respect to forge creation. Any failure rolls back via the existing compensating-delete path.
- DB provisioning is testable offline — a `FakeDatabaseProvisioner` mirrors the existing `FakeGitHubClient` pattern.

### Non-Goals (this slice)
- No auth in the template — no NextAuth, providers, or middleware. Welcome page is fully public.
- No modules. The empty Prisma schema is scaffolding only — no models, no migrations.
- No `Dockerfile` in the template, no per-forge docker stack. Template runs `pnpm dev` on the host. (The future REST-only target migrates to this — explicitly out of scope here.)
- No CI in the template. No GitHub Actions, no deploy pipeline.
- No styling system beyond plain Tailwind utilities — no shadcn, no design tokens.
- No edit-time sync of `forge.config.json` when a forge's description changes in the harness. Drift is acceptable for now.
- No mechanism for the template to learn its repo owner, GitHub URL, or other repo metadata — only the four fields in `forge.config.json`.
- No tests inside the template repo. Correctness is verified by the harness's e2e flow plus a manual local launch.
- No backup / dump tooling for the per-forge databases. Standard `pg_dump` works against any forge DB; that's enough.

## 3. Architecture

### A. Template repo structure

```
crystal-forge-template-webapp/
├── app/
│   ├── layout.tsx           # minimal HTML shell, loads globals.css
│   ├── page.tsx             # server component — reads forge config, renders banner
│   └── globals.css          # Tailwind v4 entry
├── lib/
│   └── forge-config.ts      # typed loader + shape check (no Zod, keep deps slim)
├── prisma/
│   └── schema.prisma        # generator + datasource only, no models
├── public/                  # empty
├── forge.config.json        # { name, description, slug, dbName, createdAt } — placeholder values
├── .env.example             # DATABASE_URL placeholder pointing at host:5433/<DBNAME>
├── .gitignore
├── forge-launch.sh          # adapted from harness, no docker, no migrate deploy yet
├── package.json             # next 16.2.4, react 19.2.4, prisma 7.8, tailwind 4
├── tsconfig.json            # strict
├── next.config.ts
├── postcss.config.mjs
├── eslint.config.mjs        # extends next/core-web-vitals
└── README.md
```

Notable absences vs. the harness: no `docker-compose.yml`, no `prisma/migrations/`, no auth files, no test scaffolding.

### B. `forge.config.json` contract

Lives at the repo root, committed to git, single source of forge identity inside the cloned repo.

```json
{
  "name": "Marketing Fru Fru",
  "description": "Big flash! Big sale!",
  "slug": "marketing-frufru",
  "dbName": "marketing_frufru",
  "createdAt": "2026-05-09T01:34:47.000Z"
}
```

Field rules:
- `name`: human-readable display name (preserves casing/punctuation as the user typed). Required, non-empty.
- `description`: optional, may be `null` or empty string. "No description" by the welcome page.
- `slug`: kebab-case slug used for the GitHub repo name. Required, must match `^[a-z0-9-]+$`.
- `dbName`: the Postgres database name. Required, must match `^[a-z0-9_]+$`. Derived from `slug` by replacing hyphens with underscores so it can be used unquoted in `psql` and connection strings.
- `createdAt`: ISO 8601 string. Required.

In the template repo's seed copy, values are placeholders: `name: "Forge Template"`, `description: "A minimal Crystal Forge web app."`, `slug: "forge-template"`, `dbName: "forge_template"`.

### C. `.env.example` contract

The harness writes a complete, ready-to-copy `.env.example` into every cloned repo. Contents:

```
# Postgres connection. Points at the harness's crystal-forge-pg container.
# Copy this file to .env.local before running ./forge-launch.sh.
DATABASE_URL=postgres://crystal:crystal@localhost:5433/marketing_frufru
```

The connection target — host `localhost`, port `5433`, user/password `crystal:crystal` — comes from harness env (`HARNESS_PG_HOST`, `HARNESS_PG_PORT`, `HARNESS_PG_USER`, `HARNESS_PG_PASSWORD`, all read with sensible defaults that match `docker-compose.yml`). Only the database name varies per forge.

The template repo's seed `.env.example` has `forge_template` in place of the slug-derived name and is committed to the template repo so a standalone clone of the template also has something sensible to copy.

These are local-dev credentials for a container that listens on localhost only. Committing them to the cloned repo is acceptable for the dev-only shape of this slice. When the slice that goes to a hosted environment lands, the connection string source will move out of git.

### D. Template welcome page data flow

```
HTTP GET /
        │
        ▼
app/page.tsx (Server Component)
        │  await loadForgeConfig()
        ▼
lib/forge-config.ts
        │  fs.readFile('forge.config.json'), JSON.parse, shape check
        ▼
        returns ForgeConfig (typed)
        │
        ▼
app/page.tsx renders:
    <main class="min-h-screen flex items-center justify-center">
      <div class="text-center">
        <h1 class="text-6xl">Welcome to {name}</h1>
        {description && <p class="mt-6 text-xl">{description}</p>}
      </div>
    </main>
```

`loadForgeConfig` is a tiny module — reads `forge.config.json` from `path.join(process.cwd(), 'forge.config.json')`, parses, runs an inline shape check (`typeof name === 'string'`, etc.), throws a clear error if malformed, returns `{ name, description, slug, dbName, createdAt }`. No caching layer for now — Next's default Server Component behaviour gives us per-request reads, which is fine and surfaces config edits without restart.

### E. Template's Prisma scaffold

`prisma/schema.prisma` ships with generator + datasource only:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

No models, no migrations directory yet. `forge-launch.sh` runs `prisma generate` (idempotent, no DB needed) and **skips** `prisma migrate deploy` until a `prisma/migrations/` directory exists. The first module to land in a forge will add the first model and produce the first migration.

### F. Template's `forge-launch.sh`

Adapted from the harness, with three subtractions:

1. No docker step — the template doesn't own postgres.
2. No `migrate deploy` step until the migrations directory exists. Script `[[ -d prisma/migrations ]] && pnpm prisma migrate deploy` is the gate.
3. No `--seed` flag.

It still:
- Pre-checks `.env.local` exists (copy `.env.example` first if missing).
- Pre-checks port 3000 is free.
- Runs `prisma generate`.
- Runs `pnpm dev` and prints the bordered URL banner.

It additionally adds a soft pg-connectivity probe before `prisma generate`: a one-shot `psql -c 'SELECT 1'` (or `pg_isready -h localhost -p 5433`) with a clear hint to start the harness if it fails. The probe is non-fatal in the standalone-clone case where the developer wires up their own pg — they can suppress it via `SKIP_PG_CHECK=1`.

### G. Harness change — DB provisioning + writing files

Two new pieces of harness machinery:

**1. `DatabaseProvisioner` interface**, mirroring the `GitHubClient` shape.

```ts
interface DatabaseProvisioner {
  /** Creates the named database. Throws on already-exists or any pg error. */
  createDatabase(name: string): Promise<void>;
  /** Compensating action only — drops the named database. Idempotent (no-op on missing). */
  dropDatabase(name: string): Promise<void>;
}
```

- `PgDatabaseProvisioner` (real): connects via the existing `pg` package to `postgres://{HARNESS_PG_USER}:{HARNESS_PG_PASSWORD}@{HARNESS_PG_HOST}:{HARNESS_PG_PORT}/postgres`, executes `CREATE DATABASE "<name>"` / `DROP DATABASE IF EXISTS "<name>"`. Always quotes the name to defend against future name shapes; `dbName` validation upstream guarantees no SQL-injection vector. Pool is a single short-lived `Client` per call — no shared connection pool needed.
- `FakeDatabaseProvisioner` (test): in-memory `Set<string>` of created names. `createDatabase` throws if already present; `dropDatabase` removes idempotently.
- Mode is selected by `DB_PROVISIONER_MODE = 'real' | 'fake'`, paralleling `GITHUB_CLIENT_MODE`. Tests force `fake`.

**2. `GitHubClient.writeForgeFiles`** (replaces the earlier `writeForgeConfig`-only sketch).

```ts
interface GitHubClient {
  // ... existing ...
  /**
   * Commits forge.config.json AND .env.example to the default branch of `fullName`.
   * Two PUTs to /repos/{owner}/{repo}/contents/{path}, each producing one commit.
   * Throws on any failure; caller is responsible for compensation.
   */
  writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void>;
}

type ForgeFiles = {
  forgeConfig: ForgeConfigPayload;   // serialised to JSON
  envExample: string;                // already-rendered .env.example body
};
```

`OctokitGitHubClient.writeForgeFiles`:
- Sequentially PUTs `forge.config.json` and `.env.example` to `/repos/{owner}/{repo}/contents/{path}`. Two commits is fine for now; collapsing to one via the trees API is a future optimisation.
- GitHub's template-clone is asynchronous: the new repo can return 404 on contents writes for a few hundred ms after `createUsingTemplate` resolves. **Each PUT** retries on 404 only with bounded exponential backoff — 5 attempts at 200/400/800/1600/3200ms (~6s ceiling). Any other status (401/403/422/5xx) throws immediately.

`FakeGitHubClient.writeForgeFiles`: records the payload + body in an in-memory map keyed by `fullName`. Test helpers assert against it.

### H. `createForge` flow under this design

```
1. Validate name uniqueness, group membership            (existing)
2. Compute slug, derive dbName                           (existing slug + new dbName helper)
3. createRepoFromTemplate                                (existing)
4. writeForgeFiles  ───────────────  on fail: deleteRepo, throw
5. createDatabase   ───────────────  on fail: deleteRepo, throw
6. prisma.forge.create (in $tx)  ──  on fail: dropDatabase, deleteRepo, throw
   return DTO
```

`safeDeleteRepo(client, fullName)` — best-effort delete that logs but never throws — is extracted from the existing inline catch block and reused. A new `safeDropDatabase(provisioner, dbName)` mirror handles the DB rollback.

`deleteForge` does **not** drop the database. Today's `deleteForge` archives the GitHub repo (preserving AI-generated code) — the database mirrors that: keep it, since it may contain user data, and the slug stays taken on both fronts. A future hard-delete slice will drop both. This keeps lifecycle parity between the two external resources.

## 4. Data Model

No DB schema changes to the harness's own DB. `forges` table is untouched.

The `forge.config.json` payload is a function of existing fields:
- `name` → `forges.name`
- `description` → `forges.description`
- `slug` → `slugifyForgeName(forges.name)` (already computed)
- `dbName` → `slugToDbName(slug)` (new pure helper: replace `-` with `_`)
- `createdAt` → `new Date().toISOString()` at write time

The harness's `forges` table doesn't store `dbName` because it's pure-function-derivable from `slug`. Adding a column is an option later if we ever decouple them.

## 5. Error Handling & Edge Cases

| Failure | Behaviour |
|---|---|
| Repo create fails | Existing behaviour. Validation/auth/rate-limit error propagates. No DB row, no repo, no database. |
| `writeForgeFiles` fails after retries | `safeDeleteRepo` runs; underlying error propagates. No DB row, no database. |
| `createDatabase` fails (e.g. pg unreachable, name conflict) | `safeDeleteRepo` runs; underlying error propagates. No DB row. |
| DB row write fails | `safeDropDatabase` runs, then `safeDeleteRepo` runs; underlying error propagates. |
| Compensation step fails after a primary failure | Logged loudly (matches existing pattern). Original error propagates. Manual cleanup needed. |
| Database name already exists in pg (e.g. residue from a previous failed run that didn't compensate) | `createDatabase` throws "database already exists". Caller treats as a hard failure — investigate and clean up manually. Acceptable for v1 because failed compensations are already a rare manual-fix path. |
| Template repo's seed `forge.config.json` is malformed | `loadForgeConfig` throws, welcome page returns 500 with a clear message. Treated as a developer error to fix in the template. |
| Cloned repo where the harness write succeeded but the JSON was hand-edited to invalid shape | Same as above: 500 in the cloned app. The clone is the user's repo to fix. |
| Cloned repo running with no `DATABASE_URL` set | Welcome page renders fine — it doesn't touch the DB. `prisma generate` works. `pnpm dev` runs. Only attempts to use Prisma client at runtime fail. |
| Standalone clone of template, harness pg not running | `forge-launch.sh`'s soft probe prints a clear hint. Set `SKIP_PG_CHECK=1` to bypass. Welcome page works either way. |

## 6. Testing

### Harness (in this repo)

- `lib/db/provisioner.fake.test.ts` (new) — `FakeDatabaseProvisioner` cases: create, create-twice throws, drop, drop-missing is idempotent.
- `lib/db/provisioner.pg.test.ts` (new, integration) — happy-path `createDatabase` + `dropDatabase` against the existing `_test` integration database, asserting the named DB shows up in `pg_database` and disappears after drop.
- `lib/github/fake-client.test.ts` — extend with `writeForgeFiles` cases: stores both files, second write overwrites, delete clears the recorded entry.
- `lib/github/octokit-client.test.ts` (new or extended) — retry behaviour using stubbed Octokit. Cover: succeeds first try; succeeds after 404s; throws after 5x 404; throws immediately on 401.
- `lib/services/forges.test.ts` — extend `createForge` cases:
  - happy path asserts `FakeGitHubClient` recorded the expected `forge.config.json` + `.env.example`, and `FakeDatabaseProvisioner` recorded the expected `dbName`.
  - `writeForgeFiles` failure → repo deleted, no database, no DB row.
  - `createDatabase` failure → repo deleted, no DB row.
  - DB row failure → database dropped, repo deleted.
- `tests/e2e/dashboard-crud.spec.ts` — assertion can be tightened to confirm the fakes recorded the expected files + dbName.

### Template repo (manual)

- `git clone` the template, `pnpm install`, `cp .env.example .env.local`, `./forge-launch.sh`. Welcome page shows placeholder values.
- Locally edit `forge.config.json` to a different `name` / `description`. Refresh — values change without restart.
- Confirm the soft pg probe is informative when harness pg is down.

### End-to-end (real-mode dry-run)

- Create a forge through the harness with `GITHUB_CLIENT_MODE=real` and `DB_PROVISIONER_MODE=real` against `bmodi-cf` and the harness pg. Clone the resulting repo. `cat forge.config.json` shows the harness's payload. `cat .env.example` shows the slug-named database. `psql -h localhost -p 5433 -U crystal -d marketing_frufru -c '\dt'` succeeds (empty schema). `pnpm install && cp .env.example .env.local && ./forge-launch.sh` produces a welcome page with the forge's name and description.

## 7. Out-of-Scope Follow-ups

- Propagating description edits from the harness into the cloned repo's `forge.config.json` (small Octokit PUT keyed off the existing SHA).
- Hard-delete forge → drop the database. Currently archive-only, like the repo.
- Per-forge isolation upgrade: the future "REST-only container" model where each forge becomes a self-contained docker stack. Migration touches `DATABASE_URL` and adds a `Dockerfile` + `docker-compose.yml` to the template; doesn't touch the welcome page.
- A real first module — adds the first Prisma model and migration.
- Template tests (component test for the welcome page, smoke test for `loadForgeConfig`) once the template grows.
- CI in the template repo (typecheck + lint + build on PR).
- Collapsing `writeForgeFiles` from two commits to one via the git trees API.
- A `forge.config.schema.json` shipped in both repos so the contract is machine-checkable.
- Backup / restore tooling (`pg_dump` per forge DB).

## 8. File-by-File Changes Summary

### New (template repo)

- `app/layout.tsx`, `app/page.tsx`, `app/globals.css`
- `lib/forge-config.ts`
- `prisma/schema.prisma`
- `forge.config.json` (seed values)
- `.env.example` (seed values)
- `forge-launch.sh`, `.gitignore`
- `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`
- `README.md`

### New (harness, this repo)

- `lib/db/provisioner.ts` — `DatabaseProvisioner` interface, factory `getDatabaseProvisioner()`.
- `lib/db/pg-provisioner.ts` — `PgDatabaseProvisioner` (real, uses `pg`).
- `lib/db/fake-provisioner.ts` — `FakeDatabaseProvisioner` (in-memory).
- `lib/db/fake-provisioner.test.ts`, `lib/db/pg-provisioner.test.ts` (integration).
- `lib/github/slug.ts` (modified) — add `slugToDbName(slug)` pure helper.
- `lib/github/slug.test.ts` (modified) — cases for `slugToDbName`.
- `lib/github/octokit-client.test.ts` (new or extended).

### Modified (harness, this repo)

- `lib/env.ts` — add `HARNESS_PG_HOST`, `HARNESS_PG_PORT`, `HARNESS_PG_USER`, `HARNESS_PG_PASSWORD`, `DB_PROVISIONER_MODE`.
- `lib/github/types.ts` — replace any prior `writeForgeConfig` sketch with `writeForgeFiles`, add `ForgeFiles` and `ForgeConfigPayload` types.
- `lib/github/octokit-client.ts` — implement `writeForgeFiles` with per-PUT 404-retry.
- `lib/github/fake-client.ts` — implement `writeForgeFiles` with in-memory map.
- `lib/github/fake-client.test.ts` — add cases.
- `lib/services/forges.ts` — call `writeForgeFiles`, then `createDatabase`, then DB row write. Extract `safeDeleteRepo` and add `safeDropDatabase`.
- `lib/services/forges.test.ts` — cases for the new failure paths and happy-path payload + dbName assertion.
