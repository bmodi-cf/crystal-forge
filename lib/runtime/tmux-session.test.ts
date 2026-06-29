// @vitest-environment node
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
      { containerId: 'cid', conversationId: 'conv1', sessionId: 'uuid-1' },
      { manager: fakeManager(exec) },
    );
    expect(r).toEqual({ created: false });
    expect(exec).toHaveBeenCalledTimes(1); // only the has-session probe
  });

  it('ensureSession starts a fresh session with --session-id when no transcript exists', async () => {
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    // has-session -> 1 (none); `sh -c test -f` -> 1 (transcript absent); new-session -> 0.
    const exec = vi.fn(async (_id: string, cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ cmd, args, env: opts?.env });
      return { exitCode: cmd === 'sh' ? 1 : (args.includes('has-session') ? 1 : 0) };
    });
    const r = await ensureSession(
      { containerId: 'cid', conversationId: 'conv1', sessionId: 'uuid-1' },
      { manager: fakeManager(exec as unknown as ContainerManager['exec']) },
    );
    expect(r).toEqual({ created: true });
    const create = calls.find((c) => c.args.includes('new-session'))!;
    expect(create.args).toEqual([
      '-L', 'claude-conv1', 'new-session', '-d', '-s', 'main', '-c', '/workspace',
      'claude --dangerously-skip-permissions --session-id uuid-1',
    ]);
    expect(create.env).toBeDefined();
  });

  it('ensureSession resumes with --resume when the transcript already exists', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    // has-session -> 1 (none); `sh -c test -f` -> 0 (transcript present); new-session -> 0.
    const exec = vi.fn(async (_id: string, cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { exitCode: cmd === 'sh' ? 0 : (args.includes('has-session') ? 1 : 0) };
    });
    await ensureSession(
      { containerId: 'cid', conversationId: 'conv1', sessionId: 'sess-abc' },
      { manager: fakeManager(exec as unknown as ContainerManager['exec']) },
    );
    const create = calls.find((c) => c.args.includes('new-session'))!;
    expect(create.args.at(-1)).toBe('claude --dangerously-skip-permissions --resume sess-abc');
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
