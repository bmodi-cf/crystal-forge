# Forge Preview Path-Based Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve each running forge's live app at a same-origin path `https://<host>/app/<slug>/` through an in-app reverse proxy in the Crystal Forge dashboard, replacing the broken hardcoded `http://localhost:<port>` preview links.

**Architecture:** A catch-all route handler in the dashboard authenticates the Entra session, enforces forge read-ACL, looks up the running forge's port in `state.json`, and reverse-proxies the request (preserving the `/app/<slug>/...` path) to the loopback dev-server port. Each cloned forge's `next.config.ts` is patched at clone time to set `basePath` from `FORGE_BASE_PATH` so its assets/API stay under the prefix. nginx is a pilot-only TLS front door; the proxy is in-app, so local dev needs no nginx.

**Tech Stack:** Next.js 16 (App Router, route handlers), TypeScript strict, Auth.js v5, Prisma 7, Vitest. Node `fetch`/`undici` for proxying. Spec: `docs/superpowers/specs/2026-06-02-forge-preview-path-routing-design.md`.

---

## File Structure

**New files:**
- `lib/runtime/proxy-target.ts` — `runtimeOrigin(port)`: the single place that encodes *where* a runtime lives (loopback today, container later).
- `lib/runtime/proxy-target.test.ts` — test for the above.
- `lib/runtime/preview-proxy.ts` — `handlePreviewProxy(req, slug, deps)`: dependency-injected proxy core (authN + ACL + forward). Pure of Next plumbing so it's unit-testable.
- `lib/runtime/preview-proxy.test.ts` — tests for the core.
- `app/app/[slug]/[[...path]]/route.ts` — thin route handler that wires real deps (`auth`, `prisma`, `loadState`, `fetch`) into `handlePreviewProxy` and exports all HTTP methods.

**Modified files:**
- `lib/runtime/clone.ts` — add idempotent `injectBasePath()` step to `ensureClone`.
- `lib/runtime/clone.test.ts` — tests for the basePath patch.
- `lib/services/runtime.ts` — add `FORGE_BASE_PATH` to the spawn env in `doStart`.
- `lib/services/runtime.test.ts` — assert the spawn env carries `FORGE_BASE_PATH`.
- `app/(app)/forges/[id]/InstancePanel.tsx` — relative `/app/<slug>/` preview URL.
- `app/(app)/dashboard/ForgeCardRuntime.tsx` — relative `/app/<slug>/` open URL.
- `.gitignore` — ensure `.env.local` is ignored (verification + fix if missing).

---

## Task 1: `runtimeOrigin` proxy-target helper

**Files:**
- Create: `lib/runtime/proxy-target.ts`
- Test: `lib/runtime/proxy-target.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/runtime/proxy-target.test.ts
import { describe, it, expect } from 'vitest';
import { runtimeOrigin } from './proxy-target';

describe('runtimeOrigin', () => {
  it('returns the loopback origin for a runtime port', () => {
    expect(runtimeOrigin(3001)).toBe('http://127.0.0.1:3001');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/runtime/proxy-target.test.ts`
Expected: FAIL — cannot find module `./proxy-target`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/runtime/proxy-target.ts

/**
 * The origin where a running forge's dev server can be reached from the
 * Crystal Forge process. Today forges run on loopback; when they move to
 * per-forge Docker containers, this is the ONLY place that changes.
 */
export function runtimeOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/runtime/proxy-target.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/proxy-target.ts lib/runtime/proxy-target.test.ts
git commit -m "feat(runtime): add runtimeOrigin proxy-target helper"
```

---

## Task 2: basePath injection at clone time

**Files:**
- Modify: `lib/runtime/clone.ts`
- Test: `lib/runtime/clone.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe('ensureClone', ...)` block in `lib/runtime/clone.test.ts` (it reuses the existing `makeFakeRunner`, `tmp`, and `FakeGitHubClient` setup at the top of the file):

```ts
  it('wraps next.config.ts to inject basePath, idempotently', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const { runner } = makeFakeRunner(async ({ cmd, args }) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        await fs.writeFile(
          path.join(dest, 'next.config.ts'),
          "import type { NextConfig } from 'next';\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n",
        );
      }
    });

    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    const cloneDir = path.join(tmp, 'clones', 'marketing-frufru');
    const base = await fs.readFile(path.join(cloneDir, 'next.config.base.ts'), 'utf8');
    expect(base).toContain('const nextConfig: NextConfig = {}');
    const cfg = await fs.readFile(path.join(cloneDir, 'next.config.ts'), 'utf8');
    expect(cfg).toContain("import base from './next.config.base'");
    expect(cfg).toContain('process.env.FORGE_BASE_PATH');

    // Second run must not double-wrap (idempotent via the base-file marker).
    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );
    expect(await fs.readFile(path.join(cloneDir, 'next.config.base.ts'), 'utf8')).toBe(base);
    expect(await fs.readFile(path.join(cloneDir, 'next.config.ts'), 'utf8')).toBe(cfg);
  });

  it('skips basePath injection when next.config.ts default export is a function', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const { runner } = makeFakeRunner(async ({ cmd, args }) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        await fs.writeFile(
          path.join(dest, 'next.config.ts'),
          'export default function config() { return {}; }\n',
        );
      }
    });

    await ensureClone(
      { slug: 'fn-config', repoFullName: 'bmodi-cf/fn-config' },
      fakeGh,
      runner,
    );

    const cloneDir = path.join(tmp, 'clones', 'fn-config');
    // No base file written, original config untouched.
    await expect(fs.stat(path.join(cloneDir, 'next.config.base.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(cloneDir, 'next.config.ts'), 'utf8')).toContain('export default function config');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run lib/runtime/clone.test.ts`
Expected: FAIL — `next.config.base.ts` does not exist (ENOENT) in the first new test.

- [ ] **Step 3: Implement `injectBasePath` and call it from `ensureClone`**

In `lib/runtime/clone.ts`, add this constant and function below the existing `assertOk` helper (top-level, after line ~25):

```ts
const BASE_PATH_WRAPPER = `// crystal-forge: basePath injected for path-based reverse proxy. Do not edit.
import base from './next.config.base';
const basePath = process.env.FORGE_BASE_PATH || undefined;
export default { ...base, basePath };
`;

/**
 * Make the cloned Next.js app serve itself under basePath=/app/<slug> so it
 * works behind the dashboard's path-based reverse proxy. Idempotent: the
 * presence of next.config.base.ts is the marker that the patch already ran.
 */
async function injectBasePath(cloneDir: string): Promise<void> {
  const cfg = path.join(cloneDir, 'next.config.ts');
  const marker = path.join(cloneDir, 'next.config.base.ts');
  if (await exists(marker)) return; // already patched
  if (!(await exists(cfg))) return; // nothing to patch (e.g. .js/.mjs config — out of scope)
  const content = await fs.readFile(cfg, 'utf8');
  if (/export\s+default\s+(async\s+)?function|export\s+default\s*\(/.test(content)) {
    // Function-style config can't be spread into an object wrapper; leave it alone.
    console.warn('[runtime/clone] next.config.ts exports a function; skipping basePath injection');
    return;
  }
  await fs.rename(cfg, marker);
  await fs.writeFile(cfg, BASE_PATH_WRAPPER, 'utf8');
}
```

Then call it inside `ensureClone`, immediately after the `.env.local` copy block and before the hook-script `chmod` block. Locate this existing code (around lines 56-60):

```ts
  const envLocal = path.join(cloneDir, '.env.local');
  const envExample = path.join(cloneDir, '.env.example');
  if (!(await exists(envLocal)) && (await exists(envExample))) {
    await fs.copyFile(envExample, envLocal);
  }
```

Add directly after it:

```ts
  // Run on every ensureClone (not just fresh clones) so existing clones are
  // patched on their next start. injectBasePath is idempotent.
  await injectBasePath(cloneDir);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run lib/runtime/clone.test.ts`
Expected: PASS (all existing tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/clone.ts lib/runtime/clone.test.ts
git commit -m "feat(runtime): inject basePath into cloned next.config at clone time"
```

---

## Task 3: pass `FORGE_BASE_PATH` to the spawned dev server

**Files:**
- Modify: `lib/services/runtime.ts:102-110`
- Test: `lib/services/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `lib/services/runtime.test.ts`. It builds its own fakes that capture the spawn env. Mirror the existing fixtures in that file: it already imports `makeRuntimeService` and uses `tom` (a writer user) and a `forge` fixture created via the test's DB helpers. Use the same harness the neighbouring `startForge` tests use (copy the `prisma`/`forge`/`tom` setup from the closest existing test in the file):

```ts
  it('startForge spawns the dev server with FORGE_BASE_PATH=/app/<slug>', async () => {
    await withForge(async ({ prisma, forge, tom }) => {
      const spawnEnvs: Array<Record<string, string> | undefined> = [];
      const svc = makeRuntimeService({
        ...makeFakes(),
        prisma,
        spawnLongLived: (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
          spawnEnvs.push(opts.env);
          return 12345;
        },
      });

      await svc.startForge(tom, forge.id);

      expect(spawnEnvs.length).toBe(1);
      expect(spawnEnvs[0]?.FORGE_BASE_PATH).toBeDefined();
      expect(spawnEnvs[0]?.FORGE_BASE_PATH!.startsWith('/app/')).toBe(true);
    });
  });
```

> Note: `withForge`/`makeFakes`/`tom` are the helper names used by the existing tests in this file. If the existing tests use a slightly different harness shape (e.g. an inline `prisma.$transaction` wrapper rather than a `withForge` helper), copy that exact shape from the nearest `it('startForge ...')` test instead — the only new logic is the capturing `spawnLongLived` and the two assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/services/runtime.test.ts`
Expected: FAIL — `spawnEnvs[0]?.FORGE_BASE_PATH` is `undefined`.

- [ ] **Step 3: Add `FORGE_BASE_PATH` to the spawn env**

In `lib/services/runtime.ts`, find the `deps.spawnLongLived` call in `doStart` (around lines 102-110):

```ts
    const pid = deps.spawnLongLived(
      'pnpm',
      ['dev', '--port', String(port)],
      {
        cwd: forgeClonePath(slug),
        logPath: log,
        env: { PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' },
      },
    );
```

Change the `env` object to include `FORGE_BASE_PATH`:

```ts
    const pid = deps.spawnLongLived(
      'pnpm',
      ['dev', '--port', String(port)],
      {
        cwd: forgeClonePath(slug),
        logPath: log,
        env: {
          PORT: String(port),
          NEXT_TELEMETRY_DISABLED: '1',
          FORGE_BASE_PATH: `/app/${slug}`,
        },
      },
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/services/runtime.test.ts`
Expected: PASS (all existing + the new test).

- [ ] **Step 5: Commit**

```bash
git add lib/services/runtime.ts lib/services/runtime.test.ts
git commit -m "feat(runtime): pass FORGE_BASE_PATH to spawned forge dev server"
```

---

## Task 4: reverse-proxy core (`handlePreviewProxy`)

**Files:**
- Create: `lib/runtime/preview-proxy.ts`
- Test: `lib/runtime/preview-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { handlePreviewProxy, type PreviewProxyDeps } from './preview-proxy';
import type { SessionUser } from '@/lib/services/types';
import type { RuntimeStateFile } from './types';

const user: SessionUser = {
  id: 'u1', entraOid: null, email: 'a@b.c', name: 'A', initials: 'A',
  groups: ['eng'], isAdmin: false,
};

const runningState: RuntimeStateFile = {
  'forge-1': {
    forgeId: 'forge-1', slug: 'bmodi-test1', status: 'running',
    pid: 1, port: 3001, startedAt: '2026-06-02T00:00:00.000Z', logPath: '/tmp/x.log',
  },
};

function makeDeps(over: Partial<PreviewProxyDeps> = {}): PreviewProxyDeps {
  return {
    getSession: async () => ({ user }),
    loadState: async () => runningState,
    loadForgeAcl: async () => ({ id: 'forge-1', createdById: 'u1', groups: ['eng'] }),
    fetch: (async () => new Response('OK', { status: 200 })) as unknown as typeof fetch,
    ...over,
  };
}

describe('handlePreviewProxy', () => {
  it('returns 401 when there is no session', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/'),
      'bmodi-test1',
      makeDeps({ getSession: async () => null }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the slug is not a running forge', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/ghost/'),
      'ghost',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the forge is stopped (absent from state)', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/'),
      'bmodi-test1',
      makeDeps({ loadState: async () => ({}) }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when ACL denies read access', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/'),
      'bmodi-test1',
      makeDeps({ loadForgeAcl: async () => ({ id: 'forge-1', createdById: 'other', groups: ['other'] }) }),
    );
    expect(res.status).toBe(404);
  });

  it('proxies to the runtime origin preserving path+query and relays the upstream response', async () => {
    let calledUrl = '';
    let calledMethod = '';
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/dash?q=1', { method: 'GET' }),
      'bmodi-test1',
      makeDeps({
        fetch: (async (url: string | URL, init: RequestInit) => {
          calledUrl = String(url);
          calledMethod = init?.method ?? 'GET';
          return new Response('hello', { status: 201, headers: { 'x-test': 'yes' } });
        }) as unknown as typeof fetch,
      }),
    );
    expect(calledUrl).toBe('http://127.0.0.1:3001/app/bmodi-test1/dash?q=1');
    expect(calledMethod).toBe('GET');
    expect(res.status).toBe(201);
    expect(res.headers.get('x-test')).toBe('yes');
    expect(await res.text()).toBe('hello');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run lib/runtime/preview-proxy.test.ts`
Expected: FAIL — cannot find module `./preview-proxy`.

- [ ] **Step 3: Implement `handlePreviewProxy`**

```ts
// lib/runtime/preview-proxy.ts
import { canReadForge } from '@/lib/acl';
import type { SessionUser } from '@/lib/services/types';
import type { RuntimeStateFile } from './types';
import { runtimeOrigin } from './proxy-target';

export type ForgeAcl = { id: string; createdById: string; groups: string[] };

export type PreviewProxyDeps = {
  getSession: () => Promise<{ user?: SessionUser | null } | null>;
  loadState: () => Promise<RuntimeStateFile>;
  loadForgeAcl: (forgeId: string) => Promise<ForgeAcl | null>;
  fetch: typeof fetch;
};

// Hop-by-hop headers must not be forwarded by a proxy (RFC 7230 §6.1). We also
// drop host/content-length so undici recomputes them for the upstream request.
const STRIP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function filterHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) out.append(key, value);
  });
  return out;
}

/**
 * Authenticate + ACL-gate + reverse-proxy a request for /app/<slug>/... to the
 * running forge's dev server. The full incoming path is preserved because the
 * forge app runs with basePath=/app/<slug>.
 */
export async function handlePreviewProxy(
  req: Request,
  slug: string,
  deps: PreviewProxyDeps,
): Promise<Response> {
  const session = await deps.getSession();
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const state = await deps.loadState();
  const entry = Object.values(state).find(
    (e) => e.slug === slug && e.status === 'running',
  );
  if (!entry) {
    return new Response('Forge is not running', { status: 404 });
  }

  const acl = await deps.loadForgeAcl(entry.forgeId);
  if (!acl || !canReadForge(session.user, acl)) {
    // 404 rather than 403 so we don't confirm the forge exists to outsiders.
    return new Response('Not found', { status: 404 });
  }

  const incoming = new URL(req.url);
  const target = runtimeOrigin(entry.port) + incoming.pathname + incoming.search;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: filterHeaders(req.headers),
    body: hasBody ? req.body : undefined,
    redirect: 'manual', // pass the forge app's redirects through verbatim
  };
  if (hasBody) init.duplex = 'half'; // required by undici when streaming a body

  const upstream = await deps.fetch(target, init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterHeaders(upstream.headers),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run lib/runtime/preview-proxy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/preview-proxy.ts lib/runtime/preview-proxy.test.ts
git commit -m "feat(runtime): add ACL-gated reverse-proxy core for forge previews"
```

---

## Task 5: route handler at `/app/[slug]/[[...path]]`

**Files:**
- Create: `app/app/[slug]/[[...path]]/route.ts`

This is route plumbing (no unit test — verified via typecheck + a live request in Task 8). It wires the real dependencies into `handlePreviewProxy`.

- [ ] **Step 1: Create the route handler**

```ts
// app/app/[slug]/[[...path]]/route.ts
import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadState } from '@/lib/runtime/state';
import { handlePreviewProxy, type ForgeAcl } from '@/lib/runtime/preview-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadForgeAcl(forgeId: string): Promise<ForgeAcl | null> {
  const row = await prisma.forge.findUnique({
    where: { id: forgeId },
    include: { groups: { include: { group: true } } },
  });
  if (!row) return null;
  return {
    id: row.id,
    createdById: row.createdById,
    groups: row.groups.map((g) => g.group.name),
  };
}

async function handler(
  req: NextRequest,
  ctx: RouteContext<'/app/[slug]/[[...path]]'>,
) {
  const { slug } = await ctx.params;
  return handlePreviewProxy(req, slug, {
    // Wrap auth() in an arrow — NextAuth's `auth` is overloaded and won't
    // assign cleanly to the plain `() => Promise<...>` dep type.
    getSession: () => auth(),
    loadState,
    loadForgeAcl,
    fetch,
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
```

> Note on the context type: `RouteContext<'/app/[slug]/[[...path]]'>` is the generated typed-routes helper (the same style used in `app/api/forges/[id]/conversations/[conversationId]/connect/route.ts`). If typecheck reports that generated type isn't available yet, run `pnpm dev` once to regenerate `.next/types`, or fall back to an explicit type: `ctx: { params: Promise<{ slug: string; path?: string[] }> }`.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors). If `RouteContext` errors, apply the fallback type from the note above and re-run.

- [ ] **Step 3: Lint (route must not trip the no-octokit / other repo rules)**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/app/[slug]/[[...path]]/route.ts"
git commit -m "feat(app): add /app/<slug> reverse-proxy route for forge previews"
```

---

## Task 6: point the UI preview links at the proxy path

**Files:**
- Modify: `app/(app)/forges/[id]/InstancePanel.tsx:24,28`
- Modify: `app/(app)/dashboard/ForgeCardRuntime.tsx:64`

- [ ] **Step 1: Update `InstancePanel.tsx`**

Change line 24 from:

```ts
    const url = `http://localhost:${runtime.port}`;
```

to:

```ts
    const url = `/app/${runtime.slug}/`;
```

Change line 28 from:

```tsx
          <span className="truncate">{forgeName} · localhost:{runtime.port}</span>
```

to:

```tsx
          <span className="truncate">{forgeName} · /app/{runtime.slug}</span>
```

- [ ] **Step 2: Update `ForgeCardRuntime.tsx`**

Change line 64 from:

```tsx
            href={`http://localhost:${runtime!.port}`}
```

to:

```tsx
            href={`/app/${runtime!.slug}/`}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (`RuntimeStateView` includes `slug`, so `runtime.slug` is valid.)

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/forges/[id]/InstancePanel.tsx" "app/(app)/dashboard/ForgeCardRuntime.tsx"
git commit -m "feat(ui): point forge preview links at same-origin /app/<slug> path"
```

---

## Task 7: operational checks (secrets + forge-app auth surface)

**Files:**
- Modify (if needed): `.gitignore`

These are the two operational checks from the spec's auth model. Both are verifications with a concrete fix if they fail.

- [ ] **Step 1: Confirm `.env.local` is gitignored**

Run: `git check-ignore .env.local && echo IGNORED || echo NOT-IGNORED`
Expected: `IGNORED`.

If it prints `NOT-IGNORED`, append `.env.local` (and `.env*.local`) to `.gitignore`:

```bash
printf '\n# local env (holds live secrets)\n.env*.local\n' >> .gitignore
git add .gitignore
git commit -m "chore: gitignore .env*.local (live Entra secret)"
```

Then verify the secret was never committed:

Run: `git log --all --oneline -- .env.local | head`
Expected: empty. If not empty, STOP and tell the user — the Entra client secret is in git history and should be rotated.

- [ ] **Step 2: Confirm forge clones cannot self-authenticate (no always-on auth bypassing the gate)**

The clone seeds `.env.local` from `.env.example`, which currently sets `AUTH_DEV_USERS_ENABLED="true"`. Verify whether the forge template actually exposes a dev-login path that would let the forge app mint its own session independent of the dashboard gate.

Inspect a running clone's seeded env and the template's auth wiring:

Run: `grep -i 'AUTH_DEV_USERS_ENABLED' ~/.crystal-forge/clones/bmodi-test1/.env.local; ls ~/.crystal-forge/clones/bmodi-test1/lib/auth* ~/.crystal-forge/clones/bmodi-test1/app/api/dev 2>/dev/null`

- If the template has **no** dev-login route/provider → no action; the dashboard gate is the sole auth surface. Note this in the commit/PR description.
- If the template **does** expose dev-login, disable it for clones by forcing the flag off in the seeded env. Add this to `injectBasePath`'s neighbour in `lib/runtime/clone.ts` (right after the `await injectBasePath(cloneDir);` line added in Task 2):

```ts
  // Forge apps are gated by the dashboard; they must not self-authenticate.
  const cloneEnv = path.join(cloneDir, '.env.local');
  if (await exists(cloneEnv)) {
    const body = await fs.readFile(cloneEnv, 'utf8');
    if (/^AUTH_DEV_USERS_ENABLED\s*=\s*"?true"?/m.test(body)) {
      await fs.writeFile(
        cloneEnv,
        body.replace(/^AUTH_DEV_USERS_ENABLED\s*=.*/m, 'AUTH_DEV_USERS_ENABLED="false"'),
        'utf8',
      );
    }
  }
```

If you add the code above, also add a Vitest case to `lib/runtime/clone.test.ts` mirroring the basePath tests: have the fake `git clone` write a `.env.example` containing `AUTH_DEV_USERS_ENABLED="true"`, run `ensureClone`, and assert the clone's `.env.local` contains `AUTH_DEV_USERS_ENABLED="false"`. Then run `pnpm exec vitest run lib/runtime/clone.test.ts` (expect PASS) and commit:

```bash
git add lib/runtime/clone.ts lib/runtime/clone.test.ts
git commit -m "fix(runtime): disable dev-login in forge clones (gated by dashboard)"
```

---

## Task 8: end-to-end verification (local, then pilot)

No code — confirm the feature actually works. The `bmodi-test1` clone gets the basePath patch automatically on its next start (idempotent), so restart it first.

- [ ] **Step 1: Restart the forge so the basePath patch applies**

In the dashboard UI, Stop then Start `bmodi-test1` (or stop/start via the dashboard). Confirm `~/.crystal-forge/clones/bmodi-test1/next.config.base.ts` now exists and `next.config.ts` is the wrapper.

Run: `ls ~/.crystal-forge/clones/bmodi-test1/next.config.base.ts && grep -l FORGE_BASE_PATH ~/.crystal-forge/clones/bmodi-test1/next.config.ts`
Expected: both paths print (patch applied).

- [ ] **Step 2: Verify the proxy locally (authenticated session required)**

With `pnpm dev` running and logged in as a user who can read the forge, open `http://localhost:3000/app/bmodi-test1/` in the browser. Expected: the forge app renders, assets load (no 404s for `/_next/*`), and in-app navigation stays under `/app/bmodi-test1/`. Confirm the dashboard's embedded iframe and the "Open"/"standalone" links resolve to `/app/bmodi-test1/`.

- [ ] **Step 3: Verify the ACL gate**

As a user who should NOT have read access (or logged out), request `http://localhost:3000/app/bmodi-test1/`. Expected: `404` (or redirect to login if unauthenticated middleware applies). Confirm a logged-out request returns `401`/login, not the forge app.

- [ ] **Step 4: Verify on the pilot**

Build and run as on the pilot (`pnpm build && pnpm start` behind nginx), then from a **remote** browser open `https://forge-pilot.crystalfountains.com/app/bmodi-test1/`. Expected: the forge app renders over HTTPS for a remote user; no `localhost` anywhere; runtime ports remain unreachable directly from the internet.

- [ ] **Step 5: Final full-suite gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

---

## Notes / accepted tradeoffs (from the spec)

- **HMR/live-reload does not tunnel through the proxy** (WebSocket upgrade isn't proxied by a route handler) — accepted; Docker would break it anyway. A developer can open a forge's `localhost:<port>` directly when they want hot-reload.
- **Per-request ACL adds a DB lookup per proxied request** — acceptable at pilot scale; cache later if needed.
- **App-level identity (forwarded signed identity) is out of scope** — the proxy is built as the single auth chokepoint so it can be added later (reuse `signTicket`/`verifyTicket` from `lib/auth/ws-ticket.ts`). Forge clones keep receiving empty Entra creds; forges never become their own Entra clients.
