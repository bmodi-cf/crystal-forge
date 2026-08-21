// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { pullBundle } from '@/lib/bundle/registry-bundle';
import { cutBundle, listFirstReleaseCandidates } from './first-release';

const APP_DIGEST = 'sha256:' + 'a'.repeat(64);

beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'dev'; });
afterEach(() => { delete process.env.FORGE_DASHBOARD_MODE; });

const dumpOk = async () => 'CREATE TABLE "ReviewDocument" (id text primary key);\n';
const migrationsOk = async () => ['20260801120000_init'];

/** A forge with one accepted promotion, and the app image tag it released. */
async function acceptedRelease(
  prisma: Parameters<Parameters<typeof withCleanDb>[0]>[0],
  reg: FakeRegistryClient,
  opts: { adminId: string; name?: string; version?: string; headSha?: string; seedImage?: boolean },
) {
  const name = opts.name ?? 'Second Set of Eyes';
  const version = opts.version ?? 'v1.0.0';
  const headSha = opts.headSha ?? 'abc123';
  const forge = await makeForge(prisma, { name, createdById: opts.adminId });
  const promotion = await prisma.promotionRequest.create({
    data: {
      forgeId: forge.id, requestedById: opts.adminId, prNumber: 7,
      prUrl: 'https://github.test/pr/7', headSha, bumpLevel: 'major',
      targetVersion: version, status: 'accepted', decidedAt: new Date(),
    },
  });
  if (opts.seedImage !== false) reg.seedTag('second-set-of-eyes', version, APP_DIGEST);
  return { forge, promotion, version, headSha };
}

describe('listFirstReleaseCandidates', () => {
  it('lists a forge with exactly one accepted promotion', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const { forge } = await acceptedRelease(prisma, reg, { adminId: admin.id });

      const rows = await listFirstReleaseCandidates(admin, reg);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        forgeId: forge.id, slug: 'second-set-of-eyes', version: 'v1.0.0', bundleTags: [],
      });
    });
  });

  it('reports bundles already cut so the UI can say so', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      await acceptedRelease(prisma, reg, { adminId: admin.id });
      reg.seedTag('second-set-of-eyes-seed', 'v1.0.0');

      const rows = await listFirstReleaseCandidates(admin, reg);
      expect(rows[0]!.bundleTags).toEqual(['v1.0.0']);
    });
  });

  it('omits a forge past its first release', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const { forge } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      await prisma.promotionRequest.create({
        data: {
          forgeId: forge.id, requestedById: admin.id, prNumber: 8,
          prUrl: 'https://github.test/pr/8', headSha: 'def456', bumpLevel: 'patch',
          targetVersion: 'v1.0.1', status: 'accepted', decidedAt: new Date(),
        },
      });

      expect(await listFirstReleaseCandidates(admin, reg)).toEqual([]);
    });
  });

  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'D', role: 'DEVELOPER' });
      await expect(
        listFirstReleaseCandidates(dev, new FakeRegistryClient()),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('cutBundle', () => {
  it('pushes a bundle that pulls back with the forge row and the dump', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', [
        '20260801120000_init', '20260815090000_later',
      ]);

      const result = await cutBundle(admin, promotion.id, {
        registry: reg, github: gh, dump: dumpOk, readMigrations: migrationsOk,
      });

      expect(result).toMatchObject({ repo: 'second-set-of-eyes-seed', tag: 'v1.0.0' });
      expect(result.migrations).toEqual(['20260801120000_init']);

      const { contents } = await pullBundle(reg, 'second-set-of-eyes', 'v1.0.0');
      expect(contents.forge).toMatchObject({
        name: 'Second Set of Eyes',
        slug: 'second-set-of-eyes',
        repoFullName: forge.repoFullName,
        deployVersion: 'v1.0.0',
      });
      expect(contents.dataSql).toMatch(/ReviewDocument/);
      expect(contents.bundle).toMatchObject({
        version: 'v1.0.0', appImageDigest: APP_DIGEST, migrations: ['20260801120000_init'],
      });
    });
  });

  it('refuses when the forge has more than one accepted promotion', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);
      await prisma.promotionRequest.create({
        data: {
          forgeId: forge.id, requestedById: admin.id, prNumber: 9,
          prUrl: 'https://github.test/pr/9', headSha: 'def456', bumpLevel: 'patch',
          targetVersion: 'v1.0.1', status: 'accepted', decidedAt: new Date(),
        },
      });

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toThrow(/first release/i);
    });
  });

  it('refuses when the database carries a migration the release does not have', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      // The repo at the released sha has only the first migration...
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk,
          // ...but dev's database has moved on.
          readMigrations: async () => ['20260801120000_init', '20260820000000_dev_only'],
        }),
      ).rejects.toThrow(/20260820000000_dev_only/);
    });
  });

  it('refuses when the forge database does not exist on this host', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
      const { forge, promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk, readMigrations: async () => null,
        }),
      ).rejects.toThrow(/does not exist/i);
    });
  });

  it('refuses when the promotion is not accepted', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const forge = await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });
      const promotion = await prisma.promotionRequest.create({
        data: {
          forgeId: forge.id, requestedById: admin.id, prNumber: 7,
          prUrl: 'https://github.test/pr/7', headSha: 'abc123', bumpLevel: 'major',
          targetVersion: 'v1.0.0', status: 'awaiting_approval',
        },
      });

      await expect(
        cutBundle(admin, promotion.id, {
          registry: new FakeRegistryClient(), github: new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' }),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('refuses when the released app image tag is missing from the registry', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
      const { forge, promotion } = await acceptedRelease(prisma, reg, {
        adminId: admin.id, seedImage: false,
      });
      gh.seedDirectory(forge.repoFullName, 'abc123', 'prisma/migrations', ['20260801120000_init']);

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: gh, dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toThrow(/v1\.0\.0/);
    });
  });

  it('refuses in prod mode — cutting is a pilot action', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'prod';
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      const { promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });

      await expect(
        cutBundle(admin, promotion.id, {
          registry: reg, github: new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' }),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('refuses an unknown promotion', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      await expect(
        cutBundle(admin, '00000000-0000-0000-0000-000000000000', {
          registry: new FakeRegistryClient(), github: new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' }),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'D', role: 'DEVELOPER' });
      const reg = new FakeRegistryClient();
      const { promotion } = await acceptedRelease(prisma, reg, { adminId: admin.id });

      await expect(
        cutBundle(dev, promotion.id, {
          registry: reg, github: new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' }),
          dump: dumpOk, readMigrations: migrationsOk,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
