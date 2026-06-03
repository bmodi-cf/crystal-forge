// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allocatePort, RuntimeCapacityError } from './ports';
import { saveState } from './state';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-ports-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * Ask the OS for a guaranteed-free loopback port (bind to :0, read the assigned
 * port, release it). Using ephemeral ports instead of the hardcoded 3001-3099
 * range keeps these tests passing even when a real forge is occupying a port in
 * that range on the same host.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Start a server actually listening on a free loopback port and return both. */
function listenOnFreePort(): Promise<{ srv: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ srv, port });
    });
  });
}

describe('allocatePort', () => {
  it('returns the first port that is free in state and on the host', async () => {
    const p = await freePort();
    const port = await allocatePort({ start: p, end: p + 20 });
    expect(port).toBeGreaterThanOrEqual(p);
    expect(port).toBeLessThanOrEqual(p + 20);
  });

  it('skips ports recorded in state.json', async () => {
    const p = await freePort();
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', containerId: 'c1', port: p, startedAt: 'x', logPath: '' },
    });
    const port = await allocatePort({ start: p, end: p + 20 });
    expect(port).not.toBe(p);
  });

  it('skips ports bound externally', async () => {
    const { srv, port: p } = await listenOnFreePort();
    try {
      const port = await allocatePort({ start: p, end: p + 20 });
      expect(port).not.toBe(p);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('throws RuntimeCapacityError when the pool is exhausted', async () => {
    const p = await freePort();
    // A single-port pool that is free resolves to that port...
    await expect(allocatePort({ start: p, end: p })).resolves.toBe(p);

    // ...but once that single port is taken (here via state), the pool is
    // exhausted and allocation throws.
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', containerId: 'c1', port: p, startedAt: 'x', logPath: '' },
    });
    await expect(allocatePort({ start: p, end: p })).rejects.toBeInstanceOf(RuntimeCapacityError);
  });
});
