# Forge Docker Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move each forge's dev server and Claude agent into a per-forge Docker container, backed by a hardened shared Postgres engine (per-forge role + `REVOKE CONNECT FROM PUBLIC`) and a per-forge workspace volume, so a forge's arbitrary code execution is sandboxed from the host, the dashboard, and other forges.

**Architecture:** The dashboard (host process) drives Docker via the CLI behind a fakeable `ContainerManager` interface. `doStart` creates a keep-alive container, runs setup (clone/install/build) inside it via `docker exec`, then starts `pnpm dev` on a container port published to `127.0.0.1:<host port>` — so the existing reverse proxy is unchanged. The agent runs via `docker exec -it … claude --dangerously-skip-permissions`. The shared `crystal-forge-pg` engine stays in its own container; each forge gets a scoped role and a per-start-rotated password, reachable only over a dedicated `crystal-forge-net` bridge.

**Tech Stack:** TypeScript (strict), Next.js 16, Prisma 7 + Postgres 16, `node-pty` + `ws`, Docker CLI, Vitest. Source spec: `docs/superpowers/specs/2026-06-03-forge-docker-isolation-design.md`.

---

## Scope

This plan covers spec phases 1–5 (the work required for a working containerized forge: lifecycle, DB hardening, in-container setup, agent PTY, transcript watcher). Spec **phase 6** (packet-level egress allowlist, CPU/memory limits) and the **agent GitHub-push credential** open question are deferred — see "Deferred follow-up" at the end. They have open design questions and should be planned after the foundation lands and the `docker exec` TTY + credential behaviours are validated against a real daemon.

## File map

**New files**
- `lib/runtime/container/types.ts` — `ContainerManager` interface + spec/option types
- `lib/runtime/container/fake-container-manager.ts` — in-memory fake (tests/e2e)
- `lib/runtime/container/fake-container-manager.test.ts`
- `lib/runtime/container/docker-container-manager.ts` — real CLI-backed impl
- `lib/runtime/container/docker-container-manager.test.ts` — argv-construction unit tests
- `lib/runtime/container/index.ts` — `getContainerManager()` factory keyed on `FORGE_RUNTIME_MODE`
- `lib/runtime/container-exec-runner.ts` — adapts `ContainerManager.exec` to the `CommandRunner` shape
- `lib/runtime/container-exec-runner.test.ts`
- `lib/runtime/container-setup.ts` — clone/env/basePath/install/generate, all via `exec`
- `lib/runtime/container-setup.test.ts`
- `lib/runtime/container-transcript-watcher.ts` — tails transcripts over `docker exec`
- `lib/runtime/container-transcript-watcher.test.ts`
- `lib/db/url.ts` — `buildScopedDatabaseUrl()`
- `lib/db/url.test.ts`
- `docker/forge-runtime.Dockerfile` — shared runtime image

**Modified files**
- `lib/env.ts` — add `FORGE_RUNTIME_MODE`, `FORGE_RUNTIME_IMAGE`, `FORGE_NETWORK`, `CONTAINER_PG_HOST`, `CONTAINER_PG_PORT`
- `lib/runtime/paths.ts` — add `workspaceVolumeName()`, `CONTAINER_WORKDIR`
- `lib/github/slug.ts` — add `dbNameToRole()`
- `lib/db/types.ts` — extend `DatabaseProvisioner` (role methods)
- `lib/db/pg-provisioner.ts` — implement role methods
- `lib/db/fake-provisioner.ts` — implement role methods + helpers
- `lib/services/forges.ts` — provision role at create, drop role at delete, neutralise `renderEnvExample`
- `lib/runtime/types.ts` — `pid` → `containerId`
- `lib/runtime/state.ts` — add `loadRuntimeHandle()`
- `lib/services/runtime.ts` — rewire `doStart`/`doStop` to containers
- `lib/runtime/runner.ts` — `bootCleanup` + liveness via `ContainerManager`
- `lib/runtime/claude-credentials.ts` — return creds for container injection
- `lib/runtime/ws-server.ts` — spawn agent via `docker exec`, use container watcher
- `docker-compose.yml` — add `crystal-forge-net`, bind Postgres to `127.0.0.1`
- `forge-launch.sh` — build runtime image; bring up network

---

## Phase 0 — Config & path helpers

### Task 1: Runtime/container environment variables

**Files:**
- Modify: `lib/env.ts:36-41`
- Test: `lib/env.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `lib/env.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { env } from './env';

describe('container runtime env defaults', () => {
  it('exposes docker runtime defaults', () => {
    expect(env.FORGE_RUNTIME_MODE).toBe('docker');
    expect(env.FORGE_RUNTIME_IMAGE).toBe('crystal-forge-runtime:latest');
    expect(env.FORGE_NETWORK).toBe('crystal-forge-net');
    expect(env.CONTAINER_PG_HOST).toBe('crystal-forge-pg');
    expect(env.CONTAINER_PG_PORT).toBe(5432);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/env.test.ts`
Expected: FAIL — `env.FORGE_RUNTIME_MODE` is `undefined`.

- [ ] **Step 3: Add the schema entries**

In `lib/env.ts`, inside the existing zod schema object (after the `DB_PROVISIONER_MODE` line at `:41`):
```ts
  // Forge runtime: where forges run. `docker` spawns per-forge containers;
  // `fake` uses the in-memory ContainerManager (tests/e2e/offline).
  FORGE_RUNTIME_MODE: z.enum(['docker', 'fake']).default('docker'),
  FORGE_RUNTIME_IMAGE: z.string().default('crystal-forge-runtime:latest'),
  FORGE_NETWORK: z.string().default('crystal-forge-net'),
  // How a forge container reaches the shared pg engine (service name on the
  // dedicated docker network — NOT the host-published 5433).
  CONTAINER_PG_HOST: z.string().default('crystal-forge-pg'),
  CONTAINER_PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts lib/env.test.ts
git commit -m "feat(env): add forge container runtime config"
```

### Task 2: Path & naming helpers

**Files:**
- Modify: `lib/runtime/paths.ts`
- Modify: `lib/github/slug.ts`
- Test: `lib/runtime/paths.test.ts` (create), `lib/github/slug.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Create `lib/runtime/paths.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { workspaceVolumeName, CONTAINER_WORKDIR } from './paths';

describe('paths container helpers', () => {
  it('derives a stable per-forge volume name', () => {
    expect(workspaceVolumeName('acme-blue')).toBe('forge-acme-blue');
  });
  it('uses a fixed in-container workdir', () => {
    expect(CONTAINER_WORKDIR).toBe('/workspace');
  });
});
```

Add to `lib/github/slug.test.ts`:
```ts
import { dbNameToRole } from './slug';

describe('dbNameToRole', () => {
  it('appends the _app suffix', () => {
    expect(dbNameToRole('forge_acme_blue')).toBe('forge_acme_blue_app');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test lib/runtime/paths.test.ts lib/github/slug.test.ts`
Expected: FAIL — `workspaceVolumeName`/`dbNameToRole` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `lib/runtime/paths.ts`:
```ts
/** Fixed mount point for the forge's code inside its container. */
export const CONTAINER_WORKDIR = '/workspace';

/** Stable docker volume name holding a forge's checkout + node_modules. */
export function workspaceVolumeName(slug: string): string {
  return `forge-${slug}`;
}
```

Append to `lib/github/slug.ts`:
```ts
/** Scoped login role name for a forge database. Preserves the safe charset. */
export function dbNameToRole(dbName: string): string {
  return `${dbName}_app`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test lib/runtime/paths.test.ts lib/github/slug.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/paths.ts lib/runtime/paths.test.ts lib/github/slug.ts lib/github/slug.test.ts
git commit -m "feat(runtime): add volume-name, workdir, and role-name helpers"
```

---

## Phase 1 — ContainerManager

### Task 3: ContainerManager interface & option types

**Files:**
- Create: `lib/runtime/container/types.ts`

- [ ] **Step 1: Write the types** (no test — interface only; exercised by Tasks 4–5)

Create `lib/runtime/container/types.ts`:
```ts
/** A published port binding: host side is always bound to a specific IP. */
export type PortPublish = { hostIp: string; hostPort: number; containerPort: number };

/** A volume mount: a named docker volume mounted at an in-container path. */
export type VolumeMount = { volume: string; target: string };

export type CreateContainerSpec = {
  /** docker --name; must be unique. */
  name: string;
  image: string;
  /** docker --label key=value pairs (used for discovery during cleanup). */
  labels?: Record<string, string>;
  /** Environment variables injected into the container. */
  env?: Record<string, string>;
  publish?: PortPublish;
  volumes?: VolumeMount[];
  network?: string;
  /** Long-lived PID 1. Defaults to a keep-alive (`sleep infinity`). */
  command?: string[];
};

export type ExecOpts = {
  workdir?: string;
  env?: Record<string, string>;
  /** Allocate an interactive TTY (docker exec -it). For the agent PTY. */
  tty?: boolean;
  /** Append combined stdout/stderr to this host file. */
  logPath?: string;
  timeoutMs?: number;
};

export type ContainerStatus = {
  exists: boolean;
  running: boolean;
};

export type ContainerSummary = {
  id: string;
  name: string;
  labels: Record<string, string>;
};

export type ContainerManager = {
  /** Create + start a detached container; returns its id. */
  create(spec: CreateContainerSpec): Promise<string>;
  /** Run a one-off command inside a running container. */
  exec(id: string, cmd: string, args: string[], opts?: ExecOpts): Promise<{ exitCode: number }>;
  inspect(id: string): Promise<ContainerStatus>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** List containers, optionally filtered by a `key=value` label. */
  list(opts?: { label?: string }): Promise<ContainerSummary[]>;
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no usages yet).

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/container/types.ts
git commit -m "feat(runtime): add ContainerManager interface"
```

### Task 4: FakeContainerManager

**Files:**
- Create: `lib/runtime/container/fake-container-manager.ts`
- Test: `lib/runtime/container/fake-container-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/container/fake-container-manager.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { FakeContainerManager } from './fake-container-manager';

describe('FakeContainerManager', () => {
  it('creates, inspects, stops, and removes a container', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'forge-x', image: 'img', labels: { 'crystal-forge.forgeId': 'f1' } });
    expect((await m.inspect(id)).running).toBe(true);
    await m.stop(id);
    expect((await m.inspect(id)).running).toBe(false);
    await m.remove(id);
    expect((await m.inspect(id)).exists).toBe(false);
  });

  it('records exec calls and returns the queued exit code', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'forge-x', image: 'img' });
    m.queueExit(0);
    const res = await m.exec(id, 'git', ['clone', 'url', '/workspace'], { workdir: '/workspace' });
    expect(res.exitCode).toBe(0);
    expect(m.execCalls).toEqual([
      { id, cmd: 'git', args: ['clone', 'url', '/workspace'], opts: { workdir: '/workspace' } },
    ]);
  });

  it('lists containers filtered by label', async () => {
    const m = new FakeContainerManager();
    await m.create({ name: 'a', image: 'img', labels: { 'crystal-forge.forgeId': 'f1' } });
    await m.create({ name: 'b', image: 'img', labels: { other: 'y' } });
    const found = await m.list({ label: 'crystal-forge.forgeId' });
    expect(found.map((c) => c.name)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/container/fake-container-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fake**

Create `lib/runtime/container/fake-container-manager.ts`:
```ts
import type {
  ContainerManager, ContainerStatus, ContainerSummary,
  CreateContainerSpec, ExecOpts,
} from './types';

type Entry = { id: string; spec: CreateContainerSpec; running: boolean };
export type ExecCall = { id: string; cmd: string; args: string[]; opts?: ExecOpts };

export class FakeContainerManager implements ContainerManager {
  private readonly containers = new Map<string, Entry>();
  private seq = 0;
  private readonly exitQueue: number[] = [];
  readonly execCalls: ExecCall[] = [];

  /** Queue the exit code the next exec() should return (default 0). */
  queueExit(code: number): void { this.exitQueue.push(code); }

  async create(spec: CreateContainerSpec): Promise<string> {
    const id = `fake-${++this.seq}`;
    this.containers.set(id, { id, spec, running: true });
    return id;
  }

  async exec(id: string, cmd: string, args: string[], opts?: ExecOpts): Promise<{ exitCode: number }> {
    this.execCalls.push({ id, cmd, args, ...(opts ? { opts } : {}) });
    return { exitCode: this.exitQueue.length ? this.exitQueue.shift()! : 0 };
  }

  async inspect(id: string): Promise<ContainerStatus> {
    const e = this.containers.get(id);
    return { exists: !!e, running: !!e?.running };
  }

  async stop(id: string): Promise<void> {
    const e = this.containers.get(id);
    if (e) e.running = false;
  }

  async remove(id: string): Promise<void> { this.containers.delete(id); }

  async list(opts?: { label?: string }): Promise<ContainerSummary[]> {
    const out: ContainerSummary[] = [];
    for (const e of this.containers.values()) {
      const labels = e.spec.labels ?? {};
      if (opts?.label && !(opts.label in labels)) continue;
      out.push({ id: e.id, name: e.spec.name, labels });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/container/fake-container-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container/fake-container-manager.ts lib/runtime/container/fake-container-manager.test.ts
git commit -m "feat(runtime): add FakeContainerManager"
```

### Task 5: DockerContainerManager (real, CLI-backed)

The real impl shells out through an injected `CommandRunner` for fire-and-forget commands (logged) and a small injected `capture(cmd, args)` for commands whose stdout we parse (`create` → id, `inspect`, `list`). Both are injectable so the argv construction is unit-testable without a daemon.

**Files:**
- Create: `lib/runtime/container/docker-container-manager.ts`
- Test: `lib/runtime/container/docker-container-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/container/docker-container-manager.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DockerContainerManager } from './docker-container-manager';

function recorder() {
  const calls: { args: string[] }[] = [];
  return {
    calls,
    capture: async (_cmd: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === 'create' || args[0] === 'start') return 'container123\n';
      if (args[0] === 'inspect') return 'true\n';
      return '';
    },
  };
}

describe('DockerContainerManager argv', () => {
  it('builds a create command with publish, volumes, network, env, labels', async () => {
    const rec = recorder();
    const m = new DockerContainerManager({ capture: rec.capture });
    const id = await m.create({
      name: 'forge-x',
      image: 'crystal-forge-runtime:latest',
      labels: { 'crystal-forge.forgeId': 'f1' },
      env: { PORT: '3000', DATABASE_URL: 'postgres://r:p@crystal-forge-pg:5432/forge_x' },
      publish: { hostIp: '127.0.0.1', hostPort: 3042, containerPort: 3000 },
      volumes: [{ volume: 'forge-x', target: '/workspace' }],
      network: 'crystal-forge-net',
    });
    expect(id).toBe('container123');
    const argv = rec.calls[0].args.join(' ');
    expect(argv).toContain('create --name forge-x');
    expect(argv).toContain('--label crystal-forge.forgeId=f1');
    expect(argv).toContain('--publish 127.0.0.1:3042:3000');
    expect(argv).toContain('--volume forge-x:/workspace');
    expect(argv).toContain('--network crystal-forge-net');
    expect(argv).toContain('--env PORT=3000');
    expect(argv).toContain('crystal-forge-runtime:latest sleep infinity');
  });

  it('inspect returns running=true when docker reports Running=true', async () => {
    const rec = recorder();
    const m = new DockerContainerManager({ capture: rec.capture });
    const status = await m.inspect('container123');
    expect(status).toEqual({ exists: true, running: true });
    expect(rec.calls[0].args.join(' ')).toBe('inspect -f {{.State.Running}} container123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/container/docker-container-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the real manager**

Create `lib/runtime/container/docker-container-manager.ts`:
```ts
import { spawn } from 'node:child_process';
import { childProcessRunner } from '../child-process-runner';
import type { CommandRunner } from '../runner-types';
import type {
  ContainerManager, ContainerStatus, ContainerSummary,
  CreateContainerSpec, ExecOpts,
} from './types';

/** Run a docker command and capture trimmed stdout. */
function defaultCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`docker ${args.join(' ')} failed (exit ${code}): ${err.trim()}`));
    });
  });
}

export type DockerDeps = {
  /** Injectable for tests; runs `docker <args>` and returns stdout. */
  capture?: (cmd: string, args: string[]) => Promise<string>;
  /** Injectable for tests; runs a logged, fire-and-forget docker command. */
  runner?: CommandRunner;
};

export class DockerContainerManager implements ContainerManager {
  private readonly capture: (cmd: string, args: string[]) => Promise<string>;
  private readonly runner: CommandRunner;

  constructor(deps: DockerDeps = {}) {
    this.capture = deps.capture ?? ((c, a) => defaultCapture(c, a));
    this.runner = deps.runner ?? childProcessRunner;
  }

  async create(spec: CreateContainerSpec): Promise<string> {
    const args = ['create', '--name', spec.name];
    for (const [k, v] of Object.entries(spec.labels ?? {})) args.push('--label', `${k}=${v}`);
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push('--env', `${k}=${v}`);
    if (spec.publish) {
      const p = spec.publish;
      args.push('--publish', `${p.hostIp}:${p.hostPort}:${p.containerPort}`);
    }
    for (const vol of spec.volumes ?? []) args.push('--volume', `${vol.volume}:${vol.target}`);
    if (spec.network) args.push('--network', spec.network);
    args.push(spec.image, ...(spec.command ?? ['sleep', 'infinity']));
    const id = (await this.capture('docker', args)).trim();
    await this.capture('docker', ['start', id]);
    return id;
  }

  async exec(id: string, cmd: string, args: string[], opts: ExecOpts = {}): Promise<{ exitCode: number }> {
    const docker = ['exec'];
    if (opts.tty) docker.push('-i', '-t'); else docker.push('-i');
    if (opts.workdir) docker.push('-w', opts.workdir);
    for (const [k, v] of Object.entries(opts.env ?? {})) docker.push('-e', `${k}=${v}`);
    docker.push(id, cmd, ...args);
    return this.runner.run('docker', docker, {
      ...(opts.logPath ? { logPath: opts.logPath } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  async inspect(id: string): Promise<ContainerStatus> {
    try {
      const out = (await this.capture('docker', ['inspect', '-f', '{{.State.Running}}', id])).trim();
      return { exists: true, running: out === 'true' };
    } catch {
      return { exists: false, running: false };
    }
  }

  async stop(id: string): Promise<void> {
    await this.capture('docker', ['stop', id]).catch(() => {});
  }

  async remove(id: string): Promise<void> {
    await this.capture('docker', ['rm', '-f', id]).catch(() => {});
  }

  async list(opts: { label?: string } = {}): Promise<ContainerSummary[]> {
    const args = ['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Labels}}'];
    if (opts.label) args.push('--filter', `label=${opts.label}`);
    const out = await this.capture('docker', args);
    return out.split('\n').filter(Boolean).map((line) => {
      const [id, name, labelStr] = line.split('\t');
      const labels: Record<string, string> = {};
      for (const pair of (labelStr ?? '').split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return { id, name, labels };
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/container/docker-container-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container/docker-container-manager.ts lib/runtime/container/docker-container-manager.test.ts
git commit -m "feat(runtime): add DockerContainerManager (CLI-backed)"
```

### Task 6: ContainerManager factory

**Files:**
- Create: `lib/runtime/container/index.ts`
- Test: `lib/runtime/container/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/container/index.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { getContainerManager, resetContainerManager } from './index';
import { FakeContainerManager } from './fake-container-manager';
import { DockerContainerManager } from './docker-container-manager';

afterEach(() => { resetContainerManager(); delete process.env.FORGE_RUNTIME_MODE; });

describe('getContainerManager', () => {
  it('returns the fake when FORGE_RUNTIME_MODE=fake', () => {
    process.env.FORGE_RUNTIME_MODE = 'fake';
    expect(getContainerManager()).toBeInstanceOf(FakeContainerManager);
  });
  it('returns the docker manager when FORGE_RUNTIME_MODE=docker', () => {
    process.env.FORGE_RUNTIME_MODE = 'docker';
    expect(getContainerManager()).toBeInstanceOf(DockerContainerManager);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/container/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the factory**

Create `lib/runtime/container/index.ts`:
```ts
import { env } from '@/lib/env';
import type { ContainerManager } from './types';
import { FakeContainerManager } from './fake-container-manager';
import { DockerContainerManager } from './docker-container-manager';

let cached: ContainerManager | null = null;

export function getContainerManager(): ContainerManager {
  if (cached) return cached;
  cached = env.FORGE_RUNTIME_MODE === 'fake'
    ? new FakeContainerManager()
    : new DockerContainerManager();
  return cached;
}

export function resetContainerManager(): void { cached = null; }

export type { ContainerManager } from './types';
```

Note: `env` is parsed once at import; the test sets `process.env` before first `getContainerManager()` and resets the cache between cases. If `lib/env.ts` freezes values at import time, the factory must read `process.env.FORGE_RUNTIME_MODE` directly instead of `env.FORGE_RUNTIME_MODE` — match whichever pattern `lib/env.ts` uses (check by reading it). If `env` is a getter/live proxy, the code above is correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/container/index.test.ts`
Expected: PASS. If it fails because `env` is frozen at import, switch both branches to read `process.env.FORGE_RUNTIME_MODE === 'fake'` and re-run.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container/index.ts lib/runtime/container/index.test.ts
git commit -m "feat(runtime): add ContainerManager factory"
```

---

## Phase 1b — Runtime image & infrastructure

These tasks are infrastructure; they're verified with explicit smoke commands rather than Vitest.

### Task 7: Runtime image

**Files:**
- Create: `docker/forge-runtime.Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

Create `docker/forge-runtime.Dockerfile`:
```dockerfile
# Shared base image for every forge container: Node + pnpm + git + Claude CLI.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 build-essential procps coreutils \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Pinned Claude Code CLI. Update the version to match the host's `claude --version`.
RUN npm install -g @anthropic-ai/claude-code@1.0.44

RUN useradd -m -d /home/forge -s /bin/bash forge \
 && mkdir -p /workspace /pnpm-store \
 && chown -R forge:forge /workspace /pnpm-store

ENV HOME=/home/forge
USER forge
WORKDIR /workspace
RUN pnpm config set store-dir /pnpm-store
```

- [ ] **Step 2: Build and smoke-test**

Run:
```bash
docker build -t crystal-forge-runtime:latest -f docker/forge-runtime.Dockerfile docker/
docker run --rm crystal-forge-runtime:latest sh -c 'node -v && pnpm -v && git --version && claude --version'
```
Expected: prints Node, pnpm, git, and claude versions with exit 0.

- [ ] **Step 3: Commit**

```bash
git add docker/forge-runtime.Dockerfile
git commit -m "feat(runtime): add shared forge runtime image"
```

### Task 8: Docker network + loopback-bound Postgres

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Edit compose**

In `docker-compose.yml`, change the postgres `ports` mapping and add the network. Replace:
```yaml
    ports:
      # Host 5433 → container 5432 because another Postgres already binds 5432 on this host.
      - "5433:5432"
```
with:
```yaml
    ports:
      # Bound to loopback so forge containers can't reach it via the docker gateway.
      - "127.0.0.1:5433:5432"
    networks:
      - crystal-forge-net
```
and append at the end of the file:
```yaml
networks:
  crystal-forge-net:
    name: crystal-forge-net
```

- [ ] **Step 2: Verify**

Run:
```bash
docker compose up -d postgres
docker network inspect crystal-forge-net -f '{{range .Containers}}{{.Name}} {{end}}'
docker inspect crystal-forge-pg -f '{{json .NetworkSettings.Ports}}'
```
Expected: the network lists `crystal-forge-pg`; the port binding shows `127.0.0.1`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): add crystal-forge-net and bind pg to loopback"
```

### Task 9: forge-launch.sh builds the image and network

**Files:**
- Modify: `forge-launch.sh`

- [ ] **Step 1: Add image build + network ensure**

In `forge-launch.sh`, after the step that brings up the Postgres container and before it execs `pnpm dev`, add:
```bash
# Ensure the shared forge runtime image exists (build if missing).
if ! docker image inspect crystal-forge-runtime:latest >/dev/null 2>&1; then
  echo "Building crystal-forge-runtime image…"
  docker build -t crystal-forge-runtime:latest -f docker/forge-runtime.Dockerfile docker/
fi

# Ensure the dedicated forge network exists (compose creates it, but be explicit).
docker network inspect crystal-forge-net >/dev/null 2>&1 \
  || docker network create crystal-forge-net
```

- [ ] **Step 2: Verify**

Run: `bash -n forge-launch.sh` (syntax check)
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add forge-launch.sh
git commit -m "feat(launch): build runtime image and ensure forge network"
```

---

## Phase 2 — Per-forge database role provisioning

### Task 10: Extend the DatabaseProvisioner interface + fake

**Files:**
- Modify: `lib/db/types.ts`
- Modify: `lib/db/fake-provisioner.ts`
- Test: `lib/db/fake-provisioner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/db/fake-provisioner.test.ts`:
```ts
import { FakeDatabaseProvisioner } from './fake-provisioner';

describe('FakeDatabaseProvisioner roles', () => {
  it('provisions, password-rotates, and drops a role', async () => {
    const p = new FakeDatabaseProvisioner();
    await p.createDatabase('forge_x');
    await p.provisionRole('forge_x', 'forge_x_app');
    expect(p.hasRole('forge_x_app')).toBe(true);
    await p.setRolePassword('forge_x_app', 'deadbeef');
    expect(p.passwordOf('forge_x_app')).toBe('deadbeef');
    await p.dropRole('forge_x_app');
    expect(p.hasRole('forge_x_app')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/db/fake-provisioner.test.ts`
Expected: FAIL — `provisionRole` not a function.

- [ ] **Step 3: Extend the interface**

Replace the `DatabaseProvisioner` interface body in `lib/db/types.ts` (keep the existing doc comment style), adding after `dropDatabase`:
```ts
  /**
   * Idempotently create a LOGIN role, grant it privileges on `database`, and
   * REVOKE CONNECT on that database FROM PUBLIC so only this role (and
   * superusers) can connect. Safe to call repeatedly.
   */
  provisionRole(database: string, role: string): Promise<void>;

  /** Set (rotate) the login password for an existing role. */
  setRolePassword(role: string, password: string): Promise<void>;

  /** Drop the role if it exists (compensating action / on forge delete). */
  dropRole(role: string): Promise<void>;
```

- [ ] **Step 4: Implement in the fake**

In `lib/db/fake-provisioner.ts`: extend the `Method` union to
`'createDatabase' | 'dropDatabase' | 'provisionRole' | 'setRolePassword' | 'dropRole'`,
add `private readonly roles = new Map<string, string>();` and these methods:
```ts
  async provisionRole(_database: string, role: string): Promise<void> {
    this.maybeFail('provisionRole');
    if (!this.roles.has(role)) this.roles.set(role, '');
  }

  async setRolePassword(role: string, password: string): Promise<void> {
    this.maybeFail('setRolePassword');
    this.roles.set(role, password);
  }

  async dropRole(role: string): Promise<void> {
    this.maybeFail('dropRole');
    this.roles.delete(role);
  }

  hasRole(role: string): boolean { return this.roles.has(role); }
  passwordOf(role: string): string | undefined { return this.roles.get(role); }
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test lib/db/fake-provisioner.test.ts && pnpm typecheck`
Expected: test PASS; typecheck FAIL on `PgDatabaseProvisioner` (next task implements it).

- [ ] **Step 6: Commit**

```bash
git add lib/db/types.ts lib/db/fake-provisioner.ts lib/db/fake-provisioner.test.ts
git commit -m "feat(db): add role provisioning to DatabaseProvisioner + fake"
```

### Task 11: Implement role provisioning in PgDatabaseProvisioner

`provisionRole` touches two databases: db-level grants/revoke on the admin connection, and `GRANT ALL ON SCHEMA public` on a connection to the target db (Postgres 15+ locks down `public` for non-owners).

**Files:**
- Modify: `lib/db/pg-provisioner.ts`
- Test: `lib/db/pg-provisioner.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add to `lib/db/pg-provisioner.test.ts` (reuses the file's existing `adminConnectionString`/`dropIfExists` helpers and `TEST_DB`):
```ts
async function roleExists(role: string): Promise<boolean> {
  const c = new Client({ connectionString: adminConnectionString() });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    return r.rowCount === 1;
  } finally { await c.end(); }
}

describe('PgDatabaseProvisioner roles (integration)', () => {
  const ROLE = '_test_provisioner_demo_app';
  let provisioner: PgDatabaseProvisioner;

  beforeEach(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    provisioner = new PgDatabaseProvisioner({
      host: url.hostname, port: Number(url.port || 5432),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    });
    await provisioner.dropRole(ROLE).catch(() => {});
    await dropIfExists(TEST_DB);
    await provisioner.createDatabase(TEST_DB);
  });

  afterEach(async () => {
    await dropIfExists(TEST_DB);
    await provisioner.dropRole(ROLE).catch(() => {});
  });

  it('provisionRole creates the role and lets it connect with a rotated password', async () => {
    await provisioner.provisionRole(TEST_DB, ROLE);
    await provisioner.setRolePassword(ROLE, 'abc123def456');
    expect(await roleExists(ROLE)).toBe(true);

    const url = new URL(adminConnectionString());
    url.username = ROLE; url.password = 'abc123def456'; url.pathname = `/${TEST_DB}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query('CREATE TABLE t (id int)'); // schema privilege check
    } finally { await c.end(); }
  });

  it('provisionRole is idempotent', async () => {
    await provisioner.provisionRole(TEST_DB, ROLE);
    await expect(provisioner.provisionRole(TEST_DB, ROLE)).resolves.toBeUndefined();
  });

  it('refuses unsafe role names', async () => {
    await expect(provisioner.provisionRole(TEST_DB, 'Bad-Role')).rejects.toThrow(/unsafe/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/db/pg-provisioner.test.ts`
Expected: FAIL — `provisionRole` not implemented.

- [ ] **Step 3: Implement the methods**

In `lib/db/pg-provisioner.ts`, add a private helper to build a URL for a specific db, and the three methods. The password is constrained to a safe charset (callers generate hex — see Task 16), validated defensively here:
```ts
  private dbUrl(database: string): string {
    const url = new URL(this.adminUrl);
    url.pathname = `/${database}`;
    return url.toString();
  }

  async provisionRole(database: string, role: string): Promise<void> {
    this.assertSafe(database);
    this.assertSafe(role);
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
             CREATE ROLE "${role}" LOGIN;
           END IF;
         END $$;`,
      );
      await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    } finally { await admin.end(); }

    const target = new Client({ connectionString: this.dbUrl(database) });
    await target.connect();
    try {
      await target.query(`GRANT ALL ON SCHEMA public TO "${role}"`);
    } finally { await target.end(); }
  }

  async setRolePassword(role: string, password: string): Promise<void> {
    this.assertSafe(role);
    if (!/^[a-f0-9]+$/.test(password)) {
      throw new Error('Refusing to set a password outside the safe hex charset');
    }
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(`ALTER ROLE "${role}" WITH PASSWORD '${password}'`);
    } finally { await admin.end(); }
  }

  async dropRole(role: string): Promise<void> {
    this.assertSafe(role);
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  }
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test lib/db/pg-provisioner.test.ts && pnpm typecheck`
Expected: PASS (requires the Postgres container running).

- [ ] **Step 5: Commit**

```bash
git add lib/db/pg-provisioner.ts lib/db/pg-provisioner.test.ts
git commit -m "feat(db): implement per-forge role provisioning in PgDatabaseProvisioner"
```

### Task 12: Scoped DATABASE_URL builder

**Files:**
- Create: `lib/db/url.ts`
- Test: `lib/db/url.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/db/url.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildScopedDatabaseUrl } from './url';

describe('buildScopedDatabaseUrl', () => {
  it('targets the container pg host with role creds and db name', () => {
    const url = buildScopedDatabaseUrl({ role: 'forge_x_app', password: 'abc123', database: 'forge_x' });
    expect(url).toBe('postgres://forge_x_app:abc123@crystal-forge-pg:5432/forge_x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/db/url.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/db/url.ts`:
```ts
import { env } from '@/lib/env';

/** The DATABASE_URL injected into a forge container — role creds, container-network host. */
export function buildScopedDatabaseUrl(opts: { role: string; password: string; database: string }): string {
  return `postgres://${opts.role}:${opts.password}@${env.CONTAINER_PG_HOST}:${env.CONTAINER_PG_PORT}/${opts.database}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/db/url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/url.ts lib/db/url.test.ts
git commit -m "feat(db): add scoped DATABASE_URL builder"
```

### Task 13: Provision role at forge create, drop at delete

**Files:**
- Modify: `lib/services/forges.ts` (create flow ~`:234-240`, delete flow `safeDropDatabase` area `:379-385`, `renderEnvExample` `:19-26`)
- Test: `lib/services/forges.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/services/forges.test.ts` (this suite already builds a forge with a `FakeDatabaseProvisioner` — mirror the existing create-flow test's setup):
```ts
it('provisions a scoped role alongside the database on create', async () => {
  // ...existing arrange that calls createForge with a FakeDatabaseProvisioner `provisioner`...
  await createForge(currentUser, input, prisma, client, provisioner);
  const dbName = slugToDbName(slugifyForgeName(input.name));
  expect(provisioner.has(dbName)).toBe(true);
  expect(provisioner.hasRole(`${dbName}_app`)).toBe(true);
});
```
Adjust the arrange section to match the existing test's variable names (`currentUser`, `input`, `prisma`, `client`, `provisioner`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/forges.test.ts`
Expected: FAIL — role not provisioned.

- [ ] **Step 3: Wire provisioning into create + delete**

In `lib/services/forges.ts`:
1. Add the import: `import { dbNameToRole } from '@/lib/github/slug';`
2. In the create flow, immediately after `await provisioner.createDatabase(dbName);` (`:236`), add:
```ts
    await provisioner.provisionRole(dbName, dbNameToRole(dbName));
```
3. In the delete flow, after the database is dropped (the `safeDropDatabase` call site `:259`/`:383`), add a matching role drop. Update `safeDropDatabase` (or the delete caller) to also run:
```ts
    await provisioner.dropRole(dbNameToRole(dbName)).catch(() => {});
```
   (Drop the database first, then the role — once the db is gone the role owns nothing and the drop succeeds.)
4. Neutralise `renderEnvExample` so it no longer commits superuser creds — the real URL is injected at runtime (Task 16). Replace the `DATABASE_URL=` line (`:23`) with:
```ts
    '# DATABASE_URL is injected into the forge container at runtime by the harness.',
    'DATABASE_URL=postgres://localhost:5432/placeholder',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/services/forges.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts lib/services/forges.test.ts
git commit -m "feat(forges): provision scoped role on create, drop on delete"
```

---

## Phase 3 — In-container setup (replacing host clone)

### Task 14: container-exec-runner

**Files:**
- Create: `lib/runtime/container-exec-runner.ts`
- Test: `lib/runtime/container-exec-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/container-exec-runner.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { containerExecRunner } from './container-exec-runner';
import { FakeContainerManager } from './container/fake-container-manager';

describe('containerExecRunner', () => {
  it('maps RunOpts.cwd to exec workdir and forwards the command', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    const runner = containerExecRunner(m, id);
    const res = await runner.run('pnpm', ['install'], { cwd: '/workspace', logPath: '/tmp/x.log' });
    expect(res.exitCode).toBe(0);
    expect(m.execCalls[0]).toMatchObject({
      id, cmd: 'pnpm', args: ['install'],
      opts: { workdir: '/workspace', logPath: '/tmp/x.log' },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/container-exec-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/runtime/container-exec-runner.ts`:
```ts
import type { CommandRunner, CommandResult, RunOpts } from './runner-types';
import type { ContainerManager } from './container/types';

/** A CommandRunner that runs every command inside a fixed container. */
export function containerExecRunner(mgr: ContainerManager, containerId: string): CommandRunner {
  return {
    run(cmd: string, args: string[], opts: RunOpts = {}): Promise<CommandResult> {
      return mgr.exec(containerId, cmd, args, {
        ...(opts.cwd ? { workdir: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.logPath ? { logPath: opts.logPath } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/container-exec-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container-exec-runner.ts lib/runtime/container-exec-runner.test.ts
git commit -m "feat(runtime): add containerExecRunner adapter"
```

### Task 15: container-setup orchestrator

Replaces `clone.ts`'s host-`fs` operations with `exec` calls against `/workspace`. Mirrors the existing sequence: clone (if absent) → remote set-url → env copy → basePath inject → chmod hook → install (if absent) → prisma generate.

**Files:**
- Create: `lib/runtime/container-setup.ts`
- Test: `lib/runtime/container-setup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/container-setup.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { setupForgeContainer } from './container-setup';
import { FakeContainerManager } from './container/fake-container-manager';

describe('setupForgeContainer', () => {
  it('runs clone, env copy, basePath inject, install, and prisma generate', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 'gh_tok', logPath: '/tmp/acme.log',
    });
    const cmds = m.execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.startsWith('git clone'))).toBe(true);
    expect(cmds.some((c) => c.includes('remote set-url origin https://github.com/org/acme.git'))).toBe(true);
    expect(cmds.some((c) => c.includes('next.config.base.ts'))).toBe(true); // basePath inject
    expect(cmds.some((c) => c === 'pnpm install')).toBe(true);
    expect(cmds.some((c) => c === 'pnpm prisma generate')).toBe(true);
  });

  it('throws when a step exits non-zero', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    m.queueExit(1); // first exec (the .git test) "fails" → treated as "not cloned", fine
    m.queueExit(1); // git clone fails
    await expect(setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log',
    })).rejects.toThrow(/git clone/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/container-setup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/runtime/container-setup.ts`:
```ts
import { CONTAINER_WORKDIR } from './paths';
import type { ContainerManager, ExecOpts } from './container/types';

const W = CONTAINER_WORKDIR;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 60 * 1000;

export type SetupOpts = { slug: string; repoFullName: string; token: string; logPath: string };

// Wrapper written when injecting basePath. Mirrors clone.ts BASE_PATH_WRAPPER.
const WRAPPER = `// crystal-forge: basePath injected for path-based reverse proxy. Do not edit.
import base from './next.config.base';
const basePath = process.env.FORGE_BASE_PATH || undefined;
export default { ...base, basePath };
`;

export async function setupForgeContainer(
  mgr: ContainerManager,
  id: string,
  opts: SetupOpts,
): Promise<void> {
  const base: ExecOpts = { workdir: W, logPath: opts.logPath };
  const exec = (cmd: string, args: string[], o: ExecOpts = {}) =>
    mgr.exec(id, cmd, args, { ...base, ...o });
  const assertOk = async (p: Promise<{ exitCode: number }>, label: string) => {
    const { exitCode } = await p;
    if (exitCode !== 0) throw new Error(`${label} failed (exit ${exitCode})`);
  };

  // 1. Clone if /workspace/.git is absent. The GitHub token goes via an env var,
  //    never the URL/argv (avoids leaking it into docker ps / logs).
  const gitPresent = (await exec('test', ['-d', `${W}/.git`])).exitCode === 0;
  if (!gitPresent) {
    await assertOk(
      exec('sh', ['-c',
        `git clone "https://x-access-token:$GH_TOKEN@github.com/${opts.repoFullName}.git" ${W}`,
      ], { env: { GH_TOKEN: opts.token }, timeoutMs: CLONE_TIMEOUT_MS }),
      'git clone',
    );
    await assertOk(
      exec('git', ['-C', W, 'remote', 'set-url', 'origin',
        `https://github.com/${opts.repoFullName}.git`], { timeoutMs: QUICK_TIMEOUT_MS }),
      'git remote set-url',
    );
  }

  // 2. Seed .env.local from .env.example when present and missing.
  await exec('sh', ['-c',
    `test -f ${W}/.env.local || { test -f ${W}/.env.example && cp ${W}/.env.example ${W}/.env.local; } || true`,
  ]);

  // 3. Inject basePath wrapper (idempotent: next.config.base.ts is the marker).
  await exec('sh', ['-c',
    `if [ ! -f ${W}/next.config.base.ts ] && [ -f ${W}/next.config.ts ]; then ` +
    `if grep -qE 'export[[:space:]]+default[[:space:]]+(async[[:space:]]+)?function|export[[:space:]]+default[[:space:]]*\\(' ${W}/next.config.ts; then ` +
    `echo 'skip basePath inject (function config)'; else ` +
    `mv ${W}/next.config.ts ${W}/next.config.base.ts && cat > ${W}/next.config.ts <<'EOF'\n${WRAPPER}EOF\n; fi; fi`,
  ]);

  // 4. Restore exec bit on the PreToolUse hook (GitHub contents API drops it).
  await exec('sh', ['-c',
    `test -f ${W}/.claude/hooks/block-dangerous-commands.sh && chmod 755 ${W}/.claude/hooks/block-dangerous-commands.sh || true`,
  ]);

  // 5. Install deps if node_modules is absent.
  const modulesPresent = (await exec('test', ['-d', `${W}/node_modules`])).exitCode === 0;
  if (!modulesPresent) {
    await assertOk(exec('pnpm', ['install'], { timeoutMs: INSTALL_TIMEOUT_MS }), 'pnpm install');
  }

  // 6. Generate Prisma client (every start; cheap).
  await assertOk(exec('pnpm', ['prisma', 'generate'], { timeoutMs: QUICK_TIMEOUT_MS }), 'pnpm prisma generate');
}
```

Note: the second test case relies on the first exec (the `.git` test) returning the queued `1`, which `setupForgeContainer` reads as "not present" → proceeds to clone, whose queued `1` triggers the throw. Keep the `test -d .git` as the first exec so the queue ordering in the test holds.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/container-setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container-setup.ts lib/runtime/container-setup.test.ts
git commit -m "feat(runtime): add in-container forge setup orchestrator"
```

---

## Phase 4 — Runtime lifecycle cutover

### Task 16: Runtime state shape (containerId)

**Files:**
- Modify: `lib/runtime/types.ts`
- Modify: `lib/runtime/state.ts`
- Test: `lib/runtime/state.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/state.test.ts`:
```ts
import { loadRuntimeHandle } from './state';

it('loadRuntimeHandle returns containerId and port for a known forge', async () => {
  await mutateState((s) => {
    s['f1'] = {
      forgeId: 'f1', slug: 'x', status: 'running',
      containerId: 'c123', port: 3042, startedAt: 'now', logPath: '/tmp/x.log',
    };
  });
  expect(await loadRuntimeHandle('f1')).toEqual({ containerId: 'c123', port: 3042 });
  expect(await loadRuntimeHandle('missing')).toBeNull();
});
```
(Use the same `mutateState` import + `CRYSTAL_FORGE_HOME` temp-dir setup the existing tests in this file use.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/state.test.ts`
Expected: FAIL — `loadRuntimeHandle` not exported; type error on `containerId`.

- [ ] **Step 3: Update types + add the loader**

In `lib/runtime/types.ts`, in `RuntimeStateEntry` replace `pid: number;` with `containerId: string;`, and change the view type:
```ts
export type RuntimeStateView = Omit<RuntimeStateEntry, 'containerId'> & { containerId?: string };
```

In `lib/runtime/state.ts`, append:
```ts
/** No-ACL handle lookup for trusted internal callers (WS server). */
export async function loadRuntimeHandle(
  forgeId: string,
): Promise<{ containerId: string; port: number } | null> {
  const state = await loadState();
  const e = state[forgeId];
  return e ? { containerId: e.containerId, port: e.port } : null;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test lib/runtime/state.test.ts && pnpm typecheck`
Expected: state test PASS; typecheck FAIL in `runtime.ts`/`runner.ts`/`ws-server.ts` (fixed in Tasks 17–20).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/types.ts lib/runtime/state.ts lib/runtime/state.test.ts
git commit -m "feat(runtime): replace pid with containerId in runtime state"
```

### Task 17: Rewire runtime service to containers

**Files:**
- Modify: `lib/services/runtime.ts`
- Test: `lib/services/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the start/stop happy-path tests in `lib/services/runtime.test.ts` to drive a `FakeContainerManager` (mirror the existing test's ACL/forge setup; swap the process fakes for a container manager). Core assertions:
```ts
import { FakeContainerManager } from '@/lib/runtime/container/fake-container-manager';
import { FakeDatabaseProvisioner } from '@/lib/db/fake-provisioner';

it('startForge creates a container, runs setup, and marks running', async () => {
  const containers = new FakeContainerManager();
  const provisioner = new FakeDatabaseProvisioner();
  await provisioner.createDatabase('forge_demo');
  await provisioner.provisionRole('forge_demo', 'forge_demo_app');
  const svc = makeRuntimeService({
    /* prisma, githubClient, acl forge as in existing test */
    containerManager: containers,
    provisioner,
    setup: async () => {},                 // stub setup
    probe: async () => true,               // healthy immediately
    portStart: 3001, portEnd: 3099,
  } as never);
  const entry = await svc.startForge(currentUser, forgeId);
  expect(entry.status).toBe('running');
  expect(entry.containerId).toMatch(/^fake-/);
  expect((await containers.inspect(entry.containerId)).running).toBe(true);
});

it('stopForge stops and removes the container', async () => {
  // start as above, then:
  await svc.stopForge(currentUser, forgeId);
  expect((await containers.inspect(entry.containerId)).exists).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/runtime.test.ts`
Expected: FAIL — `RuntimeDeps` has no `containerManager`.

- [ ] **Step 3: Rewrite the service**

In `lib/services/runtime.ts`:

1. Update imports — remove `spawnLongLived`/`killProcess`/`isAlive` and host `clone`; add:
```ts
import { randomBytes } from 'node:crypto';
import { getContainerManager } from '@/lib/runtime/container';
import type { ContainerManager } from '@/lib/runtime/container/types';
import { setupForgeContainer } from '@/lib/runtime/container-setup';
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { buildScopedDatabaseUrl } from '@/lib/db/url';
import { dbNameToRole, slugToDbName } from '@/lib/github/slug';
import { workspaceVolumeName, CONTAINER_WORKDIR, logPath as logPathFor } from '@/lib/runtime/paths';
import { env } from '@/lib/env';
```

2. Replace the `RuntimeDeps` type:
```ts
export type RuntimeDeps = {
  prisma: PrismaClient;
  githubClient: GitHubClient;
  containerManager: ContainerManager;
  provisioner: DatabaseProvisioner;
  setup: (mgr: ContainerManager, id: string, opts: { slug: string; repoFullName: string; token: string; logPath: string }) => Promise<void>;
  probe: (port: number) => Promise<boolean>;
  portStart: number;
  portEnd: number;
};
```

3. Replace the body of `doStart` from the `const port = await allocatePort(...)` line onward:
```ts
    const port = await allocatePort({ start: deps.portStart, end: deps.portEnd });
    const startedAt = new Date().toISOString();
    const log = logPathFor(slug);
    const dbName = slugToDbName(slug);
    const role = dbNameToRole(dbName);

    const baseEntry: RuntimeStateEntry = {
      forgeId, slug, status: 'starting',
      containerId: '', port, startedAt, logPath: log,
    };
    await mutateState((s) => { s[forgeId] = baseEntry; });

    // Rotate the scoped DB password and build the URL injected into the container.
    const password = randomBytes(24).toString('hex');
    await deps.provisioner.setRolePassword(role, password);
    const databaseUrl = buildScopedDatabaseUrl({ role, password, database: dbName });

    const containerId = await deps.containerManager.create({
      name: `forge-${slug}`,
      image: env.FORGE_RUNTIME_IMAGE,
      labels: { 'crystal-forge.forgeId': forgeId },
      env: {
        PORT: '3000',
        NEXT_TELEMETRY_DISABLED: '1',
        FORGE_BASE_PATH: `/app/${slug}`,
        DATABASE_URL: databaseUrl,
      },
      publish: { hostIp: '127.0.0.1', hostPort: port, containerPort: 3000 },
      volumes: [{ volume: workspaceVolumeName(slug), target: CONTAINER_WORKDIR }],
      network: env.FORGE_NETWORK,
    });
    await mutateState((s) => { const e = s[forgeId]; if (e) e.containerId = containerId; });

    try {
      const token = await deps.githubClient.getInstallationToken();
      await deps.setup(deps.containerManager, containerId, { slug, repoFullName: row.repoFullName, token, logPath: log });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.containerManager.remove(containerId).catch(() => {});
      await mutateState((s) => { s[forgeId] = { ...baseEntry, containerId, status: 'setup-failed', setupError: msg }; });
      throw err;
    }

    // Start the dev server in the background inside the container.
    await deps.containerManager.exec(containerId, 'sh',
      ['-c', `pnpm dev --port 3000 >> ${CONTAINER_WORKDIR}/.forge-dev.log 2>&1 &`],
      { workdir: CONTAINER_WORKDIR });

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await deps.probe(port)) {
        const final: RuntimeStateEntry = { ...baseEntry, containerId, status: 'running' };
        let written = false;
        await mutateState((s) => { if (s[forgeId]) { s[forgeId] = final; written = true; } });
        if (!written) {
          await deps.containerManager.remove(containerId).catch(() => {});
          throw new RuntimeBusyError('Forge was stopped while starting');
        }
        return final;
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    await deps.containerManager.remove(containerId).catch(() => {});
    await mutateState((s) => { const e = s[forgeId]; if (e) e.status = 'crashed'; });
    throw new Error(`Forge ${slug} failed to become healthy within ${PROBE_TIMEOUT_MS}ms`);
```

4. Replace `doStop`'s kill block (`:161-166`):
```ts
    if (entry.containerId) {
      try { await deps.containerManager.stop(entry.containerId); await deps.containerManager.remove(entry.containerId); }
      catch (err) { console.error('[runtime/stopForge] container teardown failed', { id: entry.containerId, err }); }
    }
    await mutateState((s) => { delete s[forgeId]; });
```

5. Update `redactPid` → `redactContainerId`:
```ts
function redactContainerId(e: RuntimeStateEntry): RuntimeStateView {
  const { containerId: _drop, ...rest } = e;
  return rest;
}
```
   and replace its two call sites in `getRuntime`/`listRuntimes`.

6. Update `getRuntimeService()`:
```ts
  cached = makeRuntimeService({
    prisma: defaultPrisma,
    githubClient: getGitHubClient(),
    containerManager: getContainerManager(),
    provisioner: getDatabaseProvisioner(),
    setup: setupForgeContainer,
    probe: defaultProbe,
    portStart: 3001,
    portEnd: 3099,
  });
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test lib/services/runtime.test.ts && pnpm typecheck`
Expected: runtime test PASS; typecheck FAIL only in `runner.ts`/`ws-server.ts`.

- [ ] **Step 5: Commit**

```bash
git add lib/services/runtime.ts lib/services/runtime.test.ts
git commit -m "feat(runtime): run forges in per-forge containers"
```

### Task 18: Boot cleanup & liveness via ContainerManager

**Files:**
- Modify: `lib/runtime/runner.ts`
- Test: `lib/runtime/runner.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the `bootCleanup` and liveness tests in `lib/runtime/runner.test.ts` to use a `FakeContainerManager`:
```ts
import { FakeContainerManager } from './container/fake-container-manager';

it('bootCleanup removes labelled forge containers and clears state', async () => {
  const containers = new FakeContainerManager();
  const id = await containers.create({ name: 'forge-x', image: 'img', labels: { 'crystal-forge.forgeId': 'f1' } });
  await mutateState((s) => { s['f1'] = { forgeId: 'f1', slug: 'x', status: 'running', containerId: id, port: 3042, startedAt: 'now', logPath: '/tmp/x.log' }; });
  await bootCleanup({ containerManager: containers });
  expect((await containers.inspect(id)).exists).toBe(false);
  expect(await loadState()).toEqual({});
});

it('liveness marks a forge crashed when its container is gone', async () => {
  const containers = new FakeContainerManager();
  await mutateState((s) => { s['f1'] = { forgeId: 'f1', slug: 'x', status: 'running', containerId: 'gone', port: 3042, startedAt: 'now', logPath: '/tmp/x.log' }; });
  const check = makeLivenessChecker({ containerManager: containers, probe: async () => true });
  await check();
  expect((await loadState())['f1'].status).toBe('crashed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/runner.test.ts`
Expected: FAIL — deps shape mismatch.

- [ ] **Step 3: Rewrite runner.ts**

Replace `BootCleanupDeps`/`bootCleanup` and `LivenessDeps`/`makeLivenessChecker` to use the container manager (drop `isAlive`/`kill`):
```ts
import { loadState, mutateState } from './state';
import { probe as defaultProbe } from './probe';
import { getContainerManager } from './container';
import type { ContainerManager } from './container/types';

const FORGE_LABEL = 'crystal-forge.forgeId';

export type BootCleanupDeps = { containerManager?: ContainerManager };

export async function bootCleanup(deps: BootCleanupDeps = {}): Promise<void> {
  const mgr = deps.containerManager ?? getContainerManager();
  const containers = await mgr.list({ label: FORGE_LABEL });
  for (const c of containers) {
    try { await mgr.remove(c.id); }
    catch (err) { console.error('[runtime/bootCleanup] remove failed', { id: c.id, err }); }
  }
  await mutateState((s) => { for (const k of Object.keys(s)) delete s[k]; });
}

export type LivenessDeps = {
  containerManager?: ContainerManager;
  probe?: (port: number) => Promise<boolean>;
  now?: () => Date;
  startingTimeoutMs?: number;
  failureThreshold?: number;
};

export function makeLivenessChecker(deps: LivenessDeps = {}): () => Promise<void> {
  const mgr = deps.containerManager ?? getContainerManager();
  const probe = deps.probe ?? defaultProbe;
  const now = deps.now ?? (() => new Date());
  const startingTimeoutMs = deps.startingTimeoutMs ?? 60_000;
  const failureThreshold = deps.failureThreshold ?? 3;
  const failureCounts = new Map<string, number>();

  async function markCrashed(forgeId: string, containerId: string) {
    if (containerId) await mgr.remove(containerId).catch(() => {});
    await mutateState((s) => { const e = s[forgeId]; if (e) e.status = 'crashed'; });
  }

  return async function check(): Promise<void> {
    const state = await loadState();
    for (const entry of Object.values(state)) {
      if (entry.status === 'starting') {
        const ageMs = now().getTime() - new Date(entry.startedAt).getTime();
        if (ageMs > startingTimeoutMs) await markCrashed(entry.forgeId, entry.containerId);
        continue;
      }
      if (entry.status !== 'running') continue;
      const alive = (await mgr.inspect(entry.containerId)).running;
      const healthy = alive && await probe(entry.port);
      if (healthy) { failureCounts.delete(entry.forgeId); continue; }
      const next = (failureCounts.get(entry.forgeId) ?? 0) + 1;
      failureCounts.set(entry.forgeId, next);
      if (!alive || next >= failureThreshold) {
        failureCounts.delete(entry.forgeId);
        await markCrashed(entry.forgeId, entry.containerId);
      }
    }
  };
}
```
Keep `startLivenessLoop` unchanged (it just wraps `makeLivenessChecker`).

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test lib/runtime/runner.test.ts && pnpm typecheck`
Expected: runner test PASS; typecheck FAIL only in `ws-server.ts`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/runner.ts lib/runtime/runner.test.ts
git commit -m "feat(runtime): boot cleanup and liveness via ContainerManager"
```

---

## Phase 5 — Agent PTY & transcript watcher inside the container

### Task 19: Claude credentials seam for container injection

**Files:**
- Modify: `lib/runtime/claude-credentials.ts`
- Test: `lib/runtime/claude-credentials.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/claude-credentials.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { claudeCredentialsEnv } from './claude-credentials';

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe('claudeCredentialsEnv', () => {
  it('forwards ANTHROPIC_API_KEY when set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(claudeCredentialsEnv()).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });
  it('returns an empty object when unset', () => {
    expect(claudeCredentialsEnv()).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/claude-credentials.test.ts`
Expected: FAIL — currently always returns `{}`.

- [ ] **Step 3: Implement**

Replace the body of `claudeCredentialsEnv` in `lib/runtime/claude-credentials.ts`:
```ts
export function claudeCredentialsEnv(): Record<string, string> {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? { ANTHROPIC_API_KEY: key } : {};
}
```
Keep the existing doc comment but update it to note these are now injected into the forge container (via `docker exec -e`), not inherited by a host process.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/claude-credentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/claude-credentials.ts lib/runtime/claude-credentials.test.ts
git commit -m "feat(runtime): forward Anthropic creds for container injection"
```

### Task 20: Container transcript watcher

**Files:**
- Create: `lib/runtime/container-transcript-watcher.ts`
- Test: `lib/runtime/container-transcript-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/container-transcript-watcher.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { startContainerTranscriptWatcher } from './container-transcript-watcher';
import { EventEmitter } from 'node:events';

function fakeStream() {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void };
  ee.kill = vi.fn();
  return ee;
}

describe('startContainerTranscriptWatcher', () => {
  it('parses tailed lines into setClaudeSessionId + appendMessage', async () => {
    const stream = fakeStream();
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    const setClaudeSessionId = vi.fn().mockResolvedValue(undefined);
    const w = startContainerTranscriptWatcher('conv1', 'cid', {
      appendMessage, setClaudeSessionId,
      spawnTail: () => stream,
    });
    stream.emit('line', JSON.stringify({ sessionId: 's1', message: { role: 'assistant', content: 'hi' } }));
    await Promise.resolve();
    expect(setClaudeSessionId).toHaveBeenCalledWith('conv1', 's1');
    expect(appendMessage).toHaveBeenCalledWith('conv1', { role: 'assistant', content: 'hi' });
    w.stop();
    expect(stream.kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/container-transcript-watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/runtime/container-transcript-watcher.ts`:
```ts
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CONTAINER_WORKDIR } from './paths';
import { parseTranscriptLine, encodedCwd, type WatcherDeps } from './transcript-watcher';

export type TailStream = EventEmitter & { kill: () => void };

/** Injectable for tests; real impl tails the transcript dir over `docker exec`. */
export type SpawnTail = (containerId: string) => TailStream;

const defaultSpawnTail: SpawnTail = (containerId) => {
  // Container HOME is /home/forge (see forge-runtime.Dockerfile); cwd is /workspace.
  const dir = `/home/forge/.claude/projects/${encodedCwd(CONTAINER_WORKDIR)}`;
  const script =
    `until ls ${dir}/*.jsonl >/dev/null 2>&1; do sleep 0.25; done; ` +
    `exec tail -n +1 -F ${dir}/*.jsonl`;
  const child = spawn('docker', ['exec', containerId, 'sh', '-c', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const ee = new EventEmitter() as TailStream;
  ee.kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) ee.emit('line', line);
    }
  });
  return ee;
};

export function startContainerTranscriptWatcher(
  conversationId: string,
  containerId: string,
  deps: WatcherDeps & { spawnTail?: SpawnTail },
): { stop: () => void } {
  const spawnTail = deps.spawnTail ?? defaultSpawnTail;
  const stream = spawnTail(containerId);
  let sessionRecorded = false;
  stream.on('line', (line: string) => {
    const parsed = parseTranscriptLine(line);
    if (!parsed) return;
    if (!sessionRecorded) {
      sessionRecorded = true;
      void Promise.resolve(deps.setClaudeSessionId(conversationId, parsed.sessionId)).catch(() => {});
    }
    void Promise.resolve(deps.appendMessage(conversationId, {
      role: parsed.message.role, content: parsed.message.content,
    })).catch(() => {});
  });
  return { stop: () => { stream.kill(); } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/runtime/container-transcript-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/container-transcript-watcher.ts lib/runtime/container-transcript-watcher.test.ts
git commit -m "feat(runtime): add container transcript watcher"
```

### Task 21: WS server spawns the agent via docker exec

**Files:**
- Modify: `lib/runtime/ws-server.ts`
- Test: `lib/runtime/ws-server.test.ts`

- [ ] **Step 1: Write the failing test**

Update `lib/runtime/ws-server.test.ts` so the connection path asserts the PTY is spawned as a `docker exec … claude --dangerously-skip-permissions` command against the forge's container, and the container watcher is used. Mirror the existing test's WS connect + ticket setup; key assertions:
```ts
// loadRuntimeHandle stub returns a known container id + port
loadRuntimeHandle: async () => ({ containerId: 'cid', port: 3042 }),
spawnPty: (opts) => { captured = opts; return fakeSession(); },
// ...after a ticketed connection is accepted:
expect(captured.command).toBe('docker');
expect(captured.args).toEqual(expect.arrayContaining(['exec', '-i', '-t', '-w', '/workspace', 'cid', 'claude', '--dangerously-skip-permissions']));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/runtime/ws-server.test.ts`
Expected: FAIL — still spawns `claude` directly with a host cwd.

- [ ] **Step 3: Rewrite the connection wiring**

In `lib/runtime/ws-server.ts`:
1. Swap imports: replace `loadRuntimePort` with `loadRuntimeHandle` from `./state`, replace `startTranscriptWatcher`/`forgeClonePath` with `startContainerTranscriptWatcher` from `./container-transcript-watcher`, and import `claudeCredentialsEnv` from `./claude-credentials` and `CONTAINER_WORKDIR` from `./paths`.
2. Update `WsServerOpts`: replace `forgeClonePath?` and `loadForgePort?` with
   `loadRuntimeHandle?: (forgeId: string) => Promise<{ containerId: string; port: number } | null>;`
   and change `startWatcher?` to `(conversationId: string, containerId: string, deps: WatcherDeps) => { stop: () => void }`.
3. Replace the connection body that builds `cwd`/`port`/`pty`/`watcher` (`:48-62`):
```ts
    const handle = await loadForgeHandle(conv.forgeId);
    if (!handle) { ws.close(4404, 'Forge runtime not found'); return; }

    const credFlags: string[] = [];
    for (const [k, v] of Object.entries(claudeCredentialsEnv())) credFlags.push('-e', `${k}=${v}`);
    const resumeArgs = conv.claudeSessionId ? ['--resume', conv.claudeSessionId] : [];
    const pty = spawnPty({
      command: 'docker',
      args: ['exec', '-i', '-t', '-w', CONTAINER_WORKDIR, ...credFlags,
             handle.containerId, 'claude', '--dangerously-skip-permissions', ...resumeArgs],
      cwd: '/', cols: 80, rows: 24,
    });
    const watcher = startWatcher(conv.id, handle.containerId, { appendMessage, setClaudeSessionId });
```
   where `loadForgeHandle = opts.loadRuntimeHandle ?? defaultLoadRuntimeHandle` and
   `startWatcher = opts.startWatcher ?? ((cid, containerId, deps) => startContainerTranscriptWatcher(cid, containerId, deps))`.

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `pnpm test lib/runtime/ws-server.test.ts && pnpm typecheck && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ws-server.ts lib/runtime/ws-server.test.ts
git commit -m "feat(runtime): run the agent PTY inside the forge container"
```

---

## Final verification

- [ ] **Step 1: Full unit suite + lint + typecheck**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS. Confirm no remaining references to `spawnLongLived`, `isAlive`, `killProcess`, `loadRuntimePort`, `forgeClonePath`, or `startTranscriptWatcher` in the runtime path (`grep -rn` to verify; delete now-dead host-clone code in `clone.ts`/`process.ts`/`transcript-watcher.ts` only if nothing references them — **ask before deleting files**, per repo policy).

- [ ] **Step 2: E2E (fake mode, no daemon)**

Run: `pnpm e2e`
Expected: PASS — `FORGE_RUNTIME_MODE` resolves to `fake` under e2e (set it in `playwright.config.ts`'s env alongside `GITHUB_CLIENT_MODE=fake`).

- [ ] **Step 3: Manual smoke against a real daemon**

With Docker running and the image built (Task 7): start the dashboard, create/start a forge, confirm the preview loads under `/app/<slug>/`, open the terminal, confirm the agent responds and messages persist to the conversation. Confirm `docker ps` shows `forge-<slug>` and `docker volume ls` shows `forge-<slug>`.

---

## Deferred follow-up (spec phase 6 + open questions)

Not in this plan — track as a separate spec/plan once the foundation lands:

- **Agent GitHub-push credentials.** The installation token passed to setup is short-lived (~1h); long agent sessions that push need a git credential helper in the container that calls back to the dashboard for a fresh token. Decide helper-vs-injection after observing real session lengths.
- **Egress allowlist.** Restrict container outbound to GitHub + Anthropic only (egress proxy/firewall sidecar). Phase 1 leaves outbound open.
- **Resource limits.** Add `--cpus`/`--memory` to the create spec once noisy-neighbor data exists.
- **pnpm store volume.** If install is slow, add a shared `crystal-forge-pnpm-store` volume mount + `--store-dir` and validate on macOS.
