// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { FakeContainerManager } from '@/lib/runtime/container/fake-container-manager';
import { FakeDatabaseProvisioner } from '@/lib/db/fake-provisioner';
import type { DatabaseProvisioner } from '@/lib/db/types';
import type { ContainerManager, CreateContainerSpec } from '@/lib/runtime/container/types';
import { makeRuntimeService } from './runtime';
import { env } from '@/lib/env';
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

async function waitForRuntime(
  svc: ReturnType<typeof makeRuntimeService>,
  user: Parameters<ReturnType<typeof makeRuntimeService>['getRuntime']>[0],
  forgeId: string,
  pred: (r: Awaited<ReturnType<ReturnType<typeof makeRuntimeService>['getRuntime']>>) => boolean,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await svc.getRuntime(user, forgeId);
    if (pred(r)) return r;
    if (Date.now() > deadline) throw new Error(`waitForRuntime timed out; last=${JSON.stringify(r)}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

describe('runtime service', () => {
  it('startForge returns a starting entry immediately and brings the forge up in the background', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });
      const entry = await svc.startForge(tom, forge.id);
      // Returns before the (slow) container build + health probe complete.
      expect(entry.status).toBe('starting');
      expect(entry.containerId).toBe('');
      // The bring-up proceeds asynchronously and eventually reports running.
      const ready = await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      expect(ready?.containerId).toMatch(/^fake-/);
    });
  });

  it('startForge writes a starting entry, then flips to running on probe success', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      const result = await svc.startForge(tom, forge.id);
      expect(result.status).toBe('starting');
      const ready = await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      expect(ready?.port).toBeGreaterThanOrEqual(3001);
      expect(ready?.containerId).toMatch(/^fake-/);
      expect((await fakes._containers.inspect(ready!.containerId!)).running).toBe(true);
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
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
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
      const entry = await svc.startForge(tom, forge.id);
      expect(entry.status).toBe('starting');
      const got = await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'setup-failed');
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
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
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
      // First attempt fails during background bring-up → setup-failed.
      await svc.startForge(tom, forge.id);
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'setup-failed');
      // A fresh start clears the failed entry and brings the forge up.
      await svc.startForge(tom, forge.id);
      const ok = await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      expect(ok?.status).toBe('running');
    });
  });

  it('startForge provisions the scoped role before setting its password (self-heals a missing role)', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      // Mimic Postgres: ALTER ROLE on a role that was never CREATEd fails
      // (error 42704). The role only exists if provisionRole ran first, so
      // start must (idempotently) provision it before rotating the password.
      const roles = new Set<string>();
      const provisioner: DatabaseProvisioner = {
        createDatabase: async () => {},
        dropDatabase: async () => {},
        provisionRole: async (_db, role) => { roles.add(role); },
        setRolePassword: async (role) => {
          if (!roles.has(role)) throw new Error(`role "${role}" does not exist`);
        },
        dropRole: async () => {},
        hardenDatabase: async () => {},
      };
      const svc = makeRuntimeService({ ...makeFakes(), prisma, provisioner });
      const result = await svc.startForge(tom, forge.id);
      expect(result.status).toBe('starting');
      // provisionRole runs during the background bring-up, so the role exists
      // by the time setRolePassword is called and the forge reaches running.
      const ready = await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      expect(ready?.status).toBe('running');
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
      await svc.startForge(tom, forge.id);
      const ready = await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      const containerId = ready!.containerId!;
      await svc.stopForge(tom, forge.id);
      expect((await fakes._containers.inspect(containerId)).exists).toBe(false);
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
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
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
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      expect(specs).toHaveLength(1);
      expect(specs[0]?.env?.FORGE_BASE_PATH).toBe('/app/marketing-fru-fru');
      expect(specs[0]?.env?.DATABASE_URL).toContain('marketing_fru_fru_app');
      expect(specs[0]?.env?.DATABASE_URL).toContain('/marketing_fru_fru');
    });
  });

  it('injects FORGE_DEV_ORIGINS into the forge container env', async () => {
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
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      expect(specs[0]?.env?.FORGE_DEV_ORIGINS).toBe('localhost');
    });
  });

  it('injects GH_TOKEN into the forge container only when FORGE_GIT_TOKEN is set', async () => {
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
      const prev = env.FORGE_GIT_TOKEN;
      try {
        env.FORGE_GIT_TOKEN = 'ghp_pilot_token';
        const svc = makeRuntimeService({ ...makeFakes(), prisma, containerManager: recording });
        await svc.startForge(tom, forge.id);
        await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
        expect(specs[0]?.env?.GH_TOKEN).toBe('ghp_pilot_token');
      } finally {
        env.FORGE_GIT_TOKEN = prev;
      }
    });
  });

  it('omits GH_TOKEN from the forge container env when FORGE_GIT_TOKEN is unset', async () => {
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
      const prev = env.FORGE_GIT_TOKEN;
      try {
        env.FORGE_GIT_TOKEN = undefined;
        const svc = makeRuntimeService({ ...makeFakes(), prisma, containerManager: recording });
        await svc.startForge(tom, forge.id);
        await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
        expect(specs[0]?.env && 'GH_TOKEN' in specs[0].env).toBe(false);
      } finally {
        env.FORGE_GIT_TOKEN = prev;
      }
    });
  });

  it('launches the dev server under a detached restart-loop supervisor', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, {
        name: 'Marketing Fru Fru', createdById: tom.id, groups: ['Engineering'],
      });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      await svc.startForge(tom, forge.id);
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      const devExec = fakes._containers.execCalls.find(
        (c) => c.cmd === 'sh' && c.args.join(' ').includes('pnpm dev'),
      );
      expect(devExec).toBeTruthy();
      expect(devExec?.opts?.detached).toBe(true);
      expect(devExec?.args.join(' ')).toMatch(/while true; do pnpm dev/);
    });
  });

  it('mounts per-forge workspace and claude volumes', async () => {
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
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');
      const vols = specs[0]?.volumes ?? [];
      expect(vols.map((v) => v.target)).toEqual(
        expect.arrayContaining(['/workspace', '/home/forge']),
      );
      expect(vols.find((v) => v.target === '/home/forge')?.volume)
        .toBe('forge-marketing-fru-fru-claude');
    });
  });

  it('background bring-up does not resurrect an entry deleted (race with stopForge) before probe success', async () => {
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
      const entry = await svc.startForge(tom, forge.id);
      expect(entry.status).toBe('starting');
      // The probe deletes the entry; the background bring-up must leave it gone
      // (a 'running' write would resurrect a forge the user just stopped).
      await waitForRuntime(svc, tom, forge.id, (r) => r === null);
      expect(await svc.getRuntime(tom, forge.id)).toBeNull();
    });
  });
});
