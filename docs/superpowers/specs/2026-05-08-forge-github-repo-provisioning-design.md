# Crystal Forge — Forge → GitHub Repo Provisioning Design

- **Date:** 2026-05-08
- **Status:** Draft, awaiting user review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Forge → GitHub repo provisioning (a new slice beyond the Frontend MVP; sibling to Phase 3 of `2026-05-04-crystal-forge-frontend-mvp-design.md`, independent of it)

## 1. Summary

Every Forge created in Crystal Forge automatically gets a private GitHub repo, generated from a configurable template. The repo's full name (e.g. `bmodi-cf/site-survey-pro`) is permanent metadata on the Forge and will be the canonical home for AI-generated code in later slices.

This slice does **not** commit code to the new repo, manage branches, configure webhooks, or read repo contents back. It establishes the integration boundary, the data model, and the create / delete lifecycle. Future slices will extend the integration for AI commits, previews, and deploys.

## 2. Goals & Non-Goals

### Goals
- A new private GitHub repo is created from a template the moment a Forge is created. The Forge's `repoFullName` is populated atomically with creation — no half-states, no orphans.
- Repo creation is configurable per environment via env vars: destination owner (e.g. `bmodi-cf` in dev, `CrystalFountainsInc` in prod), template repo, and GitHub App credentials.
- Forge name validation is tightened so derived repo slugs are stable and unique: `^[A-Za-z0-9 _-]+$`, unique per environment, immutable after creation.
- Forge delete archives the GitHub repo (preserves AI-generated code; slug stays taken).
- Repo URL is surfaced in the dashboard card so users can jump straight to GitHub.
- Tests inject a `FakeGitHubClient` so suites stay fast and offline. `pnpm dev` and production use a real Octokit-backed client. Mode is selected at startup via `GITHUB_CLIENT_MODE`.

### Non-Goals (this slice)
- No code is committed to the new repo by Crystal Forge — only the template's contents land there. AI commits are a future slice.
- No webhook handling, branch management, PR creation, or repo settings beyond visibility + description.
- No Forge rename. The name field on the edit modal is removed; description and groups remain editable.
- No backfill UI for old Forges. Dev environments reseed; this slice ships before any prod data exists.
- No GitHub App self-service / install flow — the App is registered once per environment by an admin and configured via env.
- No secret rotation tooling. Manual rotation only.
- No Forge workspace topbar repo link (Phase 3 / workspace slice owns its own UI; out of scope here).

## 3. Architecture

### Module layout

```
lib/
├── github/                          # NEW — GitHub integration boundary
│   ├── client.ts                    # GitHubClient interface + getGitHubClient() factory
│   ├── octokit-client.ts            # OctokitGitHubClient (@octokit/rest + @octokit/auth-app)
│   ├── fake-client.ts               # FakeGitHubClient (in-memory map, used in tests)
│   ├── slug.ts                      # slugifyForgeName(name) — pure
│   ├── slug.test.ts
│   └── types.ts                     # GitHubRepo, CreateRepoOptions, etc.
├── services/
│   ├── forges.ts                    # MODIFIED — createForge / deleteForge wire in GitHubClient
│   ├── forges-schema.ts             # MODIFIED — name regex, drop name from update schema
│   └── forges.test.ts               # MODIFIED — service tests use FakeGitHubClient
├── env.ts                           # MODIFIED — add GITHUB_* vars
└── prisma.ts                        # unchanged
```

### `GitHubClient` interface (minimal for this slice)

```ts
interface GitHubClient {
  createRepoFromTemplate(opts: {
    name: string                     // slug
    description: string | null
    private: boolean                 // always true in this slice
  }): Promise<{ fullName: string; htmlUrl: string }>

  archiveRepo(fullName: string): Promise<void>
  deleteRepo(fullName: string): Promise<void>   // compensating action only — never user-triggered
}
```

`getGitHubClient()` returns the real or fake impl based on `GITHUB_CLIENT_MODE` (`real` default, `fake` for tests). Constructed once per process and cached.

### `createForge` flow (atomic create)

1. Validate input via zod (`createForgeInput` — adds name regex `^[A-Za-z0-9 _-]+$`).
2. Compute slug = `slugifyForgeName(name)`.
3. Pre-check: query Postgres for an existing Forge with the same name. If found, throw `ValidationError("Forge name already in use")` (cheaper than going to GitHub first only to fail there).
4. Call `client.createRepoFromTemplate({ name: slug, description, private: true })` → `{ fullName, htmlUrl }`.
5. Open a Prisma transaction; insert the Forge row with `repoFullName = fullName` plus the `forge_groups` join rows.
6. **If the transaction fails** (e.g. race-condition on the unique name index): call `client.deleteRepo(fullName)` as a compensating action and re-throw. We use `deleteRepo` (not `archiveRepo`) because the repo was just created and contains nothing of value — this is rollback, not user delete.
7. Return the new Forge DTO with `repoUrl` derived from `repoFullName`.

### `deleteForge` flow

1. Existing ACL check (creator OR admin).
2. Call `client.archiveRepo(forge.repoFullName)`. **If this fails**, abort with the GitHub error — don't delete the DB row. Better to leave a usable Forge than to lose the link to its archived-or-not-archived repo.
3. Delete the Forge row in a Prisma transaction (cascade deletes `forge_groups`, plus `conversations`/`messages` once Phase 3 ships).

The archive happens before the DB delete because the DB delete is the harder rollback (we'd need to re-insert with the same id and groups). Archive is idempotent — calling it on an already-archived repo is a no-op-with-success.

### Edit flow

`ForgeFormModal` in edit mode no longer renders the Name field. `updateForgeInput` schema drops `name` entirely. Description and groups remain editable. Description changes do **not** touch GitHub — initial repo description is synced once at creation only.

### Env var additions (validated in `lib/env.ts`)

| Var | Example dev value | Example prod value | Required when `mode=fake`? |
|---|---|---|---|
| `GITHUB_CLIENT_MODE` | `real` | `real` (CI sets `fake`) | yes (`fake`) |
| `GITHUB_REPO_OWNER` | `bmodi-cf` | `CrystalFountainsInc` | yes |
| `GITHUB_TEMPLATE_REPO` | `bmodi-cf/crystal-forge-template-webapp` | `CrystalFountainsInc/crystal-forge-template-webapp` | yes |
| `GITHUB_APP_ID` | (numeric) | (numeric) | no |
| `GITHUB_APP_PRIVATE_KEY` | PEM (multiline) | PEM (multiline) | no |
| `GITHUB_APP_INSTALLATION_ID` | (numeric) | (numeric) | no |
| `GITHUB_BASE_URL` | `https://github.com` | `https://github.com` | yes |

### Strict architectural rules (lint-enforced)

- Existing rule already blocks `lib/prisma` imports outside `lib/services/*`.
- **New rule:** block `@octokit/*` imports outside `lib/github/*`. Services and route handlers go through `getGitHubClient()`. Same lint mechanism as the prisma rule.

## 4. Data Model

Two columns added to `forges`, plus two new unique indexes:

```
forges
  id              uuid pk
  name            text                  # NOW: UNIQUE, regex-validated, immutable
  description     text nullable
  status          enum('active','draft','archived')
  tone            enum('navy','gold','grey')
  initials        text
  created_by      fk users not null
  created_at      timestamptz
  updated_at      timestamptz

  repo_full_name  text NOT NULL         # NEW — e.g. "bmodi-cf/site-survey-pro"

  UNIQUE (name)                         # NEW
  UNIQUE (repo_full_name)               # NEW — safety net
```

### Notable schema choices

- **Why store `repoFullName`, not full URL?** It's the canonical identifier GitHub uses in API calls (`POST /repos/{owner}/{repo}/...`). The URL is computed for display: `${GITHUB_BASE_URL}/${repoFullName}`. One column, future-friendly if we ever move to self-hosted GitHub.
- **Why `NOT NULL`?** Per the "reseed in dev" decision — we ship before any prod data, so every Forge has a repo from day one.
- **Why `UNIQUE(name)`?** Slug is derived from name; slug must be unique on GitHub; therefore name must be unique in the DB to make this clean.
- **No new tables.** No `repo_provisioning_jobs` or audit log — synchronous create, no async state to track.

### Migration

Single Prisma migration:
- Add `repo_full_name` column as `NOT NULL`.
- Add `UNIQUE` index on `name`.
- Add `UNIQUE` index on `repo_full_name`.

`NOT NULL` from day one is safe because dev users run `prisma migrate reset && prisma db seed` (table is empty when the migration applies, then the seed populates every Forge with a real `repoFullName`). Prod hasn't shipped yet, so no row-preservation concerns.

### Seed update

`prisma/seed.ts`: each of the nine prototype Forges goes through real `createForge` (or directly via `getGitHubClient()`). Existing repos in the destination owner with conflicting slugs cause a clear seed failure with a "manually archive these on GitHub first" message. Whether the seed gets a `--force-reset` flag that archives matches first is decided during plan-writing.

## 5. Phase Breakdown

This slice is small enough to ship as **a single phase** with one implementation plan. The work splits naturally into stages within that plan, but they're not independently shippable.

### Stage A — GitHub integration boundary
- `lib/github/types.ts`, `lib/github/client.ts`, `lib/github/slug.ts` + tests.
- `FakeGitHubClient` (in-memory map of repos with create / archive / delete / lookup; supports failure injection).
- `OctokitGitHubClient` using `@octokit/rest` + `@octokit/auth-app`.
- ESLint rule extending the existing prisma rule: block `@octokit/*` imports outside `lib/github/*`.
- Env validation in `lib/env.ts` for the seven new `GITHUB_*` vars (App vars optional when `GITHUB_CLIENT_MODE=fake`).

### Stage B — Schema and service wiring
- Prisma migration: add `repo_full_name`, unique index on `name`, unique index on `repo_full_name`.
- `forges-schema.ts`: tighten `createForgeInput` (regex), drop `name` from `updateForgeInput`.
- `forges.ts`: rewrite `createForge` to call GitHub, persist atomically, compensate on DB failure. Rewrite `deleteForge` to archive first then delete row. `updateForge` no longer accepts `name`.
- Service tests with `FakeGitHubClient`: happy path, GitHub create failure, DB constraint failure triggers `deleteRepo` compensation, archive failure aborts delete, ACL still works as before.

### Stage C — UI and seed
- `ForgeFormModal`: hide name input in edit mode; tighten regex validation in create mode; surface unique-name error from server.
- `ForgeCard`: small "View on GitHub" link / icon.
- `prisma/seed.ts`: each seeded Forge goes through real `createForge`. Helpful failure message if any slug already exists in the destination owner.
- One Playwright happy path: create a Forge, assert the dashboard card shows the GitHub link, delete it, assert against `FakeGitHubClient` that archive was called.

### Definition of Done
- A user can create a Forge in `pnpm dev`, watch the modal spinner, and see the new private repo on GitHub within seconds.
- Deleting that Forge archives (not deletes) the repo on GitHub.
- A user can no longer rename a Forge.
- All existing Phase 1+2 Playwright specs still pass (with `GITHUB_CLIENT_MODE=fake`).
- `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` is green.

## 6. Testing Strategy

Same shape as the existing slice — Vitest colocated with services and components, Playwright for happy paths.

- **`FakeGitHubClient`** is the workhorse. Records every call so tests can assert "delete was called with `bmodi-cf/site-survey-pro`". Supports failure injection (`fake.failNextCall('createRepoFromTemplate', new Error('rate limited'))`) so we can test rollback paths without flakiness.
- **Service tests for `forges.ts`** cover four new cases: GitHub create success → DB success, GitHub create failure → no DB row, DB unique-name failure → `deleteRepo` called for rollback, archive failure → DB row remains.
- **Slug tests** cover the documented rules and edge cases: `"Site Survey Pro"` → `"site-survey-pro"`, `"Quote_Builder-2"` → `"quote_builder-2"`, leading / trailing whitespace trimmed, runs of consecutive spaces collapsed to a single dash, single-word inputs unchanged. The regex check happens in zod against the raw name; slug is the "shape" transform applied after validation.
- **No `OctokitGitHubClient` unit tests.** The Octokit surface is too thin to mock-test usefully; manual smoke test via `pnpm dev` against real GitHub is the truthful verification.
- **Playwright** runs with `GITHUB_CLIENT_MODE=fake`. Tests don't need GitHub credentials in CI.
- **Manual smoke test** before merging: at least one full Forge create + delete against real GitHub with the dev App.

## 7. Decision Log

| # | Decision | Rationale |
|---|---|---|
| 1 | One default template + owner per environment, configured via env vars | Simpler than a per-Forge picker; templates evolve once per env, not per-Forge |
| 2 | GitHub App auth, not PAT | Proper org integration, not tied to a personal account; survives staff turnover |
| 3 | Synchronous create, succeed-or-rollback (no async jobs) | Atomic mental model, no half-states, simple infrastructure |
| 4 | Compensating `deleteRepo` on DB rollback (not archive) | The repo was just created with template content only; nothing of value to preserve. Clean slate. |
| 5 | `archiveRepo` on Forge delete (not `deleteRepo`) | Preserve AI-generated code; archived repos still occupy the slug |
| 6 | Forge name immutable after creation | Removes the entire "rename also renames repo" failure surface; typos require delete-and-recreate (which archives, no data loss) |
| 7 | Slug derived from name (lowercase, spaces→dashes, underscores+dashes preserved); name regex `^[A-Za-z0-9 _-]+$`; name `UNIQUE` | Predictable, simple, slug-stability mirrored at the DB level |
| 8 | Single column `repo_full_name` (`owner/name`); URL computed | Canonical for API calls; future-friendly if we ever support GitHub Enterprise Server |
| 9 | Tests use `FakeGitHubClient`; dev/prod use real | Fast offline tests; manual smoke covers real-API contract |
| 10 | `GitHubClient` interface in `lib/github/`; lint rule blocks `@octokit/*` outside | Same architectural pattern as `lib/services/*` ↔ `lib/prisma`; one enforcement boundary |
| 11 | Reseed in dev; ships before any prod data | `repo_full_name` is `NOT NULL` from day one, no nullable column or backfill UI |
| 12 | Repo description set at creation only (not synced on Forge edit) | Avoids a second GitHub API call (and its failure mode) on every description edit; description on GitHub is informational, not source-of-truth |

## 8. Open Questions / Assumptions to Verify

- **GitHub App permissions** — confirm the App has: Repository → Administration: Read & write (create + archive + delete), Contents: Read (template generate). Installed on `bmodi-cf` (dev) and eventually `CrystalFountainsInc` (prod).
- **Template repo readiness** — `bmodi-cf/crystal-forge-template-webapp` must be marked as a template repository in its GitHub settings (it's not the same as a normal repo we clone from). Confirm this is set.
- **Seeding repo cleanup** — `prisma db seed` will fail on second run if seed Forge slugs already exist as repos. Decide during plan-writing: ship with a `--force-reset` flag that archives matches first, or just document the manual cleanup step.
- **Rate limits** — GitHub App installations get 5,000 requests/hr per installation. Far from a concern at current usage; flag if it becomes one.
- **Runtime App-install removal** — if the App is uninstalled at runtime, Forge creation surfaces a 5xx-class error; no special handling beyond the existing service-error → HTTP mapping. Ops responsibility.

## 9. Out of Scope

Explicit "no" for this slice (each is a future, separately-spec'd slice):

- Committing AI-generated code to the new repo
- Reading repo contents back into Crystal Forge (for previews, etc.)
- Webhooks (push events, PR events)
- Branch / PR / issue management
- Repo settings beyond visibility (`private: true`) and initial description
- Mapping Forge groups to GitHub teams (collaborators, access control on the repo itself)
- Forge workspace topbar repo link (lives in the workspace slice)
- Self-service GitHub App install flow
- Secret rotation tooling
- Multiple destinations per environment / multi-tenant
- Real-GitHub-in-CI test harness (deferred; mocked in tests by current decision)
