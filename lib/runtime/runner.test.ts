// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, mutateState } from './state';
import { bootCleanup, makeLivenessChecker } from './runner';
import { FakeContainerManager } from './container/fake-container-manager';

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
  it('removes labelled forge containers and clears state', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-x', image: 'img', labels: { 'crystal-forge.forgeId': 'f1' } });
    await mutateState((s) => { s['f1'] = { forgeId: 'f1', slug: 'x', status: 'running', containerId: id, port: 3042, startedAt: 'now', logPath: '/tmp/x.log' }; });
    await bootCleanup({ containerManager: containers });
    expect((await containers.inspect(id)).exists).toBe(false);
    expect(await loadState()).toEqual({});
  });
});

describe('makeLivenessChecker', () => {
  it('marks a forge crashed when its container is gone', async () => {
    const containers = new FakeContainerManager();
    await mutateState((s) => { s['f1'] = { forgeId: 'f1', slug: 'x', status: 'running', containerId: 'gone', port: 3042, startedAt: 'now', logPath: '/tmp/x.log' }; });
    const check = makeLivenessChecker({ containerManager: containers, probe: async () => true });
    await check();
    expect((await loadState())['f1']?.status).toBe('crashed');
  });

  it('flips a running entry to crashed after 3 consecutive probe failures', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-a', image: 'img', labels: { 'crystal-forge.forgeId': 'a' } });
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', containerId: id, port: 3001, startedAt: 'x', logPath: '' },
    });
    const check = makeLivenessChecker({
      containerManager: containers,
      probe: async () => false,
      now: () => new Date('2026-05-09T00:00:00Z'),
      startingTimeoutMs: 60_000,
    });
    await check();
    await check();
    expect((await loadState())['a']?.status).toBe('running'); // still alive after 2 failures
    await check();
    expect((await loadState())['a']?.status).toBe('crashed');
  });

  it('resets failure counter on a successful probe', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-a', image: 'img', labels: { 'crystal-forge.forgeId': 'a' } });
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', containerId: id, port: 3001, startedAt: 'x', logPath: '' },
    });
    let calls = 0;
    const check = makeLivenessChecker({
      containerManager: containers,
      probe: async () => { calls++; return calls !== 1; }, // fail once, then succeed
      now: () => new Date(),
      startingTimeoutMs: 60_000,
    });
    await check(); await check(); await check(); await check();
    expect((await loadState())['a']?.status).toBe('running');
  });

  it('escalates a starting entry older than the timeout to crashed', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-a', image: 'img', labels: { 'crystal-forge.forgeId': 'a' } });
    await saveState({
      a: {
        forgeId: 'a', slug: 'a', status: 'starting', containerId: id, port: 3001,
        startedAt: '2026-05-09T00:00:00.000Z', logPath: '',
      },
    });
    const check = makeLivenessChecker({
      containerManager: containers,
      probe: async () => true,
      now: () => new Date('2026-05-09T00:02:00.000Z'),
      startingTimeoutMs: 60_000,
    });
    await check();
    expect((await loadState())['a']?.status).toBe('crashed');
  });
});
