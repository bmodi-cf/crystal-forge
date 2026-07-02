# Forge Production Deployment (Promote-to-Registry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Forge developer request promotion to production (opens a `dev → main` PR + runs gates); an admin reviews gate results and Accepts (merge `dev → main`, retag the built image to a semver release tag in the on-prem registry) or Rejects.

**Architecture:** Extend the existing GitHub client with branch/PR/merge/protection/check-read methods; add a new on-prem Docker-registry client (fake + HTTP, same factory pattern as the GitHub client); add a `PromotionRequest` Prisma model and a `promotions` service that orchestrates request/refresh/accept/reject with ACL (writer requests, admin approves); expose it via App Router route handlers and two UI surfaces (a Request dialog on the forge card, an admin Pending-Promotions page). Scope ends when the release-tagged image is in the registry — no prod pull/deploy.

**Tech Stack:** Next.js 16 (App Router) + React 19, TypeScript strict, Prisma 7 + Postgres, Octokit (inside `lib/github/` only), Vitest, Base UI/shadcn components, `sonner` toasts.

## Global Constraints

- **Next.js APIs differ from training data** — read `node_modules/next/dist/docs/` before writing App Router code.
- **Octokit only inside `lib/github/`** — enforced by the `no-octokit-outside-github` ESLint rule. All other code consumes `getGitHubClient()` / the `GitHubClient` interface.
- **DB access via `lib/prisma.ts`.** After schema changes, create the migration with `pnpm db:migrate --name <name>` — never hand-edit migration SQL.
- **Tests are colocated** as `*.test.ts` and run under Vitest with `globals: true` (`describe`/`it`/`expect` are global). Service/DB tests start with `// @vitest-environment node`, use `withCleanDb` from `lib/test/db.ts`, and the `makeUser` / `makeForge` helpers.
- **`GITHUB_CLIENT_MODE=fake`** in all tests; inject `FakeGitHubClient` / `FakeRegistryClient` into services.
- **Version format is semver `vMAJOR.MINOR.PATCH`.** Requester picks the bump level (`major`/`minor`/`patch`, default `patch`); the first release is `v1.0.0`.
- **Branch names:** work branch is `dev`, production branch is `main`.
- **Scope ends at "release-tagged image in the registry."** No prod pull, run, DB provisioning, or migration execution in this plan.
- **The AI-analysis gate is firmly out of scope** — do not build or stub it.

---

## Prerequisites (separate tracks — NOT implemented by this plan)

These must exist for the end-to-end flow to actually run, but they are ops/other-repo work with their own execution and no TDD cycle. The code in this plan is written and tested against fakes, so it can be built before these land.

**P1 — Infra runbook (pilot box):**
- `registry:2` container running behind the reverse proxy, TLS terminated with the existing `*.crystalfountains.com` wildcard cert, reachable as `registry.crystalfountains.com`.
- DNS `A` record `registry.crystalfountains.com → pilot internal IP` (or wildcard DNS / prod `/etc/hosts`).
- htpasswd service accounts: a **push** account (used by the runner + dashboard retag) and a **pull** account (future prod).
- A self-hosted GitHub Actions runner registered to the org, online on the pilot.

**P2 — Template repo (`crystal-forge-template-webapp`) changes:**
- A production **`Dockerfile`** (multi-stage: install → `next build` → slim runtime running the production server; `COPY prisma/migrations`). Does NOT run migrations at build.
- A **CI workflow** (`.github/workflows/promote-gates.yml`) triggered `on: pull_request` targeting `main`, running on the self-hosted runner, with jobs named **exactly** `build`, `typecheck`, `lint`, `tests` (each reports a status check of that name). `build` builds the production image and pushes it as `registry.crystalfountains.com/<slug>:sha-<headSha>`. `tests` detects presence of tests and self-skips to success when none exist (so it can be a required check without blocking test-less forges).

> The required-check names in this plan (`build`, `typecheck`, `lint`, `tests`) MUST match the job/check names produced by P2's workflow. They are defined once in `lib/github/branches.ts` (Task 4) and referenced everywhere.

---

## File Structure

**New files (this repo):**
- `lib/github/branches.ts` — branch-name + required-check constants.
- `lib/versioning/semver.ts` (+ `.test.ts`) — pure semver bump/parse/compare.
- `lib/registry/types.ts` — `RegistryClient` interface + types.
- `lib/registry/fake-client.ts` (+ `.test.ts`) — in-memory registry double.
- `lib/registry/http-client.ts` — Docker Registry v2 HTTP retag.
- `lib/registry/client.ts` — `getRegistryClient()` factory.
- `lib/services/promotions.ts` (+ `.test.ts`) — promotion orchestration service.
- `lib/services/promotions-schema.ts` — Zod input schemas.
- `app/api/forges/[id]/promotion/route.ts` — POST request / GET current.
- `app/api/promotions/route.ts` — GET pending (admin).
- `app/api/promotions/[id]/accept/route.ts` — POST accept (admin).
- `app/api/promotions/[id]/reject/route.ts` — POST reject (admin).
- `app/(app)/promotions/page.tsx` + `PromotionsClient.tsx` — admin queue.
- `app/(app)/dashboard/RequestPromotionDialog.tsx` — bump-level dialog.
- `app/(app)/dashboard/usePromotion.ts` — per-forge promotion polling hook.

**Modified files:**
- `lib/github/types.ts` — extend `GitHubClient` interface + add types.
- `lib/github/fake-client.ts` — implement new methods + test helpers.
- `lib/github/octokit-client.ts` — implement new methods via Octokit.
- `lib/services/forges.ts` — provision `dev` branch + protect `main` in `createForge`.
- `lib/runtime/clone.ts` — checkout `dev` after clone.
- `prisma/schema.prisma` — `PromotionRequest` model + enums + relations.
- `lib/test/db.ts` — clear `promotion_requests` in `withCleanDb`.
- `app/(app)/dashboard/ForgeCard.tsx` + `ForgeCardRuntime.tsx` — Request-to-Production control.

---

## Task 1: Branch + required-check constants

**Files:**
- Create: `lib/github/branches.ts`

**Interfaces:**
- Produces: `DEV_BRANCH: 'dev'`, `PROD_BRANCH: 'main'`, `REQUIRED_CHECKS: readonly string[]`.

- [ ] **Step 1: Create the constants module**

```ts
// lib/github/branches.ts
/** The branch a Forge team works on (Claude Code commits here). */
export const DEV_BRANCH = 'dev' as const;

/** The production branch; protected, merged into only via an approved promotion. */
export const PROD_BRANCH = 'main' as const;

/**
 * Status-check names that must be green before a promotion can be accepted.
 * These MUST match the job/check names produced by the template's CI workflow
 * (`.github/workflows/promote-gates.yml`). The `tests` job self-skips to success
 * when a Forge has no tests, so requiring it never blocks a test-less Forge.
 */
export const REQUIRED_CHECKS = ['build', 'typecheck', 'lint', 'tests'] as const;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no references yet, module compiles).

- [ ] **Step 3: Commit**

```bash
git add lib/github/branches.ts
git commit -m "feat(github): dev/main branch + required-check constants"
```

---

## Task 2: Semver bump logic

**Files:**
- Create: `lib/versioning/semver.ts`
- Test: `lib/versioning/semver.test.ts`

**Interfaces:**
- Produces:
  - `type BumpLevel = 'major' | 'minor' | 'patch'`
  - `parseVersion(v: string): { major: number; minor: number; patch: number } | null`
  - `nextVersion(current: string | null, bump: BumpLevel): string` — `null` current → `'v1.0.0'`; otherwise bumps the given component and zeroes lower ones. Always returns a `v`-prefixed string.
  - `compareVersions(a: string, b: string): number` — negative/zero/positive; unparseable sorts lowest.

- [ ] **Step 1: Write the failing test**

```ts
// lib/versioning/semver.test.ts
import { describe, it, expect } from 'vitest';
import { parseVersion, nextVersion, compareVersions } from './semver';

describe('parseVersion', () => {
  it('parses a v-prefixed semver', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  it('returns null for garbage', () => {
    expect(parseVersion('nope')).toBeNull();
    expect(parseVersion('v1.2')).toBeNull();
  });
});

describe('nextVersion', () => {
  it('first release is v1.0.0 regardless of bump', () => {
    expect(nextVersion(null, 'patch')).toBe('v1.0.0');
    expect(nextVersion(null, 'major')).toBe('v1.0.0');
  });
  it('bumps patch', () => {
    expect(nextVersion('v1.2.3', 'patch')).toBe('v1.2.4');
  });
  it('bumps minor and zeroes patch', () => {
    expect(nextVersion('v1.2.3', 'minor')).toBe('v1.3.0');
  });
  it('bumps major and zeroes minor+patch', () => {
    expect(nextVersion('v1.2.3', 'major')).toBe('v2.0.0');
  });
});

describe('compareVersions', () => {
  it('orders by major then minor then patch', () => {
    expect(compareVersions('v1.0.0', 'v1.0.1')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', 'v1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/versioning/semver.test.ts`
Expected: FAIL — module `./semver` not found.

- [ ] **Step 3: Implement**

```ts
// lib/versioning/semver.ts
export type BumpLevel = 'major' | 'minor' | 'patch';

const RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(
  v: string,
): { major: number; minor: number; patch: number } | null {
  const m = RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function nextVersion(current: string | null, bump: BumpLevel): string {
  const parsed = current ? parseVersion(current) : null;
  if (!parsed) return 'v1.0.0';
  if (bump === 'major') return `v${parsed.major + 1}.0.0`;
  if (bump === 'minor') return `v${parsed.major}.${parsed.minor + 1}.0`;
  return `v${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return (
    pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/versioning/semver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/versioning/semver.ts lib/versioning/semver.test.ts
git commit -m "feat(versioning): semver bump/parse/compare"
```

---

## Task 3: Registry client (types, fake, HTTP, factory)

**Files:**
- Create: `lib/registry/types.ts`, `lib/registry/fake-client.ts`, `lib/registry/http-client.ts`, `lib/registry/client.ts`
- Test: `lib/registry/fake-client.test.ts`

**Interfaces:**
- Produces:
  - `interface RegistryClient { tagManifest(repo, fromTag, toTags): Promise<void>; listTags(repo): Promise<string[]> }`
  - `class FakeRegistryClient implements RegistryClient` with helpers `seedTag(repo, tag)`, `getTags(repo)`.
  - `getRegistryClient(): RegistryClient` — returns `FakeRegistryClient` when `REGISTRY_CLIENT_MODE=fake`, else `HttpRegistryClient` from `process.env.REGISTRY_HOST/REGISTRY_USERNAME/REGISTRY_PASSWORD`.
- Consumes: nothing.

- [ ] **Step 1: Write the interface + types**

```ts
// lib/registry/types.ts
export interface RegistryClient {
  /**
   * Copy the manifest currently under `fromTag` to each tag in `toTags`
   * (a pure registry manifest operation — no rebuild). Throws if `fromTag`
   * does not exist in `repo`.
   */
  tagManifest(repo: string, fromTag: string, toTags: string[]): Promise<void>;

  /** List all tags currently present for `repo` (empty array if none). */
  listTags(repo: string): Promise<string[]>;
}

export class RegistryError extends Error {}
```

- [ ] **Step 2: Write the failing test for the fake**

```ts
// lib/registry/fake-client.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRegistryClient } from './fake-client';
import { RegistryError } from './types';

describe('FakeRegistryClient', () => {
  let reg: FakeRegistryClient;
  beforeEach(() => { reg = new FakeRegistryClient(); });

  it('retags an existing manifest to new tags', async () => {
    reg.seedTag('aquaflow-designer', 'sha-abc123');
    await reg.tagManifest('aquaflow-designer', 'sha-abc123', ['v1.0.0', 'latest']);
    expect(reg.getTags('aquaflow-designer').sort()).toEqual(
      ['latest', 'sha-abc123', 'v1.0.0'],
    );
  });

  it('throws when the source tag is missing', async () => {
    await expect(
      reg.tagManifest('aquaflow-designer', 'sha-missing', ['v1.0.0']),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  it('listTags returns empty for an unknown repo', async () => {
    expect(await reg.listTags('nope')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test lib/registry/fake-client.test.ts`
Expected: FAIL — `./fake-client` not found.

- [ ] **Step 4: Implement the fake**

```ts
// lib/registry/fake-client.ts
import type { RegistryClient } from './types';
import { RegistryError } from './types';

export class FakeRegistryClient implements RegistryClient {
  // repo -> tag -> synthetic digest
  private readonly repos = new Map<string, Map<string, string>>();

  seedTag(repo: string, tag: string, digest = `sha256:${tag}`): void {
    const tags = this.repos.get(repo) ?? new Map<string, string>();
    tags.set(tag, digest);
    this.repos.set(repo, tags);
  }

  getTags(repo: string): string[] {
    return [...(this.repos.get(repo)?.keys() ?? [])];
  }

  async tagManifest(repo: string, fromTag: string, toTags: string[]): Promise<void> {
    const tags = this.repos.get(repo);
    const digest = tags?.get(fromTag);
    if (!tags || digest === undefined) {
      throw new RegistryError(`tag ${fromTag} not found in ${repo}`);
    }
    for (const t of toTags) tags.set(t, digest);
  }

  async listTags(repo: string): Promise<string[]> {
    return this.getTags(repo);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test lib/registry/fake-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement the HTTP client (Docker Registry v2 retag)**

```ts
// lib/registry/http-client.ts
import type { RegistryClient } from './types';
import { RegistryError } from './types';

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export type HttpRegistryConfig = {
  host: string; // e.g. registry.crystalfountains.com
  username: string;
  password: string;
};

/** Retag by GET-ing the source manifest and PUT-ing it under each new tag. */
export class HttpRegistryClient implements RegistryClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(cfg: HttpRegistryConfig) {
    this.base = `https://${cfg.host}/v2`;
    this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  }

  async tagManifest(repo: string, fromTag: string, toTags: string[]): Promise<void> {
    const getRes = await fetch(`${this.base}/${repo}/manifests/${fromTag}`, {
      headers: { Authorization: this.auth, Accept: MANIFEST_ACCEPT },
    });
    if (!getRes.ok) {
      throw new RegistryError(`GET manifest ${repo}:${fromTag} → ${getRes.status}`);
    }
    const contentType =
      getRes.headers.get('content-type') ?? 'application/vnd.oci.image.manifest.v1+json';
    const body = await getRes.text(); // must re-PUT byte-identical body
    for (const tag of toTags) {
      const putRes = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
        method: 'PUT',
        headers: { Authorization: this.auth, 'Content-Type': contentType },
        body,
      });
      if (!putRes.ok) {
        throw new RegistryError(`PUT manifest ${repo}:${tag} → ${putRes.status}`);
      }
    }
  }

  async listTags(repo: string): Promise<string[]> {
    const res = await fetch(`${this.base}/${repo}/tags/list`, {
      headers: { Authorization: this.auth },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new RegistryError(`GET tags/list ${repo} → ${res.status}`);
    const json = (await res.json()) as { tags?: string[] | null };
    return json.tags ?? [];
  }
}
```

- [ ] **Step 7: Implement the factory**

```ts
// lib/registry/client.ts
import type { RegistryClient } from './types';
import { FakeRegistryClient } from './fake-client';
import { HttpRegistryClient } from './http-client';

let cached: RegistryClient | undefined;

export function getRegistryClient(): RegistryClient {
  if (cached) return cached;
  if (process.env.REGISTRY_CLIENT_MODE === 'fake') {
    cached = new FakeRegistryClient();
  } else {
    const host = process.env.REGISTRY_HOST;
    const username = process.env.REGISTRY_USERNAME;
    const password = process.env.REGISTRY_PASSWORD;
    if (!host || !username || !password) {
      throw new Error(
        'REGISTRY_HOST, REGISTRY_USERNAME, REGISTRY_PASSWORD must be set (or REGISTRY_CLIENT_MODE=fake)',
      );
    }
    cached = new HttpRegistryClient({ host, username, password });
  }
  return cached;
}

/** Test-only: reset the memoized client. */
export function __resetRegistryClientForTests(): void {
  cached = undefined;
}
```

- [ ] **Step 8: Typecheck + full unit run**

Run: `pnpm typecheck && pnpm test lib/registry`
Expected: PASS.

- [ ] **Step 9: Document env vars**

Add to `.env.example` (below the existing GitHub section), verbatim:

```
# On-prem Docker registry (promote-to-production). Use fake for tests/offline.
REGISTRY_CLIENT_MODE=fake
REGISTRY_HOST=registry.crystalfountains.com
REGISTRY_USERNAME=
REGISTRY_PASSWORD=
```

- [ ] **Step 10: Commit**

```bash
git add lib/registry .env.example
git commit -m "feat(registry): on-prem docker registry client (fake + http retag)"
```

---

## Task 4: Extend the GitHub client interface + types

**Files:**
- Modify: `lib/github/types.ts`

**Interfaces:**
- Consumes: existing `GitHubClient` interface in `lib/github/types.ts`.
- Produces (added to `GitHubClient`):
  - `createBranch(fullName: string, fromBranch: string, newBranch: string): Promise<void>`
  - `setBranchProtection(fullName: string, branch: string, opts: BranchProtectionOptions): Promise<void>`
  - `openPullRequest(fullName: string, opts: OpenPrOptions): Promise<PullRequestRef>`
  - `getPullRequest(fullName: string, number: number): Promise<PullRequestInfo>`
  - `getRefCheckResults(fullName: string, ref: string): Promise<CheckResult[]>`
  - `mergePullRequest(fullName: string, number: number, opts?: MergeOptions): Promise<MergeResult>`
  - `closePullRequest(fullName: string, number: number): Promise<void>`
  - `createGitTag(fullName: string, tag: string, sha: string): Promise<void>`
- Produces (new exported types): `BranchProtectionOptions`, `OpenPrOptions`, `PullRequestRef`, `PullRequestInfo`, `CheckResult`, `CheckConclusion`, `MergeOptions`, `MergeResult`.

- [ ] **Step 1: Add the new types and interface methods**

Add to `lib/github/types.ts` (append to the existing type/interface declarations; do not remove existing members):

```ts
export type BranchProtectionOptions = {
  /** Status-check contexts that must pass before merge. */
  requiredChecks: readonly string[];
  /** Require the PR branch be up to date with the base before merge. */
  requireUpToDate: boolean;
};

export type OpenPrOptions = {
  head: string; // e.g. 'dev'
  base: string; // e.g. 'main'
  title: string;
  body: string;
};

export type PullRequestRef = {
  number: number;
  url: string;
  headSha: string;
};

export type CheckConclusion =
  | 'success' | 'failure' | 'neutral' | 'cancelled'
  | 'timed_out' | 'action_required' | 'skipped' | null;

export type CheckResult = {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: CheckConclusion;
};

export type PullRequestInfo = {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
};

export type MergeOptions = { method: 'merge' | 'squash' | 'rebase' };
export type MergeResult = { sha: string; merged: boolean };
```

Then add these method signatures inside the `GitHubClient` interface:

```ts
  /** Create `newBranch` pointing at the head of `fromBranch`. */
  createBranch(fullName: string, fromBranch: string, newBranch: string): Promise<void>;

  /** Apply/replace branch protection on `branch`. Idempotent. */
  setBranchProtection(
    fullName: string,
    branch: string,
    opts: BranchProtectionOptions,
  ): Promise<void>;

  /** Open a PR from `opts.head` into `opts.base`. */
  openPullRequest(fullName: string, opts: OpenPrOptions): Promise<PullRequestRef>;

  /** Fetch PR state + diff stats. */
  getPullRequest(fullName: string, number: number): Promise<PullRequestInfo>;

  /** Normalized check-run results for a commit ref. */
  getRefCheckResults(fullName: string, ref: string): Promise<CheckResult[]>;

  /** Merge a PR. Throws if not mergeable. */
  mergePullRequest(
    fullName: string,
    number: number,
    opts?: MergeOptions,
  ): Promise<MergeResult>;

  /** Close a PR without merging. */
  closePullRequest(fullName: string, number: number): Promise<void>;

  /** Create a lightweight git tag `tag` at `sha`. */
  createGitTag(fullName: string, tag: string, sha: string): Promise<void>;
```

- [ ] **Step 2: Typecheck to see the intended failures**

Run: `pnpm typecheck`
Expected: FAIL — `FakeGitHubClient` and `OctokitGitHubClient` no longer satisfy `GitHubClient` (missing members). This is expected; Tasks 5 and 6 implement them.

- [ ] **Step 3: Commit the interface**

```bash
git add lib/github/types.ts
git commit -m "feat(github): extend client interface for PR/branch/protection/checks/tag"
```

---

## Task 5: Implement the new methods on the fake GitHub client

**Files:**
- Modify: `lib/github/fake-client.ts`
- Test: `lib/github/fake-client.test.ts` (create if absent)

**Interfaces:**
- Consumes: Task 4 types.
- Produces: fully-implementing `FakeGitHubClient`, plus test helpers:
  - `seedBranch(fullName: string, branch: string, sha?: string)`
  - `getBranches(fullName: string): string[]`
  - `getProtection(fullName: string, branch: string): BranchProtectionOptions | undefined`
  - `setRefChecks(fullName: string, ref: string, checks: CheckResult[])`
  - `getPullRequestState(fullName: string, number: number): { state: 'open' | 'closed'; merged: boolean } | undefined`

- [ ] **Step 1: Write failing tests for the fake behavior**

```ts
// lib/github/fake-client.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeGitHubClient } from './fake-client';

describe('FakeGitHubClient promotion methods', () => {
  let gh: FakeGitHubClient;
  beforeEach(async () => {
    gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
    await gh.createRepoFromTemplate({ name: 'app1', description: null, private: true });
    gh.seedBranch('test-owner/app1', 'main', 'sha-main');
  });

  it('createBranch clones the head sha of the source branch', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    expect(gh.getBranches('test-owner/app1').sort()).toEqual(['dev', 'main']);
  });

  it('setBranchProtection stores the options', async () => {
    await gh.setBranchProtection('test-owner/app1', 'main', {
      requiredChecks: ['build', 'lint'],
      requireUpToDate: true,
    });
    expect(gh.getProtection('test-owner/app1', 'main')).toEqual({
      requiredChecks: ['build', 'lint'],
      requireUpToDate: true,
    });
  });

  it('openPullRequest returns an incrementing number + head sha', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    const pr = await gh.openPullRequest('test-owner/app1', {
      head: 'dev', base: 'main', title: 'Promote', body: 'x',
    });
    expect(pr.number).toBe(1);
    expect(pr.headSha).toBeTruthy();
    expect(pr.url).toContain('test-owner/app1');
  });

  it('getRefCheckResults returns seeded checks', async () => {
    gh.setRefChecks('test-owner/app1', 'sha-dev', [
      { name: 'build', status: 'completed', conclusion: 'success' },
    ]);
    const checks = await gh.getRefCheckResults('test-owner/app1', 'sha-dev');
    expect(checks).toEqual([{ name: 'build', status: 'completed', conclusion: 'success' }]);
  });

  it('mergePullRequest marks the PR merged and returns a sha', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    const pr = await gh.openPullRequest('test-owner/app1', {
      head: 'dev', base: 'main', title: 'Promote', body: 'x',
    });
    const res = await gh.mergePullRequest('test-owner/app1', pr.number);
    expect(res.merged).toBe(true);
    expect(gh.getPullRequestState('test-owner/app1', pr.number)).toEqual({
      state: 'closed', merged: true,
    });
  });

  it('closePullRequest closes without merging', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    const pr = await gh.openPullRequest('test-owner/app1', {
      head: 'dev', base: 'main', title: 'Promote', body: 'x',
    });
    await gh.closePullRequest('test-owner/app1', pr.number);
    expect(gh.getPullRequestState('test-owner/app1', pr.number)).toEqual({
      state: 'closed', merged: false,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test lib/github/fake-client.test.ts`
Expected: FAIL — methods/helpers not implemented.

- [ ] **Step 3: Implement the fake methods + state + helpers**

Add to the `FakeGitHubClient` class in `lib/github/fake-client.ts` (keep existing members). Add imports for the new types from `./types`.

```ts
  // --- promotion state ---
  private readonly branches = new Map<string, Map<string, string>>(); // fullName -> branch -> sha
  private readonly protections = new Map<string, Map<string, BranchProtectionOptions>>();
  private readonly pulls = new Map<
    string,
    Map<number, { head: string; base: string; headSha: string; state: 'open' | 'closed'; merged: boolean }>
  >();
  private readonly prCounter = new Map<string, number>();
  private readonly checks = new Map<string, CheckResult[]>(); // `${fullName}@${ref}` -> checks

  // --- test helpers ---
  seedBranch(fullName: string, branch: string, sha = `sha-${branch}`): void {
    const b = this.branches.get(fullName) ?? new Map<string, string>();
    b.set(branch, sha);
    this.branches.set(fullName, b);
  }
  getBranches(fullName: string): string[] {
    return [...(this.branches.get(fullName)?.keys() ?? [])];
  }
  getProtection(fullName: string, branch: string): BranchProtectionOptions | undefined {
    return this.protections.get(fullName)?.get(branch);
  }
  setRefChecks(fullName: string, ref: string, checks: CheckResult[]): void {
    this.checks.set(`${fullName}@${ref}`, checks);
  }
  getPullRequestState(
    fullName: string,
    number: number,
  ): { state: 'open' | 'closed'; merged: boolean } | undefined {
    const pr = this.pulls.get(fullName)?.get(number);
    return pr ? { state: pr.state, merged: pr.merged } : undefined;
  }

  // --- interface methods ---
  async createBranch(fullName: string, fromBranch: string, newBranch: string): Promise<void> {
    this.maybeFail('createBranch');
    const b = this.branches.get(fullName);
    const sha = b?.get(fromBranch);
    if (!b || sha === undefined) throw new Error(`branch ${fromBranch} not found in ${fullName}`);
    b.set(newBranch, sha);
  }

  async setBranchProtection(
    fullName: string,
    branch: string,
    opts: BranchProtectionOptions,
  ): Promise<void> {
    this.maybeFail('setBranchProtection');
    const p = this.protections.get(fullName) ?? new Map<string, BranchProtectionOptions>();
    p.set(branch, { requiredChecks: [...opts.requiredChecks], requireUpToDate: opts.requireUpToDate });
    this.protections.set(fullName, p);
  }

  async openPullRequest(fullName: string, opts: OpenPrOptions): Promise<PullRequestRef> {
    this.maybeFail('openPullRequest');
    const headSha = this.branches.get(fullName)?.get(opts.head) ?? `sha-${opts.head}`;
    const n = (this.prCounter.get(fullName) ?? 0) + 1;
    this.prCounter.set(fullName, n);
    const map = this.pulls.get(fullName) ?? new Map();
    map.set(n, { head: opts.head, base: opts.base, headSha, state: 'open', merged: false });
    this.pulls.set(fullName, map);
    return { number: n, url: `${this.baseUrl}/${fullName}/pull/${n}`, headSha };
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestInfo> {
    this.maybeFail('getPullRequest');
    const pr = this.pulls.get(fullName)?.get(number);
    if (!pr) throw new Error(`PR #${number} not found in ${fullName}`);
    return {
      number, state: pr.state, merged: pr.merged, headSha: pr.headSha,
      commits: 1, changedFiles: 1, additions: 1, deletions: 0,
    };
  }

  async getRefCheckResults(fullName: string, ref: string): Promise<CheckResult[]> {
    this.maybeFail('getRefCheckResults');
    return this.checks.get(`${fullName}@${ref}`) ?? [];
  }

  async mergePullRequest(
    fullName: string,
    number: number,
    _opts?: MergeOptions,
  ): Promise<MergeResult> {
    this.maybeFail('mergePullRequest');
    const pr = this.pulls.get(fullName)?.get(number);
    if (!pr) throw new Error(`PR #${number} not found in ${fullName}`);
    pr.state = 'closed';
    pr.merged = true;
    const sha = `merge-${pr.headSha}`;
    // advance base branch head to the merge commit
    this.branches.get(fullName)?.set(pr.base, sha);
    return { sha, merged: true };
  }

  async closePullRequest(fullName: string, number: number): Promise<void> {
    this.maybeFail('closePullRequest');
    const pr = this.pulls.get(fullName)?.get(number);
    if (!pr) throw new Error(`PR #${number} not found in ${fullName}`);
    pr.state = 'closed';
    pr.merged = false;
  }

  async createGitTag(fullName: string, tag: string, sha: string): Promise<void> {
    this.maybeFail('createGitTag');
    // tags are represented as branches namespace `tag/<name>` for the fake
    this.seedBranch(fullName, `tag/${tag}`, sha);
  }
```

Update the fake's `Method` union type (used by `maybeFail`/`failNextCall`) to include the new method names: `'createBranch' | 'setBranchProtection' | 'openPullRequest' | 'getPullRequest' | 'getRefCheckResults' | 'mergePullRequest' | 'closePullRequest' | 'createGitTag'`.

Also make `createRepoFromTemplate` seed a default branch so existing forge-creation tests still have a `main` to branch from — at the end of that method add:

```ts
    this.seedBranch(fullName, 'main', 'sha-main');
```

- [ ] **Step 4: Run tests**

Run: `pnpm test lib/github/fake-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/github/fake-client.ts lib/github/fake-client.test.ts
git commit -m "feat(github): fake client implements PR/branch/protection/checks/tag"
```

---

## Task 6: Implement the new methods on the Octokit client

**Files:**
- Modify: `lib/github/octokit-client.ts`

**Interfaces:**
- Consumes: Task 4 types; the existing private `this.client` Octokit instance and `parse(fullName)` → `{ owner, repo }` helper (add a small local `splitFullName` if none exists).

> Not unit-tested (real network). Verified by `pnpm typecheck` (interface satisfied) and the e2e/manual GitHub run. Follow the existing method style in this file.

- [ ] **Step 1: Add the methods**

Add to `OctokitGitHubClient` (keep existing members). Use a helper to split `fullName`:

```ts
  private split(fullName: string): { owner: string; repo: string } {
    const [owner, repo] = fullName.split('/');
    return { owner, repo };
  }

  async createBranch(fullName: string, fromBranch: string, newBranch: string): Promise<void> {
    const { owner, repo } = this.split(fullName);
    const { data: ref } = await this.client.git.getRef({
      owner, repo, ref: `heads/${fromBranch}`,
    });
    await this.client.git.createRef({
      owner, repo, ref: `refs/heads/${newBranch}`, sha: ref.object.sha,
    });
  }

  async setBranchProtection(
    fullName: string,
    branch: string,
    opts: BranchProtectionOptions,
  ): Promise<void> {
    const { owner, repo } = this.split(fullName);
    await this.client.repos.updateBranchProtection({
      owner, repo, branch,
      required_status_checks: {
        strict: opts.requireUpToDate,
        contexts: [...opts.requiredChecks],
      },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    });
  }

  async openPullRequest(fullName: string, opts: OpenPrOptions): Promise<PullRequestRef> {
    const { owner, repo } = this.split(fullName);
    const { data } = await this.client.pulls.create({
      owner, repo, head: opts.head, base: opts.base, title: opts.title, body: opts.body,
    });
    return { number: data.number, url: data.html_url, headSha: data.head.sha };
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestInfo> {
    const { owner, repo } = this.split(fullName);
    const { data } = await this.client.pulls.get({ owner, repo, pull_number: number });
    return {
      number: data.number,
      state: data.state === 'open' ? 'open' : 'closed',
      merged: Boolean(data.merged),
      headSha: data.head.sha,
      commits: data.commits ?? 0,
      changedFiles: data.changed_files ?? 0,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
    };
  }

  async getRefCheckResults(fullName: string, ref: string): Promise<CheckResult[]> {
    const { owner, repo } = this.split(fullName);
    const { data } = await this.client.checks.listForRef({ owner, repo, ref, per_page: 100 });
    return data.check_runs.map((c) => ({
      name: c.name,
      status: c.status as CheckResult['status'],
      conclusion: (c.conclusion ?? null) as CheckResult['conclusion'],
    }));
  }

  async mergePullRequest(
    fullName: string,
    number: number,
    opts?: MergeOptions,
  ): Promise<MergeResult> {
    const { owner, repo } = this.split(fullName);
    const { data } = await this.client.pulls.merge({
      owner, repo, pull_number: number, merge_method: opts?.method ?? 'squash',
    });
    return { sha: data.sha, merged: data.merged };
  }

  async closePullRequest(fullName: string, number: number): Promise<void> {
    const { owner, repo } = this.split(fullName);
    await this.client.pulls.update({ owner, repo, pull_number: number, state: 'closed' });
  }

  async createGitTag(fullName: string, tag: string, sha: string): Promise<void> {
    const { owner, repo } = this.split(fullName);
    await this.client.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha });
  }
```

Add the new type names to the file's import from `./types`.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — both clients now satisfy `GitHubClient`.

- [ ] **Step 3: Lint (confirm the octokit rule is satisfied — code is inside `lib/github/`)**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/github/octokit-client.ts
git commit -m "feat(github): octokit client implements PR/branch/protection/checks/tag"
```

---

## Task 7: Provision `dev` branch + protect `main` at forge creation

**Files:**
- Modify: `lib/services/forges.ts`
- Test: `lib/services/forges.test.ts`

**Interfaces:**
- Consumes: `client.createBranch`, `client.setBranchProtection` (Tasks 4–5); `DEV_BRANCH`, `PROD_BRANCH`, `REQUIRED_CHECKS` (Task 1).
- Produces: no signature change to `createForge`; new side effects (dev branch + protection) covered by existing compensation.

- [ ] **Step 1: Write the failing test**

Add to `lib/services/forges.test.ts` (inside the create-forge describe block):

```ts
it('creates a dev branch from main and protects main after writing forge files', async () => {
  await withCleanDb(async (prisma) => {
    const tom = await makeUser(prisma, { email: 't@x', name: 'Tom Reed', groups: ['Engineering'] });
    await createForge(
      tom,
      { name: 'Branchy App', description: null, groups: ['Engineering'] },
      fake,
      fakeDb,
    );
    const full = 'test-owner/branchy-app';
    expect(fake.getBranches(full)).toContain('dev');
    expect(fake.getProtection(full, 'main')).toEqual({
      requiredChecks: ['build', 'typecheck', 'lint', 'tests'],
      requireUpToDate: true,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test lib/services/forges.test.ts -t "creates a dev branch"`
Expected: FAIL — no dev branch / protection.

- [ ] **Step 3: Implement**

In `lib/services/forges.ts`, add imports:

```ts
import { DEV_BRANCH, PROD_BRANCH, REQUIRED_CHECKS } from '@/lib/github/branches';
```

In `createForge`, immediately after the existing `await client.writeForgeFiles(...)` call (still inside the same `try` that has the `safeDeleteRepo` compensation), add:

```ts
    // Branch dev FROM main so it inherits the just-written per-forge files,
    // then protect main. Protection is a repo setting (not templatable); dev
    // must be branched post-write (a template-copied dev would lack these files).
    await client.createBranch(created.fullName, PROD_BRANCH, DEV_BRANCH);
    await client.setBranchProtection(created.fullName, PROD_BRANCH, {
      requiredChecks: REQUIRED_CHECKS,
      requireUpToDate: true,
    });
```

- [ ] **Step 4: Run the test + the full forges suite**

Run: `pnpm test lib/services/forges.test.ts`
Expected: PASS (new test + all existing create-forge tests; the fake now seeds `main` on repo creation per Task 5 Step 3).

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts lib/services/forges.test.ts
git commit -m "feat(forges): provision dev branch + main protection at creation"
```

---

## Task 8: Runtime clones the `dev` branch

**Files:**
- Modify: `lib/runtime/clone.ts`
- Test: `lib/runtime/clone.test.ts`

**Interfaces:**
- Consumes: `DEV_BRANCH` (Task 1); the existing `runner.run` command interface.

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/clone.test.ts` (mirror the existing fake-runner setup in that file):

```ts
it('checks out the dev branch on a fresh clone', async () => {
  const calls: string[][] = [];
  const runner = {
    run: async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { exitCode: 0 };
    },
  };
  // fresh clone: point at a temp dir with no .git (see existing tests for the tmp pattern)
  await ensureClone(
    { slug: 'devy', repoFullName: 'test-owner/devy' },
    { getInstallationToken: async () => 'tok' } as unknown as GitHubClient,
    runner as unknown as CommandRunner,
  );
  const checkout = calls.find((c) => c.includes('checkout'));
  expect(checkout).toBeDefined();
  expect(checkout).toContain('dev');
});
```

> Match the imports/tmpdir scaffolding already used in `clone.test.ts`; the assertion (a `git checkout dev` call is issued) is the point.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test lib/runtime/clone.test.ts -t "checks out the dev branch"`
Expected: FAIL — no checkout call.

- [ ] **Step 3: Implement**

In `lib/runtime/clone.ts` add `import { DEV_BRANCH } from '@/lib/github/branches';`. Inside the fresh-clone block (right after the `git remote set-url` `assertOk(...)`), add:

```ts
    assertOk(
      await runner.run('git', ['-C', cloneDir, 'checkout', DEV_BRANCH], {
        logPath: log, timeoutMs: QUICK_TIMEOUT_MS,
      }),
      'git checkout dev',
    );
```

> Legacy forges created before Task 7 have no `dev` branch and would need a manual `git branch dev` (or re-provision). New forges are the target; note this in the PR description.

- [ ] **Step 4: Run tests**

Run: `pnpm test lib/runtime/clone.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/clone.ts lib/runtime/clone.test.ts
git commit -m "feat(runtime): clone checks out the dev branch"
```

---

## Task 9: `PromotionRequest` data model + migration

**Files:**
- Modify: `prisma/schema.prisma`, `lib/test/db.ts`

**Interfaces:**
- Produces: `PromotionRequest` table + `BumpLevel` / `PromotionStatus` enums; relations on `Forge` and `User`.

- [ ] **Step 1: Add enums + model to `prisma/schema.prisma`**

```prisma
enum BumpLevel {
  major
  minor
  patch
}

enum PromotionStatus {
  checks_running
  checks_failed
  awaiting_approval
  accepted
  rejected
}

model PromotionRequest {
  id            String          @id @default(uuid()) @db.Uuid
  forgeId       String          @map("forge_id") @db.Uuid
  requestedById String          @map("requested_by") @db.Uuid
  prNumber      Int             @map("pr_number")
  prUrl         String          @map("pr_url")
  headSha       String          @map("head_sha")
  bumpLevel     BumpLevel       @map("bump_level")
  targetVersion String          @map("target_version")
  status        PromotionStatus @default(checks_running)
  imageRef      String?         @map("image_ref")
  summary       Json?
  approvedById  String?         @map("approved_by") @db.Uuid
  rejectReason  String?         @map("reject_reason")
  decidedAt     DateTime?       @map("decided_at") @db.Timestamptz
  createdAt     DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  forge       Forge @relation(fields: [forgeId], references: [id], onDelete: Cascade)
  requestedBy User  @relation("PromotionRequester", fields: [requestedById], references: [id], onDelete: Restrict)
  approvedBy  User? @relation("PromotionApprover", fields: [approvedById], references: [id], onDelete: SetNull)

  @@index([forgeId])
  @@index([status])
  @@map("promotion_requests")
}
```

Add the back-relations:
- In `model Forge {}` add: `promotionRequests PromotionRequest[]`
- In `model User {}` add:
  ```prisma
  promotionsRequested PromotionRequest[] @relation("PromotionRequester")
  promotionsApproved  PromotionRequest[] @relation("PromotionApprover")
  ```

- [ ] **Step 2: Create the migration**

Run: `pnpm db:migrate --name add_promotion_requests`
Expected: a new folder under `prisma/migrations/` and `Prisma schema loaded` / `Your database is now in sync`. Do not hand-edit the generated SQL.

- [ ] **Step 3: Add promotion cleanup to the test DB helper**

In `lib/test/db.ts`, inside `withCleanDb`, add this line **before** `await prisma.forge.deleteMany();`:

```ts
  await prisma.promotionRequest.deleteMany();
```

- [ ] **Step 4: Verify schema + client generate**

Run: `pnpm typecheck`
Expected: PASS (Prisma client now includes `promotionRequest`).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/test/db.ts
git commit -m "feat(db): PromotionRequest model + migration"
```

---

## Task 10: Promotions service — request

**Files:**
- Create: `lib/services/promotions.ts`, `lib/services/promotions-schema.ts`
- Test: `lib/services/promotions.test.ts`

**Interfaces:**
- Consumes: `prisma`, `canWriteForge`, `getGitHubClient`, `getRegistryClient`, `nextVersion`, `DEV_BRANCH`/`PROD_BRANCH`, `SessionUser`, error classes (`ForbiddenError`, `NotFoundError`, `ValidationError` — reuse whatever `forges.ts` throws).
- Produces:
  - `type PromotionDto = { id; forgeId; status; bumpLevel; targetVersion; prNumber; prUrl; headSha; imageRef: string | null; summary: PromotionSummary | null; requestedBy: { id; name }; approvedBy: { id; name } | null; createdAt; decidedAt: string | null }`
  - `type PromotionSummary = { forgeName: string; commits: number; changedFiles: number; additions: number; deletions: number; gates: CheckResult[] }`
  - `requestPromotion(currentUser, forgeId, input: { bumpLevel: BumpLevel }, github?, registry?): Promise<PromotionDto>`

- [ ] **Step 1: Write the input schema**

```ts
// lib/services/promotions-schema.ts
import { z } from 'zod';

export const requestPromotionInput = z.object({
  bumpLevel: z.enum(['major', 'minor', 'patch']).default('patch'),
});
export type RequestPromotionInput = z.infer<typeof requestPromotionInput>;

export const rejectPromotionInput = z.object({
  reason: z.string().max(500).optional(),
});
export type RejectPromotionInput = z.infer<typeof rejectPromotionInput>;
```

- [ ] **Step 2: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { requestPromotion } from './promotions';
import { ForbiddenError } from '@/lib/errors';

function ghWithForge(): FakeGitHubClient {
  const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
  return gh;
}

describe('requestPromotion', () => {
  let gh: FakeGitHubClient;
  let reg: FakeRegistryClient;
  beforeEach(() => { gh = ghWithForge(); reg = new FakeRegistryClient(); });

  it('opens a PR, computes v1.0.0 for the first release, and stores a pending request', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');

      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'minor' }, gh, reg);

      expect(dto.targetVersion).toBe('v1.0.0'); // first release ignores bump level
      expect(dto.prNumber).toBe(1);
      expect(dto.status).toBe('checks_running');
      expect(gh.getPullRequestState('test-owner/aquaflow', 1)).toEqual({ state: 'open', merged: false });
    });
  });

  it('rejects a requester without write access', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'Stranger', groups: [] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await expect(
        requestPromotion(stranger, forge.id, { bumpLevel: 'patch' }, gh, reg),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('refuses a second open request for the same forge', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
      await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, reg);
      await expect(
        requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, reg),
      ).rejects.toThrow(/in progress/i);
    });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test lib/services/promotions.test.ts`
Expected: FAIL — `./promotions` not found.

- [ ] **Step 4: Implement `requestPromotion` (+ shared helpers/DTO)**

```ts
// lib/services/promotions.ts
import { prisma } from '@/lib/prisma';
import { canWriteForge } from '@/lib/acl';
import { getGitHubClient } from '@/lib/github/client';
import { getRegistryClient } from '@/lib/registry/client';
import type { GitHubClient, CheckResult } from '@/lib/github/types';
import type { RegistryClient } from '@/lib/registry/types';
import { DEV_BRANCH, PROD_BRANCH } from '@/lib/github/branches';
import { nextVersion, type BumpLevel } from '@/lib/versioning/semver';
import { slugifyForgeName } from '@/lib/github/slug';
import type { SessionUser } from './types';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

export type PromotionSummary = {
  forgeName: string;
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  gates: CheckResult[];
};

export type PromotionDto = {
  id: string;
  forgeId: string;
  status: string;
  bumpLevel: BumpLevel;
  targetVersion: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  imageRef: string | null;
  summary: PromotionSummary | null;
  requestedBy: { id: string; name: string };
  approvedBy: { id: string; name: string } | null;
  createdAt: string;
  decidedAt: string | null;
};

const ACTIVE = ['checks_running', 'checks_failed', 'awaiting_approval'] as const;

const promotionInclude = {
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
} as const;

type Row = Awaited<ReturnType<typeof loadRow>>;
async function loadRow(id: string) {
  return prisma.promotionRequest.findUnique({ where: { id }, include: promotionInclude });
}

function toDto(row: NonNullable<Row>): PromotionDto {
  return {
    id: row.id,
    forgeId: row.forgeId,
    status: row.status,
    bumpLevel: row.bumpLevel as BumpLevel,
    targetVersion: row.targetVersion,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    headSha: row.headSha,
    imageRef: row.imageRef,
    summary: (row.summary as PromotionSummary | null) ?? null,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

async function loadForgeForAcl(forgeId: string) {
  const forge = await prisma.forge.findUnique({
    where: { id: forgeId },
    include: { groups: { include: { group: true } } },
  });
  if (!forge) throw new NotFoundError('forge', forgeId);
  return forge;
}

export async function requestPromotion(
  currentUser: SessionUser,
  forgeId: string,
  input: { bumpLevel: BumpLevel },
  github: GitHubClient = getGitHubClient(),
  registry: RegistryClient = getRegistryClient(), // reserved for symmetry; not used here
): Promise<PromotionDto> {
  void registry;
  const forge = await loadForgeForAcl(forgeId);
  const acl = { id: forge.id, createdById: forge.createdById, groups: forge.groups.map((g) => g.group.name) };
  if (!canWriteForge(currentUser, acl)) {
    throw new ForbiddenError(`Cannot request promotion for forge ${forgeId}`);
  }

  const existingOpen = await prisma.promotionRequest.findFirst({
    where: { forgeId, status: { in: [...ACTIVE] } },
  });
  if (existingOpen) {
    throw new ValidationError('A promotion is already in progress for this forge', {});
  }

  // Compute the target version from the last accepted release.
  const lastAccepted = await prisma.promotionRequest.findFirst({
    where: { forgeId, status: 'accepted' },
    orderBy: { decidedAt: 'desc' },
  });
  const targetVersion = nextVersion(lastAccepted?.targetVersion ?? null, input.bumpLevel);

  const title = `Promote to production (${targetVersion})`;
  const body = `Automated promotion request for **${forge.name}** → \`${targetVersion}\`.`;
  const pr = await github.openPullRequest(forge.repoFullName, {
    head: DEV_BRANCH, base: PROD_BRANCH, title, body,
  });

  const created = await prisma.promotionRequest.create({
    data: {
      forgeId,
      requestedById: currentUser.id,
      prNumber: pr.number,
      prUrl: pr.url,
      headSha: pr.headSha,
      bumpLevel: input.bumpLevel,
      targetVersion,
      status: 'checks_running',
    },
    include: promotionInclude,
  });
  return toDto(created);
}
```

> Error classes are in `@/lib/errors` (as `forges.ts` imports them). The `slugifyForgeName` import is used by later tasks; keep it.

- [ ] **Step 5: Run tests**

Run: `pnpm test lib/services/promotions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/services/promotions.ts lib/services/promotions-schema.ts lib/services/promotions.test.ts
git commit -m "feat(promotions): requestPromotion opens PR + computes semver target"
```

---

## Task 11: Promotions service — refresh gates, list, get

**Files:**
- Modify: `lib/services/promotions.ts`
- Test: `lib/services/promotions.test.ts`

**Interfaces:**
- Consumes: `github.getRefCheckResults`, `github.getPullRequest`; `REQUIRED_CHECKS` (Task 1); `user.isAdmin`.
- Produces:
  - `refreshPromotionGates(id, github?): Promise<PromotionDto>` — reads checks, rebuilds `summary`, transitions status (`checks_running` → `awaiting_approval` when all required checks succeed; → `checks_failed` if any required check concluded non-success).
  - `listPendingPromotions(currentUser): Promise<PromotionDto[]>` — admin-only; active statuses, newest first.
  - `getForgePromotion(currentUser, forgeId): Promise<PromotionDto | null>` — latest request for a forge the user can read.

- [ ] **Step 1: Write failing tests**

```ts
import { requestPromotion, refreshPromotionGates, listPendingPromotions } from './promotions';

it('transitions to awaiting_approval when all required checks pass', async () => {
  await withCleanDb(async (prisma) => {
    const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
    const forge = await makeForge(prisma, {
      name: 'Aquaflow', createdById: owner.id, groups: ['Eng'], repoFullName: 'test-owner/aquaflow',
    });
    gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
    await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
    const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, reg);
    gh.setRefChecks('test-owner/aquaflow', dto.headSha, [
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'typecheck', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'tests', status: 'completed', conclusion: 'success' },
    ]);
    const refreshed = await refreshPromotionGates(dto.id, gh);
    expect(refreshed.status).toBe('awaiting_approval');
    expect(refreshed.summary?.gates.length).toBe(4);
  });
});

it('transitions to checks_failed when a required check fails', async () => {
  await withCleanDb(async (prisma) => {
    const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
    const forge = await makeForge(prisma, {
      name: 'Aquaflow', createdById: owner.id, groups: ['Eng'], repoFullName: 'test-owner/aquaflow',
    });
    gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
    await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
    const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, reg);
    gh.setRefChecks('test-owner/aquaflow', dto.headSha, [
      { name: 'build', status: 'completed', conclusion: 'failure' },
    ]);
    const refreshed = await refreshPromotionGates(dto.id, gh);
    expect(refreshed.status).toBe('checks_failed');
  });
});

it('listPendingPromotions is admin-only', async () => {
  await withCleanDb(async (prisma) => {
    const nonAdmin = await makeUser(prisma, { email: 'n@x', name: 'N', groups: [] });
    await expect(listPendingPromotions(nonAdmin)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test lib/services/promotions.test.ts -t "awaiting_approval"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Append to `lib/services/promotions.ts`:

```ts
import { REQUIRED_CHECKS } from '@/lib/github/branches';

function computeStatus(gates: CheckResult[]): 'checks_running' | 'checks_failed' | 'awaiting_approval' {
  const byName = new Map(gates.map((g) => [g.name, g]));
  for (const req of REQUIRED_CHECKS) {
    const g = byName.get(req);
    if (g && g.status === 'completed' && g.conclusion !== 'success' && g.conclusion !== 'skipped') {
      return 'checks_failed';
    }
  }
  const allDone = REQUIRED_CHECKS.every((req) => {
    const g = byName.get(req);
    return g && g.status === 'completed' && (g.conclusion === 'success' || g.conclusion === 'skipped');
  });
  return allDone ? 'awaiting_approval' : 'checks_running';
}

export async function refreshPromotionGates(
  id: string,
  github: GitHubClient = getGitHubClient(),
): Promise<PromotionDto> {
  const row = await loadRow(id);
  if (!row) throw new NotFoundError('promotion', id);
  const forge = await prisma.forge.findUniqueOrThrow({ where: { id: row.forgeId } });

  const gates = await github.getRefCheckResults(forge.repoFullName, row.headSha);
  const pr = await github.getPullRequest(forge.repoFullName, row.prNumber);
  const summary: PromotionSummary = {
    forgeName: forge.name,
    commits: pr.commits,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    gates,
  };

  // Only advance forward from an active checks state; never override a decided request.
  const nextStatus = ([...ACTIVE] as string[]).includes(row.status)
    ? computeStatus(gates)
    : row.status;

  const updated = await prisma.promotionRequest.update({
    where: { id },
    data: { summary: summary as unknown as object, status: nextStatus as typeof row.status },
    include: promotionInclude,
  });
  return toDto(updated);
}

export async function listPendingPromotions(currentUser: SessionUser): Promise<PromotionDto[]> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  const rows = await prisma.promotionRequest.findMany({
    where: { status: { in: [...ACTIVE] } },
    orderBy: { createdAt: 'desc' },
    include: promotionInclude,
  });
  return rows.map(toDto);
}

export async function getForgePromotion(
  currentUser: SessionUser,
  forgeId: string,
): Promise<PromotionDto | null> {
  const forge = await loadForgeForAcl(forgeId);
  const acl = { id: forge.id, createdById: forge.createdById, groups: forge.groups.map((g) => g.group.name) };
  // canReadForge is sufficient to view a forge's promotion status
  const { canReadForge } = await import('@/lib/acl');
  if (!canReadForge(currentUser, acl)) throw new ForbiddenError(`Cannot read forge ${forgeId}`);
  const row = await prisma.promotionRequest.findFirst({
    where: { forgeId },
    orderBy: { createdAt: 'desc' },
    include: promotionInclude,
  });
  return row ? toDto(row) : null;
}
```

