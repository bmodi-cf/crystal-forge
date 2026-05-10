// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState } from './state';
import { bootCleanup, makeLivenessChecker } from './runner';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-runner-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('bootCleanup', () => {
  it('kills any alive pid in state and wipes the file', async () => {
    const killed: number[] = [];
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 1, port: 3001, startedAt: 'x', logPath: '' },
      b: { forgeId: 'b', slug: 'b', status: 'running', pid: 2, port: 3002, startedAt: 'x', logPath: '' },
    });
    await bootCleanup({
      isAlive: (pid) => pid === 1,
      kill: async (pid) => { killed.push(pid); },
    });
    const s = await loadState();
    expect(s).toEqual({});
    expect(killed).toEqual([1]);
  });

  it('does not call kill for entries with pid <= 0', async () => {
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'setup-failed', pid: 0, port: 3001, startedAt: 'x', logPath: '', setupError: 'boom' },
      b: { forgeId: 'b', slug: 'b', status: 'running',      pid: -1, port: 3002, startedAt: 'x', logPath: '' },
    });
    const killed: number[] = [];
    await bootCleanup({
      isAlive: () => true,                              // pretend everything is alive
      kill: async (pid) => { killed.push(pid); },
    });
    expect(killed).toEqual([]);                         // pid 0 / -1 never reach kill
    expect(await loadState()).toEqual({});
  });
});

describe('makeLivenessChecker', () => {
  it('flips a running entry to crashed after 3 consecutive probe failures', async () => {
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 100, port: 3001, startedAt: 'x', logPath: '' },
    });
    const killed: number[] = [];
    const check = makeLivenessChecker({
      probe: async () => false,
      kill: async (pid) => { killed.push(pid); },
      now: () => new Date('2026-05-09T00:00:00Z'),
      startingTimeoutMs: 60_000,
    });
    await check();
    await check();
    let s = await loadState();
    expect(s['a']?.status).toBe('running'); // still alive after 2 failures
    await check();
    s = await loadState();
    expect(s['a']?.status).toBe('crashed');
    expect(killed).toContain(100);
  });

  it('resets failure counter on a successful probe', async () => {
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', pid: 100, port: 3001, startedAt: 'x', logPath: '' },
    });
    let calls = 0;
    const check = makeLivenessChecker({
      probe: async () => { calls++; return calls !== 1; }, // fail once, then succeed
      kill: async () => {},
      now: () => new Date(),
      startingTimeoutMs: 60_000,
    });
    await check(); await check(); await check(); await check();
    const s = await loadState();
    expect(s['a']?.status).toBe('running');
  });

  it('escalates a starting entry older than the timeout to crashed', async () => {
    await saveState({
      a: {
        forgeId: 'a', slug: 'a', status: 'starting', pid: 100, port: 3001,
        startedAt: '2026-05-09T00:00:00.000Z', logPath: '',
      },
    });
    const check = makeLivenessChecker({
      probe: async () => true,
      kill: async () => {},
      now: () => new Date('2026-05-09T00:02:00.000Z'),
      startingTimeoutMs: 60_000,
    });
    await check();
    const s = await loadState();
    expect(s['a']?.status).toBe('crashed');
  });
});
