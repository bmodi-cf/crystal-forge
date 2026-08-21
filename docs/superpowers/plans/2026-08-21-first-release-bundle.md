# First-Release Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a forge's inventory row and its pilot database from the pilot dashboard to the prod dashboard over the container registry, applied once from the prod UI on a forge's first release.

**Architecture:** The pilot cuts a **bundle** — a gzipped ustar layer holding `forge.json`, `data.sql`, and `bundle.json` — and pushes it as an ordinary OCI image manifest to its own registry repo, `<slug>-seed:<version>`. Prod discovers un-imported bundles from the registry catalog, verifies them against the app image they claim to seed, and applies them in an order that keeps the reconcile loop from seeing the forge until the data has landed: the `Forge` row is written with `deployEnabled: false`, the database is created and provisioned, `data.sql` and a `_forge_seed` marker are restored in one transaction, and only then is `deployEnabled` flipped true. Nothing in the running system changes — the reconciler, `prod-runtime.ts`, and `DatabaseProvisioner` are reused unmodified.

**Tech Stack:** Next.js 16 (App Router) + React 19, TypeScript strict, Prisma 7 + Postgres 16, Vitest, `pg` (node-postgres), Docker registry HTTP API v2, `node:zlib` + `node:crypto` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-08-21-first-release-bundle-design.md` — read it before starting. This plan implements it section by section and cites section numbers throughout.

## Global Constraints

- **No new npm dependencies.** The tar writer/reader is hand-rolled ustar (Task 1) precisely so the repo does not gain a tar dependency for three small text files. `node:zlib` provides gzip, `node:crypto` provides sha256.
- **Octokit only inside `lib/github/`.** Enforced by the local `no-octokit-outside-github` ESLint rule. Task 5 adds a method to `GitHubClient`; every caller consumes it through the interface.
- **Tests are colocated** next to source as `*.test.ts(x)`. Node-only tests start with `// @vitest-environment node`.
- **`pnpm test` uses a dedicated `<db>_test` database.** `vitest.setup.ts` rewrites `DATABASE_URL`; `lib/test/db.ts` refuses any database not ending in `_test`. Printing `🌱 The seed command has been executed` is expected and does not touch the dev DB.
- **Mode guards:** cut is dev-only (`devOnlyRouteGuard()`), import is prod-only (`prodOnlyRouteGuard()`). `isProdMode()` reads `process.env.FORGE_DASHBOARD_MODE` at call time so tests can set it.
- **Admin only.** Services throw `ForbiddenError('Admin only')` when `!user.isAdmin`, matching `lib/services/deployments.ts`.
- **Service errors** are the classes in `lib/errors.ts` (`NotFoundError`, `ForbiddenError`, `ValidationError`); routes translate them with `respondToServiceError`.
- **Versions are `vMAJOR.MINOR.PATCH`** — validate with `parseVersion` from `lib/versioning/semver.ts`, never a hand-rolled regex.
- **Passwords handed to `setRolePassword` must match `/^[a-f0-9]+$/`** — it refuses anything else. Use `randomBytes(24).toString('hex')`, as `prod-runtime.ts` does.
- **Database and role names** come from `slugifyForgeName` → `slugToDbName` → `dbNameToRole` in `lib/github/slug.ts`. Never derive them any other way; the reconciler derives them exactly this way and a mismatch would seed a database nothing reads.
- **`pnpm typecheck` and `pnpm lint` must pass** at every commit.

## Spec gaps this plan resolves

Three things the spec assumes are not true of the code as it stands. Each is resolved here, in the task noted, and none changes the spec's design:

1. **`forge.json` is missing two required columns.** `Forge.repoFullName` is `NOT NULL UNIQUE` and `Forge.createdById` is a `NOT NULL` FK with `onDelete: Restrict` (`prisma/schema.prisma`). The spec's `forge.json` (§1) lists neither. Resolution: `repoFullName` is carried in the bundle (Task 1); `createdById` is set to **the importing prod admin's own user id**, because the pilot's creator may not exist in prod's `users` table and a bundle must not have to carry users (Task 7).
2. **`GitHubClient` cannot list a directory at a sha.** §2's migration-parity guard says the GitHub client "can list at a sha"; the interface has no such method (`lib/github/types.ts`). Resolution: Task 5 adds `listDirectoryAtRef`.
3. **`admin/promotions` cannot show an accepted promotion.** §2 puts the cut action on a forge whose promotion is `accepted`, but `PromotionsClient` renders `/api/promotions`, which is `listPendingPromotions` → `status in ACTIVE_STATUSES` (`checks_running`, `checks_failed`, `awaiting_approval`) — `accepted` is excluded by construction. Resolution: a separate service function, route, and page section for first-release candidates (Tasks 6, 8, 9).

---

## File Structure

**New — bundle format and transport**
- `lib/bundle/tar.ts` — minimal ustar writer/reader. Deterministic (fixed mtime) so a re-cut of identical content yields an identical digest.
- `lib/bundle/tar.test.ts`
- `lib/bundle/types.ts` — `ForgeJson`, `BundleJson`, `BundleContents`, and their zod parsers. One file: these three shapes always change together.
- `lib/bundle/types.test.ts`
- `lib/bundle/registry-bundle.ts` — `pushBundle` / `pullBundle`: tar+gzip ⇄ OCI manifest + blobs, with the §5 bundle-integrity check.
- `lib/bundle/registry-bundle.test.ts`

**New — database dump and restore**
- `lib/db/dump.ts` — `dumpForgeDatabase`, `restoreForgeDatabase`, `readAppliedMigrations`, `readSeedMarker`, `seedMarkerSql`. Spawns `docker exec` directly (§1.3) rather than going through `ContainerManager`, whose combined stdout/stderr would corrupt a dump.
- `lib/db/dump.test.ts` — unit (injected spawn) + integration (real `_test` server).

**New — the service**
- `lib/services/first-release.ts` — `listFirstReleaseCandidates` + `cutBundle` (pilot), `listBundleCandidates` + `importBundle` (prod).
- `lib/services/first-release.test.ts`
- `lib/services/first-release-schema.ts` — zod input for the import route.

**New — routes**
- `app/api/promotions/first-release-candidates/route.ts` (GET, dev-only)
- `app/api/promotions/[id]/bundle/route.ts` (POST, dev-only)
- `app/api/deployments/bundles/route.ts` (GET, prod-only)
- `app/api/deployments/bundles/[slug]/import/route.ts` (POST, prod-only)

**New — UI**
- `app/(app)/admin/promotions/FirstReleaseSection.tsx` + `.test.tsx` — its own component, not folded into `PromotionsClient`, because it renders a different collection (decided promotions) from a different endpoint.
- `app/(app)/admin/deployments/BundleImportSection.tsx` + `.test.tsx`

**Modified**
- `lib/registry/types.ts` — six new `RegistryClient` methods.
- `lib/registry/http-client.ts`, `lib/registry/fake-client.ts` (+ its test) — implementations.
- `lib/github/types.ts`, `lib/github/octokit-client.ts`, `lib/github/fake-client.ts` (+ its test) — `listDirectoryAtRef`.
- `lib/env.ts`, `.env.example` — `PG_CONTAINER`.
- `app/(app)/admin/promotions/PromotionsClient.tsx` — render `<FirstReleaseSection />` below the pending list.
- `app/(app)/admin/deployments/DeploymentsClient.tsx` — render `<BundleImportSection />` above the inventory table.
- `AGENTS.md` — two gotcha entries.

---

### Task 1: Bundle format — ustar packing and the JSON shapes

**Files:**
- Create: `lib/bundle/tar.ts`
- Create: `lib/bundle/tar.test.ts`
- Create: `lib/bundle/types.ts`
- Create: `lib/bundle/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `writeTar(entries: TarEntry[]): Buffer` where `TarEntry = { name: string; body: Buffer }`
  - `readTar(buf: Buffer): Map<string, Buffer>`
  - `sha256Digest(buf: Buffer): string` — returns `"sha256:<64 hex>"`
  - `type ForgeJson = { name: string; displayName: string | null; description: string | null; slug: string; repoFullName: string; deployVersion: string }`
  - `type BundleJson = { version: string; sourceHost: string; cutAt: string; appImageDigest: string; migrations: string[] }`
  - `type BundleContents = { forge: ForgeJson; dataSql: string; bundle: BundleJson }`
  - `parseForgeJson(raw: unknown): ForgeJson`, `parseBundleJson(raw: unknown): BundleJson` — throw `ValidationError` on a malformed bundle
  - `BUNDLE_FILES = { forge: 'forge.json', data: 'data.sql', bundle: 'bundle.json' } as const`

- [ ] **Step 1: Write the failing tar test**

Create `lib/bundle/tar.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { writeTar, readTar, sha256Digest } from './tar';

describe('writeTar / readTar', () => {
  it('round-trips several entries, including one that does not fill a block', () => {
    const entries = [
      { name: 'forge.json', body: Buffer.from('{"name":"Second Set of Eyes"}', 'utf8') },
      { name: 'data.sql', body: Buffer.from('x'.repeat(1500), 'utf8') },
      { name: 'bundle.json', body: Buffer.from('{}', 'utf8') },
    ];

    const back = readTar(writeTar(entries));

    expect([...back.keys()].sort()).toEqual(['bundle.json', 'data.sql', 'forge.json']);
    expect(back.get('forge.json')!.toString('utf8')).toBe('{"name":"Second Set of Eyes"}');
    expect(back.get('data.sql')!.length).toBe(1500);
    expect(back.get('bundle.json')!.toString('utf8')).toBe('{}');
  });

  it('pads every entry to a 512-byte block and ends with two zero blocks', () => {
    const tar = writeTar([{ name: 'a.txt', body: Buffer.from('hi') }]);
    // one header + one padded body + two terminator blocks
    expect(tar.length).toBe(512 * 4);
    expect(tar.subarray(512 * 2).every((b) => b === 0)).toBe(true);
  });

  it('is deterministic: identical content yields an identical digest', () => {
    const make = () => writeTar([{ name: 'data.sql', body: Buffer.from('SELECT 1;') }]);
    expect(sha256Digest(make())).toBe(sha256Digest(make()));
  });

  it('round-trips an empty entry', () => {
    const back = readTar(writeTar([{ name: 'empty', body: Buffer.alloc(0) }]));
    expect(back.get('empty')!.length).toBe(0);
  });

  it('refuses a name longer than the 100-byte ustar field', () => {
    expect(() => writeTar([{ name: 'n'.repeat(101), body: Buffer.alloc(0) }])).toThrow(/too long/i);
  });

  it('sha256Digest returns a registry-shaped digest', () => {
    expect(sha256Digest(Buffer.from(''))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run lib/bundle/tar.test.ts`
Expected: FAIL — `Failed to resolve import "./tar"`.

- [ ] **Step 3: Implement the tar writer/reader**

Create `lib/bundle/tar.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * Minimal ustar packing for bundle layers (three small text files).
 *
 * Hand-rolled rather than pulled from npm: the repo has no tar dependency and
 * this needs ~80 lines. The output is a valid ustar stream, which is what makes
 * `docker pull` work on a bundle as a manual fallback (spec §1.2).
 *
 * mtime is pinned to 0 so re-cutting identical content yields an identical
 * digest — the digest is a guard (spec §5), so it must not drift with the clock.
 */

const BLOCK = 512;
const NAME_MAX = 100;

export type TarEntry = { name: string; body: Buffer };

/** Octal field: `width - 1` zero-padded digits plus a trailing NUL. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > NAME_MAX) {
    throw new Error(`tar entry name too long (>${NAME_MAX} bytes): ${name}`);
  }
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, NAME_MAX, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii'); // mode
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii'); // mtime — fixed, see above
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder: 8 spaces
  h.write('0', 156, 1, 'ascii'); // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (const byte of h) sum += byte;
  // Classic checksum encoding: 6 octal digits, NUL, space.
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e.name, e.body.length), e.body, padding(e.body.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return Buffer.concat(parts);
}

export function readTar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const h = buf.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break; // end-of-archive
    const name = h.subarray(0, NAME_MAX).toString('utf8').replace(/\0.*$/s, '');
    const sizeField = h.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = Number.parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`corrupt tar: bad size field for entry ${JSON.stringify(name)}`);
    }
    const start = offset + BLOCK;
    if (start + size > buf.length) {
      throw new Error(`corrupt tar: entry ${JSON.stringify(name)} runs past end of archive`);
    }
    out.set(name, Buffer.from(buf.subarray(start, start + size)));
    offset = start + size + padding(size).length;
  }
  return out;
}

/** Registry-shaped content digest: `sha256:<hex>`. */
export function sha256Digest(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}
```

- [ ] **Step 4: Run the tar test to verify it passes**

Run: `pnpm vitest run lib/bundle/tar.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing types test**

Create `lib/bundle/types.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ValidationError } from '@/lib/errors';
import { parseForgeJson, parseBundleJson, BUNDLE_FILES } from './types';

const forge = {
  name: 'Second Set of Eyes',
  displayName: 'Second Set of Eyes',
  description: 'Drawing review',
  slug: 'second-set-of-eyes',
  repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
  deployVersion: 'v1.0.0',
};

const bundle = {
  version: 'v1.0.0',
  sourceHost: 'pilot',
  cutAt: '2026-08-21T18:00:00.000Z',
  appImageDigest: 'sha256:' + 'a'.repeat(64),
  migrations: ['20260801120000_init'],
};

describe('parseForgeJson', () => {
  it('accepts a well-formed row and passes nullable fields through', () => {
    expect(parseForgeJson({ ...forge, description: null })).toMatchObject({
      slug: 'second-set-of-eyes',
      repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
      description: null,
    });
  });

  it('rejects a row missing repoFullName, which the Forge table requires', () => {
    const { repoFullName: _omitted, ...without } = forge;
    expect(() => parseForgeJson(without)).toThrow(ValidationError);
  });

  it('rejects a deployVersion that is not a semver tag', () => {
    expect(() => parseForgeJson({ ...forge, deployVersion: 'latest' })).toThrow(ValidationError);
  });
});

describe('parseBundleJson', () => {
  it('accepts a well-formed provenance record', () => {
    expect(parseBundleJson(bundle).appImageDigest).toBe('sha256:' + 'a'.repeat(64));
  });

  it('rejects an app image digest that is not sha256:<64 hex>', () => {
    expect(() => parseBundleJson({ ...bundle, appImageDigest: 'sha256:nope' })).toThrow(
      ValidationError,
    );
  });

  it('rejects a non-semver version', () => {
    expect(() => parseBundleJson({ ...bundle, version: '1.0.0' })).toThrow(ValidationError);
  });
});

describe('BUNDLE_FILES', () => {
  it('names the three files the spec defines', () => {
    expect(BUNDLE_FILES).toEqual({
      forge: 'forge.json',
      data: 'data.sql',
      bundle: 'bundle.json',
    });
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm vitest run lib/bundle/types.test.ts`
Expected: FAIL — `Failed to resolve import "./types"`.

- [ ] **Step 7: Implement the bundle shapes**

Create `lib/bundle/types.ts`:

```ts
import { z } from 'zod';
import { ValidationError } from '@/lib/errors';
import { parseVersion } from '@/lib/versioning/semver';

/** The three files in a bundle layer (spec §1). */
export const BUNDLE_FILES = {
  forge: 'forge.json',
  data: 'data.sql',
  bundle: 'bundle.json',
} as const;

const semverTag = z.string().refine((v) => parseVersion(v) !== null, {
  message: 'must be a vMAJOR.MINOR.PATCH tag',
});

const contentDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 hex>');

/**
 * The inventory row, as carried across the gap.
 *
 * `repoFullName` is here because `Forge.repoFullName` is NOT NULL UNIQUE and
 * prod cannot derive it — the owner is configuration, not a function of the
 * slug. `createdById` is deliberately NOT here: it is a FK into the *importing*
 * dashboard's users table, so the import sets it to the admin doing the import
 * rather than shipping a user across.
 */
export const forgeJsonSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  slug: z.string().min(1),
  repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"'),
  deployVersion: semverTag,
});

/**
 * Provenance and the one guard prod can check locally.
 *
 * `appImageDigest` is a guard (spec §5 version match). `sourceHost`, `cutAt`
 * and `migrations` are provenance only — see spec §1 for why the migration
 * fingerprint cannot be re-checked on import.
 */
export const bundleJsonSchema = z.object({
  version: semverTag,
  sourceHost: z.string().min(1),
  cutAt: z.string().min(1),
  appImageDigest: contentDigest,
  migrations: z.array(z.string()),
});

export type ForgeJson = z.infer<typeof forgeJsonSchema>;
export type BundleJson = z.infer<typeof bundleJsonSchema>;

export type BundleContents = {
  forge: ForgeJson;
  dataSql: string;
  bundle: BundleJson;
};

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, file: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `Bundle ${file} is malformed`,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }
  return parsed.data;
}

export function parseForgeJson(raw: unknown): ForgeJson {
  return parseOrThrow(forgeJsonSchema, raw, BUNDLE_FILES.forge);
}

export function parseBundleJson(raw: unknown): BundleJson {
  return parseOrThrow(bundleJsonSchema, raw, BUNDLE_FILES.bundle);
}
```

- [ ] **Step 8: Run the types test to verify it passes**

Run: `pnpm vitest run lib/bundle/types.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add lib/bundle/tar.ts lib/bundle/tar.test.ts lib/bundle/types.ts lib/bundle/types.test.ts
git commit -m "feat(bundle): ustar packing and the bundle file shapes"
```

---

### Task 2: Registry blob, manifest, and catalog surface

**Files:**
- Modify: `lib/registry/types.ts`
- Modify: `lib/registry/fake-client.ts`
- Modify: `lib/registry/fake-client.test.ts`
- Modify: `lib/registry/http-client.ts`

**Interfaces:**
- Consumes: `sha256Digest` from `lib/bundle/tar.ts` (Task 1).
- Produces, added to `interface RegistryClient`:
  - `putBlob(repo: string, bytes: Buffer): Promise<string>` — returns the `sha256:…` digest; idempotent when the blob is already present
  - `getBlob(repo: string, digest: string): Promise<Buffer>`
  - `putManifest(repo: string, tag: string, manifest: unknown): Promise<string>` — returns the manifest digest
  - `getManifest(repo: string, tag: string): Promise<{ body: string; digest: string }>`
  - `manifestDigest(repo: string, tag: string): Promise<string | null>` — `null` when the tag does not exist
  - `listRepositories(): Promise<string[]>`

The existing `tagManifest` and `listTags` are unchanged.

- [ ] **Step 1: Write the failing fake-client tests**

Append to `lib/registry/fake-client.test.ts`, inside the existing `describe('FakeRegistryClient', …)` block:

```ts
  it('putBlob returns a real sha256 digest and getBlob round-trips it', async () => {
    const bytes = Buffer.from('layer bytes');
    const digest = await reg.putBlob('sse-seed', bytes);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await reg.getBlob('sse-seed', digest)).equals(bytes)).toBe(true);
  });

  it('putBlob is idempotent for identical bytes', async () => {
    const a = await reg.putBlob('sse-seed', Buffer.from('same'));
    const b = await reg.putBlob('sse-seed', Buffer.from('same'));
    expect(a).toBe(b);
  });

  it('getBlob throws for an unknown digest', async () => {
    await expect(reg.getBlob('sse-seed', 'sha256:' + '0'.repeat(64))).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  it('blob stores are per-repo', async () => {
    const digest = await reg.putBlob('sse-seed', Buffer.from('x'));
    await expect(reg.getBlob('other-seed', digest)).rejects.toBeInstanceOf(RegistryError);
  });

  it('putManifest tags the manifest and reports its digest', async () => {
    const digest = await reg.putManifest('sse-seed', 'v1.0.0', { schemaVersion: 2 });
    expect(await reg.manifestDigest('sse-seed', 'v1.0.0')).toBe(digest);
    expect(await reg.listTags('sse-seed')).toEqual(['v1.0.0']);
    expect(JSON.parse((await reg.getManifest('sse-seed', 'v1.0.0')).body)).toEqual({
      schemaVersion: 2,
    });
  });

  it('manifestDigest is null for a tag that does not exist', async () => {
    expect(await reg.manifestDigest('sse-seed', 'v9.9.9')).toBeNull();
  });

  it('getManifest throws for a tag that does not exist', async () => {
    await expect(reg.getManifest('sse-seed', 'v9.9.9')).rejects.toBeInstanceOf(RegistryError);
  });

  it('listRepositories reports every repo touched by seedTag or putManifest', async () => {
    reg.seedTag('second-set-of-eyes', 'v1.0.0');
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', { schemaVersion: 2 });
    expect((await reg.listRepositories()).sort()).toEqual([
      'second-set-of-eyes',
      'second-set-of-eyes-seed',
    ]);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run lib/registry/fake-client.test.ts`
Expected: FAIL — `reg.putBlob is not a function`.

- [ ] **Step 3: Extend the interface**

In `lib/registry/types.ts`, add to `interface RegistryClient`, keeping the existing `tagManifest` / `listTags` and `RegistryError` exactly as they are:

```ts
  /**
   * Upload `bytes` as a blob in `repo` and return its `sha256:…` digest.
   * Idempotent: a blob already present is not re-uploaded.
   */
  putBlob(repo: string, bytes: Buffer): Promise<string>;

  /** Fetch a blob by digest. Throws RegistryError when absent. */
  getBlob(repo: string, digest: string): Promise<Buffer>;

  /** PUT `manifest` (serialised as JSON) under `tag`; returns its digest. */
  putManifest(repo: string, tag: string, manifest: unknown): Promise<string>;

  /** Fetch a manifest body plus its digest. Throws RegistryError when absent. */
  getManifest(repo: string, tag: string): Promise<{ body: string; digest: string }>;

  /**
   * The manifest digest currently under `tag`, or null when the tag is absent.
   * Distinct from listTags: this identifies the *build*, which is what the
   * first-release version-match guard compares against a bundle's record.
   */
  manifestDigest(repo: string, tag: string): Promise<string | null>;

  /** Every repository in the registry catalog (empty array when none). */
  listRepositories(): Promise<string[]>;
```

- [ ] **Step 4: Implement on the fake client**

Rewrite `lib/registry/fake-client.ts`:

```ts
import type { RegistryClient } from './types';
import { RegistryError } from './types';
import { sha256Digest } from '@/lib/bundle/tar';

export class FakeRegistryClient implements RegistryClient {
  // repo -> tag -> manifest digest
  private readonly repos = new Map<string, Map<string, string>>();
  // repo -> blob digest -> bytes
  private readonly blobs = new Map<string, Map<string, Buffer>>();
  // repo -> manifest digest -> body
  private readonly manifests = new Map<string, Map<string, string>>();

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

  async putBlob(repo: string, bytes: Buffer): Promise<string> {
    const digest = sha256Digest(bytes);
    const store = this.blobs.get(repo) ?? new Map<string, Buffer>();
    store.set(digest, Buffer.from(bytes));
    this.blobs.set(repo, store);
    return digest;
  }

  async getBlob(repo: string, digest: string): Promise<Buffer> {
    const found = this.blobs.get(repo)?.get(digest);
    if (!found) throw new RegistryError(`blob ${digest} not found in ${repo}`);
    return Buffer.from(found);
  }

  async putManifest(repo: string, tag: string, manifest: unknown): Promise<string> {
    const body = JSON.stringify(manifest);
    const digest = sha256Digest(Buffer.from(body, 'utf8'));
    const bodies = this.manifests.get(repo) ?? new Map<string, string>();
    bodies.set(digest, body);
    this.manifests.set(repo, bodies);
    this.seedTag(repo, tag, digest);
    return digest;
  }

  async getManifest(repo: string, tag: string): Promise<{ body: string; digest: string }> {
    const digest = this.repos.get(repo)?.get(tag);
    const body = digest ? this.manifests.get(repo)?.get(digest) : undefined;
    if (!digest || body === undefined) {
      throw new RegistryError(`manifest ${repo}:${tag} not found`);
    }
    return { body, digest };
  }

  async manifestDigest(repo: string, tag: string): Promise<string | null> {
    return this.repos.get(repo)?.get(tag) ?? null;
  }

  async listRepositories(): Promise<string[]> {
    return [...new Set([...this.repos.keys(), ...this.manifests.keys(), ...this.blobs.keys()])];
  }
}
```

- [ ] **Step 5: Run the fake-client test to verify it passes**

Run: `pnpm vitest run lib/registry/fake-client.test.ts`
Expected: PASS (11 tests — the 3 original plus 8 new).

- [ ] **Step 6: Implement on the HTTP client**

In `lib/registry/http-client.ts`, add `import { sha256Digest } from '@/lib/bundle/tar';` at the top and append these methods to `HttpRegistryClient`:

```ts
  async putBlob(repo: string, bytes: Buffer): Promise<string> {
    const digest = sha256Digest(bytes);

    // Already there? Registries dedupe by digest, so skip the upload.
    const head = await fetch(`${this.base}/${repo}/blobs/${digest}`, {
      method: 'HEAD',
      headers: { Authorization: this.auth },
    });
    if (head.ok) return digest;

    const start = await fetch(`${this.base}/${repo}/blobs/uploads/`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Length': '0' },
    });
    if (start.status !== 202) {
      throw new RegistryError(`POST blobs/uploads ${repo} → ${start.status}`);
    }
    const location = start.headers.get('location');
    if (!location) {
      throw new RegistryError(`POST blobs/uploads ${repo} returned no Location header`);
    }
    // Location may be absolute or root-relative; resolve either against /v2/.
    const url = new URL(location, `${this.base}/`);
    url.searchParams.set('digest', digest);

    const put = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: this.auth, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    if (put.status !== 201) {
      throw new RegistryError(`PUT blob ${repo} ${digest} → ${put.status}`);
    }
    return digest;
  }

  async getBlob(repo: string, digest: string): Promise<Buffer> {
    const res = await fetch(`${this.base}/${repo}/blobs/${digest}`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) throw new RegistryError(`GET blob ${repo} ${digest} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async putManifest(repo: string, tag: string, manifest: unknown): Promise<string> {
    const body = JSON.stringify(manifest);
    const res = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
      method: 'PUT',
      headers: {
        Authorization: this.auth,
        'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
      },
      body,
    });
    if (!res.ok) throw new RegistryError(`PUT manifest ${repo}:${tag} → ${res.status}`);
    // Trust the registry's digest when it supplies one; fall back to our own.
    return res.headers.get('docker-content-digest') ?? sha256Digest(Buffer.from(body, 'utf8'));
  }

  async getManifest(repo: string, tag: string): Promise<{ body: string; digest: string }> {
    const res = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
      headers: { Authorization: this.auth, Accept: MANIFEST_ACCEPT },
    });
    if (!res.ok) throw new RegistryError(`GET manifest ${repo}:${tag} → ${res.status}`);
    const body = await res.text();
    const digest =
      res.headers.get('docker-content-digest') ?? sha256Digest(Buffer.from(body, 'utf8'));
    return { body, digest };
  }

  async manifestDigest(repo: string, tag: string): Promise<string | null> {
    const res = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
      method: 'HEAD',
      headers: { Authorization: this.auth, Accept: MANIFEST_ACCEPT },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new RegistryError(`HEAD manifest ${repo}:${tag} → ${res.status}`);
    const digest = res.headers.get('docker-content-digest');
    if (!digest) {
      throw new RegistryError(`HEAD manifest ${repo}:${tag} returned no Docker-Content-Digest`);
    }
    return digest;
  }

  async listRepositories(): Promise<string[]> {
    const res = await fetch(`${this.base}/_catalog?n=1000`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) throw new RegistryError(`GET _catalog → ${res.status}`);
    const json = (await res.json()) as { repositories?: string[] | null };
    return json.repositories ?? [];
  }
```

- [ ] **Step 7: Verify the whole registry suite and typecheck**

Run: `pnpm vitest run lib/registry && pnpm typecheck && pnpm lint`
Expected: PASS; no type errors — the interface and both implementations agree.

- [ ] **Step 8: Commit**

```bash
git add lib/registry
git commit -m "feat(registry): blob, manifest, digest and catalog operations"
```

---

### Task 3: Push and pull a bundle over the registry

**Files:**
- Create: `lib/bundle/registry-bundle.ts`
- Create: `lib/bundle/registry-bundle.test.ts`

**Interfaces:**
- Consumes: `writeTar`, `readTar`, `sha256Digest`, `BUNDLE_FILES`, `parseForgeJson`, `parseBundleJson`, `BundleContents` (Task 1); `RegistryClient` with blob/manifest methods (Task 2).
- Produces:
  - `seedRepo(slug: string): string` — `` `${slug}-seed` ``
  - `slugFromSeedRepo(repo: string): string | null` — inverse; `null` when `repo` is not a seed repo
  - `pushBundle(registry: RegistryClient, slug: string, contents: BundleContents): Promise<{ repo: string; tag: string; manifestDigest: string }>`
  - `pullBundle(registry: RegistryClient, slug: string, tag: string): Promise<{ contents: BundleContents; manifestDigest: string }>` — throws `ValidationError` when the layer digest does not match the manifest (spec §5 bundle integrity)

- [ ] **Step 1: Write the failing test**

Create `lib/bundle/registry-bundle.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { ValidationError } from '@/lib/errors';
import type { BundleContents } from './types';
import { pushBundle, pullBundle, seedRepo, slugFromSeedRepo } from './registry-bundle';

const contents: BundleContents = {
  forge: {
    name: 'Second Set of Eyes',
    displayName: 'Second Set of Eyes',
    description: 'Drawing review',
    slug: 'second-set-of-eyes',
    repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
    deployVersion: 'v1.0.0',
  },
  dataSql: 'CREATE TABLE "ReviewDocument" (id text primary key);\n',
  bundle: {
    version: 'v1.0.0',
    sourceHost: 'pilot',
    cutAt: '2026-08-21T18:00:00.000Z',
    appImageDigest: 'sha256:' + 'a'.repeat(64),
    migrations: ['20260801120000_init'],
  },
};

describe('seedRepo / slugFromSeedRepo', () => {
  it('derives the seed repo from a slug and back again', () => {
    expect(seedRepo('second-set-of-eyes')).toBe('second-set-of-eyes-seed');
    expect(slugFromSeedRepo('second-set-of-eyes-seed')).toBe('second-set-of-eyes');
  });

  it('returns null for a repo that is not a seed repo', () => {
    expect(slugFromSeedRepo('second-set-of-eyes')).toBeNull();
  });
});

describe('pushBundle / pullBundle', () => {
  let reg: FakeRegistryClient;
  beforeEach(() => { reg = new FakeRegistryClient(); });

  it('round-trips a bundle through the registry', async () => {
    const pushed = await pushBundle(reg, 'second-set-of-eyes', contents);
    expect(pushed).toMatchObject({ repo: 'second-set-of-eyes-seed', tag: 'v1.0.0' });

    const { contents: back, manifestDigest } = await pullBundle(
      reg, 'second-set-of-eyes', 'v1.0.0',
    );
    expect(manifestDigest).toBe(pushed.manifestDigest);
    expect(back).toEqual(contents);
  });

  it('publishes a manifest a registry client would recognise', async () => {
    await pushBundle(reg, 'second-set-of-eyes', contents);
    const { body } = await reg.getManifest('second-set-of-eyes-seed', 'v1.0.0');
    const manifest = JSON.parse(body);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.mediaType).toBe('application/vnd.oci.image.manifest.v1+json');
    expect(manifest.layers).toHaveLength(1);
    expect(manifest.layers[0].mediaType).toBe('application/vnd.oci.image.layer.v1.tar+gzip');
    expect(manifest.layers[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.config.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('re-pushing the same content is stable (same manifest digest)', async () => {
    const a = await pushBundle(reg, 'second-set-of-eyes', contents);
    const b = await pushBundle(reg, 'second-set-of-eyes', contents);
    expect(b.manifestDigest).toBe(a.manifestDigest);
  });

  it('rejects a layer whose bytes do not match the digest the manifest claims', async () => {
    await pushBundle(reg, 'second-set-of-eyes', contents);
    // Corrupt the layer: repoint the manifest at a blob of other bytes.
    const { body } = await reg.getManifest('second-set-of-eyes-seed', 'v1.0.0');
    const manifest = JSON.parse(body);
    const otherDigest = await reg.putBlob(
      'second-set-of-eyes-seed', Buffer.from('not a gzipped tar'),
    );
    manifest.layers[0].digest = otherDigest;
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', manifest);

    await expect(pullBundle(reg, 'second-set-of-eyes', 'v1.0.0')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a bundle missing one of the three files', async () => {
    const { writeTar } = await import('./tar');
    const { gzipSync } = await import('node:zlib');
    const layer = gzipSync(writeTar([{ name: 'data.sql', body: Buffer.from('SELECT 1;') }]), {
      level: 9, mtime: 0,
    });
    const layerDigest = await reg.putBlob('second-set-of-eyes-seed', layer);
    const configDigest = await reg.putBlob('second-set-of-eyes-seed', Buffer.from('{}'));
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configDigest,
        size: 2,
      },
      layers: [{
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: layerDigest,
        size: layer.length,
      }],
    });

    await expect(pullBundle(reg, 'second-set-of-eyes', 'v1.0.0')).rejects.toThrow(/forge\.json/);
  });

  it('rejects a manifest with no layers', async () => {
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      layers: [],
    });
    await expect(pullBundle(reg, 'second-set-of-eyes', 'v1.0.0')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run lib/bundle/registry-bundle.test.ts`
Expected: FAIL — `Failed to resolve import "./registry-bundle"`.

- [ ] **Step 3: Implement push/pull**

Create `lib/bundle/registry-bundle.ts`:

```ts
import { gzipSync, gunzipSync } from 'node:zlib';
import { ValidationError } from '@/lib/errors';
import type { RegistryClient } from '@/lib/registry/types';
import { writeTar, readTar, sha256Digest } from './tar';
import {
  BUNDLE_FILES,
  parseBundleJson,
  parseForgeJson,
  type BundleContents,
} from './types';

const SEED_SUFFIX = '-seed';
const LAYER_MEDIA_TYPE = 'application/vnd.oci.image.layer.v1.tar+gzip';
const CONFIG_MEDIA_TYPE = 'application/vnd.oci.image.config.v1+json';
const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';

/** A bundle lives in its own repo so its lifecycle is independent (spec §1.1). */
export function seedRepo(slug: string): string {
  return `${slug}${SEED_SUFFIX}`;
}

export function slugFromSeedRepo(repo: string): string | null {
  return repo.endsWith(SEED_SUFFIX) ? repo.slice(0, -SEED_SUFFIX.length) : null;
}

type OciManifest = {
  schemaVersion: number;
  mediaType: string;
  config: { mediaType: string; digest: string; size: number };
  layers: { mediaType: string; digest: string; size: number }[];
};

function packLayer(contents: BundleContents): { tar: Buffer; layer: Buffer } {
  const tar = writeTar([
    { name: BUNDLE_FILES.forge, body: Buffer.from(JSON.stringify(contents.forge, null, 2), 'utf8') },
    { name: BUNDLE_FILES.data, body: Buffer.from(contents.dataSql, 'utf8') },
    { name: BUNDLE_FILES.bundle, body: Buffer.from(JSON.stringify(contents.bundle, null, 2), 'utf8') },
  ]);
  // mtime: 0 keeps the gzip envelope byte-stable, like the tar inside it.
  return { tar, layer: gzipSync(tar, { level: 9, mtime: 0 }) };
}

/**
 * Push a bundle as an ordinary OCI image: one gzipped tar layer plus a minimal
 * config blob. Re-cutting identical content produces an identical manifest
 * digest, because both the tar and the gzip envelope are deterministic.
 */
export async function pushBundle(
  registry: RegistryClient,
  slug: string,
  contents: BundleContents,
): Promise<{ repo: string; tag: string; manifestDigest: string }> {
  const repo = seedRepo(slug);
  const tag = contents.bundle.version;
  const { tar, layer } = packLayer(contents);

  const config = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: {},
      rootfs: { type: 'layers', diff_ids: [sha256Digest(tar)] },
    }),
    'utf8',
  );

  const [configDigest, layerDigest] = await Promise.all([
    registry.putBlob(repo, config),
    registry.putBlob(repo, layer),
  ]);

  const manifest: OciManifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: { mediaType: CONFIG_MEDIA_TYPE, digest: configDigest, size: config.length },
    layers: [{ mediaType: LAYER_MEDIA_TYPE, digest: layerDigest, size: layer.length }],
  };

  const manifestDigest = await registry.putManifest(repo, tag, manifest);
  return { repo, tag, manifestDigest };
}

/**
 * Pull and verify a bundle. Verification is the spec §5 integrity guard: the
 * layer bytes are re-digested and compared with what the manifest claims, so a
 * truncated or swapped blob is refused rather than half-restored.
 */
export async function pullBundle(
  registry: RegistryClient,
  slug: string,
  tag: string,
): Promise<{ contents: BundleContents; manifestDigest: string }> {
  const repo = seedRepo(slug);
  const { body, digest: manifestDigest } = await registry.getManifest(repo, tag);

  let manifest: OciManifest;
  try {
    manifest = JSON.parse(body) as OciManifest;
  } catch {
    throw new ValidationError(`Bundle ${repo}:${tag} has an unparseable manifest`, {});
  }

  const descriptor = manifest.layers?.[0];
  if (!descriptor) {
    throw new ValidationError(`Bundle ${repo}:${tag} has no layers`, {});
  }

  const layer = await registry.getBlob(repo, descriptor.digest);
  const actual = sha256Digest(layer);
  if (actual !== descriptor.digest) {
    throw new ValidationError(
      `Bundle ${repo}:${tag} failed its integrity check: layer is ${actual}, ` +
        `manifest claims ${descriptor.digest}`,
      {},
    );
  }

  let files: Map<string, Buffer>;
  try {
    files = readTar(gunzipSync(layer));
  } catch (err) {
    throw new ValidationError(
      `Bundle ${repo}:${tag} layer is not a gzipped tar: ` +
        (err instanceof Error ? err.message : String(err)),
      {},
    );
  }

  for (const file of Object.values(BUNDLE_FILES)) {
    if (!files.has(file)) {
      throw new ValidationError(`Bundle ${repo}:${tag} is missing ${file}`, {});
    }
  }

  const json = (name: string): unknown => {
    try {
      return JSON.parse(files.get(name)!.toString('utf8'));
    } catch {
      throw new ValidationError(`Bundle ${repo}:${tag} has unparseable ${name}`, {});
    }
  };

  return {
    manifestDigest,
    contents: {
      forge: parseForgeJson(json(BUNDLE_FILES.forge)),
      dataSql: files.get(BUNDLE_FILES.data)!.toString('utf8'),
      bundle: parseBundleJson(json(BUNDLE_FILES.bundle)),
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/bundle/registry-bundle.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add lib/bundle/registry-bundle.ts lib/bundle/registry-bundle.test.ts
git commit -m "feat(bundle): push and pull a verified bundle over the registry"
```

---

### Task 4: Dump, restore, and read a forge database

**Files:**
- Create: `lib/db/dump.ts`
- Create: `lib/db/dump.test.ts`
- Modify: `lib/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `env` from `lib/env.ts`.
- Produces:
  - `type PgExecDeps = { spawnFn?: typeof import('node:child_process').spawn }`
  - `dumpForgeDatabase(opts: { dbName: string }, deps?: PgExecDeps): Promise<string>` — plain-format SQL text
  - `restoreForgeDatabase(opts: { dbName: string; role: string; password: string; sql: string }, deps?: PgExecDeps): Promise<void>`
  - `readAppliedMigrations(dbName: string): Promise<string[] | null>` — `null` when the database does not exist
  - `readSeedMarker(dbName: string): Promise<{ bundleDigest: string; version: string } | null>`
  - `seedMarkerSql(bundleDigest: string, version: string): string`
  - `env.PG_CONTAINER` — new, defaults to `crystal-forge-pg`

- [ ] **Step 1: Add the container env var**

In `lib/env.ts`, inside `baseSchema`, directly after the `HARNESS_PG_PASSWORD` line:

```ts
  // Name of the shared Postgres container. Dump/restore run `docker exec` into
  // it (see lib/db/dump.ts), matching scripts/pg-backup.sh's PG_CONTAINER.
  PG_CONTAINER: z.string().default('crystal-forge-pg'),
```

In `.env.example`, after the `HARNESS_PG_PASSWORD` line:

```
PG_CONTAINER="crystal-forge-pg"
```

- [ ] **Step 2: Write the failing unit tests**

Create `lib/db/dump.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dumpForgeDatabase, restoreForgeDatabase, seedMarkerSql } from './dump';

/** A spawn stub that records argv and drives a scripted child process. */
function fakeSpawn(script: { stdout?: string; stderr?: string; exitCode?: number }): {
  spawnFn: never;
  calls: { cmd: string; args: string[] }[];
  stdin: () => string;
} {
  const calls: { cmd: string; args: string[] }[] = [];
  let written = '';
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { written += d.toString('utf8'); });
    setImmediate(() => {
      if (script.stdout) child.stdout.write(script.stdout);
      if (script.stderr) child.stderr.write(script.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', script.exitCode ?? 0);
    });
    return child;
  }) as never;
  return { spawnFn, calls, stdin: () => written };
}

describe('dumpForgeDatabase', () => {
  it('runs pg_dump in the pg container with --no-owner --no-privileges', async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: 'CREATE TABLE x();\n' });
    const sql = await dumpForgeDatabase({ dbName: 'second_set_of_eyes' }, { spawnFn });

    expect(sql).toBe('CREATE TABLE x();\n');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('docker');
    expect(calls[0].args).toEqual([
      'exec', '-i', 'crystal-forge-pg',
      'pg_dump', '-U', 'crystal', '--no-owner', '--no-privileges',
      '-d', 'second_set_of_eyes',
    ]);
  });

  it('keeps stderr out of the dump text', async () => {
    const { spawnFn } = fakeSpawn({
      stdout: 'CREATE TABLE x();\n',
      stderr: 'pg_dump: warning: something\n',
    });
    const sql = await dumpForgeDatabase({ dbName: 'sse' }, { spawnFn });
    expect(sql).not.toMatch(/warning/);
  });

  it('rejects when pg_dump exits non-zero, quoting stderr', async () => {
    const { spawnFn } = fakeSpawn({ stderr: 'database "nope" does not exist', exitCode: 1 });
    await expect(dumpForgeDatabase({ dbName: 'nope' }, { spawnFn })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects an empty dump rather than shipping a bundle with no data', async () => {
    const { spawnFn } = fakeSpawn({ stdout: '' });
    await expect(dumpForgeDatabase({ dbName: 'sse' }, { spawnFn })).rejects.toThrow(/empty/i);
  });

  it('refuses an unsafe database name', async () => {
    const { spawnFn } = fakeSpawn({ stdout: 'x' });
    await expect(
      dumpForgeDatabase({ dbName: 'sse"; DROP DATABASE x' }, { spawnFn }),
    ).rejects.toThrow(/unsafe/i);
  });
});

describe('restoreForgeDatabase', () => {
  it('runs psql as the app role in one transaction, SQL on stdin', async () => {
    const { spawnFn, calls, stdin } = fakeSpawn({});
    await restoreForgeDatabase(
      { dbName: 'sse', role: 'sse_app', password: 'deadbeef', sql: 'SELECT 1;' },
      { spawnFn },
    );

    expect(calls[0].args).toEqual([
      'exec', '-i', '-e', 'PGPASSWORD=deadbeef', 'crystal-forge-pg',
      'psql', '-h', 'localhost', '-p', '5432', '-U', 'sse_app', '-d', 'sse',
      '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ]);
    expect(stdin()).toBe('SELECT 1;');
  });

  it('rejects when psql exits non-zero so the caller knows nothing landed', async () => {
    const { spawnFn } = fakeSpawn({ stderr: 'ERROR:  relation already exists', exitCode: 3 });
    await expect(
      restoreForgeDatabase(
        { dbName: 'sse', role: 'sse_app', password: 'deadbeef', sql: 'x' },
        { spawnFn },
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses a password outside the safe hex charset', async () => {
    const { spawnFn } = fakeSpawn({});
    await expect(
      restoreForgeDatabase(
        { dbName: 'sse', role: 'sse_app', password: "x'; rm -rf /", sql: 'x' },
        { spawnFn },
      ),
    ).rejects.toThrow(/hex/i);
  });
});

describe('seedMarkerSql', () => {
  it('creates the marker table unconditionally so a re-import aborts the transaction', () => {
    const sql = seedMarkerSql('sha256:' + 'a'.repeat(64), 'v1.0.0');
    expect(sql).toMatch(/CREATE TABLE _forge_seed/);
    expect(sql).not.toMatch(/IF NOT EXISTS/);
    expect(sql).toMatch(/INSERT INTO _forge_seed/);
    expect(sql).toContain('a'.repeat(64));
    expect(sql).toContain('v1.0.0');
  });

  it('refuses values outside the shapes it can safely inline', () => {
    expect(() => seedMarkerSql("sha256:'; DROP TABLE x; --", 'v1.0.0')).toThrow();
    expect(() => seedMarkerSql('sha256:' + 'a'.repeat(64), "v1'; DROP")).toThrow();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run lib/db/dump.test.ts`
Expected: FAIL — `Failed to resolve import "./dump"`.

- [ ] **Step 4: Implement the dump/restore helpers**

Create `lib/db/dump.ts`:

```ts
import { spawn as nodeSpawn } from 'node:child_process';
import { Client } from 'pg';
import { env } from '@/lib/env';

/**
 * Dump and restore for per-forge databases.
 *
 * These shell out to `docker exec` directly rather than going through
 * ContainerManager (spec §1.3): that abstraction is for forge containers, and
 * its exec surfaces only *combined* stdout/stderr — which would corrupt a dump
 * the moment pg_dump emitted a warning. Here stdout and stderr stay separate.
 *
 * The house pattern is scripts/pg-backup.sh: run the client binaries inside the
 * Postgres container. Dumping uses the container's trust socket as the
 * superuser; restoring connects over TCP as the *app role* (spec §1.3), because
 * provisionRole grants no privileges on tables the role did not create.
 */

const SAFE_DBNAME = /^[a-z0-9_]+$/;
const SAFE_HEX = /^[a-f0-9]+$/;
const SAFE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_VERSION = /^v\d+\.\d+\.\d+$/;

export type PgExecDeps = { spawnFn?: typeof nodeSpawn };

function assertSafeDbName(name: string): void {
  if (!SAFE_DBNAME.test(name)) {
    throw new Error(`Refusing to use unsafe database name: ${JSON.stringify(name)}`);
  }
}

type ExecResult = { stdout: Buffer; stderr: string; exitCode: number };

function exec(spawnFn: typeof nodeSpawn, args: string[], stdin?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawnFn('docker', args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout?.on('data', (d: Buffer) => out.push(Buffer.from(d)));
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) =>
      resolve({ stdout: Buffer.concat(out), stderr: err, exitCode: code ?? -1 }),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** Plain-format dump of one forge database, as the container superuser. */
export async function dumpForgeDatabase(
  opts: { dbName: string },
  deps: PgExecDeps = {},
): Promise<string> {
  assertSafeDbName(opts.dbName);
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const res = await exec(spawnFn, [
    'exec', '-i', env.PG_CONTAINER,
    'pg_dump', '-U', env.HARNESS_PG_USER, '--no-owner', '--no-privileges',
    '-d', opts.dbName,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(`pg_dump ${opts.dbName} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  if (res.stdout.length === 0) {
    throw new Error(`pg_dump ${opts.dbName} produced an empty dump`);
  }
  return res.stdout.toString('utf8');
}

/**
 * Restore SQL into a forge database as the app role, atomically.
 *
 * `--single-transaction -v ON_ERROR_STOP=1` is what makes the import atomic
 * (spec §6): the data and the marker land together or the database is left
 * untouched and the action is retryable.
 */
export async function restoreForgeDatabase(
  opts: { dbName: string; role: string; password: string; sql: string },
  deps: PgExecDeps = {},
): Promise<void> {
  assertSafeDbName(opts.dbName);
  assertSafeDbName(opts.role);
  if (!SAFE_HEX.test(opts.password)) {
    throw new Error('Refusing to use a password outside the safe hex charset');
  }
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const res = await exec(
    spawnFn,
    [
      'exec', '-i', '-e', `PGPASSWORD=${opts.password}`, env.PG_CONTAINER,
      'psql', '-h', 'localhost', '-p', '5432', '-U', opts.role, '-d', opts.dbName,
      '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ],
    opts.sql,
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `psql restore into ${opts.dbName} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
    );
  }
}

/**
 * The marker rows appended to the restore stream (spec §4).
 *
 * `CREATE TABLE` is deliberately NOT `IF NOT EXISTS`: on a second import the
 * statement fails, ON_ERROR_STOP aborts the single transaction, and the
 * once-only guard holds even against two admins clicking at the same moment.
 */
export function seedMarkerSql(bundleDigest: string, version: string): string {
  if (!SAFE_DIGEST.test(bundleDigest)) {
    throw new Error(`Refusing to record unsafe bundle digest: ${JSON.stringify(bundleDigest)}`);
  }
  if (!SAFE_VERSION.test(version)) {
    throw new Error(`Refusing to record unsafe version: ${JSON.stringify(version)}`);
  }
  return [
    'CREATE TABLE _forge_seed (',
    '  bundle_digest text PRIMARY KEY,',
    '  version       text        NOT NULL,',
    '  applied_at    timestamptz NOT NULL DEFAULT now()',
    ');',
    `INSERT INTO _forge_seed (bundle_digest, version) VALUES ('${bundleDigest}', '${version}');`,
    '',
  ].join('\n');
}

/** Superuser connection string for one database on the shared engine. */
function adminUrl(database: string): string {
  const url = new URL('postgres://placeholder/postgres');
  url.username = encodeURIComponent(env.HARNESS_PG_USER);
  url.password = encodeURIComponent(env.HARNESS_PG_PASSWORD);
  url.hostname = env.HARNESS_PG_HOST;
  url.port = String(env.HARNESS_PG_PORT);
  url.pathname = `/${database}`;
  return url.toString();
}

async function queryForgeDb<T>(
  dbName: string,
  fn: (client: Client) => Promise<T>,
): Promise<T | null> {
  assertSafeDbName(dbName);
  const client = new Client({ connectionString: adminUrl(dbName) });
  try {
    await client.connect();
  } catch (err) {
    // No such database yet — the caller treats this as "nothing applied".
    if (/does not exist/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Migration names recorded in the forge database, or null when the database
 * does not exist. Read as the superuser: this powers the migration-parity guard
 * (spec §2), which runs on pilot where no per-forge role login is needed.
 */
export async function readAppliedMigrations(dbName: string): Promise<string[] | null> {
  return queryForgeDb(dbName, async (client) => {
    const exists = await client.query<{ present: string | null }>(
      "SELECT to_regclass('public._prisma_migrations')::text AS present",
    );
    if (!exists.rows[0]?.present) return [];
    const res = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ' +
        'ORDER BY migration_name',
    );
    return res.rows.map((r) => r.migration_name);
  });
}

/** The seed marker, or null when the database or the table is absent. */
export async function readSeedMarker(
  dbName: string,
): Promise<{ bundleDigest: string; version: string } | null> {
  const found = await queryForgeDb(dbName, async (client) => {
    const exists = await client.query<{ present: string | null }>(
      "SELECT to_regclass('public._forge_seed')::text AS present",
    );
    if (!exists.rows[0]?.present) return null;
    const res = await client.query<{ bundle_digest: string; version: string }>(
      'SELECT bundle_digest, version FROM _forge_seed ORDER BY applied_at LIMIT 1',
    );
    const row = res.rows[0];
    return row ? { bundleDigest: row.bundle_digest, version: row.version } : null;
  });
  return found ?? null;
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm vitest run lib/db/dump.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Add the restore integration test**

Append to `lib/db/dump.test.ts`. This runs against the real `_test` Postgres the vitest harness already provisions, and asserts the §8 requirement that the app role owns and can write the restored tables. Add the extra imports at the top of the file alongside the existing ones:

```ts
import { beforeEach, afterEach } from 'vitest';
import { Client } from 'pg';
import { PgDatabaseProvisioner } from './pg-provisioner';
import { readAppliedMigrations, readSeedMarker } from './dump';
```

then append:

```ts
describe('restoreForgeDatabase (integration)', () => {
  const DB = '_test_bundle_restore';
  const ROLE = '_test_bundle_restore_app';
  const PASSWORD = 'abcdef0123456789abcdef01';
  let provisioner: PgDatabaseProvisioner;

  function pgConfig() {
    const url = new URL(process.env.DATABASE_URL!);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  /** Connect to `database` as the superuser. */
  async function asAdmin<T>(database: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }

  beforeEach(async () => {
    // dump.ts reads env.HARNESS_PG_* / env.PG_CONTAINER; point them at the test
    // server, which is the same container on the same host port.
    const cfg = pgConfig();
    process.env.HARNESS_PG_HOST = cfg.host;
    process.env.HARNESS_PG_PORT = String(cfg.port);
    process.env.HARNESS_PG_USER = cfg.user;
    process.env.HARNESS_PG_PASSWORD = cfg.password;

    provisioner = new PgDatabaseProvisioner(cfg);
    await provisioner.dropDatabase(DB);
    await provisioner.dropRole(ROLE);
    await provisioner.createDatabase(DB);
    await provisioner.provisionRole(DB, ROLE);
    await provisioner.setRolePassword(ROLE, PASSWORD);
  });

  afterEach(async () => {
    await provisioner.dropDatabase(DB);
    await provisioner.dropRole(ROLE);
  });

  it('restores as the app role, which then owns and can write the tables', async () => {
    const sql =
      'CREATE TABLE "ReviewDocument" (id text PRIMARY KEY, name text NOT NULL);\n' +
      "INSERT INTO \"ReviewDocument\" (id, name) VALUES ('doc-1', 'A1.pdf');\n" +
      'CREATE TABLE _prisma_migrations (migration_name text PRIMARY KEY, finished_at timestamptz);\n' +
      "INSERT INTO _prisma_migrations VALUES ('20260801120000_init', now());\n";

    await restoreForgeDatabase({
      dbName: DB, role: ROLE, password: PASSWORD,
      sql: sql + seedMarkerSql('sha256:' + 'b'.repeat(64), 'v1.0.0'),
    });

    const owners = await asAdmin(DB, (c) =>
      c.query<{ tablename: string; tableowner: string }>(
        "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
      ),
    );
    expect(owners.rows.length).toBeGreaterThan(0);
    expect(owners.rows.every((r) => r.tableowner === ROLE)).toBe(true);

    // The role can ALTER its own tables — what a later migration needs.
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${DB}`;
    url.username = ROLE;
    url.password = PASSWORD;
    const asRole = new Client({ connectionString: url.toString() });
    await asRole.connect();
    try {
      await asRole.query('ALTER TABLE "ReviewDocument" ADD COLUMN relative_path text');
      const rows = await asRole.query('SELECT id FROM "ReviewDocument"');
      expect(rows.rows).toEqual([{ id: 'doc-1' }]);
    } finally {
      await asRole.end();
    }

    expect(await readAppliedMigrations(DB)).toEqual(['20260801120000_init']);
    expect(await readSeedMarker(DB)).toEqual({
      bundleDigest: 'sha256:' + 'b'.repeat(64),
      version: 'v1.0.0',
    });
  });

  it('leaves the database untouched when any statement fails', async () => {
    await expect(
      restoreForgeDatabase({
        dbName: DB, role: ROLE, password: PASSWORD,
        sql: 'CREATE TABLE ok (id int);\nTHIS IS NOT SQL;\n',
      }),
    ).rejects.toThrow();

    const tables = await asAdmin(DB, (c) =>
      c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"),
    );
    expect(tables.rows).toEqual([]);
  });

  it('a second restore of the marker aborts the whole transaction', async () => {
    const marker = seedMarkerSql('sha256:' + 'c'.repeat(64), 'v1.0.0');
    await restoreForgeDatabase({ dbName: DB, role: ROLE, password: PASSWORD, sql: marker });

    await expect(
      restoreForgeDatabase({
        dbName: DB, role: ROLE, password: PASSWORD,
        sql: 'CREATE TABLE second_import (id int);\n' + marker,
      }),
    ).rejects.toThrow(/already exists/i);

    const tables = await asAdmin(DB, (c) =>
      c.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' " +
          "AND tablename = 'second_import'",
      ),
    );
    expect(tables.rows).toEqual([]);
  });

  it('readAppliedMigrations is null for a database that does not exist', async () => {
    expect(await readAppliedMigrations('_test_bundle_absent')).toBeNull();
  });
});
```

- [ ] **Step 7: Run the integration tests**

Run: `pnpm vitest run lib/db/dump.test.ts`
Expected: PASS (14 tests). These need Docker up with `crystal-forge-pg` running — if `pnpm test` normally passes on this machine, that is already true.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add lib/db/dump.ts lib/db/dump.test.ts lib/env.ts .env.example
git commit -m "feat(db): dump, restore-as-app-role, and seed-marker helpers"
```

---

### Task 5: List a repo directory at a sha

**Files:**
- Modify: `lib/github/types.ts`
- Modify: `lib/github/octokit-client.ts`
- Modify: `lib/github/fake-client.ts`
- Modify: `lib/github/fake-client.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces, added to `interface GitHubClient`:
  - `listDirectoryAtRef(fullName: string, path: string, ref: string): Promise<string[]>` — entry names (not paths), empty array when the directory does not exist at that ref
- Also on `FakeGitHubClient`: `seedDirectory(fullName: string, ref: string, path: string, names: string[]): void`

- [ ] **Step 1: Write the failing fake-client test**

Append to `lib/github/fake-client.test.ts` a new top-level block:

```ts
describe('listDirectoryAtRef', () => {
  it('returns the seeded entry names for a path at a ref', async () => {
    const gh = new FakeGitHubClient();
    gh.seedDirectory('owner/sse', 'abc123', 'prisma/migrations', [
      '20260801120000_init',
      '20260815090000_add_review_document',
    ]);
    expect(await gh.listDirectoryAtRef('owner/sse', 'prisma/migrations', 'abc123')).toEqual([
      '20260801120000_init',
      '20260815090000_add_review_document',
    ]);
  });

  it('returns an empty array for a path that does not exist at that ref', async () => {
    const gh = new FakeGitHubClient();
    gh.seedDirectory('owner/sse', 'abc123', 'prisma/migrations', ['20260801120000_init']);
    expect(await gh.listDirectoryAtRef('owner/sse', 'prisma/migrations', 'other-sha')).toEqual([]);
    expect(await gh.listDirectoryAtRef('owner/sse', 'nope', 'abc123')).toEqual([]);
  });
});
```

If the existing file constructs `FakeGitHubClient` with arguments or via a helper, mirror that construction instead of the bare `new FakeGitHubClient()`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run lib/github/fake-client.test.ts`
Expected: FAIL — `gh.seedDirectory is not a function`.

- [ ] **Step 3: Add the interface method**

In `lib/github/types.ts`, add to `interface GitHubClient`, after `getRefCheckResults`:

```ts
  /**
   * Entry names (not full paths) of a directory at an exact ref. Empty array
   * when the path does not exist there — callers treat "no migrations
   * directory" as "no migrations", not as an error.
   *
   * Used by the first-release migration-parity guard, which compares a forge
   * database's applied migrations against the repo at the released sha.
   */
  listDirectoryAtRef(fullName: string, path: string, ref: string): Promise<string[]>;
```

- [ ] **Step 4: Implement on the fake client**

In `lib/github/fake-client.ts`, add to `FakeGitHubClient`:

```ts
  // `${fullName}@${ref}:${path}` -> entry names
  private readonly directories = new Map<string, string[]>();

  seedDirectory(fullName: string, ref: string, path: string, names: string[]): void {
    this.directories.set(`${fullName}@${ref}:${path}`, [...names]);
  }

  async listDirectoryAtRef(fullName: string, path: string, ref: string): Promise<string[]> {
    return this.directories.get(`${fullName}@${ref}:${path}`) ?? [];
  }
```

- [ ] **Step 5: Implement on the octokit client**

In `lib/github/octokit-client.ts`, add to `OctokitGitHubClient`, mirroring how the private `fetchFileSha` uses `repos.getContent` and `isStatus`:

```ts
  async listDirectoryAtRef(fullName: string, path: string, ref: string): Promise<string[]> {
    const [owner, repo] = parseFullName(fullName);
    try {
      const { data } = await this.client.repos.getContent({ owner, repo, path, ref });
      // A directory comes back as an array. A file at this path is not a
      // directory listing, so report empty rather than guessing.
      if (!Array.isArray(data)) return [];
      return data.map((entry) => entry.name);
    } catch (err: unknown) {
      if (isStatus(err, 404)) return [];
      throw err;
    }
  }
```

- [ ] **Step 6: Run the github suite and typecheck**

Run: `pnpm vitest run lib/github && pnpm typecheck`
Expected: PASS; no type errors — both clients implement the new method.

- [ ] **Step 7: Commit**

```bash
pnpm lint
git add lib/github
git commit -m "feat(github): list a repo directory at an exact ref"
```

---

### Task 6: Cut a bundle on the pilot

**Files:**
- Create: `lib/services/first-release.ts`
- Create: `lib/services/first-release.test.ts`

**Interfaces:**
- Consumes: `pushBundle`, `seedRepo` (Task 3); `dumpForgeDatabase`, `readAppliedMigrations` (Task 4); `listDirectoryAtRef` (Task 5); `slugifyForgeName`, `slugToDbName` (`lib/github/slug.ts`); `isProdMode` (`lib/mode.ts`).
- Produces:
  - `type FirstReleaseCandidate = { promotionId: string; forgeId: string; forgeName: string; slug: string; version: string; headSha: string; decidedAt: string; bundleTags: string[] }`
  - `listFirstReleaseCandidates(currentUser: SessionUser, registry?: RegistryClient): Promise<FirstReleaseCandidate[]>`
  - `type CutDeps = { registry?: RegistryClient; github?: GitHubClient; dump?: (opts: { dbName: string }) => Promise<string>; readMigrations?: (dbName: string) => Promise<string[] | null> }`
  - `type CutResult = { repo: string; tag: string; manifestDigest: string; migrations: string[]; bytes: number }`
  - `cutBundle(currentUser: SessionUser, promotionId: string, deps?: CutDeps): Promise<CutResult>`

- [ ] **Step 1: Write the failing test**

Create `lib/services/first-release.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { pullBundle } from '@/lib/bundle/registry-bundle';
import { cutBundle, listFirstReleaseCandidates } from './first-release';

const APP_DIGEST = 'sha256:' + 'a'.repeat(64);

beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'dev'; });
afterEach(() => { delete process.env.FORGE_DASHBOARD_MODE; });

const dumpOk = async () => 'CREATE TABLE "ReviewDocument" (id text primary key);\n';
const migrationsOk = async () => ['20260801120000_init'];

/** A forge with one accepted promotion, and the app image tag it released. */
async function acceptedRelease(
  prisma: Parameters<Parameters<typeof withCleanDb>[0]>[0],
  reg: FakeRegistryClient,
  opts: { adminId: string; name?: string; version?: string; headSha?: string; seedImage?: boolean },
) {
  const name = opts.name ?? 'Second Set of Eyes';
  const version = opts.version ?? 'v1.0.0';
  const headSha = opts.headSha ?? 'abc123';
  const forge = await makeForge(prisma, { name, createdById: opts.adminId });
  const promotion = await prisma.promotionRequest.create({
    data: {
      forgeId: forge.id, requestedById: opts.adminId, prNumber: 7,
      prUrl: 'https://github.test/pr/7', headSha, bumpLevel: 'major',
      targetVersion: version, status: 'accepted', decidedAt: new Date(),
    },
  });
  if (opts.seedImage !== false) reg.seedTag('second-set-of-eyes', version, APP_DIGEST);
  return { forge, promotion, version, headSha };
}

describe('listFirstReleaseCandidates', () => {
  it('lists a forge with exactly one accepted promotion', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const { forge } = await acceptedRelease(prisma, reg, { adminId: admin.id });

      const rows = await listFirstReleaseCandidates(admin, reg);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        forgeId: forge.id, slug: 'second-set-of-eyes', version: 'v1.0.0', bundleTags: [],
      });
    });
  });

  it('reports bundles already cut so the UI can say so', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      await acceptedRelease(prisma, reg, { adminId: admin.id });
      reg.seedTag('second-set-of-eyes-seed', 'v1.0.0');

      const rows = await listFirstReleaseCandidates(admin, reg);
      expect(rows[0].bundleTags).toEqual(['v1.0.0']);
    });
  });

  it('omits a forge past its first release', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const { forge } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      await prisma.promotionRequest.create({
        data: {
          forgeId: forge.id, requestedById: admin.id, prNumber: 8,
          prUrl: 'https://github.test/pr/8', headSha: 'def456', bumpLevel: 'patch',
          targetVersion: 'v1.0.1', status: 'accepted', decidedAt: new Date(),
        },
      });

      expect(await listFirstReleaseCandidates(admin, reg)).toEqual([]);
    });
  });

  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'D', role: 'DEVELOPER' });
      await expect(
        listFirstReleaseCandidates(dev, new FakeRegistryClient()),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('cutBundle', () => {
  it('pushes a bundle that pulls back with the forge row and the dump', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient();
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', [
        '20260801120000_init', '20260815090000_later',
      ]);

      const result = await cutBundle(admin, promotion.id, {
        registry: reg, github: gh, dump: dumpOk, readMigrations: migrationsOk,
      });

      expect(result).toMatchObject({ repo: 'second-set-of-eyes-seed', tag: 'v1.0.0' });
      expect(result.migrations).toEqual(['20260801120000_init']);

      const { contents } = await pullBundle(reg, 'second-set-of-eyes', 'v1.0.0');
      expect(contents.forge).toMatchObject({
        name: 'Second Set of Eyes',
        slug: 'second-set-of-eyes',
        repoFullName: forge.repoFullName,
        deployVersion: 'v1.0.0',
      });
      expect(contents.dataSql).toMatch(/ReviewDocument/);
      expect(contents.bundle).toMatchObject({
        version: 'v1.0.0', appImageDigest: APP_DIGEST, migrations: ['20260801120000_init'],
      });
    });
  });

  it('refuses when the forge has more than one accepted promotion', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient();
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);
      await prisma.promotionRequest.create({
        data: {
          forgeId: forge.id, requestedById: admin.id, prNumber: 9,
          prUrl: 'https://github.test/pr/9', headSha: 'def456', bumpLevel: 'patch',
          targetVersion: 'v1.0.1', status: 'accepted', decidedAt: new Date(),
        },
      });

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toThrow(/first release/i);
    });
  });

  it('refuses when the database carries a migration the release does not have', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient();
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      // The repo at the released sha has only the first migration...
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk,
          // ...but dev's database has moved on.
          readMigrations: async () => ['20260801120000_init', '20260820000000_dev_only'],
        }),
      ).rejects.toThrow(/20260820000000_dev_only/);
    });
  });

  it('refuses when the forge database does not exist on this host', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient();
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk, readMigrations: async () => null,
        }),
      ).rejects.toThrow(/does not exist/i);
    });
  });

  it('refuses when the promotion is not accepted', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const forge = await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });
      const promotion = await prisma.promotionRequest.create({
        data: {
          forgeId: forge.id, requestedById: admin.id, prNumber: 7,
          prUrl: 'https://github.test/pr/7', headSha: 'abc123', bumpLevel: 'major',
          targetVersion: 'v1.0.0', status: 'awaiting_approval',
        },
      });

      await expect(
        cutBundle(admin, promotion.id, {
          registry: new FakeRegistryClient(), github: new FakeGitHubClient(),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('refuses when the released app image tag is missing from the registry', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient();
      const { forge, promotion } = await acceptedRelease(prisma, reg, {
        adminId: admin.id, seedImage: false,
      });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toThrow(/v1\.0\.0/);
    });
  });

  it('refuses in prod mode — cutting is a pilot action', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'prod';
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const { promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: new FakeGitHubClient(),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('refuses an unknown promotion', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      await expect(
        cutBundle(admin, '00000000-0000-0000-0000-000000000000', {
          registry: new FakeRegistryClient(), github: new FakeGitHubClient(),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'D', role: 'DEVELOPER' });
      const reg = new FakeRegistryClient();
      const { promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });

      await expect(
        cutBundle(dev, promotion.id, {
          registry: reg, github: new FakeGitHubClient(),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run lib/services/first-release.test.ts`
Expected: FAIL — `Failed to resolve import "./first-release"`.

- [ ] **Step 3: Implement the cut half of the service**

Create `lib/services/first-release.ts`:

```ts
import { hostname } from 'node:os';
import { prisma } from '@/lib/prisma';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { isProdMode } from '@/lib/mode';
import { slugifyForgeName, slugToDbName } from '@/lib/github/slug';
import { getRegistryClient } from '@/lib/registry/client';
import type { RegistryClient } from '@/lib/registry/types';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/types';
import { dumpForgeDatabase, readAppliedMigrations } from '@/lib/db/dump';
import { pushBundle, seedRepo } from '@/lib/bundle/registry-bundle';
import type { BundleContents } from '@/lib/bundle/types';
import type { SessionUser } from './types';

const MIGRATIONS_DIR = 'prisma/migrations';

function assertAdmin(user: SessionUser): void {
  if (!user.isAdmin) throw new ForbiddenError('Admin only');
}

/** Cutting reads the pilot's dev database and repo; prod can do neither. */
function assertPilot(): void {
  if (isProdMode()) {
    throw new ForbiddenError('Bundles are cut on the pilot dashboard, not in production');
  }
}

export type FirstReleaseCandidate = {
  promotionId: string;
  forgeId: string;
  forgeName: string;
  slug: string;
  version: string;
  headSha: string;
  decidedAt: string;
  /** Seed tags already in the registry — a cut is a re-cut when this is non-empty. */
  bundleTags: string[];
};

/**
 * Forges at exactly one accepted promotion — the definition of "first release"
 * (spec §2), and already a fact in `promotion_requests`.
 *
 * Kept separate from `listPendingPromotions`, which filters to ACTIVE statuses
 * and therefore can never show an accepted one.
 */
export async function listFirstReleaseCandidates(
  currentUser: SessionUser,
  registry: RegistryClient = getRegistryClient(),
): Promise<FirstReleaseCandidate[]> {
  assertAdmin(currentUser);
  const accepted = await prisma.promotionRequest.findMany({
    where: { status: 'accepted' },
    include: { forge: { select: { id: true, name: true } } },
    orderBy: { decidedAt: 'desc' },
  });

  const countByForge = new Map<string, number>();
  for (const row of accepted) {
    countByForge.set(row.forgeId, (countByForge.get(row.forgeId) ?? 0) + 1);
  }

  const firsts = accepted.filter((row) => countByForge.get(row.forgeId) === 1);
  return Promise.all(
    firsts.map(async (row) => {
      const slug = slugifyForgeName(row.forge.name);
      let bundleTags: string[] = [];
      try {
        bundleTags = await registry.listTags(seedRepo(slug));
      } catch (err) {
        // A registry blip must not hide the candidate; it only hides the hint.
        console.error('[first-release] listTags failed for %s: %s', seedRepo(slug), err);
      }
      return {
        promotionId: row.id,
        forgeId: row.forgeId,
        forgeName: row.forge.name,
        slug,
        version: row.targetVersion,
        headSha: row.headSha,
        decidedAt: (row.decidedAt ?? row.updatedAt).toISOString(),
        bundleTags,
      };
    }),
  );
}

export type CutDeps = {
  registry?: RegistryClient;
  github?: GitHubClient;
  dump?: (opts: { dbName: string }) => Promise<string>;
  readMigrations?: (dbName: string) => Promise<string[] | null>;
};

export type CutResult = {
  repo: string;
  tag: string;
  manifestDigest: string;
  migrations: string[];
  bytes: number;
};

/**
 * Dump the forge database, pack it with the inventory row and provenance, and
 * push it to `<slug>-seed:<version>` (spec §2).
 *
 * Re-cutting overwrites the tag. Pilot cannot know whether prod has consumed a
 * bundle already, so the once-only guard lives on prod (spec §5).
 */
export async function cutBundle(
  currentUser: SessionUser,
  promotionId: string,
  deps: CutDeps = {},
): Promise<CutResult> {
  assertAdmin(currentUser);
  assertPilot();

  const registry = deps.registry ?? getRegistryClient();
  const github = deps.github ?? getGitHubClient();
  const dump = deps.dump ?? ((opts: { dbName: string }) => dumpForgeDatabase(opts));
  const readMigrations = deps.readMigrations ?? readAppliedMigrations;

  const promotion = await prisma.promotionRequest.findUnique({
    where: { id: promotionId },
    include: { forge: true },
  });
  if (!promotion) throw new NotFoundError('promotion', promotionId);
  if (promotion.status !== 'accepted') {
    throw new ValidationError(
      `Promotion ${promotionId} is not accepted (status ${promotion.status}); a bundle can ` +
        'only be cut from a released promotion',
      {},
    );
  }

  // First release only: exactly one accepted promotion for this forge.
  const acceptedCount = await prisma.promotionRequest.count({
    where: { forgeId: promotion.forgeId, status: 'accepted' },
  });
  if (acceptedCount !== 1) {
    throw new ValidationError(
      `${promotion.forge.name} has ${acceptedCount} accepted releases; a bundle is a ` +
        'first release mechanism only. Move the data by hand, or design an ongoing sync.',
      {},
    );
  }

  const forge = promotion.forge;
  const slug = slugifyForgeName(forge.name);
  const dbName = slugToDbName(slug);
  const version = promotion.targetVersion;

  // The app image this bundle seeds. Its digest pins not just the version but
  // the specific build (spec §5 version match).
  const appImageDigest = await registry.manifestDigest(slug, version);
  if (!appImageDigest) {
    throw new ValidationError(
      `No app image ${slug}:${version} in the registry; release the promotion before ` +
        'cutting its bundle',
      {},
    );
  }

  // Migration parity (spec §2): the database's applied migrations must be a
  // subset of the repo's at the released sha. Only pilot can check this — it is
  // the only side that can see both.
  const applied = await readMigrations(dbName);
  if (applied === null) {
    throw new ValidationError(
      `Database ${dbName} does not exist on this host; nothing to bundle`,
      {},
    );
  }
  const inRepo = new Set(
    await github.listDirectoryAtRef(forge.repoFullName, MIGRATIONS_DIR, promotion.headSha),
  );
  const ahead = applied.filter((m) => !inRepo.has(m));
  if (ahead.length > 0) {
    throw new ValidationError(
      `${forge.name}'s database has migrations the released commit does not: ` +
        `${ahead.join(', ')}. Dev has moved past ${version}, so this data's schema is ahead ` +
        'of the image. Release the newer schema first.',
      { migrations: ahead },
    );
  }

  const dataSql = await dump({ dbName });

  const contents: BundleContents = {
    forge: {
      name: forge.name,
      displayName: forge.displayName,
      description: forge.description,
      slug,
      repoFullName: forge.repoFullName,
      deployVersion: version,
    },
    dataSql,
    bundle: {
      version,
      sourceHost: hostname(),
      cutAt: new Date().toISOString(),
      appImageDigest,
      migrations: applied,
    },
  };

  const pushed = await pushBundle(registry, slug, contents);
  return { ...pushed, migrations: applied, bytes: Buffer.byteLength(dataSql, 'utf8') };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/services/first-release.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add lib/services/first-release.ts lib/services/first-release.test.ts
git commit -m "feat(first-release): cut a bundle from an accepted first promotion"
```

---

### Task 7: Import a bundle on prod

**Files:**
- Modify: `lib/services/first-release.ts`
- Modify: `lib/services/first-release.test.ts`

**Interfaces:**
- Consumes: `pullBundle`, `slugFromSeedRepo`, `seedRepo` (Task 3); `restoreForgeDatabase`, `readSeedMarker`, `seedMarkerSql` (Task 4); `getDatabaseProvisioner` / `DatabaseProvisioner` (`lib/db/provisioner.ts`, `lib/db/types.ts`); `dbNameToRole` (`lib/github/slug.ts`); `parseVersion` (`lib/versioning/semver.ts`).
- Produces:
  - `type BundleCandidate = { slug: string; repo: string; versions: string[] }`
  - `listBundleCandidates(currentUser: SessionUser, registry?: RegistryClient): Promise<BundleCandidate[]>`
  - `type ImportDeps = { registry?: RegistryClient; provisioner?: DatabaseProvisioner; restore?: (opts: { dbName: string; role: string; password: string; sql: string }) => Promise<void>; readMarker?: (dbName: string) => Promise<{ bundleDigest: string; version: string } | null>; randomPassword?: () => string }`
  - `type ImportResult = { forgeId: string; slug: string; version: string; bundleDigest: string; deployEnabled: boolean }`
  - `importBundle(currentUser: SessionUser, slug: string, version: string, deps?: ImportDeps): Promise<ImportResult>`

- [ ] **Step 1: Write the failing test**

Append to `lib/services/first-release.test.ts`, adding these imports alongside the existing ones at the top of the file:

```ts
import { FakeDatabaseProvisioner } from '@/lib/db/fake-provisioner';
import { pushBundle } from '@/lib/bundle/registry-bundle';
import type { BundleContents } from '@/lib/bundle/types';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { listBundleCandidates, importBundle, type ImportDeps } from './first-release';
```

then append:

```ts
const bundleContents = (over: Partial<BundleContents['bundle']> = {}): BundleContents => ({
  forge: {
    name: 'Second Set of Eyes',
    displayName: 'Second Set of Eyes',
    description: 'Drawing review',
    slug: 'second-set-of-eyes',
    repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
    deployVersion: 'v1.0.0',
  },
  dataSql: 'CREATE TABLE "ReviewDocument" (id text primary key);\n',
  bundle: {
    version: 'v1.0.0',
    sourceHost: 'pilot',
    cutAt: '2026-08-21T18:00:00.000Z',
    appImageDigest: APP_DIGEST,
    migrations: ['20260801120000_init'],
    ...over,
  },
});

/** A prod-mode registry holding the app image and a matching bundle. */
async function seededProdRegistry(contents = bundleContents()): Promise<FakeRegistryClient> {
  const reg = new FakeRegistryClient();
  reg.seedTag('second-set-of-eyes', contents.bundle.version, contents.bundle.appImageDigest);
  await pushBundle(reg, 'second-set-of-eyes', contents);
  return reg;
}

describe('listBundleCandidates', () => {
  beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'prod'; });

  it('lists seed repos prod has no forge row for', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();

      expect(await listBundleCandidates(admin, reg)).toEqual([
        { slug: 'second-set-of-eyes', repo: 'second-set-of-eyes-seed', versions: ['v1.0.0'] },
      ]);
    });
  });

  it('omits a forge prod already knows about', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });
      const reg = await seededProdRegistry();

      expect(await listBundleCandidates(admin, reg)).toEqual([]);
    });
  });

  it('ignores repos that are not seed repos', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      reg.seedTag('crystal-lattice', 'v1.0.2');

      const rows = await listBundleCandidates(admin, reg);
      expect(rows.map((r) => r.slug)).toEqual(['second-set-of-eyes']);
    });
  });

  it('degrades to empty when the registry catalog is unreachable', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const broken = {
        listRepositories: async () => { throw new Error('connect ECONNREFUSED'); },
      } as unknown as FakeRegistryClient;

      expect(await listBundleCandidates(admin, broken)).toEqual([]);
    });
  });

  it('refuses in dev mode — importing is a prod action', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'dev';
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      await expect(listBundleCandidates(admin, reg)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('importBundle', () => {
  beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'prod'; });

  /** Default import deps: nothing touches a real database. */
  function importDeps(over: Partial<ImportDeps> = {}) {
    const restored: { sql: string; dbName: string; role: string }[] = [];
    const deps: ImportDeps = {
      provisioner: new FakeDatabaseProvisioner(),
      restore: async (o) => { restored.push({ sql: o.sql, dbName: o.dbName, role: o.role }); },
      readMarker: async () => null,
      randomPassword: () => 'abcdef0123456789',
      ...over,
    };
    return { deps, restored };
  }

  it('creates the forge row, restores, and only then enables it', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps, restored } = importDeps();

      const result = await importBundle(admin, 'second-set-of-eyes', 'v1.0.0', {
        registry: reg, ...deps,
      });

      expect(result).toMatchObject({
        slug: 'second-set-of-eyes', version: 'v1.0.0', deployEnabled: true,
      });

      const row = await prisma.forge.findUniqueOrThrow({ where: { id: result.forgeId } });
      expect(row).toMatchObject({
        name: 'Second Set of Eyes',
        repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
        deployEnabled: true,
        deployVersion: 'v1.0.0',
        createdById: admin.id, // the importing admin, not a user from the bundle
      });

      // Data and marker went in as one stream, marker last.
      expect(restored).toHaveLength(1);
      expect(restored[0].dbName).toBe('second_set_of_eyes');
      expect(restored[0].role).toBe('second_set_of_eyes_app');
      expect(restored[0].sql).toMatch(/ReviewDocument[\s\S]*CREATE TABLE _forge_seed/);
      expect(restored[0].sql).toContain(result.bundleDigest);
    });
  });

  it('provisions the database, role, and password before restoring', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const inner = new FakeDatabaseProvisioner();
      const order: string[] = [];
      const provisioner: DatabaseProvisioner = {
        createDatabase: async (n) => { order.push(`create:${n}`); await inner.createDatabase(n); },
        provisionRole: async (d, r) => { order.push(`role:${r}`); await inner.provisionRole(d, r); },
        setRolePassword: async (r, p) => { order.push('password'); await inner.setRolePassword(r, p); },
        dropDatabase: (n) => inner.dropDatabase(n),
        dropRole: (r) => inner.dropRole(r),
        hardenDatabase: (n) => inner.hardenDatabase(n),
      };
      const { deps } = importDeps({
        provisioner,
        restore: async () => { order.push('restore'); },
      });

      await importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps });

      expect(order).toEqual([
        'create:second_set_of_eyes', 'role:second_set_of_eyes_app', 'password', 'restore',
      ]);
    });
  });

  it('tolerates an already-existing database', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const provisioner = new FakeDatabaseProvisioner();
      await provisioner.createDatabase('second_set_of_eyes');
      const { deps } = importDeps({ provisioner });

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).resolves.toMatchObject({ deployEnabled: true });
    });
  });

  it('refuses a bundle cut for a different build of the same version', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      // The registry's v1.0.0 is one build; the bundle records another.
      reg.seedTag('second-set-of-eyes', 'v1.0.0', 'sha256:' + 'a'.repeat(64));
      await pushBundle(
        reg, 'second-set-of-eyes',
        bundleContents({ appImageDigest: 'sha256:' + 'b'.repeat(64) }),
      );
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/different build/i);
    });
  });

  it('refuses a bundle for a version with no app image at all', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      await pushBundle(reg, 'second-set-of-eyes', bundleContents());
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/no app image/i);
    });
  });

  it('refuses when the marker says the database was already seeded', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps({
        readMarker: async () => ({ bundleDigest: 'sha256:' + 'c'.repeat(64), version: 'v1.0.0' }),
      });

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/already seeded/i);
    });
  });

  it('refuses when prod already has the forge row', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/already known/i);
    });
  });

  it('leaves the forge disabled when the restore fails', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps({
        restore: async () => { throw new Error('psql restore into second_set_of_eyes failed'); },
      });

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/psql restore/);

      const row = await prisma.forge.findUniqueOrThrow({
        where: { name: 'Second Set of Eyes' },
      });
      expect(row.deployEnabled).toBe(false);
      expect(row.deployVersion).toBeNull();
    });
  });

  it('refuses a version that is not a semver tag', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'latest', { registry: reg, ...deps }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'D', role: 'DEVELOPER' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(dev, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('refuses in dev mode', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'dev';
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('the ordering invariant (spec §8)', () => {
  beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'prod'; });

  it('listDesiredForges never returns the forge before the restore has finished', async () => {
    await withCleanDb(async (prisma) => {
      const { listDesiredForges } = await import('@/lib/runtime/prod/desired-state');
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();

      const seen: number[] = [];
      const probe = async () => { seen.push((await listDesiredForges(prisma)).length); };

      await importBundle(admin, 'second-set-of-eyes', 'v1.0.0', {
        registry: reg,
        provisioner: new FakeDatabaseProvisioner(),
        readMarker: async () => { await probe(); return null; },
        // The reconciler must not see the forge at any point up to and
        // including the restore — deployEnabled flips only after it returns.
        restore: async () => { await probe(); },
        randomPassword: () => 'abcdef0123456789',
      });

      expect(seen).toEqual([0, 0]);
      expect(await listDesiredForges(prisma)).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run lib/services/first-release.test.ts`
Expected: FAIL — `listBundleCandidates is not a function`.

- [ ] **Step 3: Extend the imports in the service**

At the top of `lib/services/first-release.ts`, add:

```ts
import { randomBytes } from 'node:crypto';
import { dbNameToRole } from '@/lib/github/slug';
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { restoreForgeDatabase, readSeedMarker, seedMarkerSql } from '@/lib/db/dump';
import { pullBundle, slugFromSeedRepo } from '@/lib/bundle/registry-bundle';
import { parseVersion } from '@/lib/versioning/semver';
```

`slugifyForgeName`, `slugToDbName`, `seedRepo`, `pushBundle`, `prisma`, and the error classes are already imported from Task 6.

- [ ] **Step 4: Implement the import half**

Append to `lib/services/first-release.ts`:

```ts
/** Importing writes prod's inventory and provisions prod's databases. */
function assertProd(): void {
  if (!isProdMode()) {
    throw new ForbiddenError('Bundles are imported on the production dashboard, not the pilot');
  }
}

export type BundleCandidate = {
  slug: string;
  repo: string;
  versions: string[];
};

/**
 * Un-imported bundles, discovered from the registry catalog (spec §3.1).
 *
 * The catalog is the only possible source: prod has no `Forge` row for a forge
 * it has never imported, so its own database cannot name one.
 *
 * A registry outage degrades to an empty list rather than an error — the
 * existing inventory table and status must stay unaffected (spec §6).
 */
export async function listBundleCandidates(
  currentUser: SessionUser,
  registry: RegistryClient = getRegistryClient(),
): Promise<BundleCandidate[]> {
  assertAdmin(currentUser);
  assertProd();

  let repos: string[];
  try {
    repos = await registry.listRepositories();
  } catch (err) {
    console.error('[first-release] registry catalog unavailable: %s', err);
    return [];
  }

  const known = new Set(
    (await prisma.forge.findMany({ select: { name: true } })).map((f) => slugifyForgeName(f.name)),
  );

  const candidates: BundleCandidate[] = [];
  for (const repo of repos) {
    const slug = slugFromSeedRepo(repo);
    if (!slug || known.has(slug)) continue;
    try {
      const versions = (await registry.listTags(repo)).filter((t) => parseVersion(t) !== null);
      if (versions.length > 0) candidates.push({ slug, repo, versions });
    } catch (err) {
      console.error('[first-release] listTags failed for %s: %s', repo, err);
    }
  }
  return candidates.sort((a, b) => a.slug.localeCompare(b.slug));
}

export type ImportDeps = {
  registry?: RegistryClient;
  provisioner?: DatabaseProvisioner;
  restore?: (opts: {
    dbName: string; role: string; password: string; sql: string;
  }) => Promise<void>;
  readMarker?: (dbName: string) => Promise<{ bundleDigest: string; version: string } | null>;
  randomPassword?: () => string;
};

export type ImportResult = {
  forgeId: string;
  slug: string;
  version: string;
  bundleDigest: string;
  deployEnabled: boolean;
};

/**
 * Apply a bundle (spec §3.2). The step order is what keeps the reconciler out
 * of the way: `listDesiredForges` returns only `deployEnabled: true` rows with a
 * non-null `deployVersion`, so the forge is invisible to it until step 6.
 *
 *   1. Pull and verify the bundle; check the marker.
 *   2. Write the Forge row with deployEnabled: false.
 *   3. createDatabase (idempotent) -> provisionRole -> setRolePassword.
 *   4. Restore data.sql as the app role...
 *   5. ...with the marker insert in the same transaction.
 *   6. Set deployEnabled: true and deployVersion — the handoff.
 */
export async function importBundle(
  currentUser: SessionUser,
  slug: string,
  version: string,
  deps: ImportDeps = {},
): Promise<ImportResult> {
  assertAdmin(currentUser);
  assertProd();

  const registry = deps.registry ?? getRegistryClient();
  const provisioner = deps.provisioner ?? getDatabaseProvisioner();
  const restore = deps.restore ?? ((o: Parameters<typeof restoreForgeDatabase>[0]) =>
    restoreForgeDatabase(o));
  const readMarker = deps.readMarker ?? readSeedMarker;
  const randomPassword = deps.randomPassword ?? (() => randomBytes(24).toString('hex'));

  if (parseVersion(version) === null) {
    throw new ValidationError(`${version} is not a vMAJOR.MINOR.PATCH tag`, {});
  }

  const dbName = slugToDbName(slug);
  const role = dbNameToRole(dbName);

  // --- Step 1: pull + verify ------------------------------------------------
  const { contents, manifestDigest } = await pullBundle(registry, slug, version);
  if (contents.bundle.version !== version) {
    throw new ValidationError(
      `Bundle ${seedRepo(slug)}:${version} declares version ${contents.bundle.version}`,
      {},
    );
  }

  // Version match: the bundle must seed a build prod can actually run.
  const appDigest = await registry.manifestDigest(slug, version);
  if (!appDigest) {
    throw new ValidationError(
      `No app image ${slug}:${version} in the registry — prod cannot run the version this ` +
        'bundle seeds',
      {},
    );
  }
  if (appDigest !== contents.bundle.appImageDigest) {
    throw new ValidationError(
      `Bundle ${seedRepo(slug)}:${version} was cut for a different build of ${version} ` +
        `(bundle records ${contents.bundle.appImageDigest}, registry has ${appDigest}). ` +
        'Re-cut the bundle against the image now tagged.',
      {},
    );
  }

  // Already known: prod having the row means this is not a first release.
  const existing = await prisma.forge.findUnique({ where: { name: contents.forge.name } });
  if (existing) {
    throw new ValidationError(
      `${contents.forge.name} is already known to this dashboard; a bundle is a ` +
        'first-release mechanism only',
      {},
    );
  }

  // Already imported: a readable refusal. The unconditional CREATE TABLE in
  // seedMarkerSql is the race-proof version of this same check.
  const marker = await readMarker(dbName);
  if (marker) {
    throw new ValidationError(
      `Database ${dbName} was already seeded (${marker.version}, bundle ` +
        `${marker.bundleDigest}). Re-seeding means dropping the database by hand.`,
      {},
    );
  }

  // --- Step 2: inventory row, deliberately disabled ------------------------
  const forge = await prisma.forge.create({
    data: {
      name: contents.forge.name,
      displayName: contents.forge.displayName,
      description: contents.forge.description,
      repoFullName: contents.forge.repoFullName,
      // The bundle carries no users. Attribute the row to the admin importing
      // it: createdById is a FK into *this* dashboard's users table.
      createdById: currentUser.id,
      deployEnabled: false,
      deployVersion: null,
    },
  });

  // --- Step 3: database, role, password ------------------------------------
  const password = randomPassword();
  try {
    await provisioner.createDatabase(dbName);
  } catch (err) {
    if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  await provisioner.provisionRole(dbName, role);
  await provisioner.setRolePassword(role, password);

  // --- Steps 4+5: data and marker, one transaction -------------------------
  await restore({
    dbName,
    role,
    password,
    sql: contents.dataSql + '\n' + seedMarkerSql(manifestDigest, version),
  });

  // --- Step 6: hand off to the reconciler ---------------------------------
  await prisma.forge.update({
    where: { id: forge.id },
    data: { deployEnabled: true, deployVersion: version },
  });

  return { forgeId: forge.id, slug, version, bundleDigest: manifestDigest, deployEnabled: true };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run lib/services/first-release.test.ts`
Expected: PASS (30 tests — Task 6's 13 plus 17 here).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add lib/services/first-release.ts lib/services/first-release.test.ts
git commit -m "feat(first-release): discover and import a bundle on prod"
```

---

### Task 8: API routes

**Files:**
- Create: `lib/services/first-release-schema.ts`
- Create: `app/api/promotions/first-release-candidates/route.ts`
- Create: `app/api/promotions/[id]/bundle/route.ts`
- Create: `app/api/deployments/bundles/route.ts`
- Create: `app/api/deployments/bundles/[slug]/import/route.ts`

**Interfaces:**
- Consumes: everything from Tasks 6 and 7; `auth` (`@/lib/auth`), `devOnlyRouteGuard` / `prodOnlyRouteGuard` (`@/lib/mode`), `respondToServiceError` (`@/lib/http`).
- Produces:
  - `GET /api/promotions/first-release-candidates` → `{ candidates: FirstReleaseCandidate[] }`
  - `POST /api/promotions/[id]/bundle` → `{ bundle: CutResult }`
  - `GET /api/deployments/bundles` → `{ candidates: BundleCandidate[] }`
  - `POST /api/deployments/bundles/[slug]/import` with body `{ version: string }` → `{ imported: ImportResult }`
  - `importBundleInput` — zod schema

- [ ] **Step 1: Write the request schema**

Create `lib/services/first-release-schema.ts`:

```ts
import { z } from 'zod';

export const importBundleInput = z.object({
  version: z.string().min(1),
});
```

- [ ] **Step 2: Write the pilot routes**

Create `app/api/promotions/first-release-candidates/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listFirstReleaseCandidates } from '@/lib/services/first-release';
import { devOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function GET() {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ candidates: await listFirstReleaseCandidates(session.user) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

Create `app/api/promotions/[id]/bundle/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { cutBundle } from '@/lib/services/first-release';
import { devOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/promotions/[id]/bundle'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ bundle: await cutBundle(session.user, id) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 3: Write the prod routes**

Create `app/api/deployments/bundles/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listBundleCandidates } from '@/lib/services/first-release';
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
    return NextResponse.json({ candidates: await listBundleCandidates(session.user) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

Create `app/api/deployments/bundles/[slug]/import/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { importBundle } from '@/lib/services/first-release';
import { importBundleInput } from '@/lib/services/first-release-schema';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/deployments/bundles/[slug]/import'>,
) {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { slug } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = importBundleInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const imported = await importBundle(session.user, slug, parsed.data.version);
    return NextResponse.json({ imported });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 4: Verify the routes typecheck**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. `RouteContext<'…'>` is Next 16's generated route-param type — a wrong path string fails typecheck with "not assignable to parameter of type", which is the check that all four route paths are correct.

- [ ] **Step 5: Commit**

```bash
git add lib/services/first-release-schema.ts \
  app/api/promotions/first-release-candidates \
  "app/api/promotions/[id]/bundle" \
  app/api/deployments/bundles
git commit -m "feat(api): cut and import routes for first-release bundles"
```

---

### Task 9: Pilot UI — cut a bundle from the promotions page

**Files:**
- Create: `app/(app)/admin/promotions/FirstReleaseSection.tsx`
- Create: `app/(app)/admin/promotions/FirstReleaseSection.test.tsx`
- Modify: `app/(app)/admin/promotions/PromotionsClient.tsx`

**Interfaces:**
- Consumes: `GET /api/promotions/first-release-candidates`, `POST /api/promotions/[id]/bundle` (Task 8); `FirstReleaseCandidate` (Task 6).
- Produces: named export `FirstReleaseSection`, taking no props, mounted by `PromotionsClient`.

- [ ] **Step 1: Write the failing component test**

Create `app/(app)/admin/promotions/FirstReleaseSection.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirstReleaseSection } from './FirstReleaseSection';

const candidate = {
  promotionId: 'p1',
  forgeId: 'f1',
  forgeName: 'Second Set of Eyes',
  slug: 'second-set-of-eyes',
  version: 'v1.0.0',
  headSha: 'abc12345',
  decidedAt: '2026-08-21T18:00:00.000Z',
  bundleTags: [] as string[],
};

/** Route fetches by URL substring; throws on anything unexpected. */
function mockFetch(handlers: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = Object.entries(handlers).find(([key]) => url.includes(key));
    if (!entry) throw new Error(`unexpected fetch: ${url}`);
    return entry[1]();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.restoreAllMocks(); });

describe('FirstReleaseSection', () => {
  it('renders nothing when there are no candidates', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [] }),
    }));
    const { container } = render(<FirstReleaseSection />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists a candidate with its version', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [candidate] }),
    }));
    render(<FirstReleaseSection />);
    expect(await screen.findByText('Second Set of Eyes')).toBeInTheDocument();
    expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument();
  });

  it('cuts a bundle and reports where it landed', async () => {
    const cut = vi.fn(() =>
      json({
        bundle: {
          repo: 'second-set-of-eyes-seed', tag: 'v1.0.0', bytes: 4096,
          manifestDigest: 'sha256:abc', migrations: [],
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [candidate] }),
      '/bundle': cut,
    }));

    render(<FirstReleaseSection />);
    await userEvent.click(await screen.findByRole('button', { name: /cut bundle/i }));

    await waitFor(() => expect(cut).toHaveBeenCalled());
    expect(await screen.findByText(/second-set-of-eyes-seed:v1\.0\.0/)).toBeInTheDocument();
  });

  it("surfaces the server's refusal", async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [candidate] }),
      '/bundle': () => json({ error: 'database has migrations the release does not' }, 400),
    }));

    render(<FirstReleaseSection />);
    await userEvent.click(await screen.findByRole('button', { name: /cut bundle/i }));

    expect(await screen.findByText(/migrations the release does not/i)).toBeInTheDocument();
  });

  it('warns that a bundle already exists for this version', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () =>
        json({ candidates: [{ ...candidate, bundleTags: ['v1.0.0'] }] }),
    }));
    render(<FirstReleaseSection />);
    expect(await screen.findByText(/already cut/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-cut bundle/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run "app/(app)/admin/promotions/FirstReleaseSection.test.tsx"`
Expected: FAIL — cannot resolve `./FirstReleaseSection`.

- [ ] **Step 3: Implement the section**

Create `app/(app)/admin/promotions/FirstReleaseSection.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { FirstReleaseCandidate } from '@/lib/services/first-release';

type CutResult = { repo: string; tag: string; bytes: number };

/**
 * First-release bundles, on the pilot.
 *
 * Its own section rather than part of the pending list: PromotionsClient
 * renders /api/promotions, which is listPendingPromotions — filtered to ACTIVE
 * statuses, so an *accepted* promotion can never appear there.
 */
export function FirstReleaseSection() {
  const [candidates, setCandidates] = useState<FirstReleaseCandidate[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, CutResult>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/promotions/first-release-candidates');
      if (!res.ok) return;
      const body = (await res.json()) as { candidates: FirstReleaseCandidate[] };
      if (alive.current) setCandidates(body.candidates);
    } catch {
      // Leave the last known list in place.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function cut(candidate: FirstReleaseCandidate) {
    const id = candidate.promotionId;
    setBusyId(id);
    setErrors((e) => { const next = { ...e }; delete next[id]; return next; });
    try {
      const res = await fetch(`/api/promotions/${id}/bundle`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as
        { bundle?: CutResult; error?: string };
      if (!res.ok || !body.bundle) {
        setErrors((e) => ({ ...e, [id]: body.error ?? 'Cut failed' }));
        return;
      }
      setResults((r) => ({ ...r, [id]: body.bundle! }));
      await load();
    } catch {
      setErrors((e) => ({ ...e, [id]: 'Cut failed' }));
    } finally {
      setBusyId(null);
    }
  }

  if (candidates.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">First-release bundles</h2>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Cuts this forge&apos;s pilot database and inventory row into{' '}
        <code>&lt;slug&gt;-seed</code> in the registry, for a one-time import on production.
        Offered only on a forge&apos;s first release.
      </p>
      {candidates.map((c) => {
        const already = c.bundleTags.includes(c.version);
        const result = results[c.promotionId];
        return (
          <article
            key={c.promotionId}
            className="flex flex-col gap-2 rounded-[14px] border border-border bg-panel p-5"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold">{c.forgeName}</h3>
                <div className="text-[11px] text-ink-faint">
                  {c.version} · released {new Date(c.decidedAt).toLocaleDateString()} ·{' '}
                  {c.headSha.slice(0, 8)}
                </div>
              </div>
              <Button
                variant="outline"
                disabled={busyId === c.promotionId}
                onClick={() => void cut(c)}
              >
                {busyId === c.promotionId ? 'Cutting…' : already ? 'Re-cut bundle' : 'Cut bundle'}
              </Button>
            </div>
            {already && !result ? (
              <p className="text-[11px] text-ink-dim">
                A bundle for {c.version} was already cut. Re-cutting overwrites the tag; it does
                not affect a bundle production has already imported.
              </p>
            ) : null}
            {result ? (
              <p className="text-[11px] text-[#4ad28b]">
                Pushed {result.repo}:{result.tag} ({Math.ceil(result.bytes / 1024)} KiB of SQL).
                Import it from the production Deployments tab.
              </p>
            ) : null}
            {errors[c.promotionId] ? (
              <p role="alert" className="text-[11px] text-[#d96868]">{errors[c.promotionId]}</p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
```

- [ ] **Step 4: Mount it in `PromotionsClient`**

In `app/(app)/admin/promotions/PromotionsClient.tsx`, add the import:

```tsx
import { FirstReleaseSection } from './FirstReleaseSection';
```

and render it as the last child of the outer `<div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">`, immediately after the `items.length === 0 ? … : …` expression:

```tsx
      <FirstReleaseSection />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run "app/(app)/admin/promotions"`
Expected: PASS — the 5 new tests plus the existing `PromotionsClient.test.tsx` suite. If `PromotionsClient.test.tsx` now fails on an unmocked `/api/promotions/first-release-candidates` fetch, add that URL to its existing fetch mock returning `{ candidates: [] }` — the section then renders nothing, so no other assertion changes.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add "app/(app)/admin/promotions"
git commit -m "feat(promotions): cut a first-release bundle from the admin page"
```

---

### Task 10: Prod UI — import a bundle from the deployments page

**Files:**
- Create: `app/(app)/admin/deployments/BundleImportSection.tsx`
- Create: `app/(app)/admin/deployments/BundleImportSection.test.tsx`
- Modify: `app/(app)/admin/deployments/DeploymentsClient.tsx`

**Interfaces:**
- Consumes: `GET /api/deployments/bundles`, `POST /api/deployments/bundles/[slug]/import` (Task 8); `BundleCandidate` (Task 7).
- Produces: `<BundleImportSection onImported={() => void} />` — the callback lets `DeploymentsClient` refresh its version map once a new forge appears.

- [ ] **Step 1: Write the failing component test**

Create `app/(app)/admin/deployments/BundleImportSection.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BundleImportSection } from './BundleImportSection';

const candidate = {
  slug: 'second-set-of-eyes',
  repo: 'second-set-of-eyes-seed',
  versions: ['v1.0.0'],
};

function mockFetch(handlers: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = Object.entries(handlers).find(([key]) => url.includes(key));
    if (!entry) throw new Error(`unexpected fetch: ${url}`);
    return entry[1]();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.restoreAllMocks(); });

describe('BundleImportSection', () => {
  it('renders nothing when the registry offers no bundles', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/deployments/bundles': () => json({ candidates: [] }),
    }));
    const { container } = render(<BundleImportSection onImported={() => {}} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists an available bundle', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/deployments/bundles': () => json({ candidates: [candidate] }),
    }));
    render(<BundleImportSection onImported={() => {}} />);
    expect(await screen.findByText('second-set-of-eyes')).toBeInTheDocument();
  });

  it('asks for confirmation before importing, then imports', async () => {
    const doImport = vi.fn(() =>
      json({
        imported: {
          forgeId: 'f1', slug: 'second-set-of-eyes', version: 'v1.0.0',
          bundleDigest: 'sha256:abc', deployEnabled: true,
        },
      }),
    );
    const onImported = vi.fn();
    // '/import' must be matched before the bare listing path.
    vi.stubGlobal('fetch', mockFetch({
      '/import': doImport,
      '/api/deployments/bundles': () => json({ candidates: [candidate] }),
    }));

    render(<BundleImportSection onImported={onImported} />);
    await userEvent.click(await screen.findByRole('button', { name: /^import$/i }));

    // Nothing has been sent yet — the dialog is the gate.
    expect(doImport).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /import data/i }));

    await waitFor(() => expect(doImport).toHaveBeenCalled());
    expect(onImported).toHaveBeenCalled();
    expect(await screen.findByText(/imported/i)).toBeInTheDocument();
  });

  it('surfaces a refusal from the server', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/import': () => json({ error: 'Database second_set_of_eyes was already seeded' }, 400),
      '/api/deployments/bundles': () => json({ candidates: [candidate] }),
    }));

    render(<BundleImportSection onImported={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /^import$/i }));
    await userEvent.click(screen.getByRole('button', { name: /import data/i }));

    expect(await screen.findByText(/already seeded/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run "app/(app)/admin/deployments/BundleImportSection.test.tsx"`
Expected: FAIL — cannot resolve `./BundleImportSection`.

- [ ] **Step 3: Implement the section**

Create `app/(app)/admin/deployments/BundleImportSection.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { BundleCandidate } from '@/lib/services/first-release';

/**
 * First-release import, on prod.
 *
 * Candidates come from the registry catalog, not the database: prod has no
 * Forge row for a forge it has never imported (spec §3.1). The section hides
 * itself when there is nothing to import, which is the steady state.
 */
export function BundleImportSection({ onImported }: { onImported: () => void }) {
  const [candidates, setCandidates] = useState<BundleCandidate[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{ slug: string; version: string } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/deployments/bundles');
      if (!res.ok) return;
      const body = (await res.json()) as { candidates: BundleCandidate[] };
      if (alive.current) setCandidates(body.candidates);
    } catch {
      // Registry blip — a stale list beats a blank section.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function runImport(slug: string, version: string) {
    setBusy(slug);
    setErrors((e) => { const next = { ...e }; delete next[slug]; return next; });
    try {
      const res = await fetch(`/api/deployments/bundles/${slug}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { imported?: { version: string }; error?: string };
      if (!res.ok || !body.imported) {
        setErrors((e) => ({ ...e, [slug]: body.error ?? 'Import failed' }));
        return;
      }
      setDone((d) => ({ ...d, [slug]: body.imported!.version }));
      onImported();
      await load();
    } catch {
      setErrors((e) => ({ ...e, [slug]: 'Import failed' }));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  const importedSlugs = Object.keys(done);
  if (candidates.length === 0 && importedSlugs.length === 0) return null;

  return (
    <section className="mb-8 rounded-[14px] border border-border bg-panel p-5">
      <h2 className="text-base font-semibold text-ink">Import a first release</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-dim">
        Bundles waiting in the registry. Importing writes the forge&apos;s inventory row and
        restores its pilot data, once. It cannot be undone from here.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {candidates.map((c) => {
          const version = chosen[c.slug] ?? c.versions[0] ?? '';
          return (
            <div key={c.slug} className="flex flex-wrap items-center gap-3">
              <span className="font-medium text-ink">{c.slug}</span>
              <select
                aria-label={`Bundle version for ${c.slug}`}
                className="h-8 rounded-md border border-border bg-panel px-2 text-sm text-ink"
                value={version}
                onChange={(e) => setChosen((s) => ({ ...s, [c.slug]: e.target.value }))}
              >
                {c.versions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === c.slug || version === ''}
                onClick={() => setConfirming({ slug: c.slug, version })}
              >
                {busy === c.slug ? 'Importing…' : 'Import'}
              </Button>
              {errors[c.slug] ? (
                <span role="alert" className="text-xs text-red-400">{errors[c.slug]}</span>
              ) : null}
            </div>
          );
        })}

        {importedSlugs.map((slug) => (
          <p key={slug} className="text-xs text-emerald-400">
            {slug} imported at {done[slug]} — it now appears in the table below, deployed.
          </p>
        ))}
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Import {confirming?.slug} {confirming?.version}?
            </DialogTitle>
            <DialogDescription>
              This restores the pilot&apos;s data into a new production database and enables the
              forge at <strong>{confirming?.version}</strong>. It runs once: a second import is
              refused, and undoing it means dropping the database by hand.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="gold"
              disabled={busy !== null}
              onClick={() => {
                if (confirming) void runImport(confirming.slug, confirming.version);
              }}
            >
              Import data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
```

- [ ] **Step 4: Mount it in `DeploymentsClient`**

In `app/(app)/admin/deployments/DeploymentsClient.tsx`, add the import:

```tsx
import { BundleImportSection } from './BundleImportSection';
```

and render it directly after the `<h1>Deployments</h1>` line, before the `versionsError` paragraph:

```tsx
      <BundleImportSection onImported={() => void loadVersions()} />
```

`loadVersions` is already a `useCallback` in scope. Without the refresh, a freshly imported forge has no entry in the version map and its row would render as `no image`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run "app/(app)/admin/deployments"`
Expected: PASS — the 4 new tests plus the existing `DeploymentsClient.test.tsx` and `rowState.test.ts` suites. If `DeploymentsClient.test.tsx` fails on an unmocked `/api/deployments/bundles` fetch, add that URL to its fetch mock returning `{ candidates: [] }`; the section then renders nothing.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add "app/(app)/admin/deployments"
git commit -m "feat(deployments): import a first-release bundle from the admin page"
```

---

### Task 11: Full verification and documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-08-21-first-release-bundle-design.md` (status line only)

- [ ] **Step 1: Run the whole suite**

Run: `pnpm test`
Expected: PASS, all files. `🌱 The seed command has been executed` in the output is expected — the harness seeds `<db>_test`, not the dev database.

- [ ] **Step 2: Typecheck, lint, and production build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all three pass. The build is the check that the four new route handlers are valid App Router routes.

- [ ] **Step 3: Confirm the dev database was untouched**

Run:

```bash
docker exec -i crystal-forge-pg psql -U crystal -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1"
```

Expected: the usual databases (`crystal_forge`, `crystal_forge_test`, the per-forge ones, `_e2e` if present). The Task 4 integration tests create and drop `_test_bundle_restore`, so it must **not** be listed.

- [ ] **Step 4: Document the two gotchas**

In `AGENTS.md`, under **Conventions & gotchas**, add:

```markdown
- **First-release bundles are the only pilot→prod data path, and they run once.**
  The pilot cuts `<slug>-seed:<version>` into the registry from an *accepted first*
  promotion (`admin/promotions`); prod imports it from `admin/deployments`. The
  once-only guard is a `_forge_seed` table created by an unconditional
  `CREATE TABLE` inside the restore transaction, so a second import aborts rather
  than merges. There is no `--force`: re-seeding means dropping the forge database
  by hand. Import order is load-bearing — `deployEnabled` stays false until the
  restore commits, because `listDesiredForges` filters on it and the reconciler
  would otherwise start the container mid-restore.
- **`pg_dump`/`psql` run via `docker exec` into `$PG_CONTAINER`, not through
  `ContainerManager`.** That abstraction is for forge containers and surfaces only
  *combined* stdout/stderr, which would corrupt a dump the moment `pg_dump`
  emitted a warning. Restores connect over TCP as the per-forge app role (not the
  trust socket as superuser) so the role ends up owning the restored tables —
  otherwise later `prisma migrate deploy` runs cannot `ALTER` them.
```

- [ ] **Step 5: Mark the spec implemented**

In `docs/superpowers/specs/2026-08-21-first-release-bundle-design.md`, change the status line to:

```markdown
- **Status:** Implemented — see `docs/superpowers/plans/2026-08-21-first-release-bundle.md`
```

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-08-21-first-release-bundle-design.md
git commit -m "docs: record the first-release bundle gotchas"
```

- [ ] **Step 7: Report what still needs a human**

Print this, do not automate any of it:

- **Nothing moves until a bundle is cut on the pilot and imported on prod.** Both are admin UI actions; neither should be scripted from here.
- The prod dashboard needs registry pull credentials in its `.env.local`. Per the registry-credentials note, the rotated pull password may not be wired into prod yet — verify before the first import.
- `PG_CONTAINER` defaults to `crystal-forge-pg`. If prod's Postgres container is named differently, set it in prod's `.env.local` and restart `crystal-forge.service`.
- Deleting a seed repo after cutover stays manual (spec §9), and the retention question is deliberately deferred (spec §10).

---

## Self-Review

**Spec coverage**

| Spec section | Task(s) |
| --- | --- |
| §1 bundle = three files in one layer | 1, 3 |
| §1.1 own repo (`<slug>-seed`) | 3 (`seedRepo` / `slugFromSeedRepo`) |
| §1.2 registry blobs not `docker build`; fake-client testable; valid manifest | 2, 3 |
| §1.3 plain format; restore as app role; spawn directly, not via ContainerManager | 4 |
| §2 cut surface; all four preconditions; effect; re-cut overwrites | 6, 9 |
| §3.1 discovery from the catalog | 7, 10 |
| §3.2 six-step apply sequence, in order | 7 |
| §4 `_forge_seed`, created by the import not by a Prisma migration | 4 (`seedMarkerSql`) |
| §5 all seven guards | Admin+mode: 6, 7 · first release only: 6 · migration parity: 5, 6 · bundle integrity: 3 · version match: 2, 7 · already imported: 4, 7 · already known: 7 |
| §5 no `--force` | 7 — no force parameter exists anywhere |
| §6 atomic restore; three failure modes | 4 (`--single-transaction`) · 7 (disabled row left behind, retryable) · 7 + 10 (registry degrades to empty) |
| §7 every component listed | Registry: 2 · DB: 4 · Services: 6, 7 · Routes: 8 · UI: 9, 10 · Reuse unchanged: no task modifies the reconciler, `prod-runtime.ts`, `DatabaseProvisioner`, `slug.ts`, or `semver.ts` |
| §8 all five test groups | Registry round-trip: 3 · cut preconditions: 6 · import guards: 7 · restore integration: 4 · ordering invariant: 7 |
| §9 out of scope | Nothing implements ongoing sync, on-disk state, seed-repo deletion, or version-skew handling |
| §10 deferred retention | No retention code; Task 11 Step 7 restates the deferral |

**Placeholder scan:** no TBD/TODO, no "add error handling", no "similar to Task N", no test described without its code. Every code step carries a full code block.

**Type consistency checks performed:**
- `sha256Digest` returns `"sha256:<hex>"` in Task 1, and every consumer (Tasks 2, 3) plus `contentDigest`'s regex (Task 1) expects exactly that shape.
- `restoreForgeDatabase`'s parameter object is `{ dbName, role, password, sql }` in Task 4, is called with exactly those keys in Task 7, and `ImportDeps.restore` declares the same shape.
- `dumpForgeDatabase` takes `{ dbName }` and returns `Promise<string>` in Task 4; `CutDeps.dump` in Task 6 declares `(opts: { dbName: string }) => Promise<string>`.
- `readAppliedMigrations` returns `string[] | null` in Task 4, and Task 6 handles the `null` branch explicitly.
- `readSeedMarker` returns `{ bundleDigest, version } | null` in Task 4; `ImportDeps.readMarker` declares the identical type and Task 7's test stubs match it.
- `listDirectoryAtRef(fullName, path, ref)` — argument order is identical in Task 5's interface, both implementations, and Task 6's call. Note the fake's *seeder* is `seedDirectory(fullName, ref, path, names)`, deliberately a different order; both Task 5 and Task 6 tests use it consistently.
- `manifestDigest` returns `string | null`; Tasks 6 and 7 both null-check before use.
- `pushBundle` returns `{ repo, tag, manifestDigest }`; `CutResult` spreads it and adds `migrations` and `bytes`, which is exactly the subset Task 9's local `CutResult` reads (`repo`, `tag`, `bytes`).
- `slugToDbName` → `dbNameToRole` is the only derivation of `dbName`/`role`, in Tasks 6 and 7, matching how `listDesiredForges` derives them.
- `FirstReleaseCandidate` and `BundleCandidate` are imported by the UI tasks from `@/lib/services/first-release`, the same module that defines them.
