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
- `pnpm e2e` — Playwright (forces `GITHUB_CLIENT_MODE=fake`)
- `pnpm db:migrate` — create/apply a migration from schema changes
- `pnpm db:reset` — drop + recreate dev DB then seed (**destroys local data**)
- `pnpm db:studio` — Prisma data browser

## Conventions & gotchas

- **Octokit only inside `lib/github/`.** Enforced by the local `no-octokit-outside-github` ESLint rule — consume the client via `lib/github/client.ts`, never import Octokit elsewhere.
- **Tests are colocated** next to source as `*.test.ts(x)` (e.g. `lib/acl.test.ts`); Playwright e2e lives in `tests/e2e/`.
- **`GITHUB_CLIENT_MODE=fake`** gives a no-network in-memory client — use it for offline UI work and tests. `real` needs the GitHub App env vars (see README).
- **DB access** goes through `lib/prisma.ts`. Postgres binds host port `5433` (not 5432) to avoid colliding with a system Postgres.
- **Don't run `db:reset` / `forge-launch.sh --seed`** unless you intend to wipe local data.
- After schema changes, create a migration with `pnpm db:migrate` — don't hand-edit migration SQL.
