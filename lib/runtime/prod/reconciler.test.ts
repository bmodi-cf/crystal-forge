// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeContainerManager } from '@/lib/runtime/container/fake-container-manager';
import { loadState } from '@/lib/runtime/state';
import { makeReconciler, startReconcileLoop } from './reconciler';
import { loadDeploymentStatuses } from './deployment-status';
import type { DesiredForge } from './desired-state';

let tmp: string;
let prevHome: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-recon-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

// Records start/stop calls; simulates container creation into the fake manager.
function tracker(containers: FakeContainerManager) {
  const started: DesiredForge[] = [];
  const stopped: string[] = [];
  return {
    started, stopped,
    start: async (d: DesiredForge) => {
      const id = await containers.create({
        name: `forge-${d.slug}`,
        image: `reg/${d.slug}:${d.deployVersion}`,
        labels: {
          'crystal-forge.forgeId': d.forgeId,
          'crystal-forge.version': d.deployVersion,
          'crystal-forge.port': '3300',
        },
      });
      started.push(d);
      return { containerId: id, port: 3300 };
    },
    stop: async (id: string) => { stopped.push(id); await containers.remove(id); },
  };
}

describe('reconciler diff engine', () => {
  it('starts a desired forge that is not running and writes a running state entry', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      await makeForge(prisma, { name: 'Acme', createdById: user.id, deployEnabled: true, deployVersion: 'v1.0.0' });
      const containers = new FakeContainerManager();
      const t = tracker(containers);
      const rec = makeReconciler({ prisma, containerManager: containers, start: t.start, stop: t.stop });

      await rec.reconcileOnce();

      expect(t.started.map((d) => d.slug)).toEqual(['acme']);
      const state = await loadState();
      const entry = Object.values(state)[0];
      expect(entry?.status).toBe('running');
      expect(entry?.slug).toBe('acme');
      expect(rec.statuses()[0]).toMatchObject({ slug: 'acme', phase: 'running', desiredVersion: 'v1.0.0' });
    });
  });

  it('is a no-op when the running container already matches the pinned version', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      const forge = await makeForge(prisma, { name: 'Acme', createdById: user.id, deployEnabled: true, deployVersion: 'v1.0.0' });
      const containers = new FakeContainerManager();
      await containers.create({ name: 'forge-acme', image: 'reg/acme:v1.0.0', labels: {
        'crystal-forge.forgeId': forge.id, 'crystal-forge.version': 'v1.0.0', 'crystal-forge.port': '3300' } });
      const t = tracker(containers);
      const rec = makeReconciler({ prisma, containerManager: containers, start: t.start, stop: t.stop });

      await rec.reconcileOnce();

      expect(t.started).toHaveLength(0);
      expect(t.stopped).toHaveLength(0);
    });
  });

  it('recreates when the running version differs from the pinned version', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      const forge = await makeForge(prisma, { name: 'Acme', createdById: user.id, deployEnabled: true, deployVersion: 'v2.0.0' });
      const containers = new FakeContainerManager();
      const oldId = await containers.create({ name: 'forge-acme', image: 'reg/acme:v1.0.0', labels: {
        'crystal-forge.forgeId': forge.id, 'crystal-forge.version': 'v1.0.0', 'crystal-forge.port': '3300' } });
      const t = tracker(containers);
      const rec = makeReconciler({ prisma, containerManager: containers, start: t.start, stop: t.stop });

      await rec.reconcileOnce();

      expect(t.stopped).toContain(oldId);
      expect(t.started.map((d) => d.deployVersion)).toEqual(['v2.0.0']);
    });
  });

  it('stops and removes a container whose forge is no longer desired', async () => {
    await withCleanDb(async (prisma) => {
      // A container exists for a forge id that is not in desired state.
      const containers = new FakeContainerManager();
      const orphanId = await containers.create({ name: 'forge-old', image: 'reg/old:v1', labels: {
        'crystal-forge.forgeId': 'gone', 'crystal-forge.version': 'v1', 'crystal-forge.port': '3300' } });
      const t = tracker(containers);
      const rec = makeReconciler({ prisma, containerManager: containers, start: t.start, stop: t.stop });

      await rec.reconcileOnce();

      expect(t.stopped).toContain(orphanId);
      expect(await loadState()).toEqual({});
    });
  });

  it('recreates a desired forge whose container has stopped (crash recovery)', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      const forge = await makeForge(prisma, { name: 'Acme', createdById: user.id, deployEnabled: true, deployVersion: 'v1.0.0' });
      const containers = new FakeContainerManager();
      const deadId = await containers.create({ name: 'forge-acme', image: 'reg/acme:v1.0.0', labels: {
        'crystal-forge.forgeId': forge.id, 'crystal-forge.version': 'v1.0.0', 'crystal-forge.port': '3300' } });
      await containers.stop(deadId); // not running anymore
      const t = tracker(containers);
      const rec = makeReconciler({ prisma, containerManager: containers, start: t.start, stop: t.stop });

      await rec.reconcileOnce();

      expect(t.stopped).toContain(deadId);
      expect(t.started).toHaveLength(1);
    });
  });

  it('stops retrying after maxFailures until the pinned version changes', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      await makeForge(prisma, { name: 'Acme', createdById: user.id, deployEnabled: true, deployVersion: 'v1.0.0' });
      const containers = new FakeContainerManager();
      let attempts = 0;
      const failingStart = async () => { attempts++; throw new Error('pull failed'); };
      const rec = makeReconciler({
        prisma, containerManager: containers,
        start: failingStart, stop: async () => {}, maxFailures: 2,
      });

      await rec.reconcileOnce(); // attempt 1 -> fail
      await rec.reconcileOnce(); // attempt 2 -> fail, now at cap
      await rec.reconcileOnce(); // capped -> should NOT attempt
      expect(attempts).toBe(2);
      expect(rec.statuses()[0]).toMatchObject({ phase: 'failed', error: 'pull failed', consecutiveFailures: 2 });
    });
  });

  it('adopts a matching pre-existing container on boot (no restart)', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      const forge = await makeForge(prisma, { name: 'Acme', createdById: user.id, deployEnabled: true, deployVersion: 'v1.0.0' });
      const containers = new FakeContainerManager();
      await containers.create({ name: 'forge-acme', image: 'reg/acme:v1.0.0', labels: {
        'crystal-forge.forgeId': forge.id, 'crystal-forge.version': 'v1.0.0', 'crystal-forge.port': '3300' } });
      const t = tracker(containers);
      const rec = makeReconciler({ prisma, containerManager: containers, start: t.start, stop: t.stop });

      await rec.reconcileOnce();

      // Adopted: neither started nor stopped, but its state entry reflects it running.
      expect(t.started).toHaveLength(0);
      expect(t.stopped).toHaveLength(0);
      const entry = Object.values(await loadState())[0];
      expect(entry).toMatchObject({ slug: 'acme', status: 'running', port: 3300 });
    });
  });
});

describe('startReconcileLoop', () => {
  it('runs a tick immediately and persists statuses to the snapshot file', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      await makeForge(prisma, { name: 'Acme', createdById: user.id, deployEnabled: true, deployVersion: 'v1.0.0' });
      const containers = new FakeContainerManager();
      const t = tracker(containers);
      const loop = startReconcileLoop({ prisma, containerManager: containers, start: t.start, stop: t.stop }, 60_000);
      // Give the immediate tick a moment to complete.
      await new Promise((r) => setTimeout(r, 50));
      loop.stop();
      const snapshot = await loadDeploymentStatuses();
      expect(Object.values(snapshot).map((s) => s.slug)).toContain('acme');
    });
  });
});
