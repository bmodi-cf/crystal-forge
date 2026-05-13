# Crystal Forge

A Next.js dashboard for managing **Forges** — per-team workspaces backed by GitHub repositories created from a configured template. Each Forge maps 1:1 to a private GitHub repo (created and archived through a configured GitHub App).

## Stack

- **Next.js 16** (React 19), TypeScript
- **Prisma 7** + **Postgres 16** (Docker)
- **Auth.js** (next-auth) with Microsoft Entra ID
- **GitHub App** integration via Octokit (with a `fake` mode for tests and offline dev)
- **Vitest** (unit) + **Playwright** (e2e)

## Prerequisites

- Node 20+ and pnpm 9+
- Docker Desktop, OrbStack, or Colima
- Port `5433` free on the host (Postgres binds there to avoid colliding with a system Postgres on 5432; configurable in `docker-compose.yml`)
- macOS or Linux. The launch script auto-starts Docker Desktop on macOS only.

## First-time setup

```bash
git clone git@github.com:bmodi-cf/crystal-forge.git
cd crystal-forge

# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env.local
# Then fill in:
#   AUTH_SECRET                 — generate with: pnpm dlx auth secret
#   AUTH_MICROSOFT_ENTRA_ID_*   — from your Entra ID app registration
#   GITHUB_*                    — see "GitHub integration modes" below
```

## Daily launch

```bash
./forge-launch.sh
```

The script will:

1. Verify the working directory, `.env.local`, and `node_modules`.
2. Start the Docker daemon if it isn't already running (macOS: `open -a Docker`).
3. Bail if port 3000 is taken.
4. Bring up the `crystal-forge-pg` Postgres container and wait for its healthcheck.
5. Apply any pending Prisma migrations (`prisma migrate deploy`).
6. Print the local URL and exec `pnpm dev` in the foreground.

Open http://localhost:3030 once the dev server prints `Ready in …`. Press Ctrl+C to stop the dev server; the Postgres container keeps running between launches.

Pass `--seed` to also (re)populate dev users, groups, and sample Forges after migrations:

```bash
./forge-launch.sh --seed
```

This is destructive — the seed wipes the seeded tables before re-inserting — so use it on first launch or when you want a clean slate.

## Useful scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server (assumes Postgres is up) |
| `pnpm build` / `pnpm start` | Production build / start |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (includes the `no-octokit-outside-github` repo rule) |
| `pnpm test` | Vitest unit suite |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm e2e` | Playwright e2e suite (forces `GITHUB_CLIENT_MODE=fake`) |
| `pnpm db:migrate` | `prisma migrate dev` — create/apply migrations from schema changes |
| `pnpm db:reset` | Drop and recreate the dev DB, then run the seed |
| `pnpm db:seed` | Run `prisma/seed.ts` |
| `pnpm db:studio` | Prisma Studio data browser |

## GitHub integration modes

Set `GITHUB_CLIENT_MODE` in `.env.local`:

- `fake` — in-memory client; no network calls, no GitHub credentials required. Used by the e2e suite and recommended for offline UI work.
- `real` — talks to GitHub via a configured GitHub App. Requires:
  - `GITHUB_APP_ID`
  - `GITHUB_APP_PRIVATE_KEY` (PEM)
  - `GITHUB_APP_INSTALLATION_ID`
  - `GITHUB_REPO_OWNER` (the org or user under which Forge repos are created)
  - `GITHUB_TEMPLATE_REPO` (must be marked as a template repository on GitHub)

The App needs `Repository → Administration: Read & Write` and `Contents: Read` permissions, and must be installed on the owner from `GITHUB_REPO_OWNER`.

## Project layout

- `app/` — Next.js app router (pages and route handlers)
- `lib/services/` — domain services (Forges, Groups, Users)
- `lib/github/` — GitHub client (real + fake), slug helper, types
- `prisma/` — schema, migrations, seed
- `tests/` — Vitest unit specs (`*.test.ts(x)`) and Playwright e2e (`tests/e2e/`)
- `eslint-rules/` — local ESLint rules
- `docs/superpowers/` — design specs and implementation plans

## Troubleshooting

- **Port 5433 already in use** — change the host port in `docker-compose.yml` and update `DATABASE_URL` in `.env.local`.
- **Docker Desktop won't start** — the launch script tries `open -a Docker` on macOS. If you use OrbStack or Colima, start it manually before running `./forge-launch.sh`.
- **`prisma migrate deploy` errors on first launch** — make sure `DATABASE_URL` in `.env.local` matches the Postgres container (defaults: `postgresql://crystal:crystal@localhost:5433/crystal_forge?schema=public`).
- **Schema drift after pulling** — run `pnpm db:reset` to wipe and reapply migrations + seed (destroys local dev data).
