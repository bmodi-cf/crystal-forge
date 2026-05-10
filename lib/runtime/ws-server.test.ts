// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { startWsServer } from './ws-server';
import { signTicket } from '@/lib/auth/ws-ticket';

const SECRET = 'a'.repeat(32);

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (servers.length) servers.pop()?.stop();
});

async function startServer(overrides: Partial<Parameters<typeof startWsServer>[0]> = {}) {
  const fakePty = {
    spawn: vi.fn(() => ({
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
    })),
  };
  const fakeWatcher = {
    start: vi.fn(() => ({ stop: vi.fn() })),
  };
  const server = await startWsServer({
    port: 0, // OS-assigned
    secret: SECRET,
    spawnPty: fakePty.spawn,
    startWatcher: fakeWatcher.start,
    forgeClonePath: () => '/tmp/clone',
    loadConversation: async (id: string) => ({ id, slug: 'aquaflow-designer', claudeSessionId: null }),
    ...overrides,
  });
  servers.push(server);
  return { server, fakePty, fakeWatcher };
}

describe('ws-server', () => {
  it('accepts a valid ticket and spawns a PTY', async () => {
    const { server, fakePty, fakeWatcher } = await startServer();
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 2000);
    });
    expect(fakePty.spawn).toHaveBeenCalledTimes(1);
    expect(fakeWatcher.start).toHaveBeenCalledWith('c1', '/tmp/clone', expect.anything());
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('rejects an expired ticket with close code 4401', async () => {
    const { server } = await startServer();
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() - 1 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c));
      ws.once('error', () => resolve(-1));
      setTimeout(() => resolve(-2), 2000);
    });
    expect(code).toBe(4401);
  });

  it('rejects a duplicate connection for the same conversation with close code 4409', async () => {
    const { server } = await startServer();
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const a = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    await new Promise<void>((resolve) => a.once('open', resolve));
    const b = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    const code = await new Promise<number>((resolve) => {
      b.once('close', (c) => resolve(c));
    });
    expect(code).toBe(4409);
    a.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('forwards client messages to the PTY', async () => {
    let captured: ((s: string) => void) | null = null;
    const fakeWrite = vi.fn();
    const { server } = await startServer({
      spawnPty: () => ({
        pid: 1, write: fakeWrite, resize: vi.fn(),
        onData: (h: (chunk: string) => void) => { captured = h; },
        onExit: vi.fn(), kill: vi.fn(),
      }),
    } as never);
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeWrite).toHaveBeenCalledWith('hi');
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('uses injected appendMessage and setClaudeSessionId for the watcher', async () => {
    const customAppend = vi.fn(async () => {});
    const customSet = vi.fn(async () => {});
    let capturedDeps: { appendMessage: unknown; setClaudeSessionId: unknown } | null = null;
    const { server } = await startServer({
      startWatcher: (cid, dir, deps) => {
        capturedDeps = { appendMessage: deps.appendMessage, setClaudeSessionId: deps.setClaudeSessionId };
        return { stop: vi.fn() };
      },
      appendMessage: customAppend,
      setClaudeSessionId: customSet,
    });
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    const deps = capturedDeps as { appendMessage: unknown; setClaudeSessionId: unknown } | null;
    expect(deps?.appendMessage).toBe(customAppend);
    expect(deps?.setClaudeSessionId).toBe(customSet);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});
