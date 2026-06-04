# Forge dev-HMR through the preview proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a dev-mode forge both hydrate and hot-reload behind the same-origin `/app/<slug>` preview proxy, by running the dashboard under a custom Node server that tunnels the forge's HMR WebSocket (gated by the same session + read-ACL as the HTTP proxy) and injecting `allowedDevOrigins` into each forge.

**Architecture:** A thin `server.ts` wraps Next (`next({dev}).getRequestHandler()`) and adds one `upgrade` dispatcher: `/app/<slug>/…` WebSockets are authenticated + ACL-checked + tunneled to the forge dev server; all other upgrades (the dashboard's own HMR) are delegated to Next. The clone-time `next.config` wrapper gains `allowedDevOrigins` (from `FORGE_DEV_ORIGINS`) so Next 16 accepts the tunneled cross-origin dev requests.

**Tech Stack:** Next 16.2.4 (App Router, Turbopack), `next` programmatic API, `ws`, `tsx`, Auth.js v5 (database sessions + Prisma), Vitest. Source spec: `docs/superpowers/specs/2026-06-04-forge-dev-hmr-proxy-design.md`.

---

## Scope

Single subsystem: dev-HMR through the proxy on LOCAL + PILOT. PROD production-build mode and the promotion path are out of scope (future). The plan front-loads a **de-risk gate** (Task 1): if Next 16 won't run cleanly under a custom server, stop and switch to the fallback in the spec (standalone WS-proxy service + nginx) before continuing.

## File map

**New**
- `server.ts` — dashboard custom server: Next HTTP handler + `upgrade` dispatcher
- `lib/auth/upgrade-cookie.ts` — pure cookie parsing + session-token extraction (+ test)
- `lib/runtime/hmr-proxy.ts` — `forgeHmrTarget()` (pure path match) + `handleForgeHmrUpgrade()` (gate + tunnel) (+ test)

**Modified**
- `package.json` — `dev`/`start` scripts → `tsx server.ts`
- `lib/services/users.ts` — add `getUserBySessionToken()` (+ test)
- `lib/runtime/container-setup.ts` — `WRAPPER` gains `allowedDevOrigins` (+ test update)
- `lib/services/runtime.ts` — set `FORGE_DEV_ORIGINS` in the container env (+ test)
- `lib/env.ts` — add `FORGE_DEV_ORIGINS`
- `README.md` — nginx WebSocket-passthrough note for PILOT

---

## Task 1 (DE-RISK GATE): Dashboard custom server, no tunnel yet

Validates Next 16 + Turbopack under a custom server before any tunnel work. Manual verification (a server boot isn't unit-testable).

**Files:**
- Create: `server.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the custom server**

Create `server.ts`:
```ts
import { createServer } from 'node:http';
import next from 'next';

const port = parseInt(process.env.PORT || '3030', 10);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));

  // Next's own HMR/websocket (dashboard hot-reload) is served by Next's upgrade
  // handler. Task 6 inserts the forge-HMR tunnel ahead of this delegation.
  const upgradeHandler = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => {
    void upgradeHandler(req, socket, head);
  });

  server.listen(port, () => {
    console.log(`> dashboard server listening on :${port} (${dev ? 'dev' : 'production'})`);
  });
});
```

- [ ] **Step 2: Point the scripts at the custom server**

In `package.json`, change:
```json
    "dev": "next dev",
    "start": "next start",
```
to:
```json
    "dev": "tsx server.ts",
    "start": "NODE_ENV=production tsx server.ts",
```

- [ ] **Step 3: Validate Next 16 runs under it (manual)**

Run: `pnpm dev` (or `./forge-launch.sh`).
Expected — ALL must hold, or STOP and switch to the spec's fallback:
1. `> dashboard server listening on :3030 (dev)` prints.
2. The dashboard loads at `http://localhost:3030` and is interactive.
3. `[instrumentation] runtime liveness loop started` / `WS server listening` still print (instrumentation runs under the custom server).
4. **Dashboard hot-reload works**: edit a string in `app/(app)/dashboard/*.tsx`, save, and the browser updates without a manual refresh (this proves `getUpgradeHandler()` exists and serves Next's own HMR — if `app.getUpgradeHandler` is `undefined` on this Next version, that's the stop signal).

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.ts package.json
git commit -m "feat(server): run dashboard under a custom server (HMR-tunnel foundation)"
```

---

## Task 2: Cookie parsing + session-token extraction (pure)

**Files:**
- Create: `lib/auth/upgrade-cookie.ts`
- Test: `lib/auth/upgrade-cookie.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/auth/upgrade-cookie.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseCookieHeader, sessionTokenFromCookies } from './upgrade-cookie';

describe('parseCookieHeader', () => {
  it('parses a cookie header into a map', () => {
    expect(parseCookieHeader('a=1; b=two; c=')).toEqual({ a: '1', b: 'two', c: '' });
  });
  it('returns empty for undefined', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});

describe('sessionTokenFromCookies', () => {
  it('prefers the __Secure- cookie, falls back to the plain one', () => {
    expect(sessionTokenFromCookies({ '__Secure-authjs.session-token': 'sec', 'authjs.session-token': 'plain' })).toBe('sec');
    expect(sessionTokenFromCookies({ 'authjs.session-token': 'plain' })).toBe('plain');
  });
  it('returns null when no session cookie is present', () => {
    expect(sessionTokenFromCookies({ other: 'x' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/auth/upgrade-cookie.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/auth/upgrade-cookie.ts`:
```ts
/** Parse a raw `Cookie:` header into a name→value map. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

// Auth.js v5 database-session cookie names: secure (https) first, then plain (http).
const SESSION_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];

/** The Auth.js session token from a parsed cookie map, or null. */
export function sessionTokenFromCookies(cookies: Record<string, string>): string | null {
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) return cookies[name];
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/auth/upgrade-cookie.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/upgrade-cookie.ts lib/auth/upgrade-cookie.test.ts
git commit -m "feat(auth): parse session token from a raw cookie header"
```

---

## Task 3: Resolve a user from a session token (DB)

`prisma` is services-only (the `no-prisma-outside-services` lint rule), so this lives in the users service.

**Files:**
- Modify: `lib/services/users.ts`
- Test: `lib/services/users.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/services/users.test.ts` (mirror the file's existing `withCleanDb`/`makeUser` setup):
```ts
import { getUserBySessionToken } from './users';

it('getUserBySessionToken returns the user for a live session, null for expired/missing', async () => {
  await withCleanDb(async (prisma) => {
    const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
    await prisma.session.create({
      data: { sessionToken: 'live-tok', userId: tom.id, expires: new Date(Date.now() + 60_000) },
    });
    await prisma.session.create({
      data: { sessionToken: 'dead-tok', userId: tom.id, expires: new Date(Date.now() - 60_000) },
    });
    expect((await getUserBySessionToken('live-tok', prisma))?.id).toBe(tom.id);
    expect(await getUserBySessionToken('dead-tok', prisma)).toBeNull();
    expect(await getUserBySessionToken('nope', prisma)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/users.test.ts`
Expected: FAIL — `getUserBySessionToken` not exported.

- [ ] **Step 3: Implement**

In `lib/services/users.ts` add (it already imports `prisma` and exports `getSessionUserById`):
```ts
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * Resolve the SessionUser for an Auth.js database-session token, or null if the
 * token is unknown or expired. Used to authenticate raw WebSocket upgrades,
 * which have no Next request context for `auth()`.
 */
export async function getUserBySessionToken(
  sessionToken: string,
  client: PrismaClient = defaultPrisma,
): Promise<SessionUser | null> {
  const session = await client.session.findUnique({ where: { sessionToken } });
  if (!session || session.expires <= new Date()) return null;
  return getSessionUserById(session.userId);
}
```
(If `users.ts` already imports `prisma`/`PrismaClient`, reuse those imports instead of duplicating.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/services/users.test.ts && pnpm lint lib/services/users.ts`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add lib/services/users.ts lib/services/users.test.ts
git commit -m "feat(users): resolve a user from an Auth.js session token"
```

---

## Task 4: Forge HMR path matcher (pure)

**Files:**
- Create: `lib/runtime/hmr-proxy.ts`
- Test: `lib/runtime/hmr-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/hmr-proxy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { forgeHmrTarget } from './hmr-proxy';

describe('forgeHmrTarget', () => {
  it('matches a forge HMR upgrade path and extracts slug + full path', () => {
    expect(forgeHmrTarget('/app/bmodi-test3/_next/webpack-hmr?id=abc'))
      .toEqual({ slug: 'bmodi-test3', path: '/app/bmodi-test3/_next/webpack-hmr?id=abc' });
  });
  it('matches any websocket path under a forge slug', () => {
    expect(forgeHmrTarget('/app/acme/_next/turbopack-hmr')?.slug).toBe('acme');
  });
  it('does NOT match the dashboard root HMR or non-/app paths', () => {
    expect(forgeHmrTarget('/_next/webpack-hmr')).toBeNull();
    expect(forgeHmrTarget('/api/forges/runtime')).toBeNull();
    expect(forgeHmrTarget('/app')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/hmr-proxy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/runtime/hmr-proxy.ts`:
```ts
// Matches an upgrade under a forge prefix: /app/<slug>/...  The dashboard's own
// HMR (/_next/...) and other paths are NOT matched and fall through to Next.
const FORGE_PATH = /^\/app\/([^/]+)\//;

export type ForgeHmrTarget = { slug: string; path: string };

/** If `path` is a WebSocket under /app/<slug>/, return its slug + full path. */
export function forgeHmrTarget(path: string): ForgeHmrTarget | null {
  const m = FORGE_PATH.exec(path);
  if (!m) return null;
  return { slug: m[1]!, path };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/hmr-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/hmr-proxy.ts lib/runtime/hmr-proxy.test.ts
git commit -m "feat(runtime): match forge HMR upgrade paths"
```

---

## Task 5: HMR upgrade gate + tunnel

Adds `handleForgeHmrUpgrade()` to `hmr-proxy.ts`. The gate (auth + slug→entry + ACL) is unit-tested with injected deps + a fake socket; the live frame-pipe is verified manually in Task 6 / e2e.

**Files:**
- Modify: `lib/runtime/hmr-proxy.ts`
- Test: `lib/runtime/hmr-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/hmr-proxy.test.ts`:
```ts
import { handleForgeHmrUpgrade, type HmrUpgradeDeps } from './hmr-proxy';

function fakeSocket() {
  return { destroyed: false, end: function () { this.destroyed = true; }, destroy: function () { this.destroyed = true; } } as unknown as import('node:net').Socket;
}
function deps(over: Partial<HmrUpgradeDeps>): HmrUpgradeDeps {
  return {
    getUserBySessionToken: async () => ({ id: 'u1' } as never),
    loadState: async () => ({ f1: { forgeId: 'f1', slug: 'acme', status: 'running', containerId: 'c', port: 3007, startedAt: 'x', logPath: '' } }) as never,
    loadForgeAcl: async () => ({ id: 'f1', createdById: 'u1', groups: [] }),
    canReadForge: () => true,
    tunnel: () => {},
    ...over,
  };
}

describe('handleForgeHmrUpgrade', () => {
  const req = (cookie?: string) => ({ url: '/app/acme/_next/webpack-hmr', headers: cookie ? { cookie } : {} }) as never;

  it('destroys the socket when there is no session', async () => {
    const sock = fakeSocket();
    let tunnelled = false;
    await handleForgeHmrUpgrade(req(), sock, Buffer.alloc(0), deps({
      getUserBySessionToken: async () => null, tunnel: () => { tunnelled = true; },
    }));
    expect(tunnelled).toBe(false);
    expect(sock.destroyed).toBe(true);
  });

  it('destroys the socket when ACL denies', async () => {
    const sock = fakeSocket();
    let tunnelled = false;
    await handleForgeHmrUpgrade(req('authjs.session-token=t'), sock, Buffer.alloc(0), deps({
      canReadForge: () => false, tunnel: () => { tunnelled = true; },
    }));
    expect(tunnelled).toBe(false);
    expect(sock.destroyed).toBe(true);
  });

  it('tunnels to runtimeOrigin(port)+path when authorized', async () => {
    const sock = fakeSocket();
    let target = '';
    await handleForgeHmrUpgrade(req('authjs.session-token=t'), sock, Buffer.alloc(0), deps({
      tunnel: (url) => { target = url; },
    }));
    expect(target).toBe('ws://127.0.0.1:3007/app/acme/_next/webpack-hmr');
    expect(sock.destroyed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/hmr-proxy.test.ts`
Expected: FAIL — `handleForgeHmrUpgrade` not exported.

- [ ] **Step 3: Implement the gate (+ a default tunnel)**

Append to `lib/runtime/hmr-proxy.ts`:
```ts
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { canReadForge as defaultCanReadForge } from '@/lib/acl';
import type { SessionUser } from '@/lib/services/types';
import type { RuntimeStateFile } from './types';
import { runtimeOrigin } from './proxy-target';
import { parseCookieHeader, sessionTokenFromCookies } from '@/lib/auth/upgrade-cookie';

export type ForgeAcl = { id: string; createdById: string; groups: string[] };

export type HmrUpgradeDeps = {
  getUserBySessionToken: (token: string) => Promise<SessionUser | null>;
  loadState: () => Promise<RuntimeStateFile>;
  loadForgeAcl: (forgeId: string) => Promise<ForgeAcl | null>;
  canReadForge: (user: SessionUser, acl: ForgeAcl) => boolean;
  /** Open the upstream forge socket and pipe frames. Injected for tests. */
  tunnel: (targetWsUrl: string, req: IncomingMessage, socket: Socket, head: Buffer, dashboardOrigin: string) => void;
};

/** ws origin the forge's allowedDevOrigins must trust (the page's own origin). */
function dashboardOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

export async function handleForgeHmrUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  deps: HmrUpgradeDeps,
): Promise<void> {
  const kill = () => { try { socket.destroy(); } catch { /* noop */ } };
  const target = forgeHmrTarget(req.url ?? '');
  if (!target) return kill();

  const token = sessionTokenFromCookies(parseCookieHeader(req.headers.cookie));
  if (!token) return kill();
  const user = await deps.getUserBySessionToken(token);
  if (!user) return kill();

  const state = await deps.loadState();
  const entry = Object.values(state).find((e) => e.slug === target.slug && e.status === 'running');
  if (!entry) return kill();

  const acl = await deps.loadForgeAcl(entry.forgeId);
  if (!acl || !deps.canReadForge(user, acl)) return kill();

  const wsBase = runtimeOrigin(entry.port).replace(/^http/, 'ws');
  deps.tunnel(wsBase + target.path, req, socket, head, dashboardOrigin(req));
}

/** Real upstream tunnel: accept the browser socket, dial the forge, pipe both ways. */
const tunnelServer = new WebSocketServer({ noServer: true });
export const defaultTunnel: HmrUpgradeDeps['tunnel'] = (targetWsUrl, req, socket, head, origin) => {
  tunnelServer.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(targetWsUrl, { headers: { origin } });
    const queue: Array<Buffer | string> = [];
    upstream.on('open', () => { for (const m of queue) upstream.send(m); queue.length = 0; });
    client.on('message', (d, isBin) => {
      const m = isBin ? (d as Buffer) : d.toString('utf8');
      if (upstream.readyState === WebSocket.OPEN) upstream.send(m); else queue.push(m);
    });
    upstream.on('message', (d, isBin) => {
      try { client.send(isBin ? (d as Buffer) : d.toString('utf8')); } catch { /* closed */ }
    });
    const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    client.on('close', closeBoth); upstream.on('close', closeBoth);
    client.on('error', closeBoth); upstream.on('error', closeBoth);
  });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/hmr-proxy.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/hmr-proxy.ts lib/runtime/hmr-proxy.test.ts
git commit -m "feat(runtime): gate + tunnel for the forge HMR websocket"
```

---

## Task 6: Wire the tunnel into the custom server

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Insert the forge-HMR branch into the upgrade dispatcher**

In `server.ts`, replace the `server.on('upgrade', …)` block with:
```ts
  const upgradeHandler = app.getUpgradeHandler();
  const { forgeHmrTarget, handleForgeHmrUpgrade, defaultTunnel } = await import('./lib/runtime/hmr-proxy');
  const { getUserBySessionToken } = await import('./lib/services/users');
  const { loadState } = await import('./lib/runtime/state');
  const { loadForgeAcl } = await import('./lib/services/runtime');
  const { canReadForge } = await import('./lib/acl');

  server.on('upgrade', (req, socket, head) => {
    if (forgeHmrTarget(req.url ?? '')) {
      void handleForgeHmrUpgrade(req, socket, head, {
        getUserBySessionToken: (t) => getUserBySessionToken(t),
        loadState,
        loadForgeAcl,
        canReadForge,
        tunnel: defaultTunnel,
      });
      return;
    }
    void upgradeHandler(req, socket, head); // dashboard's own HMR
  });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification (deferred until Task 8 lands `allowedDevOrigins`)**

The tunnel cannot fully succeed until the forge trusts the dashboard origin (Task 7/8). After those land, verify per "Final verification" below. For now, confirm the dashboard still boots and its own HMR works (`pnpm dev`, edit a dashboard file → hot update).

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat(server): tunnel forge HMR upgrades, delegate the rest to Next"
```

---

## Task 7: Inject `allowedDevOrigins` into the forge config wrapper

**Files:**
- Modify: `lib/runtime/container-setup.ts`
- Test: `lib/runtime/container-setup.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/container-setup.test.ts`:
```ts
it('basePath wrapper also injects allowedDevOrigins from FORGE_DEV_ORIGINS', async () => {
  const m = new FakeContainerManager();
  const id = await m.create({ name: 'x', image: 'img' });
  await setupForgeContainer(m, id, { slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log' });
  const inject = m.execCalls.find((c) => c.cmd === 'node' && c.args.join(' ').includes('next.config.base.ts'));
  expect(inject).toBeTruthy();
  expect(inject!.args.join(' ')).toContain('allowedDevOrigins');
  expect(inject!.args.join(' ')).toContain('FORGE_DEV_ORIGINS');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/container-setup.test.ts`
Expected: FAIL — wrapper has no `allowedDevOrigins`.

- [ ] **Step 3: Update the WRAPPER constant**

In `lib/runtime/container-setup.ts`, replace the `WRAPPER` constant with:
```ts
const WRAPPER = `// crystal-forge: basePath + dev origins injected for the reverse proxy. Do not edit.
import base from './next.config.base';
const basePath = process.env.FORGE_BASE_PATH || undefined;
const allowedDevOrigins = (process.env.FORGE_DEV_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
export default { ...base, basePath, ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}) };
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/container-setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container-setup.ts lib/runtime/container-setup.test.ts
git commit -m "feat(runtime): inject allowedDevOrigins into the forge config wrapper"
```

---

## Task 8: Pass `FORGE_DEV_ORIGINS` into the forge container

**Files:**
- Modify: `lib/env.ts`
- Modify: `lib/services/runtime.ts`
- Test: `lib/services/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/services/runtime.test.ts` (mirrors the existing "injects FORGE_BASE_PATH" test that captures `specs`):
```ts
it('injects FORGE_DEV_ORIGINS into the forge container env', async () => {
  await withCleanDb(async (prisma) => {
    const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
    const forge = await makeForge(prisma, { name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'] });
    const base = new FakeContainerManager();
    const specs: CreateContainerSpec[] = [];
    const recording: ContainerManager = {
      create: (s) => { specs.push(s); return base.create(s); },
      exec: base.exec.bind(base), inspect: base.inspect.bind(base),
      stop: base.stop.bind(base), remove: base.remove.bind(base), list: base.list.bind(base),
    };
    const svc = makeRuntimeService({ ...makeFakes(), prisma, containerManager: recording });
    await svc.startForge(tom, forge.id);
    expect(specs[0]?.env?.FORGE_DEV_ORIGINS).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/runtime.test.ts`
Expected: FAIL — `FORGE_DEV_ORIGINS` not in the env.

- [ ] **Step 3: Add the env var + inject it**

In `lib/env.ts`, add to the schema (near `FORGE_NETWORK`):
```ts
  // Comma-separated hostnames the forge dev server trusts for cross-origin dev
  // requests (Next allowedDevOrigins). Must include the dashboard/pilot host(s).
  FORGE_DEV_ORIGINS: z.string().default('localhost'),
```

In `lib/services/runtime.ts`, add to the `env` object in the `containerManager.create({...})` call (alongside `FORGE_BASE_PATH`):
```ts
        FORGE_DEV_ORIGINS: env.FORGE_DEV_ORIGINS,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/services/runtime.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts lib/services/runtime.ts lib/services/runtime.test.ts
git commit -m "feat(runtime): pass FORGE_DEV_ORIGINS to the forge container"
```

---

## Task 9: nginx WebSocket-passthrough note (PILOT)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the note**

Append to `README.md` under a "Pilot / deployment" section:
```markdown
### nginx (pilot): WebSocket passthrough for forge HMR

The dashboard runs forge previews under `/app/<slug>/` and tunnels each forge's
Fast Refresh WebSocket through the same origin. The `location` block that
forwards to the dashboard must carry the WebSocket upgrade headers:

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

This is a one-time, non-per-forge addition. Forge runtime ports stay
loopback-bound and are never exposed.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: nginx websocket passthrough note for pilot forge HMR"
```

---

## Final verification

- [ ] **Step 1: Suite + lint + typecheck**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

- [ ] **Step 2: Rebuild runtime image is NOT required** (no Dockerfile change in this plan). Restart the dashboard so the custom server + new env take effect: stop the dashboard task and `./forge-launch.sh`.

- [ ] **Step 3: Restart a forge in dev mode and verify HMR end-to-end (manual)**

With `FORGE_DEV_ORIGINS` set to include `localhost` (default) — start a forge from the dashboard, open `/app/<slug>/<route>`, then:
1. Confirm the page is **interactive** (e.g. the calculator computes) — proves hydration now works in dev mode through the proxy.
2. Confirm the browser console shows the HMR socket **connected** (no repeating `webpack-hmr failed`).
3. Have the agent (or you) edit a component; confirm the preview **hot-updates without a refresh**.

If hydration works but the HMR socket still errors, re-check `FORGE_DEV_ORIGINS` includes the exact host in the browser URL (e.g. add the LAN IP or pilot host).

---

## Notes / risks

- **Task 1 is a hard gate.** If `app.getUpgradeHandler()` is undefined or Next 16 misbehaves under the custom server, stop and implement the spec's fallback (standalone WS-proxy service + nginx for pilot; prod-mode locally) instead of Tasks 2–9's server wiring.
- The live frame-pipe in `defaultTunnel` is exercised by manual/e2e (Step 3), not unit tests — websocket piping isn't meaningfully unit-testable. The **gate** (the security-critical part) is fully unit-tested in Task 5.
- `loadForgeAcl` is already exported from `lib/services/runtime.ts` (used by the HTTP preview proxy); reuse it.
