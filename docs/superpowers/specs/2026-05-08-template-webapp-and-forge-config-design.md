# Crystal Forge — Template Web App + Forge Config Design

- **Date:** 2026-05-08
- **Status:** Draft, awaiting user review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Populate `bmodi-cf/crystal-forge-template-webapp` with a minimal runnable Next.js app, and have the harness write a `forge.config.json` into each cloned repo. Builds directly on `2026-05-08-forge-github-repo-provisioning-design.md`.

## 1. Summary

Today the template repo is empty (just a README). When Crystal Forge generates a new repo from the template, the cloned repo isn't a runnable app — and it has no record of which forge it belongs to.

This slice does two things:

1. **Populates the template repo** with a minimal Next.js 16 app that mirrors the harness's stack (Docker + Postgres + Prisma + Tailwind v4) but ships with no auth and no modules. The app's only page is a centred welcome banner showing the forge's `name` and `description`.
2. **Extends the harness** so that immediately after `repos.createUsingTemplate` succeeds, it commits a `forge.config.json` to the new repo's default branch. The template's welcome page reads this file at request time. End result: the moment a forge is created, its cloned repo has its own identity.

## 2. Goals & Non-Goals

### Goals
- Cloning the template via Crystal Forge produces a repo a developer can `git clone && pnpm install && ./forge-launch.sh` and see "Welcome to {Forge Name}" with the description below.
- Standalone clones of the template repo (without Crystal Forge in the loop) also run — they show placeholder values shipped in the seed `forge.config.json`.
- `forge.config.json` is the single source of forge identity inside the cloned repo; it carries `{ name, description, slug, createdAt }`.
- The harness writes `forge.config.json` atomically with respect to forge creation: if the write fails, the GitHub repo is rolled back via the existing compensating delete, just like a DB write failure.
- The template's stack and version pinning track the harness exactly for shared bits (Next 16, React 19, Prisma 7, Tailwind v4) so neither app drifts.
- The template runs alongside the harness on the same machine — different host port, different container name.

### Non-Goals (this slice)
- No auth in the template — no NextAuth, no providers, no middleware. The welcome page is fully public.
- No modules: no chat, no AI integration, no DB-backed pages. The empty Prisma schema is scaffolding only.
- No CI in the template repo. No deploy pipeline, no GitHub Actions.
- No styling system beyond plain Tailwind utilities. No shadcn, no design tokens, no theming.
- No multi-forge concurrency story for the dev container — the template assumes one forge runs at a time on the host.
- No mechanism for the template to learn its repo owner, GitHub URL, or other repo metadata. Only the four fields in `forge.config.json`.
- No edit-time sync of `forge.config.json` when a forge's description changes in the harness. Drift is acceptable for this slice (description edit in the harness updates the DB; the cloned repo is unchanged). A later slice will add propagation if it matters.
- No tests inside the template repo itself. The template's correctness is verified by the harness's e2e flow plus a manual local launch.

## 3. Architecture

### A. Template repo structure

```
crystal-forge-template-webapp/
├── app/
│   ├── layout.tsx           # minimal HTML shell, loads globals.css
│   ├── page.tsx             # server component — reads forge config, renders banner
│   └── globals.css          # Tailwind v4 entry
├── lib/
│   └── forge-config.ts      # typed loader + Zod-free schema check (keep deps slim)
├── prisma/
│   └── schema.prisma        # generator + datasource only, no models
├── public/                  # empty (favicon optional)
├── docker-compose.yml       # postgres on host port 5434, container forge-pg
├── forge.config.json        # { name, description, slug, createdAt } — placeholder values
├── forge-launch.sh          # adapted from harness, no --seed
├── .env.example             # DATABASE_URL on 5434
├── .gitignore
├── package.json             # next 16.2.4, react 19.2.4, prisma 7.8, tailwind 4
├── tsconfig.json            # strict
├── next.config.ts
├── postcss.config.mjs
├── eslint.config.mjs        # extends next/core-web-vitals
└── README.md
```

### B. `forge.config.json` contract

Single source of forge identity inside the cloned repo. Lives at the repo root, committed to git.

```json
{
  "name": "Marketing Fru Fru",
  "description": "Big flash! Big sale!",
  "slug": "marketing-frufru",
  "createdAt": "2026-05-09T01:34:47.000Z"
}
```

Field rules:
- `name`: human-readable display name (preserves casing/punctuation as the user typed it). Required, non-empty.
- `description`: optional, may be `null` or empty string. Treated as "no description" by the welcome page.
- `slug`: kebab-case slug used for the repo name. Required, must match `^[a-z0-9-]+$`.
- `createdAt`: ISO 8601 string. Required.

In the seed copy committed to the template repo itself, values are placeholders (`name: "Forge Template"`, `description: "A minimal Crystal Forge web app."`, `slug: "forge-template"`, `createdAt` of the template's first commit).

### C. Template welcome page data flow

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

`loadForgeConfig` is a tiny module:
- Reads `forge.config.json` from the project root via `path.join(process.cwd(), 'forge.config.json')`.
- Parses, then runs an inline shape check (`typeof name === 'string'`, etc.). Throws a clear error if malformed — surfaces as a 500 in dev with a useful message.
- Returns `{ name: string; description: string | null; slug: string; createdAt: string }`.

No caching layer for now. Next's default Server Component behaviour gives us per-request reads, which is fine at this scale and surfaces config edits without restart.

### D. Template's docker + Prisma scaffold

`docker-compose.yml` differs from the harness in two ways to allow co-existence on one machine:

| | Harness | Template |
|---|---|---|
| Container name | `crystal-forge-pg` | `forge-pg` |
| Host port | 5433 | 5434 |
| DB / user / password | `crystal_forge` / `crystal` / `crystal` | `forge` / `forge` / `forge` |

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

No models, no migrations directory yet. `forge-launch.sh` runs `prisma generate` (idempotent) and skips `migrate deploy` until the migrations directory exists. The first module to land in a forge will add models and produce the first migration.

### E. Harness change — writing `forge.config.json`

`GitHubClient` interface gains one method:

```ts
interface GitHubClient {
  // ... existing ...
  /**
   * Commit a `forge.config.json` to the default branch of `fullName`.
   * Throws on failure. Caller is responsible for compensation.
   */
  writeForgeConfig(fullName: string, payload: ForgeConfigPayload): Promise<void>;
}

type ForgeConfigPayload = {
  name: string;
  description: string | null;
  slug: string;
  createdAt: string; // ISO 8601
};
```

`OctokitGitHubClient.writeForgeConfig`:
- PUTs `/repos/{owner}/{repo}/contents/forge.config.json` with `{ message: 'chore: forge config', content: base64(JSON.stringify(payload, null, 2) + '\n') }`.
- GitHub's template-clone is asynchronous: the new repo can return 404 on contents writes for a few hundred ms after `createUsingTemplate` resolves. Retry the PUT with bounded exponential backoff: 5 attempts, 200ms / 400ms / 800ms / 1600ms / 3200ms (≈6s ceiling). Retry **only on 404** — that's the documented post-template-clone race. Any other status (401, 403, 422, 5xx) → throw immediately.
- Commit is made by the GitHub App identity (already authenticated). No author override needed.

`FakeGitHubClient.writeForgeConfig`:
- Records the payload in an in-memory map keyed by `fullName`. Test helpers assert against it.

`lib/services/forges.ts` — `createForge` change:

```
// 3. Create repo
const created = await client.createRepoFromTemplate({ ... });

// 4. Write forge.config.json. Failure here is treated identically to a DB
//    failure: compensate by deleting the just-created repo, re-throw.
try {
  await client.writeForgeConfig(created.fullName, {
    name: input.name,
    description,
    slug,
    createdAt: new Date().toISOString(),
  });
} catch (err) {
  await safeDeleteRepo(client, created.fullName);
  throw err;
}

// 5. Insert DB row in transaction (existing logic, with same compensation on failure).
```

`safeDeleteRepo` is the small extraction of the existing best-effort cleanup currently inlined in the catch block. Both the config-write failure path and the DB-failure path call it.

The DB row's `createdAt` will not exactly equal the value baked into `forge.config.json` because the JSON is generated before the DB row exists. This is acceptable — the JSON's `createdAt` is "when the forge was minted" semantically, and within seconds of the DB row in practice.

## 4. Data Model

No DB schema changes. `forges` table is untouched.

The `forge.config.json` payload is a function of existing fields:
- `name` → `forges.name`
- `description` → `forges.description`
- `slug` → `slugifyForgeName(forges.name)` (already computed)
- `createdAt` → `new Date().toISOString()` at write time

## 5. Error Handling & Edge Cases

| Failure | Behaviour |
|---|---|
| Repo create fails | Existing behaviour. Validation/auth/rate-limit error propagates. No DB row, no repo. |
| `writeForgeConfig` fails after retries | Repo is deleted (compensating delete). User sees the underlying error. No DB row. |
| `writeForgeConfig` succeeds but DB write fails | Repo is deleted (existing compensating delete path covers it). The committed `forge.config.json` goes with the deleted repo. |
| Compensating delete fails after a write failure | Logged loudly (matches existing pattern). Original error propagates. Manual cleanup needed — same as today. |
| Template repo's seed `forge.config.json` is malformed | `loadForgeConfig` throws, welcome page returns 500 with a clear message. Treated as a developer error to fix in the template. |
| Cloned repo where the harness write succeeded but the JSON was hand-edited to invalid shape | Same as above: 500 in the cloned app. The clone is the user's repo to fix. |
| Cloned repo running with no `DATABASE_URL` set | The welcome page renders fine — it doesn't touch the DB. `forge-launch.sh` will fail earlier on the docker / prisma steps with a clear message. |

## 6. Testing

### Harness (in this repo)
- `lib/github/fake-client.test.ts` — extend with `writeForgeConfig` cases: stores payload, multiple writes overwrite, delete clears the recorded payload.
- `lib/github/octokit-client.test.ts` (new or extended) — unit-level retry behaviour using a stubbed Octokit. Cover: succeeds first try; succeeds after 404s; throws after 5x 404; throws immediately on 401.
- `lib/services/forges.test.ts` — extend `createForge` cases: happy path asserts `FakeGitHubClient` recorded the expected payload; config-write failure path asserts the repo was deleted and no DB row was written.
- `tests/e2e/dashboard-crud.spec.ts` — no change strictly required (still uses fake client), but the assertion can be tightened to confirm the fake recorded a `forge.config.json`.

### Template repo (manual)
- `git clone` the template, `pnpm install`, `./forge-launch.sh`. Confirm welcome page shows placeholder values.
- Locally edit `forge.config.json` to a different `name` / `description`. Refresh — values change without restart.
- Stop the harness (port 5433 / container `crystal-forge-pg`) and start the template (port 5434 / container `forge-pg`). Confirm both can run sequentially without collision.

### End-to-end (real-mode dry-run)
- Create a forge through the harness with `GITHUB_CLIENT_MODE=real` against `bmodi-cf`. Clone the resulting repo. `cat forge.config.json` shows the harness's payload. `pnpm install && ./forge-launch.sh` produces a welcome page with the forge's name and description.

## 7. Out-of-Scope Follow-ups

- Propagating description edits from the harness into the cloned repo's `forge.config.json` (a small Octokit PUT keyed off the existing SHA).
- Substituting the slug into the docker container name and host port at clone time so multiple forges can run concurrently on one machine.
- A real first module (chat? AI brief?) — adds the first Prisma model and migration.
- Template tests (component test for the welcome page, smoke test for `loadForgeConfig`) once the template grows beyond the welcome screen.
- CI in the template repo (typecheck + lint + build on PR).
- A `forge.config.schema.json` file shipped in both repos so the contract is machine-checkable.

## 8. File-by-File Changes Summary

### New (template repo)
- `app/layout.tsx`, `app/page.tsx`, `app/globals.css`
- `lib/forge-config.ts`
- `prisma/schema.prisma`
- `docker-compose.yml`, `forge-launch.sh`, `.env.example`, `.gitignore`
- `forge.config.json` (seed values)
- `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`
- `README.md`

### Modified (harness, this repo)
- `lib/github/types.ts` — add `writeForgeConfig` to `GitHubClient`, add `ForgeConfigPayload`.
- `lib/github/octokit-client.ts` — implement `writeForgeConfig` with retry.
- `lib/github/fake-client.ts` — implement `writeForgeConfig` with in-memory map.
- `lib/github/fake-client.test.ts` — add cases.
- `lib/github/octokit-client.test.ts` — new or extended with retry cases.
- `lib/services/forges.ts` — call `writeForgeConfig` after repo creation, extract `safeDeleteRepo` helper.
- `lib/services/forges.test.ts` — add cases for the new failure path and happy-path payload assertion.
