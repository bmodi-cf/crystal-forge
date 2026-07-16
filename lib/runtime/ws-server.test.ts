// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { startWsServer } from './ws-server';
import { signTicket } from '@/lib/auth/ws-ticket';
import type { SpawnOpts } from './pty-session';

const SECRET = 'a'.repeat(32);
const servers: Array<{ stop: () => void }> = [];

afterEach(() => { while (servers.length) servers.pop()?.stop(); });

function fakeSession() {
  return { pid: 1234, write: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
}

async function startServer(overrides: Partial<Parameters<typeof startWsServer>[0]> = {}) {
  const fakePty = { spawn: vi.fn(() => fakeSession()) };
  const fakeWatcher = { start: vi.fn(() => ({ stop: vi.fn() })) };
  const server = await startWsServer({
    port: 0,
    secret: SECRET,
    spawnPty: fakePty.spawn,
    startWatcher: fakeWatcher.start,
    loadConversation: async (id: string) => ({ id, forgeId: 'f1', slug: 'aquaflow-designer', claudeSessionId: null }),
    loadRuntimeHandle: async () => ({ containerId: 'cid', port: 3042 }),
    ensureClaudeSessionId: async () => 'gen-uuid',
    sessionExists: async () => false, // fresh by default
    appendMessage: async () => {},
    ...overrides,
  });
  servers.push(server);
  return { server, fakePty, fakeWatcher };
}

function open(server: { port: number }, conversationId = 'c1') {
  const tok = signTicket({ conversationId, userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
  return new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
}
const opened = (ws: WebSocket) => new Promise<void>((res, rej) => {
  if (ws.readyState === WebSocket.OPEN) { res(); return; }
  ws.once('open', () => res()); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 2000);
});
const closedCode = (ws: WebSocket) => new Promise<number>((res) => {
  ws.once('close', (c) => res(c)); ws.once('error', () => res(-1)); setTimeout(() => res(-2), 2000);
});

describe('ws-server (direct streaming)', () => {
  it('spawns a fresh claude PTY with --session-id and starts the watcher', async () => {
    let captured: SpawnOpts | null = null;
    const { server, fakeWatcher } = await startServer({
      spawnPty: (opts: SpawnOpts) => { captured = opts; return fakeSession(); },
    });
    const ws = open(server);
    await opened(ws);
    const opts = captured as SpawnOpts | null;
    expect(opts?.command).toBe('docker');
    // null stored id -> ensureClaudeSessionId backfills 'gen-uuid'; fresh -> --session-id.
    expect(opts?.args).toEqual([
      'exec', '-i', '-t', '-w', '/workspace', 'cid',
      'claude', '--dangerously-skip-permissions', '--session-id', 'gen-uuid',
    ]);
    expect(fakeWatcher.start).toHaveBeenCalledWith('c1', 'cid', 'gen-uuid', expect.anything());
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('uses --resume with the stored session id when the transcript exists', async () => {
    let captured: SpawnOpts | null = null;
    const { server } = await startServer({
      spawnPty: (opts: SpawnOpts) => { captured = opts; return fakeSession(); },
      loadConversation: async (id: string) => ({ id, forgeId: 'f1', slug: 's', claudeSessionId: 'sess-9' }),
      sessionExists: async () => true,
    });
    const ws = open(server);
    await opened(ws);
    const opts = captured as SpawnOpts | null;
    expect(opts?.args?.slice(-3)).toEqual(['--dangerously-skip-permissions', '--resume', 'sess-9']);
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

  it('rejects a second connection for the same conversation with 4409', async () => {
    const { server } = await startServer();
    const a = open(server);
    await opened(a);
    const b = open(server);
    expect(await closedCode(b)).toBe(4409);
    a.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('closes 4500 when the session cannot be started', async () => {
    const { server } = await startServer({
      sessionExists: vi.fn(async () => { throw new Error('docker exec failed'); }),
    });
    expect(await closedCode(open(server))).toBe(4500);
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

  it('kills the PTY and stops the watcher when the socket closes', async () => {
    const kill = vi.fn();
    const stop = vi.fn();
    const { server } = await startServer({
      spawnPty: () => ({ pid: 1, write: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill }),
      startWatcher: () => ({ stop }),
    });
    const ws = open(server);
    await opened(ws);
    ws.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(kill).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('acquires a token on connect and releases it on close', async () => {
    const acquire = vi.fn(async () => true);
    const release = vi.fn(() => {});
    const { server } = await startServer({
      loadRuntimeHandle: async () => ({ containerId: 'c1', port: 1, repoFullName: 'own/aquaflow' }),
      tokenRefresher: { acquire, release },
    });
    const ws = open(server);
    await opened(ws);
    expect(acquire).toHaveBeenCalledWith('c1', 'own/aquaflow');
    ws.close();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith('c1'));
  });

  it('releases the token exactly once when ws-close and pty-exit both fire for one session', async () => {
    const acquire = vi.fn(async () => true);
    const release = vi.fn(() => {});
    let exitCb: ((code: number) => void) | null = null;
    const kill = vi.fn(() => {
      // Simulate node-pty: kill() causes the child to exit, which later fires onExit.
      exitCb?.(0);
    });
    const { server } = await startServer({
      loadRuntimeHandle: async () => ({ containerId: 'c1', port: 1, repoFullName: 'own/aquaflow' }),
      tokenRefresher: { acquire, release },
      spawnPty: () => ({
        pid: 1,
        write: vi.fn(),
        resize: vi.fn(),
        onData: vi.fn(),
        onExit: (cb: (code: number) => void) => { exitCb = cb; },
        kill,
      }),
    });
    const ws = open(server);
    await opened(ws);
    // ws.on('close') calls pty.kill(), which (per the fake above) synchronously
    // invokes the captured pty.onExit callback -- exercising both teardown paths
    // for the same session, as real node-pty does asynchronously.
    ws.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('c1');
  });
});
