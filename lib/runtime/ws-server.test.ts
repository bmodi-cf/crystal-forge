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
  if (ws.readyState === WebSocket.OPEN) { res(); return; }
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
