# Session-gated Forge Installation Tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long-lived `FORGE_GIT_TOKEN` PAT injected into every forge container with short-lived, repo-scoped GitHub App installation tokens that a dashboard-side refresher keeps fresh only while a conversation pane is open.

**Architecture:** The GitHub App client mints a repo-scoped installation token (`contents:write` + `pull_requests:write`). A `TokenRefresher` in the dashboard process (wired into the WebSocket server) ref-counts open conversations per container; on the first session it mints a token and writes it into the forge's `gh` credential store (`hosts.yml`), re-minting every 45 min, and stops when the last pane closes. `git` already delegates to `gh` (`gh auth setup-git`), so both read the refreshed token per invocation. The container-level `GH_TOKEN` PAT injection is removed.

**Tech Stack:** TypeScript (strict), Next.js 16 custom server (`instrumentation.ts`), Octokit + `@octokit/auth-app`, `ws`, node-pty, Vitest, Docker (`docker exec`).

## Global Constraints

- **Octokit only inside `lib/github/`** — enforced by the `no-octokit-outside-github` ESLint rule. The scoped-token mint lives in `lib/github/octokit-client.ts`.
- **Never put a secret in argv** — tokens pass through the exec *environment* only, never command arguments (they would leak into `docker ps`/process listings/logs). Mirror the existing clone at `lib/runtime/container-setup.ts:38`.
- **Tests colocated** as `*.test.ts` next to source. Unit runner: `pnpm test <file>` (= `vitest run <file>`); filter by name with `-t "<name>"`.
- **`GITHUB_CLIENT_MODE=fake`** must keep working offline — every new interface method gets a `FakeGitHubClient` implementation.
- **Deleting in-repo dead code is pre-approved** (git is the backup) — prefer removing superseded code over leaving clutter. `getInstallationToken()` and the dead host-side `clone.ts` are removed once their last callers are gone (Task 4b). Deleting anything *outside* the repo still needs approval.
- Container constants: `CLAUDE_HOME = /home/forge` (the agent's `$HOME`, a persistent volume), `CONTAINER_WORKDIR = /workspace` (from `lib/runtime/paths.ts`).
- Token lifetime is ~1h (GitHub-fixed); refresh cadence **45 min**, failure-retry **5 min**.
- Verify each task with `pnpm typecheck` before committing.

---

## File Structure

- `lib/github/types.ts` — add `getScopedInstallationToken` to the `GitHubClient` interface.
- `lib/github/octokit-client.ts` — real scoped-token mint via App auth.
- `lib/github/fake-client.ts` — fake scoped-token mint.
- `lib/runtime/gh-credential.ts` *(new)* — `writeForgeGitToken(mgr, containerId, token)`: write the token into the forge's `gh` `hosts.yml`.
- `lib/runtime/token-refresher.ts` *(new)* — `createTokenRefresher(deps)`: ref-counted, self-rescheduling refresher.
- `lib/runtime/types.ts` — add `repoFullName?` to `RuntimeStateEntry`.
- `lib/runtime/state.ts` — `loadRuntimeHandle` returns `repoFullName`.
- `lib/services/runtime.ts` — store `repoFullName` in state; clone uses scoped token; remove PAT env injection.
- `lib/runtime/container-setup.ts` — seed `hosts.yml` with the create-time token.
- `lib/runtime/ws-server.ts` — acquire/release the refresher around a session; terminal notice on mint failure.
- `instrumentation.ts` — construct the real `TokenRefresher` and pass it to `startWsServer`.
- `lib/env.ts` — remove `FORGE_GIT_TOKEN`.
- **Deletions (Task 4b):** `lib/runtime/clone.ts` + `lib/runtime/clone.test.ts` (dead host-side clone, superseded by the in-container clone); `forgeClonePath` from `lib/runtime/paths.ts`; `getInstallationToken` from `lib/github/{types,octokit-client,fake-client}.ts` and its two test blocks.

---

## Task 1: Repo-scoped installation token in the GitHub client

**Files:**
- Modify: `lib/github/types.ts` (interface)
- Modify: `lib/github/octokit-client.ts:144` (add method after `getInstallationToken`)
- Modify: `lib/github/fake-client.ts:98` (add method after `getInstallationToken`)
- Test: `lib/github/octokit-client.test.ts`, `lib/github/fake-client.test.ts`

**Interfaces:**
- Produces: `getScopedInstallationToken(repoFullName: string): Promise<{ token: string; expiresAt: string }>` on `GitHubClient`.

- [ ] **Step 1: Add the failing fake-client test**

In `lib/github/fake-client.test.ts` add:

```ts
describe('FakeGitHubClient.getScopedInstallationToken', () => {
  it('returns a deterministic token and far-future expiry for the repo', async () => {
    const fake = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
    const res = await fake.getScopedInstallationToken('test-owner/aquaflow');
    expect(res.token).toBe('fake-scoped-token:test-owner/aquaflow');
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test lib/github/fake-client.test.ts -t "getScopedInstallationToken"`
Expected: FAIL — `getScopedInstallationToken is not a function`.

- [ ] **Step 3: Add the interface method**

In `lib/github/types.ts`, immediately after the `getInstallationToken(): Promise<string>;` declaration (`:80`), add:

```ts
  /**
   * Mints a repo-scoped installation token (contents + pull_requests write)
   * for `repoFullName` ("owner/repo"). Short-lived (~1h). Returns the token
   * and its expiry. Used for in-forge git/gh, refreshed while a session is open.
   */
  getScopedInstallationToken(repoFullName: string): Promise<{ token: string; expiresAt: string }>;
```

- [ ] **Step 4: Implement the fake**

In `lib/github/fake-client.ts`, after `getInstallationToken` (`:100`), add:

```ts
  async getScopedInstallationToken(
    repoFullName: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return {
      token: `fake-scoped-token:${repoFullName}`,
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
  }
```

- [ ] **Step 5: Run the fake test — expect PASS**

Run: `pnpm test lib/github/fake-client.test.ts -t "getScopedInstallationToken"`
Expected: PASS.

- [ ] **Step 6: Add the failing octokit test**

Look at `lib/github/octokit-client.test.ts:331` to match how the existing `getInstallationToken` test stubs `client.auth`. Add a sibling test:

```ts
describe('OctokitGitHubClient.getScopedInstallationToken', () => {
  it('requests a token scoped to the repo with contents+PR write and returns token+expiry', async () => {
    const authCalls: unknown[] = [];
    const octokit = {
      auth: async (opts: unknown) => {
        authCalls.push(opts);
        return { token: 'ghs_scoped', expiresAt: '2026-07-16T12:00:00.000Z' };
      },
    } as unknown as import('@octokit/rest').Octokit;
    const client = new OctokitGitHubClient({
      owner: 'test-owner',
      templateRepo: 'test-owner/tmpl',
      appId: '1', privateKey: 'k', installationId: '2',
      octokit,
    });
    const res = await client.getScopedInstallationToken('test-owner/aquaflow');
    expect(res).toEqual({ token: 'ghs_scoped', expiresAt: '2026-07-16T12:00:00.000Z' });
    expect(authCalls[0]).toEqual({
      type: 'installation',
      repositoryNames: ['aquaflow'],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
  });
});
```

- [ ] **Step 7: Run it — expect FAIL**

Run: `pnpm test lib/github/octokit-client.test.ts -t "getScopedInstallationToken"`
Expected: FAIL — method missing.

- [ ] **Step 8: Implement the real mint**

In `lib/github/octokit-client.ts`, after `getInstallationToken` (`:151`), add:

```ts
  async getScopedInstallationToken(
    repoFullName: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const repo = repoFullName.split('/')[1];
    if (!repo) throw new Error(`repoFullName must be "owner/repo": ${repoFullName}`);
    // octokit-auth-app returns a repo+permission-scoped installation token
    // through the same client.auth() callable when given repositoryNames/permissions.
    const auth = (this.client as unknown as {
      auth: (opts: {
        type: 'installation';
        repositoryNames: string[];
        permissions: Record<string, string>;
      }) => Promise<{ token: string; expiresAt: string }>;
    }).auth;
    const result = await auth({
      type: 'installation',
      repositoryNames: [repo],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    return { token: result.token, expiresAt: result.expiresAt };
  }
```

- [ ] **Step 9: Run both suites — expect PASS**

Run: `pnpm test lib/github/octokit-client.test.ts lib/github/fake-client.test.ts`
Expected: PASS. Then `pnpm typecheck` — clean.

- [ ] **Step 10: Commit**

```bash
git add lib/github/types.ts lib/github/octokit-client.ts lib/github/fake-client.ts lib/github/octokit-client.test.ts lib/github/fake-client.test.ts
git commit -m "feat(github): add repo-scoped installation token mint"
```

---

## Task 2: `writeForgeGitToken` — write the token into the forge's gh store

**Files:**
- Create: `lib/runtime/gh-credential.ts`
- Test: `lib/runtime/gh-credential.test.ts`

**Interfaces:**
- Consumes: `ContainerManager.exec` from `lib/runtime/container/types.ts`; `CLAUDE_HOME` from `lib/runtime/paths.ts`.
- Produces: `writeForgeGitToken(mgr: ContainerManager, containerId: string, token: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/gh-credential.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeForgeGitToken } from './gh-credential';
import type { ContainerManager, ExecOpts } from './container/types';

function recordingManager(exitCode = 0) {
  const calls: { cmd: string; args: string[]; opts?: ExecOpts }[] = [];
  const mgr = {
    create: async () => 'id',
    exec: async (_id: string, cmd: string, args: string[], opts?: ExecOpts) => {
      calls.push({ cmd, args, opts });
      return { exitCode };
    },
    inspect: async () => ({ exists: true, running: true }),
    stop: async () => {},
    remove: async () => {},
    list: async () => [],
  } as ContainerManager;
  return { mgr, calls };
}

describe('writeForgeGitToken', () => {
  it('writes hosts.yml under /home/forge and passes the token via env, never argv', async () => {
    const { mgr, calls } = recordingManager();
    await writeForgeGitToken(mgr, 'cid', 'ghs_secret');
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0];
    expect(cmd).toBe('sh');
    const script = args[args.length - 1];
    expect(script).toContain('/home/forge/.config/gh/hosts.yml');
    expect(script).toContain('$FORGE_GH_TOKEN');
    expect(args.join(' ')).not.toContain('ghs_secret'); // token never in argv
    expect(opts?.env).toEqual({ FORGE_GH_TOKEN: 'ghs_secret' });
  });

  it('throws when the exec exits non-zero', async () => {
    const { mgr } = recordingManager(1);
    await expect(writeForgeGitToken(mgr, 'cid', 't')).rejects.toThrow(/write gh token/i);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm test lib/runtime/gh-credential.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `lib/runtime/gh-credential.ts`:

```ts
import type { ContainerManager } from './container/types';
import { CLAUDE_HOME } from './paths';

const HOSTS_YML = `${CLAUDE_HOME}/.config/gh/hosts.yml`;
const WRITE_TIMEOUT_MS = 30_000;

/**
 * Write `token` into the forge's `gh` credential store (hosts.yml) so both the
 * `gh` CLI and `git` (via `gh auth setup-git` → `gh auth git-credential`) pick
 * it up on their next invocation. The token is passed through the exec
 * environment ($FORGE_GH_TOKEN), never argv, so it never leaks into process
 * listings or logs. Container-level GH_TOKEN must be unset, or it would shadow
 * hosts.yml in `gh`.
 */
export async function writeForgeGitToken(
  mgr: ContainerManager,
  containerId: string,
  token: string,
): Promise<void> {
  const script =
    `set -e; mkdir -p "$(dirname "${HOSTS_YML}")"; ` +
    `printf 'github.com:\\n    oauth_token: %s\\n    user: x-access-token\\n    git_protocol: https\\n' ` +
    `"$FORGE_GH_TOKEN" > "${HOSTS_YML}"`;
  const { exitCode } = await mgr.exec(containerId, 'sh', ['-c', script], {
    env: { FORGE_GH_TOKEN: token },
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (exitCode !== 0) throw new Error(`write gh token failed (exit ${exitCode})`);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm test lib/runtime/gh-credential.test.ts`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/gh-credential.ts lib/runtime/gh-credential.test.ts
git commit -m "feat(runtime): write scoped token into forge gh credential store"
```

---

## Task 3: `createTokenRefresher` — ref-counted, self-rescheduling refresher

**Files:**
- Create: `lib/runtime/token-refresher.ts`
- Test: `lib/runtime/token-refresher.test.ts`

**Interfaces:**
- Produces:
  - `type Scheduler = { schedule(fn: () => void, ms: number): unknown; cancel(handle: unknown): void }`
  - `type TokenRefresherDeps = { mint: (repoFullName: string) => Promise<{ token: string; expiresAt: string }>; write: (containerId: string, token: string) => Promise<void>; scheduler?: Scheduler; refreshMs?: number; retryMs?: number; onError?: (containerId: string, err: unknown) => void }`
  - `type TokenRefresher = { acquire(containerId: string, repoFullName: string): Promise<boolean>; release(containerId: string): void }`
  - `createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher`
- `acquire` returns `true` iff a valid token has been written for the container (used by the WS server to decide whether to warn the user). It never throws.

- [ ] **Step 1: Write the failing tests**

Create `lib/runtime/token-refresher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createTokenRefresher, type Scheduler } from './token-refresher';

// A scheduler that captures jobs so the test drives time by hand.
function fakeScheduler() {
  const jobs: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const scheduler: Scheduler = {
    schedule: (fn, ms) => { const j = { fn, ms, cancelled: false }; jobs.push(j); return j; },
    cancel: (h) => { (h as { cancelled: boolean }).cancelled = true; },
  };
  // fire the most recently scheduled, still-live job
  const fireLast = async () => {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (!jobs[i].cancelled) { jobs[i].cancelled = true; jobs[i].fn(); break; }
    }
    await Promise.resolve(); await Promise.resolve();
  };
  return { scheduler, jobs, fireLast };
}

describe('createTokenRefresher', () => {
  it('mints and writes once on first acquire, and schedules the next refresh', async () => {
    const { scheduler, jobs } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't1', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000, retryMs: 100 });

    const ok = await r.acquire('cid', 'own/repo');

    expect(ok).toBe(true);
    expect(mint).toHaveBeenCalledExactlyOnceWith('own/repo');
    expect(write).toHaveBeenCalledExactlyOnceWith('cid', 't1');
    expect(jobs.filter((j) => !j.cancelled)).toHaveLength(1);
    expect(jobs[0].ms).toBe(1000);
  });

  it('does not re-mint on a second acquire for the same container (ref-count)', async () => {
    const { scheduler } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler });
    await r.acquire('cid', 'own/repo');
    await r.acquire('cid', 'own/repo');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('re-mints when the scheduled refresh fires', async () => {
    const { scheduler, fireLast } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000 });
    await r.acquire('cid', 'own/repo');
    await fireLast();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('on mint failure: acquire returns false, calls onError, and schedules a retry', async () => {
    const { scheduler, jobs } = fakeScheduler();
    const mint = vi.fn(async () => { throw new Error('boom'); });
    const write = vi.fn(async () => {});
    const onError = vi.fn();
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000, retryMs: 100, onError });
    const ok = await r.acquire('cid', 'own/repo');
    expect(ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(jobs.filter((j) => !j.cancelled)[0].ms).toBe(100); // retry cadence
  });

  it('release at zero ref-count cancels the pending timer and stops re-minting', async () => {
    const { scheduler, jobs, fireLast } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000 });
    await r.acquire('cid', 'own/repo');
    r.release('cid');
    expect(jobs.every((j) => j.cancelled)).toBe(true);
    await fireLast(); // nothing live to fire
    expect(mint).toHaveBeenCalledTimes(1); // no re-mint after release
  });
});
```

> Note: `toHaveBeenCalledExactlyOnceWith` is available in the Vitest version here; if a red appears on the matcher itself, substitute `toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(...)`.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm test lib/runtime/token-refresher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the refresher**

Create `lib/runtime/token-refresher.ts`:

```ts
export type Scheduler = {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

export type TokenRefresherDeps = {
  mint: (repoFullName: string) => Promise<{ token: string; expiresAt: string }>;
  write: (containerId: string, token: string) => Promise<void>;
  scheduler?: Scheduler;
  refreshMs?: number;
  retryMs?: number;
  onError?: (containerId: string, err: unknown) => void;
};

export type TokenRefresher = {
  acquire(containerId: string, repoFullName: string): Promise<boolean>;
  release(containerId: string): void;
};

const DEFAULT_REFRESH_MS = 45 * 60 * 1000; // under GitHub's ~60m token life
const DEFAULT_RETRY_MS = 5 * 60 * 1000;

const defaultScheduler: Scheduler = {
  schedule: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Entry = {
  refs: number;
  repoFullName: string;
  handle: unknown;
  hasToken: boolean;
  stopped: boolean;
};

export function createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher {
  const scheduler = deps.scheduler ?? defaultScheduler;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const entries = new Map<string, Entry>();

  async function tick(containerId: string): Promise<void> {
    const e = entries.get(containerId);
    if (!e || e.stopped) return; // released mid-flight
    try {
      const { token } = await deps.mint(e.repoFullName);
      await deps.write(containerId, token);
      e.hasToken = true;
      e.handle = scheduler.schedule(() => { void tick(containerId); }, refreshMs);
    } catch (err) {
      deps.onError?.(containerId, err);
      e.handle = scheduler.schedule(() => { void tick(containerId); }, retryMs);
    }
  }

  return {
    async acquire(containerId, repoFullName) {
      const existing = entries.get(containerId);
      if (existing) { existing.refs += 1; return existing.hasToken; }
      const e: Entry = { refs: 1, repoFullName, handle: null, hasToken: false, stopped: false };
      entries.set(containerId, e);
      await tick(containerId); // mint before the first git op; never throws
      return e.hasToken;
    },
    release(containerId) {
      const e = entries.get(containerId);
      if (!e) return;
      e.refs -= 1;
      if (e.refs > 0) return;
      e.stopped = true;
      if (e.handle != null) scheduler.cancel(e.handle);
      entries.delete(containerId);
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm test lib/runtime/token-refresher.test.ts`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/token-refresher.ts lib/runtime/token-refresher.test.ts
git commit -m "feat(runtime): session-gated installation-token refresher"
```

---

## Task 4: Carry `repoFullName` in runtime state; scope the clone; drop the PAT

**Files:**
- Modify: `lib/runtime/types.ts:8-17` (`RuntimeStateEntry`)
- Modify: `lib/runtime/state.ts:65-71` (`loadRuntimeHandle`)
- Modify: `lib/services/runtime.ts` (baseEntry `:118-124`; clone token `:180`; remove PAT env `:163-166`)
- Test: `lib/runtime/state.test.ts`, `lib/services/runtime.test.ts`

**Interfaces:**
- Consumes: `getScopedInstallationToken` (Task 1).
- Produces: `loadRuntimeHandle(forgeId): Promise<{ containerId: string; port: number; repoFullName?: string } | null>`.

- [ ] **Step 1: Failing test — handle carries repoFullName**

In `lib/runtime/state.test.ts`, add a case (follow the existing `loadRuntimeHandle` setup for how state is seeded):

```ts
it('loadRuntimeHandle returns repoFullName when present in state', async () => {
  await mutateState((s) => {
    s['f1'] = {
      forgeId: 'f1', slug: 'aquaflow', status: 'running',
      containerId: 'c1', port: 3210, startedAt: '2026-07-16T00:00:00Z',
      logPath: '/tmp/x.log', repoFullName: 'own/aquaflow',
    };
  });
  const h = await loadRuntimeHandle('f1');
  expect(h).toEqual({ containerId: 'c1', port: 3210, repoFullName: 'own/aquaflow' });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm test lib/runtime/state.test.ts -t "repoFullName"`
Expected: FAIL — `repoFullName` absent from the returned handle (and a TS error on the seed object).

- [ ] **Step 3: Add the field and return it**

In `lib/runtime/types.ts`, add to `RuntimeStateEntry` (after `logPath: string;`):

```ts
  /** "owner/repo" for the forge's GitHub repo; used to scope the in-forge token. Optional for entries written before this feature. */
  repoFullName?: string;
```

In `lib/runtime/state.ts`, change the `loadRuntimeHandle` return type and body:

```ts
export async function loadRuntimeHandle(
  forgeId: string,
): Promise<{ containerId: string; port: number; repoFullName?: string } | null> {
  const state = await loadState();
  const e = state[forgeId];
  return e ? { containerId: e.containerId, port: e.port, repoFullName: e.repoFullName } : null;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm test lib/runtime/state.test.ts -t "repoFullName"`
Expected: PASS.

- [ ] **Step 5: Failing tests for the runtime service changes**

Open `lib/services/runtime.test.ts` and find the start/finishStart tests (they inject a fake `githubClient`, `containerManager`, and `setup`). Add/adjust:

1. The fake `githubClient` must implement `getScopedInstallationToken` (returning `{ token: 'scoped-tok', expiresAt: 'x' }`) — add it to whatever fake/stub the test uses.
2. Add an assertion that the container `create` spec's `env` has **no** `GH_TOKEN` key.
3. Add an assertion that `setup` is called with `token: 'scoped-tok'`.
4. Add an assertion that the persisted state entry for the forge has `repoFullName` set to the fake forge's repo.

Concretely (adapt names to the existing harness):

```ts
it('does not inject GH_TOKEN and clones with a repo-scoped token', async () => {
  // ...arrange start with a fake forge whose repoFullName is 'own/aquaflow'...
  await startForge(/* ... */);
  const createSpec = containerManager.createCalls.at(-1)!; // however the fake records it
  expect(createSpec.env).not.toHaveProperty('GH_TOKEN');
  expect(setupCalls.at(-1)!.token).toBe('scoped-tok');
  const state = await loadState();
  expect(state[forgeId].repoFullName).toBe('own/aquaflow');
});
```

- [ ] **Step 6: Run — expect FAIL**

Run: `pnpm test lib/services/runtime.test.ts -t "scoped token"`
Expected: FAIL — `GH_TOKEN` still present / `getScopedInstallationToken` missing on the fake / `repoFullName` unset.

- [ ] **Step 7: Apply the runtime service changes**

In `lib/services/runtime.ts`:

a) Add `repoFullName` to the `baseEntry` literal (currently `{ forgeId, slug, status: 'starting', containerId: '', port, startedAt, logPath: log }` near `:118`):

```ts
      forgeId, slug, status: 'starting',
      containerId: '', port, startedAt, logPath: log,
      repoFullName: row.repoFullName,
```

b) Remove the PAT injection at `:163-166`. Delete the comment block and the line, so the `env` object ends at `DATABASE_URL: databaseUrl,`:

```ts
      env: {
        PORT: '3000',
        NEXT_TELEMETRY_DISABLED: '1',
        FORGE_BASE_PATH: `/app/${slug}`,
        FORGE_DEV_ORIGINS: env.FORGE_DEV_ORIGINS,
        DATABASE_URL: databaseUrl,
      },
```

c) Change the clone token mint at `:180`:

```ts
      const token = (await deps.githubClient.getScopedInstallationToken(repoFullName)).token;
```

- [ ] **Step 8: Run — expect PASS**

Run: `pnpm test lib/services/runtime.test.ts`
Expected: PASS (fix any other tests that asserted the old `GH_TOKEN` env or `getInstallationToken` call). Then `pnpm typecheck`.

- [ ] **Step 9: Commit**

```bash
git add lib/runtime/types.ts lib/runtime/state.ts lib/runtime/state.test.ts lib/services/runtime.ts lib/services/runtime.test.ts
git commit -m "feat(runtime): store repoFullName, scope clone token, drop PAT env"
```

---

## Task 4b: Delete dead host-side clone code and remove `getInstallationToken`

Must run **after** Task 4 (which was the last thing still calling `getInstallationToken`). At this point `getInstallationToken`'s only remaining reference is `clone.ts` (itself dead) plus tests.

**Files:**
- Delete: `lib/runtime/clone.ts`, `lib/runtime/clone.test.ts`
- Modify: `lib/runtime/paths.ts` (remove `forgeClonePath`)
- Modify: `lib/github/types.ts` (remove `getInstallationToken` from the interface, `:75-80`)
- Modify: `lib/github/octokit-client.ts:144-151` (remove the method)
- Modify: `lib/github/fake-client.ts:98-100` (remove the method)
- Modify: `lib/github/octokit-client.test.ts:331` and `lib/github/fake-client.test.ts:144` (delete the `getInstallationToken` describe blocks)
- Modify: `tests/e2e/forge-orchestration.spec.ts:29-30` (reword the stale `ensureClone` comment)

- [ ] **Step 1: Confirm no live callers remain**

```bash
grep -rn "ensureClone\|forgeClonePath" --include=*.ts . | grep -v node_modules
grep -rn "getInstallationToken" --include=*.ts . | grep -v node_modules
```

Expected: `ensureClone`/`forgeClonePath` appear only in `clone.ts` (and a comment); `getInstallationToken` appears only in `clone.ts`, the interface, the two impls, and the two test blocks — **no** production caller outside `clone.ts`. If anything else shows up, stop and reassess.

- [ ] **Step 2: Delete the dead clone files**

```bash
git rm lib/runtime/clone.ts lib/runtime/clone.test.ts
```

- [ ] **Step 3: Remove `forgeClonePath` from `lib/runtime/paths.ts`**

Delete the `forgeClonePath` function (`:17`). Leave `logPath` and the rest intact.

- [ ] **Step 4: Remove `getInstallationToken` everywhere**

- `lib/github/types.ts`: delete the `getInstallationToken(): Promise<string>;` declaration and its doc comment (`:75-80`).
- `lib/github/octokit-client.ts`: delete the `async getInstallationToken()` method (`:144-151`).
- `lib/github/fake-client.ts`: delete the `async getInstallationToken()` method (`:98-100`).
- `lib/github/octokit-client.test.ts`: delete the `describe('OctokitGitHubClient.getInstallationToken', …)` block (`:331`).
- `lib/github/fake-client.test.ts`: delete the `describe('FakeGitHubClient.getInstallationToken', …)` block (`:144`).

- [ ] **Step 5: Reword the stale e2e comment**

In `tests/e2e/forge-orchestration.spec.ts` (`:29-30`), replace the comment that references `ensureClone` with one that reflects reality:

```ts
  // package.json: dev script invokes server.js; prisma script is a no-op so
  // container-setup's `pnpm prisma generate` step exits 0 without needing the CLI.
```

- [ ] **Step 6: Typecheck, test, lint**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: clean. TypeScript will flag any missed reference to the removed method — fix and re-run.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(github): drop unused getInstallationToken and dead clone.ts"
```

---

## Task 5: Seed the gh credential store at container setup

**Files:**
- Modify: `lib/runtime/container-setup.ts` (add a step after `1b`, `:55`)
- Test: `lib/runtime/container-setup.test.ts`

**Interfaces:**
- Consumes: `writeForgeGitToken` (Task 2); `SetupOpts.token` already carries the create-time scoped token.

- [ ] **Step 1: Failing test**

In `lib/runtime/container-setup.test.ts` (it already drives `setupForgeContainer` with a fake manager that records exec calls — follow that harness), add:

```ts
it('seeds the gh credential store with the create-time token', async () => {
  // ...run setupForgeContainer with opts.token = 'ghs_seed'...
  const wrote = execCalls.find((c) =>
    c.cmd === 'sh' && c.args.at(-1)?.includes('/home/forge/.config/gh/hosts.yml'));
  expect(wrote).toBeTruthy();
  expect(wrote!.opts?.env).toEqual({ FORGE_GH_TOKEN: 'ghs_seed' });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm test lib/runtime/container-setup.test.ts -t "gh credential store"`
Expected: FAIL — no such exec recorded.

- [ ] **Step 3: Implement**

In `lib/runtime/container-setup.ts`, add the import at the top:

```ts
import { writeForgeGitToken } from './gh-credential';
```

Then, immediately after the `gh auth setup-git` step (`:55`), add:

```ts
  // 1c. Seed the gh credential store with the create-time scoped token so git/gh
  //     work before the session-gated refresher takes over. The refresher
  //     (dashboard side) overwrites this while a conversation is open; when idle
  //     the token simply expires. Container-level GH_TOKEN is intentionally not
  //     set, so hosts.yml is the sole source for both git and gh.
  await writeForgeGitToken(mgr, id, opts.token);
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm test lib/runtime/container-setup.test.ts`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container-setup.ts lib/runtime/container-setup.test.ts
git commit -m "feat(runtime): seed gh credential store at container setup"
```

---

## Task 6: Wire the refresher into the WebSocket server

**Files:**
- Modify: `lib/runtime/ws-server.ts` (`WsServerOpts` `:13-23`; `ActiveSession`/handle handling `:57-105`)
- Test: `lib/runtime/ws-server.test.ts`

**Interfaces:**
- Consumes: `TokenRefresher` (Task 3); `loadRuntimeHandle` now returns `repoFullName` (Task 4).
- Produces: `WsServerOpts.tokenRefresher?: TokenRefresher` (defaults to a no-op so existing callers/tests are unaffected).

- [ ] **Step 1: Failing test — acquire on connect, release on close**

In `lib/runtime/ws-server.test.ts` (it already stands up the server with injected `spawnPty`, `loadConversation`, `loadRuntimeHandle`, etc.), add a fake refresher and assert lifecycle. Follow the existing connect helper; the key assertions:

```ts
it('acquires a token on connect and releases it on close', async () => {
  const acquire = vi.fn(async () => true);
  const release = vi.fn(() => {});
  // loadRuntimeHandle stub must now return repoFullName:
  const loadRuntimeHandle = async () => ({ containerId: 'c1', port: 1, repoFullName: 'own/aquaflow' });
  // ...start server with { ..., loadRuntimeHandle, tokenRefresher: { acquire, release } } ...
  // ...open a WS connection for a valid conversation, wait for session setup...
  expect(acquire).toHaveBeenCalledWith('c1', 'own/aquaflow');
  // ...close the socket...
  await vi.waitFor(() => expect(release).toHaveBeenCalledWith('c1'));
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm test lib/runtime/ws-server.test.ts -t "acquires a token"`
Expected: FAIL — `tokenRefresher` not consumed.

- [ ] **Step 3: Implement the wiring**

In `lib/runtime/ws-server.ts`:

a) Import the type:

```ts
import type { TokenRefresher } from './token-refresher';
```

b) Add to `WsServerOpts`:

```ts
  tokenRefresher?: TokenRefresher;
  loadRuntimeHandle?: (forgeId: string) => Promise<{ containerId: string; port: number; repoFullName?: string } | null>;
```

(Replace the existing `loadRuntimeHandle?` line so the return type includes `repoFullName`.)

c) In `startWsServer`, after the other dep defaults (`:42`), add:

```ts
  const tokenRefresher: TokenRefresher =
    opts.tokenRefresher ?? { acquire: async () => true, release: () => {} };
```

d) In the `connection` handler, after `handle` is validated (`:58`) and before spawning the PTY, acquire and warn on failure:

```ts
      if (handle.repoFullName) {
        const hasToken = await tokenRefresher.acquire(handle.containerId, handle.repoFullName);
        if (!hasToken) {
          try { ws.send('\r\n[crystal-forge] GitHub token unavailable — git/gh may fail until it refreshes.\r\n'); } catch { /* socket closed */ }
        }
      }
```

e) Release in both teardown paths. In `pty.onExit` (`:80-84`) and in `ws.on('close')` (`:101-105`), add alongside the existing `sessions.delete(cid)`:

```ts
        tokenRefresher.release(handle.containerId);
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm test lib/runtime/ws-server.test.ts`
Expected: PASS (update any existing test whose `loadRuntimeHandle` stub lacked `repoFullName` — it's optional, so most compile unchanged). Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ws-server.ts lib/runtime/ws-server.test.ts
git commit -m "feat(runtime): acquire/release scoped token around a forge session"
```

---

## Task 7: Construct the real refresher; remove `FORGE_GIT_TOKEN`

**Files:**
- Modify: `instrumentation.ts:1-30`
- Modify: `lib/env.ts` (remove `FORGE_GIT_TOKEN` `:35-40`)
- Test: `lib/env.test.ts` (if it asserts on `FORGE_GIT_TOKEN`)

**Interfaces:**
- Consumes: `createTokenRefresher` (Task 3), `writeForgeGitToken` (Task 2), `getGitHubClient` (`@/lib/github/client`), `getContainerManager` (`@/lib/runtime/container`).

- [ ] **Step 1: Remove the env var**

In `lib/env.ts`, delete the `FORGE_GIT_TOKEN` field and its comment (`:35-40`). Then grep to confirm no remaining references:

```bash
grep -rn "FORGE_GIT_TOKEN" --include=*.ts . | grep -v node_modules
```

Expected: no hits (if `lib/env.test.ts` referenced it, remove that assertion).

- [ ] **Step 2: Wire the real refresher in `instrumentation.ts`**

`instrumentation.ts` uses dynamic imports in its `register()`. Match that style. Before the `startWsServer` call (`:29`), add:

```ts
    const { getGitHubClient } = await import('@/lib/github/client');
    const { getContainerManager } = await import('@/lib/runtime/container');
    const { createTokenRefresher } = await import('./lib/runtime/token-refresher');
    const { writeForgeGitToken } = await import('./lib/runtime/gh-credential');

    const github = getGitHubClient();
    const mgr = getContainerManager();
    const tokenRefresher = createTokenRefresher({
      mint: (repo) => github.getScopedInstallationToken(repo),
      write: (id, token) => writeForgeGitToken(mgr, id, token),
      onError: (id, err) => console.error('[runtime/token] refresh failed for', id, err),
    });
```

Then pass it to `startWsServer`:

```ts
    const ws = await startWsServer({
      port: env.CRYSTAL_FORGE_WS_PORT,
      secret: env.CRYSTAL_FORGE_WS_SECRET,
      tokenRefresher,
    });
```

- [ ] **Step 3: Typecheck + full unit suite**

Run: `pnpm typecheck && pnpm test`
Expected: clean typecheck; all unit tests green.

- [ ] **Step 4: Lint (verify the Octokit rule is satisfied)**

Run: `pnpm lint`
Expected: no `no-octokit-outside-github` violations (the scoped mint lives in `lib/github/`).

- [ ] **Step 5: Commit**

```bash
git add instrumentation.ts lib/env.ts lib/env.test.ts
git commit -m "feat(runtime): wire real token refresher; remove FORGE_GIT_TOKEN"
```

---

## Task 8: Rollout (manual ops — no code)

Do this after the branch is merged. These steps mutate the live pilot host; run them deliberately.

- [ ] **Step 1: Remove `FORGE_GIT_TOKEN` from `.env.local`**

Edit `/home/bmodi/work/crystal-forge/.env.local` and delete the `FORGE_GIT_TOKEN=...` line (line 54). (This is a live-secret/config change — the operator does it, not an automated step.)

- [ ] **Step 2: Restart the dashboard service**

```bash
sudo systemctl restart crystal-forge.service
```

- [ ] **Step 3: Confirm the App installation covers every forge repo**

The scoped mint fails for a repo the App installation doesn't include. Verify `second-set-of-eyes`, `crystal-lattice`, and `pe-skills-matrix` are all in the installation's repository access:
`https://github.com/organizations/CrystalFountainsInc/settings/installations/144292228`

- [ ] **Step 4: Stop + start each forge to apply the new credential path**

A restart recreates the container (no `GH_TOKEN` env; `hosts.yml` seeded at setup, then refreshed while a pane is open). Do this per forge from the dashboard.

- [ ] **Step 5: Verify inside a forge with an open conversation**

Open a conversation on a restarted forge, then from a shell in that container:

```bash
docker exec <container> sh -c 'env | grep -c GH_TOKEN; gh auth token >/dev/null 2>&1 && echo "gh has token"; git -C /workspace ls-remote origin -h >/dev/null 2>&1 && echo "git auth OK"'
```

Expected: `0` (no container-level `GH_TOKEN`), `gh has token`, `git auth OK`.

---

## Self-Review

**Spec coverage:**
- Repo-scoped mint (`contents`+PR) → Task 1. ✅
- Remove unused `getInstallationToken` + dead host-side `clone.ts` → Task 4b. ✅
- `gh hosts.yml` single source, token via env not argv → Task 2. ✅
- Session-gated, ref-counted, 45m/5m refresh, non-blocking failure → Task 3. ✅
- `repoFullName` for scoping; clone tightened; PAT env removed → Task 4. ✅
- Seed token at setup so pre-session git works → Task 5. ✅
- Acquire before PTY, release on close & pty-exit, terminal notice → Task 6. ✅
- Real wiring; drop `FORGE_GIT_TOKEN` → Task 7. ✅
- Rollout (env, restart, installation repos, verify) → Task 8. ✅
- Testing via `GITHUB_CLIENT_MODE=fake`, no new e2e → covered by unit tasks. ✅

**Deviations from spec (deliberate):**
- `getInstallationToken()`'s only caller besides the switched clone was `clone.ts`, which is itself dead (host-side clone superseded by the in-container clone). Both are removed in Task 4b — matching the spec's "remove if unused" and the user's preference to clean up rather than clutter.
- Spec mentioned "emit a one-line notice to the terminal" — implemented as a single `ws.send` line when the initial mint fails (Task 6d), kept decoupled from the refresher via `acquire`'s boolean return.

**Type consistency:** `getScopedInstallationToken(repoFullName) → { token, expiresAt }` used identically in Tasks 1, 3, 4, 7. `TokenRefresher.acquire/release` signatures match across Tasks 3, 6, 7. `loadRuntimeHandle` return type extended in Task 4 and consumed with the same shape in Task 6. No placeholder steps; every code step shows complete code.
