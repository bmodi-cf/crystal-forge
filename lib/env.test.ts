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
