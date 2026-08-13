// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { saveDeploymentStatuses } from '@/lib/runtime/prod/deployment-status';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { RegistryError } from '@/lib/registry/types';
import { listDeployments, listAvailableVersions, deployForge } from './deployments';

let tmp: string;
let prevHome: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-depsvc-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('listDeployments', () => {
  it('includes never-deployed forges alongside running ones', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const live = await makeForge(prisma, {
        name: 'Crystal Lattice', createdById: admin.id,
        deployEnabled: true, deployVersion: 'v1.0.2',
      });
      await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });

      await saveDeploymentStatuses([{
        forgeId: live.id, slug: 'crystal-lattice', name: 'Crystal Lattice',
        desiredVersion: 'v1.0.2', runningVersion: 'v1.0.2',
        phase: 'running', error: null, consecutiveFailures: 0,
      }]);

      const rows = await listDeployments(admin);

      expect(rows).toHaveLength(2);
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byName['Crystal Lattice']).toMatchObject({
        slug: 'crystal-lattice', deployEnabled: true,
        pinnedVersion: 'v1.0.2', runningVersion: 'v1.0.2', phase: 'running',
      });
      expect(byName['Second Set of Eyes']).toMatchObject({
        slug: 'second-set-of-eyes', deployEnabled: false,
        pinnedVersion: null, runningVersion: null, phase: null,
      });
    });
  });

  it('surfaces the failure reason and count from the snapshot', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const f = await makeForge(prisma, {
        name: 'Acme', createdById: admin.id, deployEnabled: true, deployVersion: 'v9.9.9',
      });
      await saveDeploymentStatuses([{
        forgeId: f.id, slug: 'acme', name: 'Acme',
        desiredVersion: 'v9.9.9', runningVersion: null,
        phase: 'failed', error: 'pull failed', consecutiveFailures: 3,
      }]);

      const rows = await listDeployments(admin);
      expect(rows[0]).toMatchObject({ phase: 'failed', error: 'pull failed', consecutiveFailures: 3 });
    });
  });

  it('renders inventory with unknown status when the snapshot is missing', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await makeForge(prisma, { name: 'Acme', createdById: admin.id, deployEnabled: true, deployVersion: 'v1.0.0' });

      const rows = await listDeployments(admin);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pinnedVersion: 'v1.0.0', phase: null, runningVersion: null });
    });
  });

  it('rejects non-admins', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(listDeployments(dev)).rejects.toThrow(/[Aa]dmin/);
    });
  });
});

describe('listAvailableVersions', () => {
  it('keeps only semver tags, newest first, dropping latest and sha tags', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const f = await makeForge(prisma, { name: 'Crystal Lattice', createdById: admin.id });

      const registry = new FakeRegistryClient();
      for (const t of ['v1.0.0', 'v1.0.2', 'latest', 'sha-abc123', 'v1.1.0', 'v1.0.1']) {
        registry.seedTag('crystal-lattice', t);
      }

      const map = await listAvailableVersions(admin, registry);
      expect(map[f.id]).toEqual(['v1.1.0', 'v1.0.2', 'v1.0.1', 'v1.0.0']);
    });
  });

  it('returns an empty array for a forge with no images', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const f = await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });

      const map = await listAvailableVersions(admin, new FakeRegistryClient());
      expect(map[f.id]).toEqual([]);
    });
  });

  it('yields null for a forge whose registry lookup fails, without failing the batch', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const ok = await makeForge(prisma, { name: 'Crystal Lattice', createdById: admin.id });
      const bad = await makeForge(prisma, { name: 'Broken One', createdById: admin.id });

      const registry = new FakeRegistryClient();
      registry.seedTag('crystal-lattice', 'v1.0.0');
      const guarded = {
        tagManifest: registry.tagManifest.bind(registry),
        listTags: async (repo: string) => {
          if (repo === 'broken-one') throw new RegistryError('registry unreachable');
          return registry.listTags(repo);
        },
      };

      const map = await listAvailableVersions(admin, guarded);
      expect(map[ok.id]).toEqual(['v1.0.0']);
      expect(map[bad.id]).toBeNull();
    });
  });

  it('rejects non-admins', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(listAvailableVersions(dev, new FakeRegistryClient())).rejects.toThrow(/[Aa]dmin/);
    });
  });
});

describe('deployForge', () => {
  async function setup(prisma: PrismaClient) {
    const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
    const forge = await makeForge(prisma, { name: 'Crystal Lattice', createdById: admin.id });
    const registry = new FakeRegistryClient();
    registry.seedTag('crystal-lattice', 'v1.0.0');
    registry.seedTag('crystal-lattice', 'v1.1.0');
    registry.seedTag('crystal-lattice', 'latest');
    return { admin, forge, registry };
  }

  it('enables the forge and pins the version on first deploy', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);

      const row = await deployForge(admin, forge.id, 'v1.1.0', registry);

      expect(row).toMatchObject({ pinnedVersion: 'v1.1.0', deployEnabled: true });
      const after = await prisma.forge.findUniqueOrThrow({ where: { id: forge.id } });
      expect(after.deployEnabled).toBe(true);
      expect(after.deployVersion).toBe('v1.1.0');
    });
  });

  it('allows deploying an older version (rollback)', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);
      await deployForge(admin, forge.id, 'v1.1.0', registry);

      await deployForge(admin, forge.id, 'v1.0.0', registry);

      const after = await prisma.forge.findUniqueOrThrow({ where: { id: forge.id } });
      expect(after.deployVersion).toBe('v1.0.0');
    });
  });

  it('rejects a version that is not in the registry', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);
      await expect(deployForge(admin, forge.id, 'v9.9.9', registry)).rejects.toThrow(/not available/i);
      const after = await prisma.forge.findUniqueOrThrow({ where: { id: forge.id } });
      expect(after.deployEnabled).toBe(false);
    });
  });

  it('rejects the moving latest tag', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, forge, registry } = await setup(prisma);
      await expect(deployForge(admin, forge.id, 'latest', registry)).rejects.toThrow(/not available/i);
    });
  });

  it('throws NotFound for an unknown forge', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, registry } = await setup(prisma);
      await expect(
        deployForge(admin, '00000000-0000-0000-0000-000000000000', 'v1.0.0', registry),
      ).rejects.toThrow(/not found/i);
    });
  });

  it('rejects non-admins', async () => {
    await withCleanDb(async (prisma) => {
      const { forge, registry } = await setup(prisma);
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(deployForge(dev, forge.id, 'v1.0.0', registry)).rejects.toThrow(/[Aa]dmin/);
    });
  });
});
