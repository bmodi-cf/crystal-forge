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

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('allocatePort', () => {
  it('returns the first port that is free in state and on the host', async () => {
    const port = await allocatePort({ start: 3001, end: 3099 });
    expect(port).toBeGreaterThanOrEqual(3001);
    expect(port).toBeLessThanOrEqual(3099);
  });

  it('skips ports recorded in state.json', async () => {
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 1, port: 3001, startedAt: 'x', logPath: '' },
    });
    const port = await allocatePort({ start: 3001, end: 3099 });
    expect(port).not.toBe(3001);
  });

  it('skips ports bound externally', async () => {
    const srv = await listenOn(3001);
    try {
      const port = await allocatePort({ start: 3001, end: 3099 });
      expect(port).not.toBe(3001);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('throws RuntimeCapacityError when the pool is exhausted', async () => {
    await expect(allocatePort({ start: 3001, end: 3001 })).resolves.toBe(3001);

    // Fill the entire tiny pool via state.
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 1, port: 3001, startedAt: 'x', logPath: '' },
    });
    await expect(allocatePort({ start: 3001, end: 3001 })).rejects.toBeInstanceOf(RuntimeCapacityError);
  });
});
