<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project: Crystal Forge

A Next.js dashboard for managing **Forges** — per-team workspaces, each mapped 1:1 to a
private GitHub repo created from a template via a configured GitHub App. The dashboard can
also launch agent runtimes inside a Forge (clone repo → spawn a PTY process → stream over a
WebSocket to an xterm terminal in the browser).

See `README.md` for full setup, env vars, and troubleshooting. This file covers what an
agent needs to work in the codebase correctly.

## Stack

- **Next.js 16** (App Router) + **React 19**, TypeScript strict (see the rule above — APIs differ from training data)
- **Prisma 7** + **Postgres 16** (Docker, host port `5433`)
- **Auth.js** (`next-auth` v5 beta) with Microsoft Entra ID
- **GitHub App** via Octokit, with an in-memory `fake` mode for tests/offline
- **Tailwind v4** + **shadcn** (Base UI) components
- **Vitest** (unit) + **Playwright** (e2e); **node-pty** + **ws** + **xterm** for runtimes

## Layout

- `app/` — App Router. Route groups: `(app)` (dashboard, forges), `(auth)` (login), `api/` (route handlers)
- `lib/services/` — domain services (forges, groups, users, conversations, runtime). Start here for business logic.
- `lib/github/` — GitHub client: `client.ts` (factory), `octokit-client.ts` (real), `fake-client.ts` (fake), `slug.ts`
- `lib/runtime/` — agent-runtime layer: clone, port allocation, process/PTY management, WebSocket server, transcript watching
- `lib/acl.ts` — access control (users ↔ groups ↔ roles ↔ forges)
- `prisma/` — `schema.prisma`, migrations, `seed.ts`
- `components/ui/` — shadcn primitives; `components/topbar/` — app chrome
- `eslint-rules/` — local lint rules (see below)
- `docs/superpowers/` — design specs and implementation plans

## Commands

- `./forge-launch.sh [--seed]` — daily launch (Docker → Postgres → migrate → dev server). `--seed` is destructive.
- `pnpm dev` / `pnpm build` / `pnpm start` — dev / prod build / prod start
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint (includes the repo rule below)
- `pnpm test` / `pnpm test:watch` — Vitest unit suite
- `./scripts/e2e.sh` — Playwright (forces `GITHUB_CLIENT_MODE=fake`). **Not** a `pnpm` script, on purpose — see below. Only needed when standing up a new server or a fresh local instance.
- `pnpm db:migrate` — create/apply a migration from schema changes
- `pnpm db:reset` — drop + recreate dev DB then seed (**destroys local data**)
- `pnpm db:studio` — Prisma data browser

## Conventions & gotchas

- **Octokit only inside `lib/github/`.** Enforced by the local `no-octokit-outside-github` ESLint rule — consume the client via `lib/github/client.ts`, never import Octokit elsewhere.
- **Tests are colocated** next to source as `*.test.ts(x)` (e.g. `lib/acl.test.ts`); Playwright e2e lives in `tests/e2e/`.
- **`GITHUB_CLIENT_MODE=fake`** gives a no-network in-memory client — use it for offline UI work and tests. `real` needs the GitHub App env vars (see README).
- **DB access** goes through `lib/prisma.ts`. Postgres binds host port `5433` (not 5432) to avoid colliding with a system Postgres.
- **Don't run `db:reset` / `forge-launch.sh --seed`** unless you intend to wipe local data.
- **`pnpm test` printing `🌱 The seed command has been executed` is EXPECTED — it does not touch the dev DB.** `vitest.global-setup.ts` derives a dedicated database by appending `_test` to the configured `DATABASE_URL` (so `crystal_forge` → `crystal_forge_test`), creates it, runs `prisma migrate deploy` + `db:seed` against *that*, and `vitest.setup.ts` rewrites `DATABASE_URL` per worker so every test targets it — even when `.env.local` points at the live dev database. Verify with `select datname from pg_database`, don't panic.
- **The e2e suite re-seeds, so it is gated behind `./scripts/e2e.sh` rather than a `pnpm` script.** It used to be `pnpm e2e`, which inherited `DATABASE_URL` verbatim and wiped the *live* dashboard DB on the pilot (forges, users, promotion history), while `reuseExistingServer` pointed the tests at the live dashboard on `:80`. Now: the script refuses when it detects a live deployment (override with `--i-understand-this-seeds-the-db`), rewrites `DATABASE_URL` to `<db>_e2e`, and pins the server to `E2E_PORT` (default 3300) with no server reuse. `tests/e2e/global-setup.ts` independently throws on any database not ending in `_e2e`, so `pnpm exec playwright test` can't bypass the guard. Don't re-add an `e2e` entry to `package.json`.
- After schema changes, create a migration with `pnpm db:migrate` — don't hand-edit migration SQL.
- **Forge restart = full container recreate, never reuse.** `stopForge`→`doStop` *stops and removes* the container; `startForge`→`finishStart` always `containerManager.create()`s a fresh one (there is no `docker start`-an-existing-container path). So container env (`FORGE_BASE_PATH`, `FORGE_DEV_ORIGINS`, `DATABASE_URL`, `GH_TOKEN`) is re-applied at every start (DB password rotates per start), and **only the named volumes — workspace + Claude home — persist** across the cycle. ⇒ To change a forge's container env you must stop+start it; to change the *dashboard* env that feeds `create()` (e.g. `FORGE_DEV_ORIGINS`), update `.env.local`, restart `crystal-forge.service`, *then* restart the forge.
- **Deleting files inside this repo is pre-approved** — git history is sufficient backup, so remove dead code freely without stopping to ask. Deleting anything **outside** the repo still requires explicit approval.
- **First-release bundles are the only pilot→prod data path, and they run once.**
  The pilot cuts `<slug>-seed:<version>` into the registry from an *accepted first*
  promotion (`admin/promotions`); prod imports it from `admin/deployments`. The
  once-only guard is a `_forge_seed` table created by an unconditional
  `CREATE TABLE` inside the restore transaction, so a second import aborts rather
  than merges. There is no `--force`: re-seeding means dropping the forge database
  by hand. Import order is load-bearing — `deployEnabled` stays false until the
  restore commits, because `listDesiredForges` filters on it and the reconciler
  would otherwise start the container mid-restore. Only a *completed* restore
  blocks a retry: an import that failed before writing the marker leaves the
  row at `deployEnabled: false, deployVersion: null`, and simply re-running the
  import resumes it — the by-hand drop is needed only once the marker exists.
  Two things the bundle does *not* carry, both of which need a human either side
  of the gap: it is a **snapshot**, so anything written on the pilot between the
  cut and the cutover is silently lost and the pilot must stop taking writes for
  that window (re-cut if it does not); and it carries **no group access**, since
  `importBundle` writes no `ForgeGroup` rows and attributes the row to the
  importing admin — `forgeReadFilter` grants read only via group membership or
  `createdById`, so an imported forge is visible to admins only until its groups
  are granted by hand (prod has no forge-settings UI: insert the `ForgeGroup`
  rows), and the team it was migrated for cannot see it.
- **`pg_dump`/`psql` run via `docker exec` into `$PG_CONTAINER`, not through
  `ContainerManager`.** That abstraction is for forge containers and surfaces only
  *combined* stdout/stderr, which would corrupt a dump the moment `pg_dump`
  emitted a warning. Restores connect over TCP as the per-forge app role (not the
  trust socket as superuser) so the role ends up owning the restored tables —
  otherwise later `prisma migrate deploy` runs cannot `ALTER` them.
