# Durable Claude Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a running Claude session survive a browser disconnect — close the tab (or drop the network), reopen later, and reattach to the same still-running session including the output produced while away.

**Architecture:** Move the durable `claude` process *inside* the forge container, hosted by a per-conversation tmux server (its own socket `claude-<conversationId>`). The dashboard's WebSocket server stops *launching* claude and instead *attaches* to that tmux session via `docker exec … tmux attach`. Session liveness is owned by tmux (`tmux has-session`), not by the dashboard process. Closing the browser detaches the tmux client; claude keeps running. Reattach replays tmux scrollback for free. An in-process registry (a `globalThis` singleton, like `lib/prisma.ts`) tracks the per-conversation transcript watcher and the currently-attached socket so we can move the watcher to session-lifecycle and support an explicit "End session". Surviving a dashboard restart is explicitly **out of scope** — the weekly maintenance restart + existing `bootCleanup` is the backstop reaper.

**Tech Stack:** Next.js 16 / React 19, TypeScript strict, `ws`, `node-pty`, Docker (`tmux` in the forge image), Vitest, Prisma 7.

**Spec:** `docs/superpowers/specs/2026-06-11-durable-claude-sessions-design.md`

---

## File Structure

- **Create** `lib/runtime/tmux-session.ts` — pure helpers wrapping `docker exec`: `hasSession`, `ensureSession`, `attachArgv`, `killSession`. Injectable `ContainerManager` for tests.
- **Create** `lib/runtime/session-registry.ts` — `globalThis`-backed singleton `Map<conversationId, SessionEntry>` shared between the WS server and the end-session route.
- **Create** `lib/runtime/end-session.ts` — tears down a session: `killSession` + stop watcher + close attached socket + drop registry entry.
- **Create** `app/api/forges/[id]/conversations/[conversationId]/end/route.ts` — authenticated POST that ACL-checks then calls `endSession`.
- **Modify** `lib/runtime/ws-server.ts` — connection handler becomes *ensure-then-attach* with takeover, stale-container handling, and watcher-on-session-lifecycle. New injectable opts.
- **Modify** `docker/forge-runtime.Dockerfile` — add `tmux` + a minimal config.
- **Modify** `app/(app)/forges/[id]/useChatSession.ts` — handle new close codes (4410 superseded, 4411 ended) and expose `end()`.
- **Modify** `app/(app)/forges/[id]/ChatPanel.tsx` — add an "End session" button.
- **Tests:** colocated `*.test.ts(x)` next to each new/changed file (repo convention).

---

## Task 1: Add tmux to the forge container image

**Files:**
- Modify: `docker/forge-runtime.Dockerfile:4-7`
- Create: `docker/forge-runtime.Dockerfile.test.ts` (guard test — keeps the dependency from silently regressing)

- [ ] **Step 1: Write the failing test**

Create `docker/forge-runtime.Dockerfile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('forge-runtime.Dockerfile', () => {
  const dockerfile = readFileSync(join(__dirname, 'forge-runtime.Dockerfile'), 'utf8');

  it('installs tmux (durable Claude sessions depend on it)', () => {
    expect(dockerfile).toMatch(/\btmux\b/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- docker/forge-runtime.Dockerfile.test.ts`
Expected: FAIL — `tmux` not present in the Dockerfile.

- [ ] **Step 3: Add tmux to the apt-get line**

In `docker/forge-runtime.Dockerfile`, edit the install list (line 6) to add `tmux`:

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 build-essential procps coreutils jq tmux \
 && rm -rf /var/lib/apt/lists/*
```

Then, after the `USER forge` / `WORKDIR /workspace` block (after line 23), add a minimal tmux config so reattach has generous scrollback and no status chrome:

```dockerfile
# tmux hosts the durable Claude session (see lib/runtime/tmux-session.ts).
# Large scrollback so a reattaching browser repaints prior output; no status
# bar; 256-color terminal to match the xterm client.
RUN printf '%s\n' \
      'set -g history-limit 100000' \
      'set -g status off' \
      'set -g default-terminal "tmux-256color"' \
      'set -g escape-time 0' \
      > /home/forge/.tmux.conf
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- docker/forge-runtime.Dockerfile.test.ts`
Expected: PASS.

- [ ] **Step 5: Rebuild the base image (manual, documents the migration)**

Run: `docker build -f docker/forge-runtime.Dockerfile -t crystal-forge/forge-runtime .`
Expected: build succeeds. Note in the commit body that **existing running forge containers must be recreated to gain tmux** (they won't have durable sessions until then).

- [ ] **Step 6: Commit**

```bash
git add docker/forge-runtime.Dockerfile docker/forge-runtime.Dockerfile.test.ts
git commit -m "feat(runtime): add tmux to the forge image for durable sessions"
```

---

## Task 2: tmux-session helpers

**Files:**
- Create: `lib/runtime/tmux-session.ts`
- Test: `lib/runtime/tmux-session.test.ts`

These wrap `docker exec` against a forge container. `hasSession` relies on `exec` returning `{ exitCode }` without throwing on non-zero (confirmed in `docker-container-manager.ts:65`). Each conversation gets its **own tmux server socket** (`-L claude-<id>`) so credentials passed via `docker exec -e` reliably reach the freshly-spawned claude (no shared-server env-propagation gotcha) and sessions are isolated.

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/tmux-session.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { hasSession, ensureSession, attachArgv, killSession } from './tmux-session';
import type { ContainerManager } from './container/types';

function fakeManager(execImpl: ContainerManager['exec']): ContainerManager {
  return {
    create: vi.fn(),
    exec: execImpl,
    inspect: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
  } as unknown as ContainerManager;
}

describe('tmux-session', () => {
  it('hasSession is true when tmux has-session exits 0', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const ok = await hasSession('cid', 'conv1', { manager: fakeManager(exec) });
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('cid', 'tmux',
      ['-L', 'claude-conv1', 'has-session', '-t', 'main']);
  });

  it('hasSession is false when tmux has-session exits non-zero', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1 }));
    expect(await hasSession('cid', 'conv1', { manager: fakeManager(exec) })).toBe(false);
  });

  it('ensureSession does nothing when the session already exists', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 })); // has-session -> 0
    const r = await ensureSession(
      { containerId: 'cid', conversationId: 'conv1', resumeSessionId: null },
      { manager: fakeManager(exec) },
    );
    expect(r).toEqual({ created: false });
    expect(exec).toHaveBeenCalledTimes(1); // only the has-session probe
  });

  it('ensureSession creates a new detached session running claude in /workspace', async () => {
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    const exec = vi.fn(async (_id: string, cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ cmd, args, env: opts?.env });
      return { exitCode: args.includes('has-session') ? 1 : 0 };
    });
    const r = await ensureSession(
      { containerId: 'cid', conversationId: 'conv1', resumeSessionId: null },
      { manager: fakeManager(exec as unknown as ContainerManager['exec']) },
    );
    expect(r).toEqual({ created: true });
    const create = calls.find((c) => c.args.includes('new-session'))!;
    expect(create.args).toEqual([
      '-L', 'claude-conv1', 'new-session', '-d', '-s', 'main', '-c', '/workspace',
      'claude --dangerously-skip-permissions',
    ]);
  });

  it('ensureSession appends --resume when a prior session id exists', async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (_id: string, _cmd: string, args: string[]) => {
      calls.push(args);
      return { exitCode: args.includes('has-session') ? 1 : 0 };
    });
    await ensureSession(
      { containerId: 'cid', conversationId: 'conv1', resumeSessionId: 'sess-abc' },
      { manager: fakeManager(exec as unknown as ContainerManager['exec']) },
    );
    const create = calls.find((a) => a.includes('new-session'))!;
    expect(create.at(-1)).toBe('claude --dangerously-skip-permissions --resume sess-abc');
  });

  it('attachArgv builds the interactive docker exec tmux attach command', () => {
    expect(attachArgv('cid', 'conv1')).toEqual({
      command: 'docker',
      args: ['exec', '-i', '-t', 'cid', 'tmux', '-L', 'claude-conv1', 'attach', '-t', 'main'],
    });
  });

  it('killSession kills the per-conversation tmux server', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    await killSession('cid', 'conv1', { manager: fakeManager(exec) });
    expect(exec).toHaveBeenCalledWith('cid', 'tmux', ['-L', 'claude-conv1', 'kill-server']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- lib/runtime/tmux-session.test.ts`
Expected: FAIL — module `./tmux-session` does not exist.

- [ ] **Step 3: Write the implementation**

Create `lib/runtime/tmux-session.ts`:

```ts
import { getContainerManager } from './container';
import type { ContainerManager } from './container/types';
import { CONTAINER_WORKDIR } from './paths';
import { claudeCredentialsEnv } from './claude-credentials';

/** One window per conversation; the socket name carries the conversation id. */
const SESSION = 'main';
const socket = (conversationId: string) => `claude-${conversationId}`;

export type TmuxDeps = { manager?: ContainerManager };

export async function hasSession(
  containerId: string,
  conversationId: string,
  deps: TmuxDeps = {},
): Promise<boolean> {
  const mgr = deps.manager ?? getContainerManager();
  const { exitCode } = await mgr.exec(containerId, 'tmux',
    ['-L', socket(conversationId), 'has-session', '-t', SESSION]);
  return exitCode === 0;
}

export async function ensureSession(
  opts: { containerId: string; conversationId: string; resumeSessionId: string | null },
  deps: TmuxDeps = {},
): Promise<{ created: boolean }> {
  const mgr = deps.manager ?? getContainerManager();
  if (await hasSession(opts.containerId, opts.conversationId, deps)) return { created: false };
  const resume = opts.resumeSessionId ? ` --resume ${opts.resumeSessionId}` : '';
  const command = `claude --dangerously-skip-permissions${resume}`;
  // Fresh per-conversation server, so credentials passed via `-e` (ExecOpts.env
  // -> docker exec -e) propagate to the claude process this spawns.
  await mgr.exec(opts.containerId, 'tmux',
    ['-L', socket(opts.conversationId), 'new-session', '-d', '-s', SESSION, '-c', CONTAINER_WORKDIR, command],
    { env: claudeCredentialsEnv() });
  return { created: true };
}

export function attachArgv(
  containerId: string,
  conversationId: string,
): { command: string; args: string[] } {
  return {
    command: 'docker',
    args: ['exec', '-i', '-t', containerId, 'tmux', '-L', socket(conversationId), 'attach', '-t', SESSION],
  };
}

export async function killSession(
  containerId: string,
  conversationId: string,
  deps: TmuxDeps = {},
): Promise<void> {
  const mgr = deps.manager ?? getContainerManager();
  await mgr.exec(containerId, 'tmux', ['-L', socket(conversationId), 'kill-server']);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- lib/runtime/tmux-session.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/tmux-session.ts lib/runtime/tmux-session.test.ts
git commit -m "feat(runtime): tmux-session helpers (ensure/attach/has/kill)"
```

---

## Task 3: In-process session registry

**Files:**
- Create: `lib/runtime/session-registry.ts`
- Test: `lib/runtime/session-registry.test.ts`

A `globalThis`-backed singleton so the WS server and the end-session API route (same Node process, possibly different bundles) share one map. Mirrors the `lib/prisma.ts` pattern.

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/session-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sessionRegistry, type SessionEntry } from './session-registry';

describe('sessionRegistry', () => {
  it('returns the same map instance across calls', () => {
    expect(sessionRegistry()).toBe(sessionRegistry());
  });

  it('stores and retrieves an entry', () => {
    const reg = sessionRegistry();
    const entry: SessionEntry = { containerId: 'cid', watcher: { stop: () => {} }, attachedWs: null };
    reg.set('conv-test-1', entry);
    expect(reg.get('conv-test-1')).toBe(entry);
    reg.delete('conv-test-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- lib/runtime/session-registry.test.ts`
Expected: FAIL — module `./session-registry` does not exist.

- [ ] **Step 3: Write the implementation**

Create `lib/runtime/session-registry.ts`:

```ts
import type { WebSocket } from 'ws';

export type SessionEntry = {
  /** Container the live tmux session belongs to. */
  containerId: string;
  /** Transcript watcher, scoped to the session (not the socket). */
  watcher: { stop: () => void };
  /** The currently-attached browser socket, or null when detached. */
  attachedWs: WebSocket | null;
};

export type SessionRegistry = Map<string, SessionEntry>;

const globalForRegistry = globalThis as unknown as {
  __forgeSessionRegistry?: SessionRegistry;
};

/** Shared in-process registry of live Claude sessions, keyed by conversationId. */
export function sessionRegistry(): SessionRegistry {
  return (globalForRegistry.__forgeSessionRegistry ??= new Map());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- lib/runtime/session-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/session-registry.ts lib/runtime/session-registry.test.ts
git commit -m "feat(runtime): shared in-process session registry"
```

---

## Task 4: Rework the WS server to ensure-then-attach

**Files:**
- Modify: `lib/runtime/ws-server.ts` (full rewrite of the connection handler + opts)
- Test: `lib/runtime/ws-server.test.ts` (update existing cases, add takeover + reattach)

The handler now: takes over any attached socket (was a `4409` reject), drops a stale-container entry, ensures the tmux session exists (starting the watcher only on creation), attaches a PTY to tmux, and on `ws.close` detaches **without** killing the session or watcher.

- [ ] **Step 1: Update the test file**

Replace the body of `lib/runtime/ws-server.test.ts` with the following. (Key changes vs. today: `startServer` injects `ensureSession`/`hasSession`/`attachArgv`/a fresh `registry`; the "spawns claude" test becomes "attaches via tmux"; the `4409` test becomes a takeover test; new reattach test asserts the watcher is started once.)

```ts
// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { startWsServer } from './ws-server';
import { signTicket } from '@/lib/auth/ws-ticket';
import type { SpawnOpts } from './pty-session';
import type { SessionRegistry } from './session-registry';

const SECRET = 'a'.repeat(32);
const servers: Array<{ stop: () => void }> = [];

afterEach(() => { while (servers.length) servers.pop()?.stop(); });

function fakeSession() {
  return { pid: 1234, write: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
}

async function startServer(overrides: Partial<Parameters<typeof startWsServer>[0]> = {}) {
  const fakePty = { spawn: vi.fn(() => fakeSession()) };
  const fakeWatcher = { start: vi.fn(() => ({ stop: vi.fn() })) };
  const registry: SessionRegistry = new Map();
  const server = await startWsServer({
    port: 0,
    secret: SECRET,
    spawnPty: fakePty.spawn,
    startWatcher: fakeWatcher.start,
    loadConversation: async (id: string) => ({ id, forgeId: 'f1', slug: 'aquaflow-designer', claudeSessionId: null }),
    loadRuntimeHandle: async () => ({ containerId: 'cid', port: 3042 }),
    ensureSession: vi.fn(async () => ({ created: true })),
    hasSession: vi.fn(async () => true),
    attachArgv: (containerId: string, conversationId: string) => ({
      command: 'docker',
      args: ['exec', '-i', '-t', containerId, 'tmux', '-L', `claude-${conversationId}`, 'attach', '-t', 'main'],
    }),
    registry,
    ...overrides,
  });
  servers.push(server);
  return { server, fakePty, fakeWatcher, registry };
}

function open(server: { port: number }, conversationId = 'c1') {
  const tok = signTicket({ conversationId, userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
  return new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
}
const opened = (ws: WebSocket) => new Promise<void>((res, rej) => {
  ws.once('open', () => res()); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 2000);
});
const closedCode = (ws: WebSocket) => new Promise<number>((res) => {
  ws.once('close', (c) => res(c)); ws.once('error', () => res(-1)); setTimeout(() => res(-2), 2000);
});

describe('ws-server', () => {
  it('attaches to the tmux session and starts the watcher on first connect', async () => {
    const { server, fakePty, fakeWatcher } = await startServer();
    const ws = open(server);
    await opened(ws);
    expect(fakePty.spawn).toHaveBeenCalledTimes(1);
    expect(fakeWatcher.start).toHaveBeenCalledWith('c1', 'cid', expect.anything());
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('spawns the PTY against docker exec ... tmux attach', async () => {
    let captured: SpawnOpts | null = null;
    const { server } = await startServer({ spawnPty: (opts: SpawnOpts) => { captured = opts; return fakeSession(); } });
    const ws = open(server);
    await opened(ws);
    const opts = captured as SpawnOpts | null;
    expect(opts?.command).toBe('docker');
    expect(opts?.args).toEqual(['exec', '-i', '-t', 'cid', 'tmux', '-L', 'claude-c1', 'attach', '-t', 'main']);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('passes the stored claudeSessionId to ensureSession for --resume', async () => {
    const ensureSession = vi.fn(async () => ({ created: true }));
    const { server } = await startServer({
      ensureSession,
      loadConversation: async (id: string) => ({ id, forgeId: 'f1', slug: 's', claudeSessionId: 'sess-9' }),
    });
    const ws = open(server);
    await opened(ws);
    expect(ensureSession).toHaveBeenCalledWith({ containerId: 'cid', conversationId: 'c1', resumeSessionId: 'sess-9' });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('rejects an expired ticket with close code 4401', async () => {
    const { server } = await startServer();
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() - 1 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    expect(await closedCode(ws)).toBe(4401);
  });

  it('closes 4404 when the forge has no running container', async () => {
    const { server } = await startServer({ loadRuntimeHandle: async () => null });
    expect(await closedCode(open(server))).toBe(4404);
  });

  it('closes 4500 when the session cannot be started (e.g. tmux missing)', async () => {
    const { server } = await startServer({
      ensureSession: vi.fn(async () => { throw new Error('tmux: command not found'); }),
    });
    expect(await closedCode(open(server))).toBe(4500);
  });

  it('supersedes the previous connection: old socket closes 4410, new attaches', async () => {
    const { server, fakeWatcher } = await startServer({ hasSession: vi.fn(async () => true) });
    const a = open(server);
    await opened(a);
    const b = open(server);
    const aCode = await closedCode(a);
    await opened(b);
    expect(aCode).toBe(4410);
    // Reattach must NOT start a second watcher.
    expect(fakeWatcher.start).toHaveBeenCalledTimes(1);
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('does not kill the session/watcher on ws close (detach only)', async () => {
    const stop = vi.fn();
    const { server, registry } = await startServer({ startWatcher: () => ({ stop }) });
    const ws = open(server);
    await opened(ws);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(stop).not.toHaveBeenCalled();
    expect(registry.get('c1')).toBeTruthy();
    expect(registry.get('c1')?.attachedWs).toBeNull();
  });

  it('forwards client input messages to the PTY', async () => {
    const write = vi.fn();
    const { server } = await startServer({
      spawnPty: () => ({ pid: 1, write, resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }),
    });
    const ws = open(server);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(write).toHaveBeenCalledWith('hi');
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- lib/runtime/ws-server.test.ts`
Expected: FAIL — `startWsServer` does not accept `ensureSession`/`hasSession`/`attachArgv`/`registry`; PTY args/close-code assertions don't match.

- [ ] **Step 3: Rewrite `lib/runtime/ws-server.ts`**

Replace the file with:

```ts
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTicket } from '@/lib/auth/ws-ticket';
import { spawnClaudeSession, type Session, type SpawnOpts } from './pty-session';
import type { WatcherDeps } from './transcript-watcher';
import { startContainerTranscriptWatcher } from './container-transcript-watcher';
import { appendMessage as defaultAppend, setClaudeSessionId as defaultSet, loadConversationLite } from '@/lib/services/conversations';
import type { ConversationLite } from '@/lib/services/conversations';
import { loadRuntimeHandle as defaultLoadRuntimeHandle } from './state';
import {
  ensureSession as defaultEnsureSession,
  hasSession as defaultHasSession,
  attachArgv as defaultAttachArgv,
} from './tmux-session';
import { sessionRegistry, type SessionRegistry } from './session-registry';

export type WsServerOpts = {
  port: number;
  secret: string;
  spawnPty?: (opts: SpawnOpts) => Session;
  startWatcher?: (conversationId: string, containerId: string, deps: WatcherDeps) => { stop: () => void };
  loadConversation?: (conversationId: string) => Promise<ConversationLite | null>;
  loadRuntimeHandle?: (forgeId: string) => Promise<{ containerId: string; port: number } | null>;
  appendMessage?: (conversationId: string, payload: { role: 'user' | 'assistant'; content: unknown; createdAt?: Date }) => Promise<void>;
  setClaudeSessionId?: (conversationId: string, sessionId: string) => Promise<void>;
  ensureSession?: (opts: { containerId: string; conversationId: string; resumeSessionId: string | null }) => Promise<{ created: boolean }>;
  hasSession?: (containerId: string, conversationId: string) => Promise<boolean>;
  attachArgv?: (containerId: string, conversationId: string) => { command: string; args: string[] };
  registry?: SessionRegistry;
};

export function startWsServer(opts: WsServerOpts): Promise<{ stop: () => void; port: number }> {
  const spawnPty = opts.spawnPty ?? spawnClaudeSession;
  const startWatcher = opts.startWatcher
    ?? ((cid, containerId, deps) => startContainerTranscriptWatcher(cid, containerId, deps));
  const appendMessage = opts.appendMessage ?? defaultAppend;
  const setClaudeSessionId = opts.setClaudeSessionId ?? defaultSet;
  const loadConversation = opts.loadConversation ?? loadConversationLite;
  const loadForgeHandle = opts.loadRuntimeHandle ?? defaultLoadRuntimeHandle;
  const ensureSession = opts.ensureSession ?? defaultEnsureSession;
  const hasSession = opts.hasSession ?? defaultHasSession;
  const attachArgv = opts.attachArgv ?? defaultAttachArgv;
  const registry = opts.registry ?? sessionRegistry();

  // Serialize concurrent connects for the same conversation so the
  // has-session -> ensure -> attach sequence is atomic.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  }

  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const payload = verifyTicket(token, opts.secret);
    if (!payload) { ws.close(4401, 'Invalid or expired ticket'); return; }
    const cid = payload.conversationId;

    void withLock(cid, async () => {
      try {
      const conv = await loadConversation(cid);
      if (!conv) { ws.close(4404, 'Conversation not found'); return; }
      const handle = await loadForgeHandle(conv.forgeId);
      if (!handle) { ws.close(4404, 'Forge runtime not found'); return; }

      // Takeover: detach any socket currently attached for this conversation.
      const prior = registry.get(cid);
      if (prior?.attachedWs && prior.attachedWs !== ws) {
        try { prior.attachedWs.close(4410, 'Superseded by a newer connection'); } catch { /* noop */ }
        prior.attachedWs = null;
      }
      // Stale entry from a previous container (forge stop/start): drop it.
      if (prior && prior.containerId !== handle.containerId) {
        prior.watcher.stop();
        registry.delete(cid);
      }

      // Ensure a live tmux session + a session-scoped watcher exist.
      let entry = registry.get(cid);
      if (!entry) {
        await ensureSession({ containerId: handle.containerId, conversationId: cid, resumeSessionId: conv.claudeSessionId });
        const watcher = startWatcher(cid, handle.containerId, { appendMessage, setClaudeSessionId });
        entry = { containerId: handle.containerId, watcher, attachedWs: null };
        registry.set(cid, entry);
      } else if (!(await hasSession(handle.containerId, cid))) {
        // Claude exited but the entry lingered — recreate from scratch.
        entry.watcher.stop();
        await ensureSession({ containerId: handle.containerId, conversationId: cid, resumeSessionId: conv.claudeSessionId });
        entry.watcher = startWatcher(cid, handle.containerId, { appendMessage, setClaudeSessionId });
      }

      const { command, args } = attachArgv(handle.containerId, cid);
      const pty = spawnPty({ command, args, cwd: '/', cols: 80, rows: 24 });
      const active = entry;
      active.attachedWs = ws;

      pty.onData((chunk) => { try { ws.send(chunk, { binary: false }); } catch { /* socket closed */ } });
      pty.onExit(() => {
        // The attach *client* exited (detach). Leave the session + watcher alone.
        if (active.attachedWs === ws) active.attachedWs = null;
        try { ws.close(4000, 'tmux client exited'); } catch { /* already closed */ }
      });
      ws.on('message', (raw, isBinary) => {
        if (isBinary) { pty.write(raw as Buffer); return; }
        const text = raw.toString('utf8');
        try {
          const msg = JSON.parse(text) as { type?: string };
          if (msg.type === 'input' && typeof (msg as { data?: unknown }).data === 'string') {
            pty.write((msg as { data: string }).data); return;
          }
          if (msg.type === 'resize') {
            const m = msg as { cols?: number; rows?: number };
            if (typeof m.cols === 'number' && typeof m.rows === 'number') pty.resize(m.cols, m.rows);
            return;
          }
        } catch { /* not JSON — raw write */ }
        pty.write(text);
      });
      ws.on('close', () => {
        pty.kill(); // detaches the tmux client; claude + watcher keep running
        if (active.attachedWs === ws) active.attachedWs = null;
      });
      } catch (err) {
        // tmux missing (un-rebuilt image), docker exec failure, etc.
        console.error('[runtime/ws] session setup failed', err);
        try { ws.close(4500, 'Failed to start session'); } catch { /* noop */ }
      }
    });
  });

  return new Promise<{ stop: () => void; port: number }>((resolve) => {
    http.listen(opts.port, () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        stop: () => {
          // Process teardown only: detach sockets. Sessions live in containers.
          for (const entry of registry.values()) {
            try { entry.attachedWs?.close(); } catch { /* noop */ }
            entry.attachedWs = null;
          }
          wss.close();
          http.close();
        },
      });
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- lib/runtime/ws-server.test.ts`
Expected: PASS (all cases, including takeover + detach-without-kill).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/ws-server.ts lib/runtime/ws-server.test.ts
git commit -m "feat(runtime): attach to durable tmux sessions, takeover instead of reject"
```

---

## Task 5: End-session teardown + API route

**Files:**
- Create: `lib/runtime/end-session.ts`
- Test: `lib/runtime/end-session.test.ts`
- Create: `app/api/forges/[id]/conversations/[conversationId]/end/route.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/end-session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { endSession } from './end-session';
import { sessionRegistry } from './session-registry';

vi.mock('./tmux-session', () => ({ killSession: vi.fn(async () => {}) }));
vi.mock('./state', () => ({ loadRuntimeHandle: vi.fn(async () => ({ containerId: 'cid', port: 3042 })) }));

import { killSession } from './tmux-session';

beforeEach(() => { sessionRegistry().clear(); vi.clearAllMocks(); });

describe('endSession', () => {
  it('kills the tmux session, stops the watcher, closes the socket, drops the entry', async () => {
    const stop = vi.fn();
    const close = vi.fn();
    sessionRegistry().set('conv1', { containerId: 'cid', watcher: { stop }, attachedWs: { close } as never });

    await endSession('f1', 'conv1');

    expect(killSession).toHaveBeenCalledWith('cid', 'conv1');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(4411, 'Session ended');
    expect(sessionRegistry().has('conv1')).toBe(false);
  });

  it('is a no-op-safe when no registry entry exists (still kills tmux)', async () => {
    await endSession('f1', 'conv-unknown');
    expect(killSession).toHaveBeenCalledWith('cid', 'conv-unknown');
    expect(sessionRegistry().has('conv-unknown')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- lib/runtime/end-session.test.ts`
Expected: FAIL — module `./end-session` does not exist.

- [ ] **Step 3: Write the implementation**

Create `lib/runtime/end-session.ts`:

```ts
import { loadRuntimeHandle } from './state';
import { killSession } from './tmux-session';
import { sessionRegistry } from './session-registry';

/**
 * Explicitly end a conversation's durable Claude session: kill the in-container
 * tmux server, stop its transcript watcher, close any attached socket, and drop
 * the registry entry. Safe to call when nothing is live.
 */
export async function endSession(forgeId: string, conversationId: string): Promise<void> {
  const handle = await loadRuntimeHandle(forgeId);
  if (handle) await killSession(handle.containerId, conversationId);

  const reg = sessionRegistry();
  const entry = reg.get(conversationId);
  if (entry) {
    entry.watcher.stop();
    try { entry.attachedWs?.close(4411, 'Session ended'); } catch { /* noop */ }
    reg.delete(conversationId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- lib/runtime/end-session.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Add the API route**

Create `app/api/forges/[id]/conversations/[conversationId]/end/route.ts` (mirrors the `connect` route's auth + ACL + error pattern):

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { assertCanConnect } from '@/lib/services/conversations';
import { endSession } from '@/lib/runtime/end-session';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations/[conversationId]/end'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: forgeId, conversationId } = await ctx.params;
  try {
    await assertCanConnect(session.user, forgeId, conversationId);
    await endSession(forgeId, conversationId);
    return NextResponse.json({ ok: true });
  } catch (err) { return respondToServiceError(err); }
}
```

- [ ] **Step 6: Typecheck (verifies the generated `RouteContext` type for the new route)**

Run: `pnpm typecheck`
Expected: no errors. (If the `RouteContext<...>` literal isn't recognized, run `pnpm build` once to regenerate `.next/types`, then re-run typecheck.)

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/end-session.ts lib/runtime/end-session.test.ts "app/api/forges/[id]/conversations/[conversationId]/end/route.ts"
git commit -m "feat(runtime): explicit end-session teardown + API route"
```

---

## Task 6: Frontend — close-code messaging + End session button

**Files:**
- Modify: `app/(app)/forges/[id]/useChatSession.ts`
- Modify: `app/(app)/forges/[id]/ChatPanel.tsx`
- Test: `app/(app)/forges/[id]/ChatPanel.test.tsx` (add a case)

- [ ] **Step 1: Add `end()` and new close-code handling to `useChatSession.ts`**

In `app/(app)/forges/[id]/useChatSession.ts`, extend the `ChatSession` type (after line 13) with an `end` method:

```ts
  /** Explicitly end the durable server-side session. */
  end: () => Promise<void>;
```

Replace the `onclose` handler (lines 40-45) to cover the new codes:

```ts
        ws.onclose = (ev) => {
          if (ev.code === 4401) setErrorMessage('Authorization expired');
          else if (ev.code === 4410) setErrorMessage('Reconnected in another tab');
          else if (ev.code === 4411) setErrorMessage('Session ended');
          else if (ev.code === 4404) setErrorMessage('Conversation not found');
          else if (ev.code === 4500) setErrorMessage('Failed to start session');
          setStatus('closed');
        };
```

Add `end` to the returned object (inside the `return { … }`, after `onData`):

```ts
    end: async () => {
      if (!conversationId) return;
      await fetch(`/api/forges/${forgeId}/conversations/${conversationId}/end`, { method: 'POST' });
      try { wsRef.current?.close(); } catch { /* noop */ }
    },
```

Note: the old `4409` branch is removed — duplicate connections are now takeovers (`4410`), not rejections.

- [ ] **Step 2: Add the End session button to `ChatPanel.tsx`**

In `app/(app)/forges/[id]/ChatPanel.tsx`, put the button inside the existing header row (`ChatPanel.tsx:61-64`, the `flex items-center justify-between` div). Replace that header block with:

```tsx
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-ink-faint">
        <span>{STATUS_LABEL[session.status]}</span>
        <div className="flex items-center gap-3">
          {session.errorMessage ? <span className="text-[#d96868]">{session.errorMessage}</span> : null}
          <button
            type="button"
            onClick={() => { void session.end(); }}
            disabled={session.status !== 'open'}
            className="px-2 py-0.5 rounded border border-border text-ink-faint hover:text-ink disabled:opacity-40"
          >
            End session
          </button>
        </div>
      </div>
```

- [ ] **Step 3: Update the mocks and add a test in `ChatPanel.test.tsx`**

This file mocks `./useChatSession` (`ChatPanel.test.tsx:5-13`). Every mock return value must now include `end`, or `pnpm typecheck` fails once `ChatSession` gains the `end` field. Make three edits:

(a) Add `fireEvent` to the testing-library import (`ChatPanel.test.tsx:2`):

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
```

(b) Add `end: vi.fn()` to the default mock factory and to both `mockReturnValueOnce` objects (lines 5-13, 53-57, 64-68). For example the default factory becomes:

```tsx
vi.mock('./useChatSession', () => ({
  useChatSession: vi.fn(() => ({
    status: 'idle',
    errorMessage: null,
    send: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => () => {}),
    end: vi.fn(async () => {}),
  })),
}));
```

(c) Add this case to the `describe('ChatPanel', …)` block:

```tsx
it('End session button calls session.end when connected', async () => {
  const end = vi.fn(async () => {});
  const { useChatSession } = await import('./useChatSession');
  (useChatSession as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    status: 'open', errorMessage: null,
    send: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), end,
  });
  render(<ChatPanel forgeId="f1" conversationId="c1" />);
  fireEvent.click(screen.getByRole('button', { name: /end session/i }));
  expect(end).toHaveBeenCalled();
});
```

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `pnpm test -- "app/(app)/forges/[id]/ChatPanel.test.tsx"`
Expected: FAIL before Steps 1-2 are complete (no button / no `end`), PASS after.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/forges/[id]/useChatSession.ts" "app/(app)/forges/[id]/ChatPanel.tsx" "app/(app)/forges/[id]/ChatPanel.test.tsx"
git commit -m "feat(forges): End session control + reattach/takeover close-code messaging"
```

---

## Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `pnpm test`
Expected: PASS. Pay attention to `lib/runtime/*` and the forges UI tests.

- [ ] **Step 2: Lint + typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors (the `no-octokit-outside-github` rule is unaffected; nothing here imports Octokit).

- [ ] **Step 3: Manual pilot verification (cannot be unit-tested — fake mode has no tmux/container)**

With a rebuilt forge image and a running forge:
1. Open a conversation, start a prompt that runs for a while.
2. Close the browser tab. Reopen the conversation.
3. Confirm: the terminal repaints with the output produced while away, and the session is still live (you can keep typing). Output produced while detached is present in the DB (conversation messages).
4. Click **End session**; confirm the terminal closes and a reconnect starts a fresh session.

Document the result (works / doesn't) in the PR description — do not claim success without observing it.

- [ ] **Step 4: Commit any fixes, then open the PR**

```bash
git add -A && git commit -m "test(runtime): verify durable-session suite green"   # only if fixes were needed
```

---

## Notes for the implementer

- **Out of scope (do not build):** boot reconciliation, idle-timeout reaping, transcript dedup. `bootCleanup` stays as-is — the weekly maintenance restart is the backstop reaper. The pre-existing `--resume` duplicate-message behavior (`appendMessage` is not idempotent) is a separate ticket; this work makes it *less* frequent, not worse.
- **Credentials:** `claudeCredentialsEnv()` is the only seam (`lib/runtime/claude-credentials.ts`). The per-conversation tmux socket exists specifically so `docker exec -e` creds reach the spawned claude reliably; don't reintroduce inline `-e` flags in `ws-server.ts`.
- **Single-process assumption:** the registry + per-conversation lock are in-process. Fine for the pilot. Liveness is read from tmux (`hasSession`), so the design degrades gracefully if that assumption is relaxed later.
- **Octokit rule:** nothing in this plan touches GitHub; no risk of the `no-octokit-outside-github` lint rule.
