// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { FakeContainerManager } from '@/lib/runtime/container/fake-container-manager';
import { FakeDatabaseProvisioner } from '@/lib/db/fake-provisioner';
import type { ContainerManager, CreateContainerSpec } from '@/lib/runtime/container/types';
import { makeRuntimeService } from './runtime';
import { ForbiddenError } from '@/lib/errors';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-svc-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeFakes() {
  const probes: number[] = [];
  const containers = new FakeContainerManager();
  const provisioner = new FakeDatabaseProvisioner();
  return {
    githubClient: new FakeGitHubClient({ owner: 'o', baseUrl: 'https://github.com' }),
    containerManager: containers,
    provisioner,
    setup: async () => {},
    probe: async (port: number) => { probes.push(port); return true; },
    portStart: 3001, portEnd: 3099,
    _calls: { probes },
    _containers: containers,
    _provisioner: provisioner,
  };
}

describe('runtime service', () => {
  it('startForge writes a starting entry, then flips to running on probe success', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      const result = await svc.startForge(tom, forge.id);
      expect(result.status).toBe('running');
      expect(result.port).toBeGreaterThanOrEqual(3001);
      expect(result.containerId).toMatch(/^fake-/);
      expect((await fakes._containers.inspect(result.containerId)).running).toBe(true);
      expect(fakes._calls.probes.length).toBeGreaterThan(0);
    });
  });

  it('startForge requires write access', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const intruder = await makeUser(prisma, { email: 'i@x', name: 'I', groups: [] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      await expect(svc.startForge(intruder, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('startForge collapses concurrent calls onto one promise', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      let setupCalls = 0;
      const svc = makeRuntimeService({
        ...makeFakes(),
        prisma,
        setup: async () => { setupCalls++; await new Promise((r) => setTimeout(r, 20)); },
      });
      const [a, b] = await Promise.all([svc.startForge(tom, forge.id), svc.startForge(tom, forge.id)]);
      expect(a.port).toBe(b.port);
      expect(setupCalls).toBe(1);
    });
  });

  it('startForge marks setup-failed when setup throws', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({
        ...makeFakes(),
        prisma,
        setup: async () => { throw new Error('git clone exploded'); },
      });
      await expect(svc.startForge(tom, forge.id)).rejects.toThrow('git clone exploded');
      const got = await svc.getRuntime(tom, forge.id);
      expect(got?.status).toBe('setup-failed');
      expect(got?.setupError).toContain('git clone exploded');
    });
  });

  it('startForge on running forge is idempotent', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      const first = await svc.startForge(tom, forge.id);
      const second = await svc.startForge(tom, forge.id);
      expect(second.port).toBe(first.port);
    });
  });

  it('startForge after crashed/setup-failed clears the entry and starts fresh', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      let attempt = 0;
      const svc = makeRuntimeService({
        ...makeFakes(),
        prisma,
        setup: async () => { if (attempt++ === 0) throw new Error('first try fails'); },
      });
      await expect(svc.startForge(tom, forge.id)).rejects.toThrow();
      const ok = await svc.startForge(tom, forge.id);
      expect(ok.status).toBe('running');
    });
  });

  it('stopForge stops and removes the container, removes the entry; second stop is a no-op', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      const entry = await svc.startForge(tom, forge.id);
      await svc.stopForge(tom, forge.id);
      expect((await fakes._containers.inspect(entry.containerId)).exists).toBe(false);
      expect(await svc.getRuntime(tom, forge.id)).toBeNull();
      await svc.stopForge(tom, forge.id); // idempotent — no throw
    });
  });

  it('listRuntimes filters by ACL and redacts containerId for read-only viewers', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const reader = await makeUser(prisma, { email: 'r@x', name: 'R', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      await svc.startForge(tom, forge.id);
      const tomList = await svc.listRuntimes(tom);
      const readerList = await svc.listRuntimes(reader);
      expect(tomList[0]?.containerId).toMatch(/^fake-/);
      expect(readerList[0]?.containerId).toBeUndefined();
    });
  });

  it('startForge injects FORGE_BASE_PATH and a scoped DATABASE_URL into the container', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const base = new FakeContainerManager();
      const specs: CreateContainerSpec[] = [];
      const recording: ContainerManager = {
        create: (spec) => { specs.push(spec); return base.create(spec); },
        exec: base.exec.bind(base),
        inspect: base.inspect.bind(base),
        stop: base.stop.bind(base),
        remove: base.remove.bind(base),
        list: base.list.bind(base),
      };
      const svc = makeRuntimeService({ ...makeFakes(), prisma, containerManager: recording });
      await svc.startForge(tom, forge.id);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.env?.FORGE_BASE_PATH).toBe('/app/marketing-fru-fru');
      expect(specs[0]?.env?.DATABASE_URL).toContain('marketing_fru_fru_app');
      expect(specs[0]?.env?.DATABASE_URL).toContain('/marketing_fru_fru');
    });
  });

  it('startForge throws RuntimeBusyError if the entry is deleted (race with stopForge) before probe success', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const fakes = makeFakes();
      const svc = makeRuntimeService({
        ...fakes,
        prisma,
        probe: async () => {
          // Simulate a concurrent stopForge wiping the entry between
          // container start and the probe-success state write.
          const { mutateState } = await import('@/lib/runtime/state');
          await mutateState((s) => { delete s[forge.id]; });
          return true;
        },
      });
      await expect(svc.startForge(tom, forge.id)).rejects.toThrow(/stopped while starting/i);
      expect(await svc.getRuntime(tom, forge.id)).toBeNull();
    });
  });
});
