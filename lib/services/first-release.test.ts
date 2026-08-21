// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { pullBundle } from '@/lib/bundle/registry-bundle';
import { cutBundle, listFirstReleaseCandidates } from './first-release';
import { FakeDatabaseProvisioner } from '@/lib/db/fake-provisioner';
import { pushBundle } from '@/lib/bundle/registry-bundle';
import type { BundleContents } from '@/lib/bundle/types';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { listBundleCandidates, importBundle, type ImportDeps } from './first-release';

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

const bundleContents = (over: Partial<BundleContents['bundle']> = {}): BundleContents => ({
  forge: {
    name: 'Second Set of Eyes',
    displayName: 'Second Set of Eyes',
    description: 'Drawing review',
    slug: 'second-set-of-eyes',
    repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
    deployVersion: 'v1.0.0',
  },
  dataSql: 'CREATE TABLE "ReviewDocument" (id text primary key);\n',
  bundle: {
    version: 'v1.0.0',
    sourceHost: 'pilot',
    cutAt: '2026-08-21T18:00:00.000Z',
    appImageDigest: APP_DIGEST,
    migrations: ['20260801120000_init'],
    ...over,
  },
});

/** A prod-mode registry holding the app image and a matching bundle. */
async function seededProdRegistry(contents = bundleContents()): Promise<FakeRegistryClient> {
  const reg = new FakeRegistryClient();
  reg.seedTag('second-set-of-eyes', contents.bundle.version, contents.bundle.appImageDigest);
  await pushBundle(reg, 'second-set-of-eyes', contents);
  return reg;
}

describe('listBundleCandidates', () => {
  beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'prod'; });

  it('lists seed repos prod has no forge row for', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();

      expect(await listBundleCandidates(admin, reg)).toEqual([
        { slug: 'second-set-of-eyes', repo: 'second-set-of-eyes-seed', versions: ['v1.0.0'] },
      ]);
    });
  });

  it('omits a forge prod already knows about', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });
      const reg = await seededProdRegistry();

      expect(await listBundleCandidates(admin, reg)).toEqual([]);
    });
  });

  it('ignores repos that are not seed repos', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      reg.seedTag('crystal-lattice', 'v1.0.2');

      const rows = await listBundleCandidates(admin, reg);
      expect(rows.map((r) => r.slug)).toEqual(['second-set-of-eyes']);
    });
  });

  it('degrades to empty when the registry catalog is unreachable', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const broken = {
        listRepositories: async () => { throw new Error('connect ECONNREFUSED'); },
      } as unknown as FakeRegistryClient;

      expect(await listBundleCandidates(admin, broken)).toEqual([]);
    });
  });

  it('refuses in dev mode — importing is a prod action', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'dev';
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      await expect(listBundleCandidates(admin, reg)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('importBundle', () => {
  beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'prod'; });

  /** Default import deps: nothing touches a real database. */
  function importDeps(over: Partial<ImportDeps> = {}) {
    const restored: { sql: string; dbName: string; role: string }[] = [];
    const deps: ImportDeps = {
      provisioner: new FakeDatabaseProvisioner(),
      restore: async (o) => { restored.push({ sql: o.sql, dbName: o.dbName, role: o.role }); },
      readMarker: async () => null,
      randomPassword: () => 'abcdef0123456789',
      ...over,
    };
    return { deps, restored };
  }

  it('creates the forge row, restores, and only then enables it', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps, restored } = importDeps();

      const result = await importBundle(admin, 'second-set-of-eyes', 'v1.0.0', {
        registry: reg, ...deps,
      });

      expect(result).toMatchObject({
        slug: 'second-set-of-eyes', version: 'v1.0.0', deployEnabled: true,
      });

      const row = await prisma.forge.findUniqueOrThrow({ where: { id: result.forgeId } });
      expect(row).toMatchObject({
        name: 'Second Set of Eyes',
        repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
        deployEnabled: true,
        deployVersion: 'v1.0.0',
        createdById: admin.id, // the importing admin, not a user from the bundle
      });

      // Data and marker went in as one stream, marker last.
      expect(restored).toHaveLength(1);
      expect(restored[0]!.dbName).toBe('second_set_of_eyes');
      expect(restored[0]!.role).toBe('second_set_of_eyes_app');
      expect(restored[0]!.sql).toMatch(/ReviewDocument[\s\S]*CREATE TABLE _forge_seed/);
      expect(restored[0]!.sql).toContain(result.bundleDigest);
    });
  });

  it('provisions the database, role, and password before restoring', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const inner = new FakeDatabaseProvisioner();
      const order: string[] = [];
      const provisioner: DatabaseProvisioner = {
        createDatabase: async (n) => { order.push(`create:${n}`); await inner.createDatabase(n); },
        provisionRole: async (d, r) => { order.push(`role:${r}`); await inner.provisionRole(d, r); },
        setRolePassword: async (r, p) => { order.push('password'); await inner.setRolePassword(r, p); },
        dropDatabase: (n) => inner.dropDatabase(n),
        dropRole: (r) => inner.dropRole(r),
        hardenDatabase: (n) => inner.hardenDatabase(n),
      };
      const { deps } = importDeps({
        provisioner,
        restore: async () => { order.push('restore'); },
      });

      await importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps });

      expect(order).toEqual([
        'create:second_set_of_eyes', 'role:second_set_of_eyes_app', 'password', 'restore',
      ]);
    });
  });

  it('tolerates an already-existing database', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const provisioner = new FakeDatabaseProvisioner();
      await provisioner.createDatabase('second_set_of_eyes');
      const { deps } = importDeps({ provisioner });

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).resolves.toMatchObject({ deployEnabled: true });
    });
  });

  it('refuses a bundle cut for a different build of the same version', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      // The registry's v1.0.0 is one build; the bundle records another.
      reg.seedTag('second-set-of-eyes', 'v1.0.0', 'sha256:' + 'a'.repeat(64));
      await pushBundle(
        reg, 'second-set-of-eyes',
        bundleContents({ appImageDigest: 'sha256:' + 'b'.repeat(64) }),
      );
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/different build/i);
    });
  });

  it('refuses a bundle for a version with no app image at all', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = new FakeRegistryClient();
      await pushBundle(reg, 'second-set-of-eyes', bundleContents());
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/no app image/i);
    });
  });

  it('refuses when the marker says the database was already seeded', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps({
        readMarker: async () => ({ bundleDigest: 'sha256:' + 'c'.repeat(64), version: 'v1.0.0' }),
      });

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/already seeded/i);
    });
  });

  it('refuses when prod already has the forge row', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      await makeForge(prisma, { name: 'Second Set of Eyes', createdById: admin.id });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/already known/i);
    });
  });

  it('leaves the forge disabled when the restore fails', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps({
        restore: async () => { throw new Error('psql restore into second_set_of_eyes failed'); },
      });

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toThrow(/psql restore/);

      const row = await prisma.forge.findUniqueOrThrow({
        where: { name: 'Second Set of Eyes' },
      });
      expect(row.deployEnabled).toBe(false);
      expect(row.deployVersion).toBeNull();
    });
  });

  it('refuses a version that is not a semver tag', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'latest', { registry: reg, ...deps }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'D', role: 'DEVELOPER' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(dev, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('refuses in dev mode', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'dev';
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();
      const { deps } = importDeps();

      await expect(
        importBundle(admin, 'second-set-of-eyes', 'v1.0.0', { registry: reg, ...deps }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe('the ordering invariant (spec §8)', () => {
  beforeEach(() => { process.env.FORGE_DASHBOARD_MODE = 'prod'; });

  it('listDesiredForges never returns the forge before the restore has finished', async () => {
    await withCleanDb(async (prisma) => {
      const { listDesiredForges } = await import('@/lib/runtime/prod/desired-state');
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'A', role: 'ADMIN' });
      const reg = await seededProdRegistry();

      const seen: number[] = [];
      const probe = async () => { seen.push((await listDesiredForges(prisma)).length); };

      await importBundle(admin, 'second-set-of-eyes', 'v1.0.0', {
        registry: reg,
        provisioner: new FakeDatabaseProvisioner(),
        readMarker: async () => { await probe(); return null; },
        // The reconciler must not see the forge at any point up to and
        // including the restore — deployEnabled flips only after it returns.
        restore: async () => { await probe(); },
        randomPassword: () => 'abcdef0123456789',
      });

      expect(seen).toEqual([0, 0]);
      expect(await listDesiredForges(prisma)).toHaveLength(1);
    });
  });
});
