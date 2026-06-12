// @vitest-environment node
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
