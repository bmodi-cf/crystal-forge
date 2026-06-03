import { describe, it, expect } from 'vitest';
import { runtimeOrigin } from './proxy-target';

describe('runtimeOrigin', () => {
  it('returns the loopback origin for a runtime port', () => {
    expect(runtimeOrigin(3001)).toBe('http://127.0.0.1:3001');
  });
});
