// @vitest-environment node
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
