# Production Deployments Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the admin Deployments tab in prod mode into an inventory view of every forge, its available registry versions, and what is running — with a gated DEPLOY button — and fix the bug that makes the tab permanently empty.

**Architecture:** The reconcile loop persists its per-tick status snapshot to `~/.crystal-forge/deployments.json` instead of a module-level variable (which Turbopack duplicates across server chunks, causing the bug). A new `lib/services/deployments.ts` joins that snapshot with the unfiltered forge inventory from Postgres and, on a separate cadence, with semver tags from the registry. DEPLOY writes `deployVersion` + `deployEnabled` and returns immediately; the existing reconcile loop converges. No new container-starting code path is introduced.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Prisma 7 + Postgres 16, Vitest (`@vitest-environment node` for services, `jsdom` for components), Tailwind v4, existing `RegistryClient` and `lib/versioning/semver.ts`.

**Spec:** `docs/superpowers/specs/2026-08-13-prod-deployments-tab-design.md`

## Global Constraints

- **No schema change.** Reuses `Forge.deployEnabled` and `Forge.deployVersion`. Do not create a migration.
- **The reconciler remains the only thing that starts containers.** Deploy endpoints write DB columns and return; they never call `ContainerManager` or `startForgeContainer`.
- **Nothing is built or retagged on the prod host.** Deploying selects which existing image runs.
- **Excluded from the deploy menu:** `latest` (a moving pointer maintained by `acceptPromotion` — pinning it would break the reconciler's version check) and all `sha-…` candidate tags. Only tags accepted by `parseVersion` are offered.
- **All new/changed routes are admin-only AND prod-only.**
- **A missing or corrupt status file must never break the page** — it degrades to "status unknown", never a 500.
- **`versions === []`** means no images exist (disables DEPLOY); **`versions === null`** means the registry call failed for that forge (must not masquerade as `no image`).
- Tests are colocated as `*.test.ts(x)`. Run with `pnpm test`.

**Note on the test database:** `crystal_forge_test` does not currently exist on this host — it was dropped during prod cleanup. This is self-healing: `vitest.global-setup.ts` recreates and migrates it automatically on the first `pnpm test`. No manual step needed.

---

## File Structure

**Create:**
- `lib/runtime/prod/deployment-status.ts` — load/save the reconciler's status snapshot
- `lib/runtime/prod/deployment-status.test.ts`
- `lib/services/deployments.ts` — inventory join, registry version lookup, deploy write
- `lib/services/deployments.test.ts`
- `lib/services/deployments-schema.ts` — zod body schema for the deploy route
- `app/api/deployments/versions/route.ts` — batch version map
- `app/api/deployments/[forgeId]/deploy/route.ts` — deploy action
- `app/(app)/deployments/rowState.ts` — pure row-state derivation
- `app/(app)/deployments/rowState.test.ts`

**Modify:**
- `lib/runtime/paths.ts` — add `deploymentsFilePath()`
- `lib/runtime/prod/reconciler.ts` — write snapshot per tick; delete `latest` + `getLatestDeploymentStatuses`
- `lib/runtime/prod/reconciler.test.ts:176-190` — the loop test asserts the deleted function; retarget at the file
- `lib/mode.ts` — add `prodOnlyRouteGuard()`
- `app/api/deployments/route.ts` — read the snapshot, then the service
- `app/(app)/deployments/DeploymentsClient.tsx` — inventory table with DEPLOY
- `app/(app)/deployments/DeploymentsClient.test.tsx`

---

## Task 1: Persist the reconciler status snapshot (fixes the empty tab)

This task alone makes the tab show real data. It is the whole bug fix.

**Why the current code is broken:** `reconciler.ts` keeps statuses in a module-level `let latest`, written by `startReconcileLoop` and read by `getLatestDeploymentStatuses()`. Turbopack emits that module into two separate server chunks — the instrumentation bundle gets `startReconcileLoop`, the route bundle gets `getLatestDeploymentStatuses` — so they are two different bindings. The loop writes one, the route reads the other, which nothing assigns.

**Files:**
- Modify: `lib/runtime/paths.ts`
- Create: `lib/runtime/prod/deployment-status.ts`
- Create: `lib/runtime/prod/deployment-status.test.ts`
- Modify: `lib/runtime/prod/reconciler.ts:154-158` (delete) and `:170-180` (tick)
- Modify: `lib/runtime/prod/reconciler.test.ts:9` and `:176-190`
- Modify: `app/api/deployments/route.ts`

**Interfaces:**
- Consumes: `DeploymentStatus` (already exported from `lib/runtime/prod/reconciler.ts`), `forgeHome()` from `lib/runtime/paths.ts`
- Produces: `deploymentsFilePath(): string`; `DeploymentStatusFile = Record<string, DeploymentStatus>`; `loadDeploymentStatuses(): Promise<DeploymentStatusFile>`; `saveDeploymentStatuses(statuses: DeploymentStatus[]): Promise<void>`

- [ ] **Step 1: Add the path helper**

In `lib/runtime/paths.ts`, directly below `stateFilePath()`:

```ts
export function deploymentsFilePath(): string {
  return path.join(forgeHome(), 'deployments.json');
}
```

- [ ] **Step 2: Write the failing test**

Create `lib/runtime/prod/deployment-status.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deploymentsFilePath } from '@/lib/runtime/paths';
import { loadDeploymentStatuses, saveDeploymentStatuses } from './deployment-status';
import type { DeploymentStatus } from './reconciler';

let tmp: string;
let prevHome: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-depstatus-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

const SAMPLE: DeploymentStatus = {
  forgeId: 'f1', slug: 'acme', name: 'Acme',
  desiredVersion: 'v1.2.3', runningVersion: 'v1.2.3',
  phase: 'running', error: null, consecutiveFailures: 0,
};

describe('deployment status snapshot', () => {
  it('returns an empty record when the file does not exist', async () => {
    expect(await loadDeploymentStatuses()).toEqual({});
  });

  it('round-trips statuses keyed by forgeId', async () => {
    await saveDeploymentStatuses([SAMPLE]);
    expect(await loadDeploymentStatuses()).toEqual({ f1: SAMPLE });
  });

  it('replaces the previous snapshot rather than merging into it', async () => {
    await saveDeploymentStatuses([SAMPLE]);
    await saveDeploymentStatuses([{ ...SAMPLE, forgeId: 'f2', slug: 'beta', name: 'Beta' }]);
    const snap = await loadDeploymentStatuses();
    expect(Object.keys(snap)).toEqual(['f2']);
  });

  it('backs up an unparseable file and returns empty', async () => {
    await fs.writeFile(deploymentsFilePath(), 'not json', 'utf8');
    expect(await loadDeploymentStatuses()).toEqual({});
    const files = await fs.readdir(tmp);
    expect(files.some((f) => f.startsWith('deployments.json.corrupt-'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test lib/runtime/prod/deployment-status.test.ts`
Expected: FAIL — cannot resolve `./deployment-status`.

- [ ] **Step 4: Implement the snapshot module**

Create `lib/runtime/prod/deployment-status.ts`. This mirrors `lib/runtime/state.ts` deliberately — same atomic write, same corrupt-file recovery — so the two behave identically under partial writes.

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { deploymentsFilePath, forgeHome } from '@/lib/runtime/paths';
import type { DeploymentStatus } from './reconciler';

/**
 * Last reconcile tick's statuses, keyed by forgeId (mirrors state.json's shape).
 *
 * Persisted rather than held in a module-level variable: Turbopack emits
 * reconciler.ts into separate chunks for instrumentation and for route
 * handlers, so a shared in-memory binding does not exist across that boundary.
 */
export type DeploymentStatusFile = Record<string, DeploymentStatus>;

export async function loadDeploymentStatuses(): Promise<DeploymentStatusFile> {
  const p = deploymentsFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as DeploymentStatusFile;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('shape');
    }
    return parsed;
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(forgeHome(), `deployments.json.corrupt-${ts}`);
    await fs.rename(p, backup).catch(() => {});
    console.error('[prod/deployment-status] deployments.json was unparseable; backed up to', backup);
    return {};
  }
}

export async function saveDeploymentStatuses(statuses: DeploymentStatus[]): Promise<void> {
  await fs.mkdir(forgeHome(), { recursive: true });
  const p = deploymentsFilePath();
  const tmp = `${p}.tmp`;
  const record: DeploymentStatusFile = {};
  for (const s of statuses) record[s.forgeId] = s;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(record, null, 2), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, p);
}
```

The `import type { DeploymentStatus } from './reconciler'` alongside `reconciler.ts` importing `saveDeploymentStatuses` from here is a **type-only** cycle. TypeScript erases it, so there is no runtime cycle. Leave the type where it is.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test lib/runtime/prod/deployment-status.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire the reconcile loop to write the snapshot**

In `lib/runtime/prod/reconciler.ts`, add the import:

```ts
import { saveDeploymentStatuses } from './deployment-status';
```

Delete these lines entirely (currently at `:154-158`):

```ts
let latest: DeploymentStatus[] = [];

/** Statuses from the most recent reconcile tick (read by the Deployments API). */
export function getLatestDeploymentStatuses(): DeploymentStatus[] {
  return latest;
}
```

Then in `startReconcileLoop`'s `tick()`, replace `latest = rec.statuses();` with the persisted write:

```ts
    try {
      await rec.reconcileOnce();
      await saveDeploymentStatuses(rec.statuses());
    } catch (err) {
      console.error('[reconciler] tick failed', err);
    } finally {
      inFlight = false;
    }
```

- [ ] **Step 7: Retarget the existing loop test**

`lib/runtime/prod/reconciler.test.ts:176-190` currently asserts on `getLatestDeploymentStatuses()`. That test **passes today despite the bug**, because under Vitest both callers share one module instance — which is exactly why the bug reached production. Point it at the file instead.

Change the import on line 9 to drop `getLatestDeploymentStatuses`:

```ts
import { makeReconciler, startReconcileLoop } from './reconciler';
```

Add next to it:

```ts
import { loadDeploymentStatuses } from './deployment-status';
```

Replace the assertion at the end of that test:

```ts
      const loop = startReconcileLoop({ prisma, containerManager: containers, start: t.start, stop: t.stop }, 60_000);
      // Give the immediate tick a moment to complete.
      await new Promise((r) => setTimeout(r, 50));
      loop.stop();
      const snapshot = await loadDeploymentStatuses();
      expect(Object.values(snapshot).map((s) => s.slug)).toContain('acme');
```

- [ ] **Step 8: Point the API route at the snapshot**

Replace the body of `app/api/deployments/route.ts` (Task 5 replaces this again with the service; this keeps the build green and ships the fix now):

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { loadDeploymentStatuses } from '@/lib/runtime/prod/deployment-status';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const snapshot = await loadDeploymentStatuses();
  return NextResponse.json({ deployments: Object.values(snapshot) });
}
```

- [ ] **Step 9: Verify the whole suite and types**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass. If `getLatestDeploymentStatuses` still appears anywhere, typecheck fails — remove those references.

- [ ] **Step 10: Commit**

```bash
git add lib/runtime/paths.ts lib/runtime/prod/deployment-status.ts \
        lib/runtime/prod/deployment-status.test.ts lib/runtime/prod/reconciler.ts \
        lib/runtime/prod/reconciler.test.ts app/api/deployments/route.ts
git commit -m "fix(prod-mode): persist reconcile status snapshot instead of module state

Turbopack emits reconciler.ts into separate chunks for instrumentation and
route handlers, so the module-level \`latest\` written by startReconcileLoop
was never the one getLatestDeploymentStatuses read. The Deployments tab was
therefore permanently empty. Persist to ~/.crystal-forge/deployments.json."
```

---

## Task 2: Inventory join (`listDeployments`)

**Files:**
- Create: `lib/services/deployments.ts`
- Create: `lib/services/deployments.test.ts`

**Interfaces:**
- Consumes: `loadDeploymentStatuses` (Task 1), `prisma` from `@/lib/prisma`, `SessionUser` from `@/lib/services/types`, `ForbiddenError` from `@/lib/errors`, `slugifyForgeName` from `@/lib/github/slug`
- Produces: `DeploymentRow` type and `listDeployments(currentUser: SessionUser): Promise<DeploymentRow[]>`

**Field naming matters:** the row exposes `pinnedVersion`, not the reconciler's internal `desiredVersion`. Tasks 5, 6 and 7 all depend on that name.

- [ ] **Step 1: Write the failing test**

Create `lib/services/deployments.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { saveDeploymentStatuses } from '@/lib/runtime/prod/deployment-status';
import { listDeployments } from './deployments';

let tmp: string;
let prevHome: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-depsvc-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('listDeployments', () => {
  it('includes never-deployed forges alongside running ones', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const live = await makeForge(prisma, {
        name: 'Crystal Lattice', createdById: admin.id,
        deployEnabled: true, deployVersion: 'v1.0.2',
      });
      await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });

      await saveDeploymentStatuses([{
        forgeId: live.id, slug: 'crystal-lattice', name: 'Crystal Lattice',
        desiredVersion: 'v1.0.2', runningVersion: 'v1.0.2',
        phase: 'running', error: null, consecutiveFailures: 0,
      }]);

      const rows = await listDeployments(admin);

      expect(rows).toHaveLength(2);
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byName['Crystal Lattice']).toMatchObject({
        slug: 'crystal-lattice', deployEnabled: true,
        pinnedVersion: 'v1.0.2', runningVersion: 'v1.0.2', phase: 'running',
      });
      expect(byName['Second Set of Eyes']).toMatchObject({
        slug: 'second-set-of-eyes', deployEnabled: false,
        pinnedVersion: null, runningVersion: null, phase: null,
      });
    });
  });

  it('surfaces the failure reason and count from the snapshot', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const f = await makeForge(prisma, {
        name: 'Acme', createdById: admin.id, deployEnabled: true, deployVersion: 'v9.9.9',
      });
      await saveDeploymentStatuses([{
        forgeId: f.id, slug: 'acme', name: 'Acme',
        desiredVersion: 'v9.9.9', runningVersion: null,
        phase: 'failed', error: 'pull failed', consecutiveFailures: 3,
      }]);

      const rows = await listDeployments(admin);
      expect(rows[0]).toMatchObject({ phase: 'failed', error: 'pull failed', consecutiveFailures: 3 });
    });
  });

  it('renders inventory with unknown status when the snapshot is missing', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await makeForge(prisma, { name: 'Acme', createdById: admin.id, deployEnabled: true, deployVersion: 'v1.0.0' });

      const rows = await listDeployments(admin);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pinnedVersion: 'v1.0.0', phase: null, runningVersion: null });
    });
  });

  it('rejects non-admins', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(listDeployments(dev)).rejects.toThrow(/[Aa]dmin/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/deployments.test.ts`
Expected: FAIL — cannot resolve `./deployments`.

- [ ] **Step 3: Implement `listDeployments`**

Create `lib/services/deployments.ts`:

```ts
import { prisma } from '@/lib/prisma';
import { ForbiddenError } from '@/lib/errors';
import { slugifyForgeName } from '@/lib/github/slug';
import { loadDeploymentStatuses } from '@/lib/runtime/prod/deployment-status';
import type { DeploymentPhase } from '@/lib/runtime/prod/reconciler';
import type { SessionUser } from './types';

/** One row of the admin Deployments table: inventory joined with live status. */
export type DeploymentRow = {
  forgeId: string;
  name: string;
  displayName: string | null;
  slug: string;
  deployEnabled: boolean;
  /** Desired version from the DB. Null when the forge has never been deployed. */
  pinnedVersion: string | null;
  /** Actual version from the last reconcile tick. Null when nothing is running. */
  runningVersion: string | null;
  /** Null when the snapshot has no entry for this forge (never deployed, or no tick yet). */
  phase: DeploymentPhase | null;
  error: string | null;
  consecutiveFailures: number;
};

function assertAdmin(user: SessionUser): void {
  if (!user.isAdmin) throw new ForbiddenError('Admin only');
}

/**
 * Every forge prod knows about — deliberately unfiltered, unlike
 * listDesiredForges — joined with the reconciler's last status snapshot.
 *
 * Never calls the registry: the client polls this every 3s, and a registry
 * outage must not blank the status table. Versions come from
 * listAvailableVersions on its own cadence.
 */
export async function listDeployments(currentUser: SessionUser): Promise<DeploymentRow[]> {
  assertAdmin(currentUser);
  const [forges, snapshot] = await Promise.all([
    prisma.forge.findMany({
      select: { id: true, name: true, displayName: true, deployEnabled: true, deployVersion: true },
      orderBy: { name: 'asc' },
    }),
    loadDeploymentStatuses(),
  ]);
  return forges.map((f) => {
    const s = snapshot[f.id];
    return {
      forgeId: f.id,
      name: f.name,
      displayName: f.displayName,
      slug: slugifyForgeName(f.name),
      deployEnabled: f.deployEnabled,
      pinnedVersion: f.deployVersion,
      runningVersion: s?.runningVersion ?? null,
      phase: s?.phase ?? null,
      error: s?.error ?? null,
      consecutiveFailures: s?.consecutiveFailures ?? 0,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/services/deployments.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/services/deployments.ts lib/services/deployments.test.ts
git commit -m "feat(prod-mode): deployments inventory join (listDeployments)"
```

---

## Task 3: Registry version lookup (`listAvailableVersions`)

**Files:**
- Modify: `lib/services/deployments.ts`
- Modify: `lib/services/deployments.test.ts`

**Interfaces:**
- Consumes: `RegistryClient` from `@/lib/registry/types`, `getRegistryClient` from `@/lib/registry/client`, `parseVersion`/`compareVersions` from `@/lib/versioning/semver`
- Produces: `listAvailableVersions(currentUser: SessionUser, registry?: RegistryClient): Promise<Record<string, string[] | null>>` — keyed by forgeId

The `registry` parameter is injectable exactly as `createForge` injects its `client` and `provisioner`, so tests pass `FakeRegistryClient`.

- [ ] **Step 1: Write the failing test**

Append to `lib/services/deployments.test.ts`. Add these imports at the top of the file:

```ts
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { RegistryError } from '@/lib/registry/types';
import { listAvailableVersions } from './deployments';
```

Then append:

```ts
describe('listAvailableVersions', () => {
  it('keeps only semver tags, newest first, dropping latest and sha tags', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const f = await makeForge(prisma, { name: 'Crystal Lattice', createdById: admin.id });

      const registry = new FakeRegistryClient();
      for (const t of ['v1.0.0', 'v1.0.2', 'latest', 'sha-abc123', 'v1.1.0', 'v1.0.1']) {
        registry.seedTag('crystal-lattice', t);
      }

      const map = await listAvailableVersions(admin, registry);
      expect(map[f.id]).toEqual(['v1.1.0', 'v1.0.2', 'v1.0.1', 'v1.0.0']);
    });
  });

  it('returns an empty array for a forge with no images', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const f = await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });

      const map = await listAvailableVersions(admin, new FakeRegistryClient());
      expect(map[f.id]).toEqual([]);
    });
  });

  it('yields null for a forge whose registry lookup fails, without failing the batch', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const ok = await makeForge(prisma, { name: 'Crystal Lattice', createdById: admin.id });
      const bad = await makeForge(prisma, { name: 'Broken One', createdById: admin.id });

      const registry = new FakeRegistryClient();
      registry.seedTag('crystal-lattice', 'v1.0.0');
      const guarded = {
        tagManifest: registry.tagManifest.bind(registry),
        listTags: async (repo: string) => {
          if (repo === 'broken-one') throw new RegistryError('registry unreachable');
          return registry.listTags(repo);
        },
      };

      const map = await listAvailableVersions(admin, guarded);
      expect(map[ok.id]).toEqual(['v1.0.0']);
      expect(map[bad.id]).toBeNull();
    });
  });

  it('rejects non-admins', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(listAvailableVersions(dev, new FakeRegistryClient())).rejects.toThrow(/[Aa]dmin/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/deployments.test.ts`
Expected: FAIL — `listAvailableVersions` is not exported.

- [ ] **Step 3: Implement `listAvailableVersions`**

Add to `lib/services/deployments.ts`. Extend the imports:

```ts
import { getRegistryClient } from '@/lib/registry/client';
import type { RegistryClient } from '@/lib/registry/types';
import { compareVersions, parseVersion } from '@/lib/versioning/semver';
```

Then append:

```ts
/**
 * Semver tags per forge, newest first, keyed by forgeId.
 *
 * Batch (not per-forge-on-demand) because the `no image` row state disables the
 * DEPLOY button: the client must know a forge has no tags before the admin
 * interacts with it, which a lazy per-menu fetch cannot provide.
 *
 * `latest` and `sha-…` are excluded. `latest` is a moving pointer maintained by
 * acceptPromotion — pinning it would break the reconciler's version check,
 * because the container label would read "latest" forever and never appear to
 * drift even after the underlying manifest moves.
 *
 * A forge whose lookup throws yields `null`, distinct from `[]` ("no images
 * exist"), so one unreachable repo neither fails the batch nor masquerades as
 * an imageless forge.
 */
export async function listAvailableVersions(
  currentUser: SessionUser,
  registry: RegistryClient = getRegistryClient(),
): Promise<Record<string, string[] | null>> {
  assertAdmin(currentUser);
  const forges = await prisma.forge.findMany({ select: { id: true, name: true } });
  const entries = await Promise.all(
    forges.map(async (f) => {
      const slug = slugifyForgeName(f.name);
      try {
        const tags = await registry.listTags(slug);
        const versions = tags
          .filter((t) => parseVersion(t) !== null)
          .sort((a, b) => compareVersions(b, a));
        return [f.id, versions] as const;
      } catch (err) {
        console.error('[deployments] listTags failed for %s: %s', slug, err);
        return [f.id, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/services/deployments.test.ts`
Expected: PASS (8 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/services/deployments.ts lib/services/deployments.test.ts
git commit -m "feat(prod-mode): batch registry version lookup for deployments"
```

---

## Task 4: The deploy write (`deployForge`)

**Files:**
- Modify: `lib/services/deployments.ts`
- Modify: `lib/services/deployments.test.ts`

**Interfaces:**
- Consumes: `NotFoundError`, `ValidationError` from `@/lib/errors`
- Produces: `deployForge(currentUser: SessionUser, forgeId: string, version: string, registry?: RegistryClient): Promise<DeploymentRow>`

Validation against the live tag list is the main guard against an unrecoverable state: the reconciler stops the old container before pulling the new image, so a pin to a nonexistent tag takes the forge **down** until a working version is deployed.

- [ ] **Step 1: Write the failing test**

Add `deployForge` to the `./deployments` import in the test file, then append:

Add `import type { PrismaClient } from '@prisma/client';` to the test file's imports, then append:

```ts
describe('deployForge', () => {
  async function setup(prisma: PrismaClient) {
    const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
    const forge = await makeForge(prisma, { name: 'Crystal Lattice', createdById: admin.id });
    const registry = new FakeRegistryClient();
    registry.seedTag('crystal-lattice', 'v1.0.0');
    registry.seedTag('crystal-lattice', 'v1.1.0');
    registry.seedTag('crystal-lattice', 'latest');
    return { admin, forge, registry };
  }

  it('enables the forge and pins the version on first deploy', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);

      const row = await deployForge(admin, forge.id, 'v1.1.0', registry);

      expect(row).toMatchObject({ pinnedVersion: 'v1.1.0', deployEnabled: true });
      const after = await prisma.forge.findUniqueOrThrow({ where: { id: forge.id } });
      expect(after.deployEnabled).toBe(true);
      expect(after.deployVersion).toBe('v1.1.0');
    });
  });

  it('allows deploying an older version (rollback)', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);
      await deployForge(admin, forge.id, 'v1.1.0', registry);

      await deployForge(admin, forge.id, 'v1.0.0', registry);

      const after = await prisma.forge.findUniqueOrThrow({ where: { id: forge.id } });
      expect(after.deployVersion).toBe('v1.0.0');
    });
  });

  it('rejects a version that is not in the registry', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);
      await expect(deployForge(admin, forge.id, 'v9.9.9', registry)).rejects.toThrow(/not available/i);
      const after = await prisma.forge.findUniqueOrThrow({ where: { id: forge.id } });
      expect(after.deployEnabled).toBe(false);
    });
  });

  it('rejects the moving latest tag', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);
      await expect(deployForge(admin, forge.id, 'latest', registry)).rejects.toThrow(/not available/i);
    });
  });

  it('throws NotFound for an unknown forge', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, registry } = await setup(prisma);
      await expect(
        deployForge(admin, '00000000-0000-0000-0000-000000000000', 'v1.0.0', registry),
      ).rejects.toThrow(/not found/i);
    });
  });

  it('rejects non-admins', async () => {
    await withCleanDb(async (prisma) => {
      const { forge, registry } = await setup(prisma);
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(deployForge(dev, forge.id, 'v1.0.0', registry)).rejects.toThrow(/[Aa]dmin/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/deployments.test.ts`
Expected: FAIL — `deployForge` is not exported.

- [ ] **Step 3: Implement `deployForge`**

Extend the error import in `lib/services/deployments.ts`:

```ts
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
```

Append:

```ts
/**
 * Pin a forge to a version and enable it. First deploy and upgrade are the same
 * gesture; deploying an older version is rollback.
 *
 * Writes desired state and returns — the reconcile loop converges on its next
 * tick. This must never start a container itself: the reconciler is the only
 * thing that does, and a second writer could race it.
 *
 * The version is validated against the live semver tag list because a bad pin
 * is not self-correcting: the reconciler removes the running container before
 * pulling, so pinning a nonexistent tag takes the forge down until someone
 * deploys a working version.
 */
export async function deployForge(
  currentUser: SessionUser,
  forgeId: string,
  version: string,
  registry: RegistryClient = getRegistryClient(),
): Promise<DeploymentRow> {
  assertAdmin(currentUser);
  const forge = await prisma.forge.findUnique({
    where: { id: forgeId },
    select: { id: true, name: true },
  });
  if (!forge) throw new NotFoundError('forge', forgeId);

  const slug = slugifyForgeName(forge.name);
  const tags = await registry.listTags(slug);
  const available = tags.filter((t) => parseVersion(t) !== null);
  if (!available.includes(version)) {
    throw new ValidationError(`Version ${version} is not available for ${slug}`, {
      version: [`Not a published version of ${slug}`],
    });
  }

  await prisma.forge.update({
    where: { id: forgeId },
    data: { deployVersion: version, deployEnabled: true },
  });

  const rows = await listDeployments(currentUser);
  const row = rows.find((r) => r.forgeId === forgeId);
  if (!row) throw new NotFoundError('forge', forgeId);
  return row;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/services/deployments.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/services/deployments.ts lib/services/deployments.test.ts
git commit -m "feat(prod-mode): gated deployForge write with registry validation"
```

---

## Task 5: Routes and the prod-only guard

**Files:**
- Modify: `lib/mode.ts`
- Create: `lib/services/deployments-schema.ts`
- Modify: `app/api/deployments/route.ts`
- Create: `app/api/deployments/versions/route.ts`
- Create: `app/api/deployments/[forgeId]/deploy/route.ts`

**Interfaces:**
- Consumes: `listDeployments`, `listAvailableVersions`, `deployForge` (Tasks 2-4); `respondToServiceError` from `@/lib/http`
- Produces: `prodOnlyRouteGuard(): NextResponse | null`; `deployForgeInput` zod schema; three HTTP endpoints returning `{ deployments: DeploymentRow[] }`, `{ versions: Record<string, string[] | null> }`, `{ deployment: DeploymentRow }`

Route resolution note: `versions` is a static segment and `[forgeId]` is dynamic, and `[forgeId]/deploy` needs two segments. `GET /api/deployments/versions` cannot collide with the deploy route.

- [ ] **Step 1: Add the prod-only guard**

Append to `lib/mode.ts`, mirroring `devOnlyRouteGuard`:

```ts
/**
 * Guard for prod-only route handlers: returns a 404 response in dev mode so
 * the route is inert there, else null (caller proceeds).
 */
export function prodOnlyRouteGuard(): NextResponse | null {
  return isProdMode() ? null : NextResponse.json({ error: 'Not found' }, { status: 404 });
}
```

- [ ] **Step 2: Add the request schema**

Create `lib/services/deployments-schema.ts`:

```ts
import { z } from 'zod';

export const deployForgeInput = z.object({
  version: z.string().min(1),
});
```

- [ ] **Step 3: Rework the inventory route**

Replace `app/api/deployments/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listDeployments } from '@/lib/services/deployments';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function GET() {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ deployments: await listDeployments(session.user) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

The admin check now lives in the service and surfaces as 403 via `respondToServiceError`, matching how the other services do it.

- [ ] **Step 4: Add the versions route**

Create `app/api/deployments/versions/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listAvailableVersions } from '@/lib/services/deployments';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function GET() {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ versions: await listAvailableVersions(session.user) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 5: Add the deploy route**

Create `app/api/deployments/[forgeId]/deploy/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { deployForge } from '@/lib/services/deployments';
import { deployForgeInput } from '@/lib/services/deployments-schema';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/deployments/[forgeId]/deploy'>,
) {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { forgeId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = deployForgeInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const deployment = await deployForge(session.user, forgeId, parsed.data.version);
    return NextResponse.json({ deployment });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 6: Verify build and types**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/mode.ts lib/services/deployments-schema.ts app/api/deployments
git commit -m "feat(prod-mode): deployments inventory, versions, and deploy routes"
```

---

## Task 6: Row-state derivation

Pure function, extracted so the six-state precedence is testable without rendering.

**Files:**
- Create: `app/(app)/deployments/rowState.ts`
- Create: `app/(app)/deployments/rowState.test.ts`

**Interfaces:**
- Consumes: `DeploymentRow` (Task 2)
- Produces: `RowState` union and `deriveRowState(row: DeploymentRow, versions: string[] | null | undefined): RowState`

**Note:** `stopped` is currently unreachable — `reconciler.ts` only ever pushes `running` or `failed` — but it is a valid `DeploymentPhase`, so the branch exists for completeness rather than as dead code to remove.

- [ ] **Step 1: Write the failing test**

Create `app/(app)/deployments/rowState.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deriveRowState } from './rowState';
import type { DeploymentRow } from '@/lib/services/deployments';

const BASE: DeploymentRow = {
  forgeId: 'f1', name: 'Acme', displayName: null, slug: 'acme',
  deployEnabled: true, pinnedVersion: 'v1.0.0', runningVersion: 'v1.0.0',
  phase: 'running', error: null, consecutiveFailures: 0,
};

describe('deriveRowState', () => {
  it('reports running when pinned matches running and the phase is running', () => {
    expect(deriveRowState(BASE, ['v1.0.0'])).toBe('running');
  });

  it('reports not-deployed for a forge that was never enabled', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null, runningVersion: null, phase: null };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('not-deployed');
  });

  it('reports no-image when a never-deployed forge has no semver tags', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null, runningVersion: null, phase: null };
    expect(deriveRowState(row, [])).toBe('no-image');
  });

  it('does not report no-image when the registry lookup failed', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null, runningVersion: null, phase: null };
    expect(deriveRowState(row, null)).toBe('not-deployed');
  });

  it('reports deploying while pinned and running disagree', () => {
    const row = { ...BASE, pinnedVersion: 'v1.1.0', runningVersion: 'v1.0.0' };
    expect(deriveRowState(row, ['v1.1.0', 'v1.0.0'])).toBe('deploying');
  });

  it('reports deploying for a first deploy with no snapshot entry yet', () => {
    const row = { ...BASE, pinnedVersion: 'v1.0.0', runningVersion: null, phase: null };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('deploying');
  });

  it('reports failed even when pinned and running disagree', () => {
    const row = { ...BASE, pinnedVersion: 'v9.9.9', runningVersion: null, phase: 'failed' as const, error: 'pull failed' };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('failed');
  });

  it('reports stopped when the reconciler says stopped', () => {
    const row = { ...BASE, phase: 'stopped' as const, runningVersion: 'v1.0.0' };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('stopped');
  });

  it('prefers not-deployed over any snapshot phase', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('not-deployed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test rowState`
Expected: FAIL — cannot resolve `./rowState`.

- [ ] **Step 3: Implement the derivation**

Create `app/(app)/deployments/rowState.ts`:

```ts
import type { DeploymentRow } from '@/lib/services/deployments';

export type RowState =
  | 'not-deployed'
  | 'no-image'
  | 'deploying'
  | 'running'
  | 'failed'
  | 'stopped';

/**
 * Six display states from three inputs: the DB's desired state, the
 * reconciler's snapshot, and the registry's tag list. Order is precedence.
 *
 * `versions` distinguishes three cases: a list (images exist), `[]` (none
 * exist -> no-image, DEPLOY disabled), and `null`/`undefined` (registry
 * unreachable or not fetched yet -> must NOT read as no-image).
 */
export function deriveRowState(
  row: DeploymentRow,
  versions: string[] | null | undefined,
): RowState {
  // 1. Never deployed wins over any stale snapshot phase.
  if (!row.deployEnabled || row.pinnedVersion === null) {
    return versions !== null && versions !== undefined && versions.length === 0
      ? 'no-image'
      : 'not-deployed';
  }
  // 2. A failure is the most actionable thing to show.
  if (row.phase === 'failed') return 'failed';
  // 3. Desired != actual means the loop has not converged yet. Also covers a
  //    first deploy, where the snapshot has no entry at all.
  if (row.pinnedVersion !== row.runningVersion) return 'deploying';
  if (row.phase === 'stopped') return 'stopped';
  return 'running';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test rowState`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/deployments/rowState.ts" "app/(app)/deployments/rowState.test.ts"
git commit -m "feat(prod-mode): deployments row-state derivation"
```

---

## Task 7: Inventory table UI with DEPLOY

**Files:**
- Modify: `app/(app)/deployments/DeploymentsClient.tsx`
- Modify: `app/(app)/deployments/DeploymentsClient.test.tsx`

**Interfaces:**
- Consumes: `DeploymentRow` (Task 2), `deriveRowState`/`RowState` (Task 6), the three routes (Task 5), `Button` from `@/components/ui/button`
- Produces: the rendered admin table. No exports beyond `DeploymentsClient`.

A native `<select>` is used for version choice rather than `DropdownMenu`: there is no `select.tsx` primitive in `components/ui/`, and a native control is keyboard-accessible and trivially driven with `fireEvent.change` in jsdom.

- [ ] **Step 1: Write the failing test**

Replace `app/(app)/deployments/DeploymentsClient.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DeploymentsClient } from './DeploymentsClient';
import type { DeploymentRow } from '@/lib/services/deployments';

const RUNNING: DeploymentRow = {
  forgeId: 'f1', name: 'Crystal Lattice', displayName: null, slug: 'crystal-lattice',
  deployEnabled: true, pinnedVersion: 'v1.0.2', runningVersion: 'v1.0.2',
  phase: 'running', error: null, consecutiveFailures: 0,
};
const FAILED: DeploymentRow = {
  forgeId: 'f2', name: 'Acme', displayName: null, slug: 'acme',
  deployEnabled: true, pinnedVersion: 'v9.9.9', runningVersion: null,
  phase: 'failed', error: 'pull failed', consecutiveFailures: 3,
};
const NO_IMAGE: DeploymentRow = {
  forgeId: 'f3', name: 'Second Set of Eyes', displayName: null, slug: 'second-set-of-eyes',
  deployEnabled: false, pinnedVersion: null, runningVersion: null,
  phase: null, error: null, consecutiveFailures: 0,
};

const deployCalls: Array<{ url: string; body: unknown }> = [];

function mockFetch(rows: DeploymentRow[], versions: Record<string, string[] | null>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/deployments')) {
      return { ok: true, json: async () => ({ deployments: rows }) };
    }
    if (url.endsWith('/api/deployments/versions')) {
      return { ok: true, json: async () => ({ versions }) };
    }
    deployCalls.push({ url, body: JSON.parse(String(init?.body)) });
    return { ok: true, json: async () => ({ deployment: rows[0] }) };
  });
}

beforeEach(() => { deployCalls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('DeploymentsClient', () => {
  it('renders every forge including never-deployed ones', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING, FAILED, NO_IMAGE], {
      f1: ['v1.1.0', 'v1.0.2'], f2: ['v1.0.0'], f3: [],
    }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('Crystal Lattice')).toBeInTheDocument());
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Second Set of Eyes')).toBeInTheDocument();
  });

  it('shows the failure reason and count', async () => {
    vi.stubGlobal('fetch', mockFetch([FAILED], { f2: ['v1.0.0'] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
    expect(screen.getByText(/pull failed/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed attempts/)).toBeInTheDocument();
  });

  it('disables deploy and shows no image when a forge has no versions', async () => {
    vi.stubGlobal('fetch', mockFetch([NO_IMAGE], { f3: [] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('no image')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /deploy/i })).toBeDisabled();
  });

  it('does not show no image when the registry lookup failed', async () => {
    vi.stubGlobal('fetch', mockFetch([NO_IMAGE], { f3: null }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('not deployed')).toBeInTheDocument());
    expect(screen.queryByText('no image')).not.toBeInTheDocument();
  });

  it('posts the selected version when deploy is pressed', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING], { f1: ['v1.1.0', 'v1.0.2'] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1.1.0' } });
    fireEvent.click(screen.getByRole('button', { name: /deploy/i }));

    await waitFor(() => expect(deployCalls).toHaveLength(1));
    expect(deployCalls[0]!.url).toContain('/api/deployments/f1/deploy');
    expect(deployCalls[0]!.body).toEqual({ version: 'v1.1.0' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test DeploymentsClient`
Expected: FAIL — the component renders the old status-only table.

- [ ] **Step 3: Implement the component**

Replace `app/(app)/deployments/DeploymentsClient.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DeploymentRow } from '@/lib/services/deployments';
import { deriveRowState, type RowState } from './rowState';

type VersionMap = Record<string, string[] | null>;

const STATE_LABEL: Record<RowState, string> = {
  'not-deployed': 'not deployed',
  'no-image': 'no image',
  deploying: 'deploying',
  running: 'running',
  failed: 'failed',
  stopped: 'stopped',
};

const STATE_CLASS: Record<RowState, string> = {
  'not-deployed': 'text-ink-dim',
  'no-image': 'text-ink-dim',
  deploying: 'text-amber-400',
  running: 'text-emerald-400',
  failed: 'text-red-400',
  stopped: 'text-ink-dim',
};

export function DeploymentsClient() {
  const [rows, setRows] = useState<DeploymentRow[]>([]);
  const [versions, setVersions] = useState<VersionMap>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Status poll: every 3s, never touches the registry.
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch('/api/deployments');
        if (!res.ok) return;
        const data = (await res.json()) as { deployments: DeploymentRow[] };
        if (alive) setRows(data.deployments);
      } catch {
        /* keep last known state */
      }
    }
    void poll();
    const h = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  // Versions: on mount and after a deploy, on their own cadence.
  const loadVersions = useCallback(async () => {
    try {
      const res = await fetch('/api/deployments/versions');
      if (!res.ok) return;
      const data = (await res.json()) as { versions: VersionMap };
      setVersions(data.versions);
    } catch {
      /* leave the previous map in place */
    }
  }, []);

  useEffect(() => { void loadVersions(); }, [loadVersions]);

  async function deploy(forgeId: string, version: string) {
    setBusy((b) => ({ ...b, [forgeId]: true }));
    try {
      await fetch(`/api/deployments/${forgeId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      await loadVersions();
    } finally {
      setBusy((b) => ({ ...b, [forgeId]: false }));
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-8 py-10">
      <h1 className="mb-6 text-lg font-semibold text-ink">Deployments</h1>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-dim">No forges are registered on this server.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-dim">
              <tr>
                <th className="py-2 pr-4">Forge</th>
                <th className="py-2 pr-4">Pinned</th>
                <th className="py-2 pr-4">Running</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Detail</th>
                <th className="py-2 pr-4">Deploy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const available = versions[r.forgeId];
                const state = deriveRowState(r, available);
                const options = available ?? [];
                const choice = selected[r.forgeId] ?? options[0] ?? '';
                const canDeploy = options.length > 0 && !busy[r.forgeId];
                return (
                  <tr key={r.forgeId} className="border-t border-border">
                    <td className="py-2 pr-4 font-medium text-ink">{r.displayName || r.name}</td>
                    <td className="py-2 pr-4">{r.pinnedVersion ?? '—'}</td>
                    <td className="py-2 pr-4">{r.runningVersion ?? '—'}</td>
                    <td className={`py-2 pr-4 ${STATE_CLASS[state]}`}>{STATE_LABEL[state]}</td>
                    <td className="py-2 pr-4 text-ink-dim">
                      {available === null
                        ? 'registry unavailable'
                        : [
                            r.error,
                            r.consecutiveFailures > 0 ? `${r.consecutiveFailures} failed attempts` : null,
                          ].filter(Boolean).join(' · ')}
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={`Version for ${r.displayName || r.name}`}
                          className="h-8 rounded-md border border-border bg-panel px-2 text-sm text-ink disabled:opacity-50"
                          value={choice}
                          disabled={options.length === 0}
                          onChange={(e) => setSelected((s) => ({ ...s, [r.forgeId]: e.target.value }))}
                        >
                          {options.length === 0 ? (
                            <option value="">—</option>
                          ) : (
                            options.map((v) => <option key={v} value={v}>{v}</option>)
                          )}
                        </select>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canDeploy}
                          onClick={() => void deploy(r.forgeId, choice)}
                        >
                          {busy[r.forgeId] ? 'Deploying…' : 'Deploy'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test DeploymentsClient`
Expected: PASS (5 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/deployments/DeploymentsClient.tsx" "app/(app)/deployments/DeploymentsClient.test.tsx"
git commit -m "feat(prod-mode): deployments inventory table with gated DEPLOY"
```

---

## Task 8: Verify against the live prod server

The unit suite cannot prove the instrumentation↔route wiring works, because the bug was cross-bundle and invisible to Vitest. This task is the only thing that does.

**Files:** none — verification only.

- [ ] **Step 1: Restart the prod service**

```bash
sudo systemctl restart crystal-forge.service
journalctl -u crystal-forge.service -n 20 --no-pager | grep -i reconcile
```

Expected: `[instrumentation] prod reconcile loop started`.

- [ ] **Step 2: Confirm the reconciler writes the snapshot**

```bash
sleep 5 && cat ~/.crystal-forge/deployments.json
```

Expected: a JSON object keyed by forge id, containing Crystal Lattice with `"phase": "running"` and `"runningVersion": "v1.0.2"`. **If this file is absent, stop** — the loop is not writing and nothing downstream will work.

- [ ] **Step 3: Confirm the tab renders**

Open the dashboard's Deployments tab as an admin. Expected: Crystal Lattice listed as `running` at `v1.0.2`, with `v1.1.0`, `v1.0.2`, `v1.0.1`, `v1.0.0` in its version menu — and no `latest` or `sha-…` entries.

- [ ] **Step 4: Deploy and watch it converge**

Select `v1.1.0` and press Deploy. Expected: the row moves to `deploying`, then to `running` at `v1.1.0` within one reconcile interval plus pull time. Confirm with:

```bash
docker ps --format '{{.Names}}\t{{.Image}}'
```

Expected: `forge-crystal-lattice` on `registry.crystalfountains.com/crystal-lattice:v1.1.0`.

Note that `v1.1.0` has both a git tag and a registry image, whereas the currently-running `v1.0.2` is an image with no git tag behind it — so this also moves prod onto the more traceable of the two.

- [ ] **Step 5: Roll back**

Deploy `v1.0.2` again and confirm the row returns to `running` at `v1.0.2`. This proves rollback works before anyone needs it at 2am.

- [ ] **Step 6: Record the outcome**

If every step passed, the feature is done. If step 2 produced no file, the loop is not writing — check `journalctl` for `[reconciler] tick failed` before changing any code.

---

## Notes for the executor

- **Do not add a Prisma migration.** This feature reuses two existing columns.
- **Do not make the deploy endpoint start containers.** If a test seems to want that, the test is wrong.
- **Deleting `getLatestDeploymentStatuses` is intended**, not an oversight. Removing dead code inside this repo is pre-approved per `AGENTS.md`.
- **`DeploymentRow` must be imported into client files with `import type`.** `lib/services/deployments.ts` pulls in `@/lib/prisma`; a value import from a `'use client'` file (or from `rowState.ts`, which one imports) would drag the Prisma client into the browser bundle. `import type` is erased at compile time, so it is safe — but a later refactor that drops the `type` keyword will break the build in a confusing way.
- **`pnpm e2e` is not part of this plan.** Playwright forces `GITHUB_CLIENT_MODE=fake` and does not run in prod mode; these routes 404 there by design.
