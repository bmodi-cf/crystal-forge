# Forge Orchestration (Start / Stop / Open) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Start / Stop / Open controls to each forge card so the harness clones, installs, and runs each forge as a host child process on a managed local port — implementing `docs/superpowers/specs/2026-05-08-forge-orchestration-design.md`.

**Architecture:** A new `lib/runtime/` boundary owns filesystem state (`~/.crystal-forge/`), port allocation, child-process spawn/kill/probe, and the clone+install pipeline. A `lib/services/runtime.ts` factory composes those into Start/Stop/Get/List with auth + per-forge locks. Three thin API routes expose the service; a polling hook + a new card row drive the UI. A boot hook in `instrumentation.ts` runs orphan cleanup and the liveness loop.

**Tech Stack:** Next 16 (App Router) · React 19 · TypeScript strict · Vitest (jsdom + node) · Playwright · `@octokit/rest` + `@octokit/auth-app` · Node stdlib (`child_process`, `fs/promises`, `net`, `http`).

---

## File Structure (recap)

| Path | Purpose |
|---|---|
| `lib/runtime/types.ts` | `RuntimeStatus`, `RuntimeStateEntry` shapes |
| `lib/runtime/paths.ts` | All `~/.crystal-forge/...` path helpers |
| `lib/runtime/state.ts` | Atomic load/save/mutate of `state.json` |
| `lib/runtime/ports.ts` | Allocate/release in 3001..3099 with bind probe |
| `lib/runtime/probe.ts` | `probe(port)` HTTP liveness |
| `lib/runtime/process.ts` | `spawnDev`, `kill`, `isAlive` |
| `lib/runtime/runner-types.ts` | `CommandRunner` interface |
| `lib/runtime/child-process-runner.ts` | Real `CommandRunner` |
| `lib/runtime/clone.ts` | `ensureClone(forge, githubClient, runner)` |
| `lib/runtime/runner.ts` | Boot cleanup + liveness loop |
| `lib/services/runtime.ts` | Service entry points + per-forge locks |
| `app/api/forges/[id]/start/route.ts` | POST start |
| `app/api/forges/[id]/stop/route.ts` | POST stop |
| `app/api/forges/runtime/route.ts` | GET all visible runtimes |
| `app/(app)/dashboard/ForgeCardRuntime.tsx` | Status badge + Start/Stop/Open buttons |
| `app/(app)/dashboard/useForgeRuntimes.ts` | 3-second polling hook |
| `instrumentation.ts` | Next 16 boot hook — calls `bootCleanup` then `startLivenessLoop` |
| `tests/e2e/forge-orchestration.spec.ts` | Playwright E2E using `CRYSTAL_FORGE_HOME` fixture |

Modified: `lib/env.ts`, `lib/github/{types,octokit-client,fake-client}.ts` (+ tests), `lib/errors.ts` (+ test), `lib/http.ts` (+ test), `app/(app)/dashboard/{ForgeCard.tsx,ForgeCard.test.tsx,DashboardClient.tsx}`.

---

## Task 1: Env var + path helpers + runtime types

**Files:**
- Modify: `lib/env.ts`
- Create: `lib/runtime/paths.ts`
- Create: `lib/runtime/types.ts`

- [ ] **Step 1: Add `CRYSTAL_FORGE_HOME` to env schema**

In `lib/env.ts`, add inside `baseSchema` (after the existing `DB_PROVISIONER_MODE` line):

```ts
  // Runtime orchestration root. Defaults to ~/.crystal-forge.
  CRYSTAL_FORGE_HOME: z.string().optional(),
```

- [ ] **Step 2: Create `lib/runtime/types.ts`**

```ts
export type RuntimeStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'setup-failed';

export type RuntimeStateEntry = {
  forgeId: string;
  slug: string;
  status: RuntimeStatus;
  pid: number;
  port: number;
  startedAt: string; // ISO
  logPath: string;
  setupError?: string;
};

/** Public-facing entry: same shape but `pid` is omitted when the viewer cannot write the forge. */
export type RuntimeStateView = Omit<RuntimeStateEntry, 'pid'> & { pid?: number };

/**
 * On-disk shape of state.json — a flat map of forgeId → entry, exactly as
 * the spec describes. Stopped forges are represented by absence.
 */
export type RuntimeStateFile = Record<string, RuntimeStateEntry>;
```

- [ ] **Step 3: Create `lib/runtime/paths.ts`**

```ts
import os from 'node:os';
import path from 'node:path';
import { env } from '@/lib/env';

export function forgeHome(): string {
  return env.CRYSTAL_FORGE_HOME ?? path.join(os.homedir(), '.crystal-forge');
}

export function stateFilePath(): string {
  return path.join(forgeHome(), 'state.json');
}

export function clonesDir(): string {
  return path.join(forgeHome(), 'clones');
}

export function forgeClonePath(slug: string): string {
  return path.join(clonesDir(), slug);
}

export function logPath(slug: string): string {
  return path.join(forgeClonePath(slug), '.forge.log');
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts lib/runtime/types.ts lib/runtime/paths.ts
git commit -m "feat(runtime): env var + path helpers + state types"
```

---

## Task 2: Runtime state — atomic load/save/mutate

**Files:**
- Create: `lib/runtime/state.ts`
- Test:   `lib/runtime/state.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/runtime/state.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, mutateState } from './state';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-state-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('runtime state', () => {
  it('loadState returns an empty object when the file is missing', async () => {
    const s = await loadState();
    expect(s).toEqual({});
  });

  it('saveState writes atomically and loadState reads it back', async () => {
    await saveState({
      f1: {
        forgeId: 'f1', slug: 'foo', status: 'running',
        pid: 1234, port: 3001, startedAt: '2026-05-09T00:00:00.000Z',
        logPath: '/tmp/x.log',
      },
    });
    const s = await loadState();
    expect(s['f1']?.status).toBe('running');
    // Tmp file should not be left behind.
    const files = await fs.readdir(tmp);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('mutateState applies the mutator and persists', async () => {
    await mutateState((s) => {
      s['f1'] = {
        forgeId: 'f1', slug: 'foo', status: 'starting',
        pid: 0, port: 3002, startedAt: '2026-05-09T00:00:00.000Z',
        logPath: '/tmp/x.log',
      };
    });
    const s = await loadState();
    expect(s['f1']?.status).toBe('starting');
  });

  it('loadState backs up corrupt files and returns empty state', async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, 'state.json'), 'this is not json', 'utf8');
    const s = await loadState();
    expect(s).toEqual({});
    const files = await fs.readdir(tmp);
    expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test lib/runtime/state.test.ts`
Expected: FAIL — `Cannot find module './state'`.

- [ ] **Step 3: Implement `lib/runtime/state.ts`**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateFilePath, forgeHome } from './paths';
import type { RuntimeStateFile } from './types';

export async function loadState(): Promise<RuntimeStateFile> {
  const p = stateFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as RuntimeStateFile;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('shape');
    }
    return parsed;
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(forgeHome(), `state.json.corrupt-${ts}`);
    await fs.rename(p, backup).catch(() => {});
    console.error('[runtime/state] state.json was unparseable; backed up to', backup);
    return {};
  }
}

export async function saveState(state: RuntimeStateFile): Promise<void> {
  const dir = forgeHome();
  await fs.mkdir(dir, { recursive: true });
  const p = stateFilePath();
  const tmp = `${p}.tmp`;
  const body = JSON.stringify(state, null, 2);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, p);
}

export async function mutateState(
  mutator: (state: RuntimeStateFile) => void | Promise<void>,
): Promise<RuntimeStateFile> {
  const state = await loadState();
  await mutator(state);
  await saveState(state);
  return state;
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test lib/runtime/state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/state.ts lib/runtime/state.test.ts
git commit -m "feat(runtime): atomic state.json load/save/mutate with corrupt-file backup"
```

---

## Task 3: Port allocation

**Files:**
- Create: `lib/runtime/ports.ts`
- Test:   `lib/runtime/ports.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/runtime/ports.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allocatePort, RuntimeCapacityError } from './ports';
import { saveState } from './state';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-ports-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('allocatePort', () => {
  it('returns the first port that is free in state and on the host', async () => {
    const port = await allocatePort({ start: 3001, end: 3099 });
    expect(port).toBeGreaterThanOrEqual(3001);
    expect(port).toBeLessThanOrEqual(3099);
  });

  it('skips ports recorded in state.json', async () => {
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 1, port: 3001, startedAt: 'x', logPath: '' },
    });
    const port = await allocatePort({ start: 3001, end: 3099 });
    expect(port).not.toBe(3001);
  });

  it('skips ports bound externally', async () => {
    const srv = await listenOn(3001);
    try {
      const port = await allocatePort({ start: 3001, end: 3099 });
      expect(port).not.toBe(3001);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('throws RuntimeCapacityError when the pool is exhausted', async () => {
    await expect(allocatePort({ start: 3001, end: 3001 })).resolves.toBe(3001);

    // Fill the entire tiny pool via state.
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 1, port: 3001, startedAt: 'x', logPath: '' },
    });
    await expect(allocatePort({ start: 3001, end: 3001 })).rejects.toBeInstanceOf(RuntimeCapacityError);
  });
});
```

- [ ] **Step 2: Run the tests — should fail**

Run: `pnpm test lib/runtime/ports.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/runtime/ports.ts`**

```ts
import net from 'node:net';
import { loadState } from './state';

export class RuntimeCapacityError extends Error {
  constructor(message = 'No free port in pool') {
    super(message);
    this.name = 'RuntimeCapacityError';
  }
}

export async function allocatePort(
  range: { start: number; end: number } = { start: 3001, end: 3099 },
): Promise<number> {
  const state = await loadState();
  const inUse = new Set<number>(Object.values(state).map((e) => e.port));
  for (let p = range.start; p <= range.end; p++) {
    if (inUse.has(p)) continue;
    if (await isHostFree(p)) return p;
  }
  throw new RuntimeCapacityError();
}

function isHostFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}
```

Note: `releasePort` is intentionally absent — releasing means deleting the forge's entry from state.json (Stop's job). No separate book.

- [ ] **Step 4: Run the tests — they should pass**

Run: `pnpm test lib/runtime/ports.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ports.ts lib/runtime/ports.test.ts
git commit -m "feat(runtime): port allocator with state + host-bind check"
```

---

## Task 4: HTTP probe

**Files:**
- Create: `lib/runtime/probe.ts`
- Test:   `lib/runtime/probe.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/runtime/probe.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { probe } from './probe';

let server: http.Server | null = null;

afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function listen(port: number, status: number): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end('ok');
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

describe('probe', () => {
  it('returns true on 200', async () => {
    await listen(3911, 200);
    expect(await probe(3911, { timeoutMs: 500 })).toBe(true);
  });

  it('returns true on 404 (server is alive)', async () => {
    await listen(3912, 404);
    expect(await probe(3912, { timeoutMs: 500 })).toBe(true);
  });

  it('returns true on 500 (server is alive)', async () => {
    await listen(3913, 500);
    expect(await probe(3913, { timeoutMs: 500 })).toBe(true);
  });

  it('returns false on connection refused', async () => {
    expect(await probe(3914, { timeoutMs: 500 })).toBe(false);
  });

  it('returns false on timeout', async () => {
    server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((r) => server!.listen(3915, '127.0.0.1', () => r()));
    expect(await probe(3915, { timeoutMs: 100 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests — they should fail**

Run: `pnpm test lib/runtime/probe.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/runtime/probe.ts`**

```ts
import http from 'node:http';

export function probe(port: number, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        // Any response — even 404/500 — means a process is listening.
        res.resume();
        finish(true);
      },
    );
    req.once('error', () => finish(false));
    req.once('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.end();
  });
}
```

- [ ] **Step 4: Run the tests — they should pass**

Run: `pnpm test lib/runtime/probe.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/probe.ts lib/runtime/probe.test.ts
git commit -m "feat(runtime): HTTP liveness probe"
```

---

## Task 5: Process spawn / kill / isAlive

**Files:**
- Create: `lib/runtime/process.ts`
- Test:   `lib/runtime/process.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/runtime/process.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnLongLived, killProcess, isAlive } from './process';

const spawned: number[] = [];

afterEach(async () => {
  for (const pid of spawned) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
  spawned.length = 0;
});

describe('process helpers', () => {
  it('spawnLongLived returns a live pid; isAlive reflects that', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-proc-'));
    const logPath = path.join(tmp, 'log');
    const pid = spawnLongLived('node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmp, logPath });
    spawned.push(pid);
    expect(typeof pid).toBe('number');
    expect(isAlive(pid)).toBe(true);
  });

  it('killProcess SIGTERMs and returns once the process exits', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-proc-'));
    const pid = spawnLongLived('node', ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmp, logPath: path.join(tmp, 'log'),
    });
    spawned.push(pid);
    await killProcess(pid, { graceMs: 1000 });
    expect(isAlive(pid)).toBe(false);
  });

  it('killProcess escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-proc-'));
    const pid = spawnLongLived(
      'node',
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { cwd: tmp, logPath: path.join(tmp, 'log') },
    );
    spawned.push(pid);
    await killProcess(pid, { graceMs: 200 });
    expect(isAlive(pid)).toBe(false);
  });

  it('isAlive returns false for an unknown pid', () => {
    expect(isAlive(999_999_999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests — they should fail**

Run: `pnpm test lib/runtime/process.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/runtime/process.ts`**

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export type SpawnOpts = {
  cwd: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
};

export function spawnLongLived(cmd: string, args: string[], opts: SpawnOpts): number {
  const fd = fs.openSync(opts.logPath, 'a');
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', fd, fd],
    detached: false,
  });
  child.unref();
  if (!child.pid) {
    fs.closeSync(fd);
    throw new Error(`Failed to spawn ${cmd}`);
  }
  return child.pid;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killProcess(
  pid: number,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const grace = opts.graceMs ?? 5000;
  if (!isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const start = Date.now();
  while (Date.now() - start < grace) {
    if (!isAlive(pid)) return;
    await sleep(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) return;
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run the tests — they should pass**

Run: `pnpm test lib/runtime/process.test.ts`
Expected: PASS (4 tests). Total runtime ~1–2s.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/process.ts lib/runtime/process.test.ts
git commit -m "feat(runtime): spawn/kill/isAlive helpers with SIGTERM→SIGKILL escalation"
```

---

## Task 6: GitHubClient — `getInstallationToken`

**Files:**
- Modify: `lib/github/types.ts`
- Modify: `lib/github/fake-client.ts`
- Modify: `lib/github/fake-client.test.ts`
- Modify: `lib/github/octokit-client.ts`
- Modify: `lib/github/octokit-client.test.ts`

- [ ] **Step 1: Write the failing fake-client test**

In `lib/github/fake-client.test.ts`, append a new `describe` block:

```ts
describe('FakeGitHubClient.getInstallationToken', () => {
  it('returns a deterministic stub token', async () => {
    const fake = new FakeGitHubClient({ owner: 'o', baseUrl: 'https://github.com' });
    const tok = await fake.getInstallationToken();
    expect(tok).toBe('fake-installation-token');
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test lib/github/fake-client.test.ts`
Expected: FAIL — `getInstallationToken is not a function`.

- [ ] **Step 3: Add to interface and implementations**

In `lib/github/types.ts`, append inside `GitHubClient`:

```ts
  /**
   * Mints an installation access token usable in `https://x-access-token:<token>@github.com/...`
   * URLs (e.g. for `git clone`). Tokens are short-lived (~1h) and the caller is
   * responsible for not persisting them. Throws on any auth failure.
   */
  getInstallationToken(): Promise<string>;
```

In `lib/github/fake-client.ts`, add a method (anywhere in the class):

```ts
  async getInstallationToken(): Promise<string> {
    return 'fake-installation-token';
  }
```

In `lib/github/octokit-client.ts`, add (above `private async putContents`):

```ts
  async getInstallationToken(): Promise<string> {
    // octokit-auth-app exposes this through the same client.auth() callable.
    const auth = (this.client as unknown as {
      auth: (opts: { type: 'installation' }) => Promise<{ token: string }>;
    }).auth;
    const result = await auth({ type: 'installation' });
    return result.token;
  }
```

- [ ] **Step 4: Add the octokit-client test**

In `lib/github/octokit-client.test.ts`, append:

```ts
describe('OctokitGitHubClient.getInstallationToken', () => {
  it('delegates to octokit auth({ type: "installation" })', async () => {
    const stub = {
      auth: vi.fn().mockResolvedValue({ token: 'ghs_xyz' }),
    } as unknown as Octokit;
    const client = new OctokitGitHubClient({
      owner: 'o', templateRepo: 't/r',
      appId: '1', privateKey: 'k', installationId: 'i',
      octokit: stub,
    });
    expect(await client.getInstallationToken()).toBe('ghs_xyz');
    expect((stub as unknown as { auth: ReturnType<typeof vi.fn> }).auth)
      .toHaveBeenCalledWith({ type: 'installation' });
  });
});
```

(Imports `vi`, `Octokit`, and `OctokitGitHubClient` may already be present at the top of the file. If not, add them.)

- [ ] **Step 5: Run all GitHub tests — should pass**

Run: `pnpm test lib/github`
Expected: PASS (existing + 2 new cases).

- [ ] **Step 6: Commit**

```bash
git add lib/github/types.ts lib/github/fake-client.ts lib/github/fake-client.test.ts lib/github/octokit-client.ts lib/github/octokit-client.test.ts
git commit -m "feat(github): expose getInstallationToken on GitHubClient"
```

---

## Task 7: `CommandRunner` + `ensureClone`

**Files:**
- Create: `lib/runtime/runner-types.ts`
- Create: `lib/runtime/child-process-runner.ts`
- Create: `lib/runtime/clone.ts`
- Test:   `lib/runtime/clone.test.ts`

- [ ] **Step 1: Create `lib/runtime/runner-types.ts`**

```ts
export type CommandResult = { exitCode: number };

export type RunOpts = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** When set, the child's stdout+stderr are appended to this file. */
  logPath?: string;
  /** Hard timeout. The child is SIGKILLed if it exceeds this. */
  timeoutMs?: number;
};

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: RunOpts): Promise<CommandResult>;
}
```

- [ ] **Step 2: Create `lib/runtime/child-process-runner.ts`**

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { CommandResult, CommandRunner, RunOpts } from './runner-types';

export const childProcessRunner: CommandRunner = {
  run(cmd, args, opts: RunOpts = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const fd = opts.logPath ? fs.openSync(opts.logPath, 'a') : 'inherit';
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', fd as never, fd as never],
      });
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* noop */ }
          reject(new Error(`Command "${cmd}" timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      child.once('error', (err) => {
        if (timer) clearTimeout(timer);
        if (typeof fd === 'number') fs.closeSync(fd);
        reject(err);
      });
      child.once('exit', (code) => {
        if (timer) clearTimeout(timer);
        if (typeof fd === 'number') fs.closeSync(fd);
        resolve({ exitCode: code ?? -1 });
      });
    });
  },
};
```

- [ ] **Step 3: Write the failing clone tests**

`lib/runtime/clone.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureClone } from './clone';
import type { CommandRunner, RunOpts } from './runner-types';
import { FakeGitHubClient } from '@/lib/github/fake-client';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-clone-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

type Call = { cmd: string; args: string[]; opts?: RunOpts };

function makeFakeRunner(side: (call: Call) => Promise<void> = async () => {}): {
  runner: CommandRunner; calls: Call[];
} {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      await side({ cmd, args, opts });
      return { exitCode: 0 };
    },
  };
  return { runner, calls };
}

describe('ensureClone', () => {
  it('clones, rewrites the remote, copies env, installs, generates prisma — in order', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const { runner, calls } = makeFakeRunner(async ({ cmd, args }) => {
      // Simulate `git clone` creating .git and .env.example.
      if (cmd === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        await fs.writeFile(path.join(dest, '.env.example'), 'DATABASE_URL=foo\n');
      }
    });

    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    const cloneDir = path.join(tmp, 'clones', 'marketing-frufru');
    expect(calls[0]?.cmd).toBe('git');
    expect(calls[0]?.args[0]).toBe('clone');
    expect(calls[0]?.args[1]).toContain('x-access-token:fake-installation-token');
    expect(calls[1]?.args).toEqual(
      ['-C', cloneDir, 'remote', 'set-url', 'origin', 'https://github.com/bmodi-cf/marketing-frufru.git'],
    );
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'install')).toBeDefined();
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'prisma' && c.args[1] === 'generate')).toBeDefined();

    expect(await fs.readFile(path.join(cloneDir, '.env.local'), 'utf8')).toContain('DATABASE_URL=foo');
  });

  it('is idempotent: a second call skips clone, env-copy, and install', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const cloneDir = path.join(tmp, 'clones', 'marketing-frufru');
    await fs.mkdir(path.join(cloneDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(cloneDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(cloneDir, '.env.example'), 'X=1\n');
    await fs.writeFile(path.join(cloneDir, '.env.local'), 'X=existing\n');

    const { runner, calls } = makeFakeRunner();
    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'clone')).toBeUndefined();
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'install')).toBeUndefined();
    // prisma generate still runs (cheap, idempotent).
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'prisma')).toBeDefined();
    // .env.local left untouched.
    expect(await fs.readFile(path.join(cloneDir, '.env.local'), 'utf8')).toBe('X=existing\n');
  });

  it('throws if a runner step exits non-zero', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const failing: CommandRunner = { async run() { return { exitCode: 1 }; } };
    await expect(
      ensureClone({ slug: 's', repoFullName: 'o/s' }, fakeGh, failing),
    ).rejects.toThrow(/exit/i);
  });
});
```

- [ ] **Step 4: Run — should fail**

Run: `pnpm test lib/runtime/clone.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 5: Implement `lib/runtime/clone.ts`**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitHubClient } from '@/lib/github/types';
import { forgeClonePath, logPath as logPathFor } from './paths';
import type { CommandRunner } from './runner-types';
import { childProcessRunner } from './child-process-runner';

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 60 * 1000;

export type ForgeForClone = {
  slug: string;
  repoFullName: string;
};

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

function assertOk(result: { exitCode: number }, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode})`);
  }
}

export async function ensureClone(
  forge: ForgeForClone,
  githubClient: GitHubClient,
  runner: CommandRunner = childProcessRunner,
): Promise<void> {
  const cloneDir = forgeClonePath(forge.slug);
  const log = logPathFor(forge.slug);
  await fs.mkdir(path.dirname(cloneDir), { recursive: true });

  if (!(await exists(path.join(cloneDir, '.git')))) {
    const token = await githubClient.getInstallationToken();
    const cloneUrl = `https://x-access-token:${token}@github.com/${forge.repoFullName}.git`;
    assertOk(
      await runner.run('git', ['clone', cloneUrl, cloneDir], {
        logPath: log, timeoutMs: CLONE_TIMEOUT_MS,
      }),
      'git clone',
    );
    assertOk(
      await runner.run(
        'git',
        ['-C', cloneDir, 'remote', 'set-url', 'origin', `https://github.com/${forge.repoFullName}.git`],
        { logPath: log, timeoutMs: QUICK_TIMEOUT_MS },
      ),
      'git remote set-url',
    );
  }

  const envLocal = path.join(cloneDir, '.env.local');
  const envExample = path.join(cloneDir, '.env.example');
  if (!(await exists(envLocal)) && (await exists(envExample))) {
    await fs.copyFile(envExample, envLocal);
  }

  if (!(await exists(path.join(cloneDir, 'node_modules')))) {
    assertOk(
      await runner.run('pnpm', ['install'], {
        cwd: cloneDir, logPath: log, timeoutMs: INSTALL_TIMEOUT_MS,
      }),
      'pnpm install',
    );
  }

  assertOk(
    await runner.run('pnpm', ['prisma', 'generate'], {
      cwd: cloneDir, logPath: log, timeoutMs: QUICK_TIMEOUT_MS,
    }),
    'pnpm prisma generate',
  );
}
```

- [ ] **Step 6: Run — should pass**

Run: `pnpm test lib/runtime/clone.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/runner-types.ts lib/runtime/child-process-runner.ts lib/runtime/clone.ts lib/runtime/clone.test.ts
git commit -m "feat(runtime): ensureClone pipeline with injectable CommandRunner"
```

---

## Task 8: Runtime errors + http mapping

**Files:**
- Modify: `lib/errors.ts`
- Modify: `lib/errors.test.ts`
- Modify: `lib/http.ts`
- Modify: `lib/http.test.ts`

- [ ] **Step 1: Write the failing test in `lib/http.test.ts`**

Append:

```ts
describe('respondToServiceError — runtime errors', () => {
  it('maps RuntimeBusyError to 409', async () => {
    const { RuntimeBusyError } = await import('./errors');
    const res = respondToServiceError(new RuntimeBusyError('busy'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'busy' });
  });

  it('maps RuntimeCapacityError to 503', async () => {
    const { RuntimeCapacityError } = await import('./errors');
    const res = respondToServiceError(new RuntimeCapacityError('full'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'full' });
  });
});
```

- [ ] **Step 2: Append a test to `lib/errors.test.ts`**

```ts
describe('runtime error classes', () => {
  it('RuntimeBusyError carries name + message', async () => {
    const { RuntimeBusyError } = await import('./errors');
    const e = new RuntimeBusyError('x');
    expect(e.name).toBe('RuntimeBusyError');
    expect(e.message).toBe('x');
    expect(e.code).toBe('RUNTIME_BUSY');
  });

  it('RuntimeCapacityError carries name + message', async () => {
    const { RuntimeCapacityError } = await import('./errors');
    const e = new RuntimeCapacityError('x');
    expect(e.name).toBe('RuntimeCapacityError');
    expect(e.code).toBe('RUNTIME_CAPACITY');
  });
});
```

- [ ] **Step 3: Run — should fail**

Run: `pnpm test lib/errors.test.ts lib/http.test.ts`
Expected: FAIL — `RuntimeBusyError` not exported.

- [ ] **Step 4: Add the error classes**

In `lib/errors.ts`, change `ErrorCode` and append two classes:

```ts
export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'RUNTIME_BUSY'
  | 'RUNTIME_CAPACITY';

// ... existing code unchanged ...

export class RuntimeBusyError extends AppError {
  constructor(message: string) {
    super('RUNTIME_BUSY', message);
  }
}

export class RuntimeCapacityError extends AppError {
  constructor(message = 'No free runtime port; stop another forge first') {
    super('RUNTIME_CAPACITY', message);
  }
}
```

- [ ] **Step 5: Map them in `lib/http.ts`**

```ts
import { NextResponse } from 'next/server';
import {
  NotFoundError, ForbiddenError, ValidationError,
  RuntimeBusyError, RuntimeCapacityError,
} from './errors';

export function respondToServiceError(err: unknown): NextResponse {
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
  }
  if (err instanceof RuntimeBusyError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof RuntimeCapacityError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  console.error('[respondToServiceError] unhandled error', err);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}
```

- [ ] **Step 6: Update `lib/runtime/ports.ts` to use the canonical error**

Replace `lib/runtime/ports.ts`'s local class with a re-export and import:

```ts
import net from 'node:net';
import { loadState } from './state';
import { RuntimeCapacityError } from '@/lib/errors';

export { RuntimeCapacityError };

export async function allocatePort(
  range: { start: number; end: number } = { start: 3001, end: 3099 },
): Promise<number> {
  const state = await loadState();
  const inUse = new Set<number>(Object.values(state).map((e) => e.port));
  for (let p = range.start; p <= range.end; p++) {
    if (inUse.has(p)) continue;
    if (await isHostFree(p)) return p;
  }
  throw new RuntimeCapacityError();
}

function isHostFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}
```

- [ ] **Step 7: Run all affected tests — should pass**

Run: `pnpm test lib/errors.test.ts lib/http.test.ts lib/runtime/ports.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/errors.ts lib/errors.test.ts lib/http.ts lib/http.test.ts lib/runtime/ports.ts
git commit -m "feat(errors): add RuntimeBusyError (409) + RuntimeCapacityError (503)"
```

---

## Task 9: Background runner (boot cleanup + liveness loop)

**Files:**
- Create: `lib/runtime/runner.ts`
- Test:   `lib/runtime/runner.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/runtime/runner.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState } from './state';
import { bootCleanup, makeLivenessChecker } from './runner';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-runner-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('bootCleanup', () => {
  it('kills any alive pid in state and wipes the file', async () => {
    const killed: number[] = [];
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 1, port: 3001, startedAt: 'x', logPath: '' },
      b: { forgeId: 'b', slug: 'b', status: 'running', pid: 2, port: 3002, startedAt: 'x', logPath: '' },
    });
    await bootCleanup({
      isAlive: (pid) => pid === 1,
      kill: async (pid) => { killed.push(pid); },
    });
    const s = await loadState();
    expect(s).toEqual({});
    expect(killed).toEqual([1]);
  });
});

describe('makeLivenessChecker', () => {
  it('flips a running entry to crashed after 3 consecutive probe failures', async () => {
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 100, port: 3001, startedAt: 'x', logPath: '' },
    });
    const killed: number[] = [];
    const check = makeLivenessChecker({
      probe: async () => false,
      kill: async (pid) => { killed.push(pid); },
      now: () => new Date('2026-05-09T00:00:00Z'),
      startingTimeoutMs: 60_000,
    });
    await check();
    await check();
    let s = await loadState();
    expect(s['a']?.status).toBe('running'); // still alive after 2 failures
    await check();
    s = await loadState();
    expect(s['a']?.status).toBe('crashed');
    expect(killed).toContain(100);
  });

  it('resets failure counter on a successful probe', async () => {
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 100, port: 3001, startedAt: 'x', logPath: '' },
    });
    let calls = 0;
    const check = makeLivenessChecker({
      probe: async () => { calls++; return calls !== 1; }, // fail once, then succeed
      kill: async () => {},
      now: () => new Date(),
      startingTimeoutMs: 60_000,
    });
    await check(); await check(); await check(); await check();
    const s = await loadState();
    expect(s['a']?.status).toBe('running');
  });

  it('escalates a starting entry older than the timeout to crashed', async () => {
    await saveState({
      a: {
        forgeId: 'a', slug: 'a', status: 'starting', pid: 100, port: 3001,
        startedAt: '2026-05-09T00:00:00.000Z', logPath: '',
      },
    });
    const check = makeLivenessChecker({
      probe: async () => true,
      kill: async () => {},
      now: () => new Date('2026-05-09T00:02:00.000Z'),
      startingTimeoutMs: 60_000,
    });
    await check();
    const s = await loadState();
    expect(s['a']?.status).toBe('crashed');
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test lib/runtime/runner.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/runtime/runner.ts`**

```ts
import { loadState, mutateState } from './state';
import { isAlive as defaultIsAlive, killProcess as defaultKill } from './process';
import { probe as defaultProbe } from './probe';

export type BootCleanupDeps = {
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<void>;
};

export async function bootCleanup(deps: BootCleanupDeps = {}): Promise<void> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const kill = deps.kill ?? ((pid: number) => defaultKill(pid));
  const state = await loadState();
  for (const entry of Object.values(state)) {
    if (isAlive(entry.pid)) {
      try { await kill(entry.pid); } catch (err) {
        console.error('[runtime/bootCleanup] kill failed', { pid: entry.pid, err });
      }
    }
  }
  await mutateState((s) => {
    for (const k of Object.keys(s)) delete s[k];
  });
}

export type LivenessDeps = {
  probe?: (port: number) => Promise<boolean>;
  kill?: (pid: number) => Promise<void>;
  now?: () => Date;
  startingTimeoutMs?: number;
  failureThreshold?: number;
};

export function makeLivenessChecker(deps: LivenessDeps = {}): () => Promise<void> {
  const probe = deps.probe ?? defaultProbe;
  const kill = deps.kill ?? ((pid: number) => defaultKill(pid));
  const now = deps.now ?? (() => new Date());
  const startingTimeoutMs = deps.startingTimeoutMs ?? 60_000;
  const failureThreshold = deps.failureThreshold ?? 3;
  const failureCounts = new Map<string, number>();

  return async function check(): Promise<void> {
    const state = await loadState();
    for (const entry of Object.values(state)) {
      if (entry.status === 'starting') {
        const ageMs = now().getTime() - new Date(entry.startedAt).getTime();
        if (ageMs > startingTimeoutMs) {
          await kill(entry.pid).catch(() => {});
          await mutateState((s) => {
            const e = s[entry.forgeId];
            if (e) e.status = 'crashed';
          });
        }
        continue;
      }
      if (entry.status !== 'running') continue;
      const ok = await probe(entry.port);
      if (ok) {
        failureCounts.delete(entry.forgeId);
        continue;
      }
      const next = (failureCounts.get(entry.forgeId) ?? 0) + 1;
      failureCounts.set(entry.forgeId, next);
      if (next >= failureThreshold) {
        failureCounts.delete(entry.forgeId);
        await kill(entry.pid).catch(() => {});
        await mutateState((s) => {
          const e = s[entry.forgeId];
          if (e) e.status = 'crashed';
        });
      }
    }
  };
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startLivenessLoop(deps: LivenessDeps = {}, intervalMs = 5000): { stop: () => void } {
  const check = makeLivenessChecker(deps);
  intervalHandle = setInterval(() => {
    void check().catch((err) => console.error('[runtime/runner] check failed', err));
  }, intervalMs);
  intervalHandle.unref?.();
  return {
    stop: () => {
      if (intervalHandle) clearInterval(intervalHandle);
      intervalHandle = null;
    },
  };
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test lib/runtime/runner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/runner.ts lib/runtime/runner.test.ts
git commit -m "feat(runtime): boot cleanup + liveness checker (3-fail threshold + start timeout)"
```

---

## Task 10: Service layer — `makeRuntimeService`

**Files:**
- Create: `lib/services/runtime.ts`
- Test:   `lib/services/runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/services/runtime.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { makeRuntimeService } from './runtime';
import { ForbiddenError } from '@/lib/errors';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-svc-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeFakes() {
  const probes: number[] = [];
  return {
    githubClient: new FakeGitHubClient({ owner: 'o', baseUrl: 'https://github.com' }),
    clone: async () => {},
    spawnLongLived: () => 12345,
    killProcess: async () => {},
    isAlive: () => true,
    probe: async (port: number) => { probes.push(port); return true; },
    portStart: 3001, portEnd: 3099,
    _calls: { probes },
  };
}

describe('runtime service', () => {
  it('startForge writes a starting entry, then flips to running on probe success', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      const result = await svc.startForge(tom, forge.id);
      expect(result.status).toBe('running');
      expect(result.port).toBeGreaterThanOrEqual(3001);
      expect(fakes._calls.probes.length).toBeGreaterThan(0);
    });
  });

  it('startForge requires write access', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const intruder = await makeUser(prisma, { email: 'i@x', name: 'I', groups: [] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      await expect(svc.startForge(intruder, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('startForge collapses concurrent calls onto one promise', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      let cloneCalls = 0;
      const svc = makeRuntimeService({
        ...makeFakes(),
        prisma,
        clone: async () => { cloneCalls++; await new Promise((r) => setTimeout(r, 20)); },
      });
      const [a, b] = await Promise.all([svc.startForge(tom, forge.id), svc.startForge(tom, forge.id)]);
      expect(a.port).toBe(b.port);
      expect(cloneCalls).toBe(1);
    });
  });

  it('startForge marks setup-failed when ensureClone throws', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({
        ...makeFakes(),
        prisma,
        clone: async () => { throw new Error('git clone exploded'); },
      });
      await expect(svc.startForge(tom, forge.id)).rejects.toThrow('git clone exploded');
      const got = await svc.getRuntime(tom, forge.id);
      expect(got?.status).toBe('setup-failed');
      expect(got?.setupError).toContain('git clone exploded');
    });
  });

  it('startForge on running forge is idempotent', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      const first = await svc.startForge(tom, forge.id);
      const second = await svc.startForge(tom, forge.id);
      expect(second.port).toBe(first.port);
    });
  });

  it('startForge after crashed/setup-failed clears the entry and starts fresh', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      let attempt = 0;
      const svc = makeRuntimeService({
        ...makeFakes(),
        prisma,
        clone: async () => { if (attempt++ === 0) throw new Error('first try fails'); },
      });
      await expect(svc.startForge(tom, forge.id)).rejects.toThrow();
      const ok = await svc.startForge(tom, forge.id);
      expect(ok.status).toBe('running');
    });
  });

  it('stopForge terminates and removes the entry; second stop is a no-op', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      await svc.startForge(tom, forge.id);
      await svc.stopForge(tom, forge.id);
      expect(await svc.getRuntime(tom, forge.id)).toBeNull();
      await svc.stopForge(tom, forge.id); // idempotent — no throw
    });
  });

  it('listRuntimes filters by ACL and redacts pid for read-only viewers', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const reader = await makeUser(prisma, { email: 'r@x', name: 'R', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      await svc.startForge(tom, forge.id);
      const tomList = await svc.listRuntimes(tom);
      const readerList = await svc.listRuntimes(reader);
      expect(tomList[0]?.pid).toBe(12345);
      expect(readerList[0]?.pid).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test lib/services/runtime.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/services/runtime.ts`**

```ts
import type { PrismaClient } from '@prisma/client';
import { canWriteForge, forgeReadFilter, canReadForge } from '@/lib/acl';
import { ForbiddenError, NotFoundError, RuntimeBusyError } from '@/lib/errors';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/types';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { slugifyForgeName } from '@/lib/github/slug';
import { allocatePort } from '@/lib/runtime/ports';
import { ensureClone as defaultClone } from '@/lib/runtime/clone';
import { spawnLongLived as defaultSpawn, killProcess as defaultKill, isAlive as defaultIsAlive } from '@/lib/runtime/process';
import { probe as defaultProbe } from '@/lib/runtime/probe';
import { mutateState, loadState } from '@/lib/runtime/state';
import { forgeClonePath, logPath as logPathFor } from '@/lib/runtime/paths';
import type { RuntimeStateEntry, RuntimeStateView } from '@/lib/runtime/types';
import type { SessionUser } from './types';

export type RuntimeDeps = {
  prisma: PrismaClient;
  githubClient: GitHubClient;
  clone: (forge: { slug: string; repoFullName: string }, gh: GitHubClient) => Promise<void>;
  spawnLongLived: (cmd: string, args: string[], opts: { cwd: string; logPath: string; env?: NodeJS.ProcessEnv }) => number;
  killProcess: (pid: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
  probe: (port: number) => Promise<boolean>;
  portStart: number;
  portEnd: number;
};

export type RuntimeService = {
  startForge(currentUser: SessionUser, forgeId: string): Promise<RuntimeStateEntry>;
  stopForge(currentUser: SessionUser, forgeId: string): Promise<void>;
  getRuntime(currentUser: SessionUser, forgeId: string): Promise<RuntimeStateView | null>;
  listRuntimes(currentUser: SessionUser): Promise<RuntimeStateView[]>;
};

const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 30_000;

export function makeRuntimeService(deps: RuntimeDeps): RuntimeService {
  const startInflight = new Map<string, Promise<RuntimeStateEntry>>();
  const stopInflight = new Map<string, Promise<void>>();

  async function loadForgeForAcl(forgeId: string) {
    const row = await deps.prisma.forge.findUnique({
      where: { id: forgeId },
      include: { groups: { include: { group: true } } },
    });
    if (!row) throw new NotFoundError('forge', forgeId);
    return {
      id: row.id,
      name: row.name,
      repoFullName: row.repoFullName,
      createdById: row.createdById,
      groupNames: row.groups.map((g) => g.group.name),
    };
  }

  function aclFor(row: { id: string; createdById: string; groupNames: string[] }) {
    return { id: row.id, createdById: row.createdById, groups: row.groupNames };
  }

  async function doStart(currentUser: SessionUser, forgeId: string): Promise<RuntimeStateEntry> {
    const row = await loadForgeForAcl(forgeId);
    if (!canWriteForge(currentUser, aclFor(row))) {
      throw new ForbiddenError(`Cannot start forge ${forgeId}`);
    }

    const slug = slugifyForgeName(row.name);

    // Step 3 of spec: dispatch on existing entry status.
    const state = await loadState();
    const existing = state[forgeId];
    if (existing) {
      if (existing.status === 'running' || existing.status === 'starting') return existing;
      if (existing.status === 'stopping') {
        throw new RuntimeBusyError('Forge is currently stopping; try again shortly');
      }
      // crashed / setup-failed → clear and continue to fresh start.
      await mutateState((s) => { delete s[forgeId]; });
    }

    const port = await allocatePort({ start: deps.portStart, end: deps.portEnd });
    const startedAt = new Date().toISOString();
    const log = logPathFor(slug);

    const baseEntry: RuntimeStateEntry = {
      forgeId, slug, status: 'starting',
      pid: 0, port, startedAt, logPath: log,
    };
    await mutateState((s) => { s[forgeId] = baseEntry; });

    try {
      await deps.clone({ slug, repoFullName: row.repoFullName }, deps.githubClient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mutateState((s) => {
        s[forgeId] = { ...baseEntry, status: 'setup-failed', setupError: msg };
      });
      throw err;
    }

    const pid = deps.spawnLongLived(
      'pnpm',
      ['dev', '--port', String(port)],
      {
        cwd: forgeClonePath(slug),
        logPath: log,
        env: { PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' },
      },
    );
    await mutateState((s) => {
      const e = s[forgeId];
      if (e) e.pid = pid;
    });

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await deps.probe(port)) {
        const final: RuntimeStateEntry = { ...baseEntry, pid, status: 'running' };
        await mutateState((s) => { s[forgeId] = final; });
        return final;
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    await deps.killProcess(pid).catch(() => {});
    await mutateState((s) => {
      const e = s[forgeId];
      if (e) e.status = 'crashed';
    });
    throw new Error(`Forge ${slug} failed to become healthy within ${PROBE_TIMEOUT_MS}ms`);
  }

  async function doStop(currentUser: SessionUser, forgeId: string): Promise<void> {
    const row = await loadForgeForAcl(forgeId);
    if (!canWriteForge(currentUser, aclFor(row))) {
      throw new ForbiddenError(`Cannot stop forge ${forgeId}`);
    }
    const state = await loadState();
    const entry = state[forgeId];
    if (!entry) return; // idempotent
    await mutateState((s) => {
      const e = s[forgeId];
      if (e) e.status = 'stopping';
    });
    if (entry.pid > 0) {
      try { await deps.killProcess(entry.pid); } catch (err) {
        console.error('[runtime/stopForge] kill failed', { pid: entry.pid, err });
      }
    }
    await mutateState((s) => { delete s[forgeId]; });
  }

  return {
    async startForge(currentUser, forgeId) {
      const cached = startInflight.get(forgeId);
      if (cached) return cached;
      const p = doStart(currentUser, forgeId)
        .finally(() => startInflight.delete(forgeId));
      startInflight.set(forgeId, p);
      return p;
    },

    async stopForge(currentUser, forgeId) {
      const cached = stopInflight.get(forgeId);
      if (cached) return cached;
      const p = doStop(currentUser, forgeId)
        .finally(() => stopInflight.delete(forgeId));
      stopInflight.set(forgeId, p);
      return p;
    },

    async getRuntime(currentUser, forgeId) {
      const row = await loadForgeForAcl(forgeId);
      if (!canReadForge(currentUser, aclFor(row))) {
        throw new ForbiddenError(`Cannot read forge ${forgeId}`);
      }
      const state = await loadState();
      const entry = state[forgeId];
      if (!entry) return null;
      return canWriteForge(currentUser, aclFor(row)) ? entry : redactPid(entry);
    },

    async listRuntimes(currentUser) {
      const visible = await deps.prisma.forge.findMany({
        where: forgeReadFilter(currentUser),
        include: { groups: { include: { group: true } } },
      });
      const idToWriteable = new Map<string, boolean>();
      for (const f of visible) {
        const acl = { id: f.id, createdById: f.createdById, groups: f.groups.map((g) => g.group.name) };
        idToWriteable.set(f.id, canWriteForge(currentUser, acl));
      }
      const state = await loadState();
      const out: RuntimeStateView[] = [];
      for (const [forgeId, writable] of idToWriteable) {
        const entry = state[forgeId];
        if (!entry) continue;
        out.push(writable ? entry : redactPid(entry));
      }
      return out;
    },
  };
}

function redactPid(e: RuntimeStateEntry): RuntimeStateView {
  const { pid: _drop, ...rest } = e;
  return rest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let cached: RuntimeService | null = null;

export function getRuntimeService(): RuntimeService {
  if (cached) return cached;
  cached = makeRuntimeService({
    prisma: defaultPrisma,
    githubClient: getGitHubClient(),
    clone: async (forge, gh) => { await defaultClone(forge, gh); },
    spawnLongLived: defaultSpawn,
    killProcess: defaultKill,
    isAlive: defaultIsAlive,
    probe: defaultProbe,
    portStart: 3001,
    portEnd: 3099,
  });
  return cached;
}

export function resetRuntimeService(): void {
  cached = null;
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test lib/services/runtime.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/services/runtime.ts lib/services/runtime.test.ts
git commit -m "feat(services): runtime service with per-forge locks + ACL-aware listing"
```

---

## Task 11: API routes — start / stop / runtime

**Files:**
- Create: `app/api/forges/[id]/start/route.ts`
- Create: `app/api/forges/[id]/stop/route.ts`
- Create: `app/api/forges/runtime/route.ts`

- [ ] **Step 1: Create `app/api/forges/[id]/start/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getRuntimeService } from '@/lib/services/runtime';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/start'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const runtime = await getRuntimeService().startForge(session.user, id);
    return NextResponse.json({ runtime });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 2: Create `app/api/forges/[id]/stop/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getRuntimeService } from '@/lib/services/runtime';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/stop'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await getRuntimeService().stopForge(session.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 3: Create `app/api/forges/runtime/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getRuntimeService } from '@/lib/services/runtime';
import { respondToServiceError } from '@/lib/http';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const runtimes = await getRuntimeService().listRuntimes(session.user);
    const map: Record<string, unknown> = {};
    for (const r of runtimes) map[r.forgeId] = r;
    return NextResponse.json({ runtimes: map });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/forges/[id]/start app/api/forges/[id]/stop app/api/forges/runtime
git commit -m "feat(api): runtime routes — POST start, POST stop, GET runtime"
```

---

## Task 12: UI — `ForgeCardRuntime` component

**Files:**
- Create: `app/(app)/dashboard/ForgeCardRuntime.tsx`
- Test:   `app/(app)/dashboard/ForgeCardRuntime.test.tsx`

- [ ] **Step 1: Write the failing tests**

`app/(app)/dashboard/ForgeCardRuntime.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeCardRuntime } from './ForgeCardRuntime';

const baseProps = {
  forgeId: 'f1',
  forgeName: 'Marketing Fru Fru',
  canWrite: true,
  onAction: vi.fn(),
};

beforeEach(() => baseProps.onAction.mockReset());

describe('ForgeCardRuntime', () => {
  it('renders Stopped + Start when there is no runtime', () => {
    render(<ForgeCardRuntime {...baseProps} runtime={null} />);
    expect(screen.getByText(/Stopped/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });

  it('renders Running + Open + Stop when status is running', () => {
    render(
      <ForgeCardRuntime
        {...baseProps}
        runtime={{
          forgeId: 'f1', slug: 'marketing-frufru', status: 'running',
          pid: 1, port: 3007, startedAt: '2026-05-09T00:00:00.000Z', logPath: '/tmp/x',
        }}
      />,
    );
    expect(screen.getByText(/Running/i)).toBeInTheDocument();
    const open = screen.getByRole('link', { name: /open/i });
    expect(open).toHaveAttribute('href', 'http://localhost:3007');
    expect(screen.getByRole('button', { name: /stop/i })).toBeEnabled();
  });

  it('renders Crashed + retry-Start with the log path', () => {
    render(
      <ForgeCardRuntime
        {...baseProps}
        runtime={{
          forgeId: 'f1', slug: 's', status: 'crashed',
          pid: 1, port: 3007, startedAt: 'x', logPath: '/tmp/log',
        }}
      />,
    );
    expect(screen.getByText(/Crashed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
    expect(screen.getByText('/tmp/log')).toBeInTheDocument();
  });

  it('start click invokes onAction("start")', async () => {
    const user = userEvent.setup();
    render(<ForgeCardRuntime {...baseProps} runtime={null} />);
    await user.click(screen.getByRole('button', { name: /start/i }));
    expect(baseProps.onAction).toHaveBeenCalledWith('start');
  });

  it('hides Start/Stop buttons when canWrite is false', () => {
    render(<ForgeCardRuntime {...baseProps} canWrite={false} runtime={null} />);
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test app/(app)/dashboard/ForgeCardRuntime.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `app/(app)/dashboard/ForgeCardRuntime.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { Play, Square, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RuntimeStateView } from '@/lib/runtime/types';

export type RuntimeAction = 'start' | 'stop';

type Props = {
  forgeId: string;
  forgeName: string;
  canWrite: boolean;
  runtime: RuntimeStateView | null;
  onAction: (action: RuntimeAction) => void | Promise<void>;
};

const DOT_CLASS: Record<NonNullable<RuntimeStateView['status']> | 'stopped', string> = {
  stopped: 'bg-[#6b7785]',
  starting: 'bg-[#e0a948] animate-pulse',
  running: 'bg-[#4ad28b]',
  stopping: 'bg-[#e0a948] animate-pulse',
  crashed: 'bg-[#d96868]',
  'setup-failed': 'bg-[#d96868]',
};

const LABEL: Record<NonNullable<RuntimeStateView['status']> | 'stopped', string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  crashed: 'Crashed',
  'setup-failed': 'Setup failed',
};

export function ForgeCardRuntime({ forgeId: _id, forgeName: _name, canWrite, runtime, onAction }: Props) {
  const status: keyof typeof LABEL = runtime?.status ?? 'stopped';
  const [busy, setBusy] = useState(false);

  async function go(action: RuntimeAction) {
    if (busy) return;
    setBusy(true);
    try { await onAction(action); } finally { setBusy(false); }
  }

  const showOpen = status === 'running' && runtime;
  const showStop = canWrite && (status === 'running' || status === 'starting' || status === 'stopping');
  const showStart = canWrite && (status === 'stopped' || status === 'crashed' || status === 'setup-failed');

  return (
    <div className="flex items-center justify-between gap-2 border-t border-border pt-3.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', DOT_CLASS[status])} />
        <span className="text-ink-dim">{LABEL[status]}</span>
        {status === 'crashed' || status === 'setup-failed' ? (
          <span className="ml-2 truncate font-mono text-[10px] text-ink-faint" title={runtime?.logPath}>
            {runtime?.logPath ?? ''}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        {showOpen ? (
          <a
            href={`http://localhost:${runtime!.port}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim hover:bg-panel-3 hover:text-ink"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open
          </a>
        ) : null}
        {showStop ? (
          <button
            type="button"
            onClick={() => go('stop')}
            disabled={busy || status === 'starting' || status === 'stopping'}
            aria-label="Stop"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim disabled:opacity-50 hover:bg-panel-3 hover:text-ink"
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
        ) : null}
        {showStart ? (
          <button
            type="button"
            onClick={() => go('start')}
            disabled={busy}
            aria-label="Start"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim disabled:opacity-50 hover:bg-panel-3 hover:text-ink"
          >
            <Play className="h-3.5 w-3.5" /> Start
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test app/(app)/dashboard/ForgeCardRuntime.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/(app)/dashboard/ForgeCardRuntime.tsx app/(app)/dashboard/ForgeCardRuntime.test.tsx
git commit -m "feat(dashboard): ForgeCardRuntime component (status + Start/Stop/Open)"
```

---

## Task 13: UI — polling hook + ForgeCard wiring

**Files:**
- Create: `app/(app)/dashboard/useForgeRuntimes.ts`
- Modify: `app/(app)/dashboard/ForgeCard.tsx`
- Modify: `app/(app)/dashboard/ForgeCard.test.tsx`
- Modify: `app/(app)/dashboard/DashboardClient.tsx`

- [ ] **Step 1: Implement `useForgeRuntimes`**

```ts
'use client';

import { useEffect, useRef, useState } from 'react';
import type { RuntimeStateView } from '@/lib/runtime/types';

export type RuntimeMap = Record<string, RuntimeStateView>;

const POLL_INTERVAL_MS = 3000;

export function useForgeRuntimes(): {
  runtimes: RuntimeMap;
  refetch: () => Promise<void>;
} {
  const [runtimes, setRuntimes] = useState<RuntimeMap>({});
  const cancelled = useRef(false);

  async function fetchOnce(): Promise<void> {
    try {
      const res = await fetch('/api/forges/runtime');
      if (!res.ok) return;
      const body = (await res.json()) as { runtimes: RuntimeMap };
      if (!cancelled.current) setRuntimes(body.runtimes ?? {});
    } catch {
      // Network blip — leave previous state in place.
    }
  }

  useEffect(() => {
    cancelled.current = false;
    void fetchOnce();
    const handle = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      clearInterval(handle);
    };
  }, []);

  return { runtimes, refetch: fetchOnce };
}
```

- [ ] **Step 2: Wire ForgeCardRuntime into ForgeCard**

Make exactly three textual changes to `app/(app)/dashboard/ForgeCard.tsx`:

(a) After the existing `import type { Forge } from '@/lib/services/types';` line, add:

```tsx
import { ForgeCardRuntime, type RuntimeAction } from './ForgeCardRuntime';
import type { RuntimeStateView } from '@/lib/runtime/types';
```

(b) Replace the existing `Props` type (currently `{ forge; onEdit?; onDelete? }`) with:

```tsx
type Props = {
  forge: Forge;
  canWrite: boolean;
  runtime: RuntimeStateView | null;
  onRuntimeAction: (forge: Forge, action: RuntimeAction) => void | Promise<void>;
  onEdit?: (forge: Forge) => void;
  onDelete?: (forge: Forge) => void;
};
```

…and update the destructuring in the function signature accordingly:

```tsx
export function ForgeCard({ forge, canWrite, runtime, onRuntimeAction, onEdit, onDelete }: Props) {
```

(c) Immediately before the closing `</article>` tag (currently the last line of the JSX), insert:

```tsx
      <ForgeCardRuntime
        forgeId={forge.id}
        forgeName={forge.name}
        canWrite={canWrite}
        runtime={runtime}
        onAction={(action) => onRuntimeAction(forge, action)}
      />
```

Do not modify any of the existing markup between `<article>` and the new line.

- [ ] **Step 3: Update `ForgeCard.test.tsx`**

Search for places that render `<ForgeCard ... />` and add the new required props:

```tsx
<ForgeCard
  forge={forge}
  canWrite
  runtime={null}
  onRuntimeAction={() => {}}
  // ... existing props
/>
```

- [ ] **Step 4: Wire it up in DashboardClient**

Make four textual changes to `app/(app)/dashboard/DashboardClient.tsx`:

(a) Add to the imports near the top of the file:

```tsx
import { useForgeRuntimes } from './useForgeRuntimes';
import type { RuntimeAction } from './ForgeCardRuntime';
```

(`Forge` is already imported via `@/lib/services/types` — no change needed.)

(b) Replace the existing `Props` type with:

```tsx
type Props = {
  initialForges: Forge[];
  allGroups: GroupDto[];
  myGroups: string[];
  isAdmin: boolean;
  currentUserId: string;
};
```

…and update the function signature:

```tsx
export function DashboardClient({ initialForges, allGroups, myGroups, isAdmin, currentUserId }: Props) {
```

(c) Immediately after the existing `const [forges, setForges] = useState<Forge[]>(initialForges);` block (and the seenInitial sync that follows it), add:

```tsx
  const { runtimes, refetch: refetchRuntimes } = useForgeRuntimes();

  async function handleRuntimeAction(forge: Forge, action: RuntimeAction): Promise<void> {
    try {
      const res = await fetch(`/api/forges/${forge.id}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `${action} failed (${res.status})`);
      }
      void refetchRuntimes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${action} failed`);
    }
  }
```

(d) In the existing `<ForgeCard key={f.id} ... />` render, add the new props (keep the existing `onEdit` / `onDelete` lines):

```tsx
<ForgeCard
  key={f.id}
  forge={f}
  canWrite={isAdmin || f.createdBy.id === currentUserId}
  runtime={runtimes[f.id] ?? null}
  onRuntimeAction={handleRuntimeAction}
  onEdit={(forge) => setEditing(forge)}
  onDelete={(forge) => setDeleting(forge)}
/>
```

- [ ] **Step 4b: Pass `currentUserId` from the RSC**

In `app/(app)/dashboard/page.tsx`, the existing `<DashboardClient ... />` element looks like:

```tsx
return (
  <DashboardClient
    initialForges={forges}
    allGroups={allGroups}
    myGroups={session.user.groups}
    isAdmin={session.user.isAdmin}
  />
);
```

Add one prop just below `isAdmin`:

```tsx
    currentUserId={session.user.id}
```

- [ ] **Step 5: Typecheck + run all UI tests**

Run: `pnpm typecheck && pnpm test app/(app)/dashboard`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/(app)/dashboard/useForgeRuntimes.ts app/(app)/dashboard/ForgeCard.tsx app/(app)/dashboard/ForgeCard.test.tsx app/(app)/dashboard/DashboardClient.tsx app/(app)/dashboard/page.tsx
git commit -m "feat(dashboard): poll runtime status + wire Start/Stop/Open into ForgeCard"
```

---

## Task 14: Boot hook — `instrumentation.ts`

**Files:**
- Create: `instrumentation.ts` (repo root)

- [ ] **Step 1: Create `instrumentation.ts`**

```ts
export async function register(): Promise<void> {
  // Skip Edge / browser runtimes — runtime modules use Node stdlib.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Skip during tests — tests construct their own services.
  if (process.env.NODE_ENV === 'test') return;
  const { bootCleanup, startLivenessLoop } = await import('./lib/runtime/runner');
  try {
    await bootCleanup();
  } catch (err) {
    console.error('[instrumentation] bootCleanup failed', err);
  }
  startLivenessLoop();
  console.info('[instrumentation] runtime liveness loop started');
}
```

- [ ] **Step 2: Verify Next 16 picks it up**

Run: `pnpm dev` (in a second shell), wait for `Ready in ...`, then check the log includes `[instrumentation] runtime liveness loop started`.

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add instrumentation.ts
git commit -m "feat(runtime): boot orphan cleanup + liveness loop via instrumentation.ts"
```

---

## Task 15: E2E — start, open, stop a real forge

**Files:**
- Create: `tests/e2e/forge-orchestration.spec.ts`
- Modify: `playwright.config.ts` (only if `CRYSTAL_FORGE_HOME` needs forwarding)

- [ ] **Step 1: Inspect Playwright webServer env**

Run: `cat playwright.config.ts`
Expected: see existing `webServer.env`. If `CRYSTAL_FORGE_HOME` is not in there, add a fixture path. Otherwise skip Step 2.

- [ ] **Step 2: Forward `CRYSTAL_FORGE_HOME` to the Playwright web server**

In `playwright.config.ts` `webServer.env`:

```ts
CRYSTAL_FORGE_HOME: process.env.CRYSTAL_FORGE_HOME ?? './.test-forge-home',
```

- [ ] **Step 3: Add a pre-warmed clone fixture under `./.test-forge-home/clones/<slug>`**

For local dev only — committed only as a `.gitkeep` placeholder; the fixture itself is built on demand via a setup step. To keep this slice self-contained, the test stubs the clone directory before clicking Start:

```ts
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('start, open, stop a forge', async ({ page, request }) => {
  // Sign in as the dev user (existing helper used elsewhere in tests).
  await page.goto('/api/dev/switch-user?email=alice@example.com');
  await page.goto('/');

  // Find a forge created by the seed; the seed creates "Marketing Fru Fru" by default.
  const card = page.getByRole('article').filter({ hasText: 'Marketing Fru Fru' });
  await expect(card).toBeVisible();

  // Pre-warm the clone fixture so Start skips git clone + pnpm install in CI.
  const home = process.env.CRYSTAL_FORGE_HOME ?? './.test-forge-home';
  const clone = path.resolve(home, 'clones/marketing-frufru');
  await fs.mkdir(path.join(clone, '.git'), { recursive: true });
  await fs.mkdir(path.join(clone, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(clone, '.env.example'), 'DATABASE_URL=postgres://crystal:crystal@localhost:5433/marketing_frufru\n');
  await fs.writeFile(path.join(clone, 'package.json'), JSON.stringify({
    name: 'marketing-frufru', scripts: { dev: 'node -e "require(\'http\').createServer((_,res)=>res.end(\'Welcome to Marketing Fru Fru\')).listen(process.env.PORT||3000)"', 'prisma': 'node -e "process.exit(0)"' },
  }, null, 2));

  await card.getByRole('button', { name: /start/i }).click();
  await expect(card.getByText(/Running/i)).toBeVisible({ timeout: 60_000 });

  const open = card.getByRole('link', { name: /open/i });
  const href = await open.getAttribute('href');
  expect(href).toMatch(/^http:\/\/localhost:30\d\d$/);
  const child = await request.get(href!);
  expect(await child.text()).toContain('Welcome to Marketing Fru Fru');

  await card.getByRole('button', { name: /stop/i }).click();
  await expect(card.getByText(/Stopped/i)).toBeVisible({ timeout: 30_000 });
});
```

(Adjust the dev-user sign-in and seed forge name to match the existing harness conventions if they differ — check `tests/e2e` for the patterns already in use, e.g. `dashboard-crud.spec.ts`.)

- [ ] **Step 4: Run E2E**

Run: `pnpm e2e tests/e2e/forge-orchestration.spec.ts`
Expected: PASS. First run may take 30–60s on the Start step.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/forge-orchestration.spec.ts playwright.config.ts
git commit -m "test(e2e): start/open/stop a forge end-to-end with pre-warmed fixture"
```

---

## Final verification

- [ ] **Run the full suite**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
```

Expected: ALL PASS. Confirm `instrumentation.ts` log line appears in `pnpm dev`. Confirm two forges can run concurrently on different ports.

- [ ] **Manual smoke (matches spec §6 Manual)**

1. Two forges Start concurrently, both reach Running, Open both, both render correctly on different ports.
2. Kill the harness with SIGTERM mid-run. Restart. Confirm previously-running forges are gone (orphan cleanup). State is empty.
3. `kill -9 <forge-pid>` from a separate terminal. Within ~15s the badge flips to Crashed.
