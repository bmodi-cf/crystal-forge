// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, mutateState } from './state';
import { reconcileForges, makeLivenessChecker } from './runner';
import { logPath } from './paths';
import type { ForgeLookup } from './runner';
import { FakeContainerManager } from './container/fake-container-manager';

const LABEL = 'crystal-forge.forgeId';
const AT = () => new Date('2026-07-20T12:00:00.000Z');

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

describe('reconcileForges', () => {
  const lookupHit = (slug: string, repoFullName: string): ForgeLookup =>
    async () => ({ slug, repoFullName });
  const lookupNull: ForgeLookup = async () => null;

  it('running container + existing entry → entry kept, status running', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({
      name: 'forge-x', image: 'img', labels: { [LABEL]: 'f1' },
      publish: { hostIp: '127.0.0.1', hostPort: 3042, containerPort: 3000 },
    });
    await saveState({
      f1: { forgeId: 'f1', slug: 'x', status: 'crashed', containerId: id, port: 3042, startedAt: '2026-01-01T00:00:00.000Z', logPath: '/tmp/x.log', repoFullName: 'org/x' },
    });
    await reconcileForges({ containerManager: containers, forgeLookup: lookupNull, now: AT });
    expect((await loadState())['f1']).toEqual({
      forgeId: 'f1', slug: 'x', status: 'running', containerId: id, port: 3042,
      startedAt: '2026-01-01T00:00:00.000Z', logPath: '/tmp/x.log', repoFullName: 'org/x',
    });
  });

  it('running container + no entry + lookup hit → adopted with inspect port and DB repo/slug', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({
      name: 'forge-x', image: 'img', labels: { [LABEL]: 'f1' },
      publish: { hostIp: '127.0.0.1', hostPort: 3055, containerPort: 3000 },
    });
    await reconcileForges({ containerManager: containers, forgeLookup: lookupHit('mediumslug', 'org/repo'), now: AT });
    expect((await loadState())['f1']).toEqual({
      forgeId: 'f1', slug: 'mediumslug', status: 'running', containerId: id, port: 3055,
      startedAt: '2026-07-20T12:00:00.000Z', logPath: logPath('mediumslug'), repoFullName: 'org/repo',
    });
  });

  it('running container + no entry + lookup null (forge deleted) → container removed, no entry', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-x', image: 'img', labels: { [LABEL]: 'gone' } });
    await reconcileForges({ containerManager: containers, forgeLookup: lookupNull, now: AT });
    expect((await containers.inspect(id)).exists).toBe(false);
    expect(await loadState()).toEqual({});
  });

  it('exited container + entry → container removed, entry dropped', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-x', image: 'img', labels: { [LABEL]: 'f1' } });
    await containers.stop(id); // exited leftover
    await saveState({
      f1: { forgeId: 'f1', slug: 'x', status: 'running', containerId: id, port: 3042, startedAt: 'x', logPath: '' },
    });
    await reconcileForges({ containerManager: containers, forgeLookup: lookupNull, now: AT });
    expect((await containers.inspect(id)).exists).toBe(false);
    expect(await loadState()).toEqual({});
  });

  it('exited container + no entry → container removed', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-x', image: 'img', labels: { [LABEL]: 'f1' } });
    await containers.stop(id);
    await reconcileForges({ containerManager: containers, forgeLookup: lookupNull, now: AT });
    expect((await containers.inspect(id)).exists).toBe(false);
    expect(await loadState()).toEqual({});
  });

  it('entry with no matching container → entry dropped', async () => {
    const containers = new FakeContainerManager();
    await saveState({
      f9: { forgeId: 'f9', slug: 'ghost', status: 'running', containerId: 'vanished', port: 3099, startedAt: 'x', logPath: '' },
    });
    await reconcileForges({ containerManager: containers, forgeLookup: lookupNull, now: AT });
    expect(await loadState()).toEqual({});
  });

  it('empty list + empty state → no-op', async () => {
    const containers = new FakeContainerManager();
    await reconcileForges({ containerManager: containers, forgeLookup: lookupNull, now: AT });
    expect(await loadState()).toEqual({});
  });
});

describe('makeLivenessChecker', () => {
  it('marks a forge crashed when its container is gone', async () => {
    const containers = new FakeContainerManager();
    await mutateState((s) => { s['f1'] = { forgeId: 'f1', slug: 'x', status: 'running', containerId: 'gone', port: 3042, startedAt: 'now', logPath: '/tmp/x.log' }; });
    const check = makeLivenessChecker({ containerManager: containers });
    await check();
    expect((await loadState())['f1']?.status).toBe('crashed');
  });

  it('keeps a running forge running while its container is up (no probe-kill)', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-a', image: 'img', labels: { 'crystal-forge.forgeId': 'a' } });
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', containerId: id, port: 3001, startedAt: 'x', logPath: '' },
    });
    const check = makeLivenessChecker({ containerManager: containers, now: () => new Date() });
    // Repeated checks must NOT crash a forge whose container is alive — the
    // in-container supervisor owns dev-server restarts.
    await check(); await check(); await check();
    expect((await loadState())['a']?.status).toBe('running');
  });

  it('marks crashed WITHOUT removing the container when it stops running', async () => {
    const containers = new FakeContainerManager();
    const id = await containers.create({ name: 'forge-a', image: 'img', labels: { 'crystal-forge.forgeId': 'a' } });
    await saveState({
      a: { forgeId: 'a', slug: 'a', status: 'running', containerId: id, port: 3001, startedAt: 'x', logPath: '' },
    });
    await containers.stop(id); // container stopped but not removed
    const check = makeLivenessChecker({ containerManager: containers, now: () => new Date() });
    await check();
    expect((await loadState())['a']?.status).toBe('crashed');
    // Non-destructive: the container is left in place for inspection/recovery.
    expect((await containers.inspect(id)).exists).toBe(true);
  });

  it('escalates a starting entry older than the timeout to crashed (non-destructively)', async () => {
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
      now: () => new Date('2026-05-09T00:02:00.000Z'),
      startingTimeoutMs: 60_000,
    });
    await check();
    expect((await loadState())['a']?.status).toBe('crashed');
    expect((await containers.inspect(id)).exists).toBe(true);
  });
});
