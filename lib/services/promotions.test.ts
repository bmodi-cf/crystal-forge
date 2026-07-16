// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { requestPromotion, refreshPromotionGates, listPendingPromotions, acceptPromotion, rejectPromotion, getForgeCurrentVersion } from './promotions';
import { ForbiddenError } from '@/lib/errors';

function ghWithForge(): FakeGitHubClient {
  const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
  return gh;
}

describe('requestPromotion', () => {
  let gh: FakeGitHubClient;
  beforeEach(() => { gh = ghWithForge(); });

  it('opens a PR, computes v1.0.0 for the first release, and stores a pending request', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');

      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'minor' }, gh);

      expect(dto.targetVersion).toBe('v1.0.0'); // first release ignores bump level
      expect(dto.prNumber).toBe(1);
      expect(dto.status).toBe('checks_running');
      expect(gh.getPullRequestState('test-owner/aquaflow', 1)).toEqual({ state: 'open', merged: false });
    });
  });

  it('rejects a requester without write access', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'Stranger', groups: [] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await expect(
        requestPromotion(stranger, forge.id, { bumpLevel: 'patch' }, gh),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('refuses a second open request for the same forge', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
      await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh);
      await expect(
        requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh),
      ).rejects.toThrow(/in progress/i);
    });
  });
});

describe('refreshPromotionGates', () => {
  let gh: FakeGitHubClient;
  beforeEach(() => { gh = ghWithForge(); });

  it('transitions to awaiting_approval when all required checks pass', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'], repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh);
      gh.setRefChecks('test-owner/aquaflow', dto.headSha, [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'typecheck', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'completed', conclusion: 'success' },
        { name: 'tests', status: 'completed', conclusion: 'success' },
      ]);
      const refreshed = await refreshPromotionGates(dto.id, gh);
      expect(refreshed.status).toBe('awaiting_approval');
      expect(refreshed.summary?.gates.length).toBe(4);
    });
  });

  it('transitions to checks_failed when a required check fails', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'], repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh);
      gh.setRefChecks('test-owner/aquaflow', dto.headSha, [
        { name: 'build', status: 'completed', conclusion: 'failure' },
      ]);
      const refreshed = await refreshPromotionGates(dto.id, gh);
      expect(refreshed.status).toBe('checks_failed');
    });
  });
});

describe('listPendingPromotions', () => {
  it('is admin-only', async () => {
    await withCleanDb(async (prisma) => {
      const nonAdmin = await makeUser(prisma, { email: 'n@x', name: 'N', groups: [] });
      await expect(listPendingPromotions(nonAdmin)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

async function seedAwaiting(prisma: PrismaClient, gh: FakeGitHubClient, reg: FakeRegistryClient) {
  const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
  const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin', groups: [], role: 'ADMIN' });
  const forge = await makeForge(prisma, {
    name: 'Aquaflow', createdById: owner.id, groups: ['Eng'], repoFullName: 'test-owner/aquaflow',
  });
  gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
  await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
  const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh);
  // registry has the candidate image the CI build pushed:
  reg.seedTag('aquaflow', `sha-${dto.headSha}`);
  gh.setRefChecks('test-owner/aquaflow', dto.headSha,
    ['build', 'typecheck', 'lint', 'tests'].map((name) => ({ name, status: 'completed', conclusion: 'success' })));
  await refreshPromotionGates(dto.id, gh);
  return { admin, owner, forge, dto };
}

describe('acceptPromotion / rejectPromotion', () => {
  let gh: FakeGitHubClient;
  let reg: FakeRegistryClient;
  beforeEach(() => { gh = ghWithForge(); reg = new FakeRegistryClient(); });

  it('accept merges, tags git, retags the image, and records the release', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);
      const accepted = await acceptPromotion(admin, dto.id, gh, reg);
      expect(accepted.status).toBe('accepted');
      expect(accepted.imageRef).toContain('aquaflow');
      expect(accepted.imageRef).toContain('v1.0.0');
      expect(gh.getPullRequestState('test-owner/aquaflow', dto.prNumber)).toEqual({ state: 'closed', merged: true });
      expect(reg.getTags('aquaflow').sort()).toEqual(
        [`sha-${dto.headSha}`, 'latest', 'v1.0.0'].sort(),
      );
    });
  });

  it('accept is admin-only and requires awaiting_approval', async () => {
    await withCleanDb(async (prisma) => {
      const { owner, dto } = await seedAwaiting(prisma, gh, reg);
      await expect(acceptPromotion(owner, dto.id, gh, reg)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('reject closes the PR and records the reason', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);
      const rejected = await rejectPromotion(admin, dto.id, { reason: 'not yet' }, gh);
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectReason).toBe('not yet');
      expect(gh.getPullRequestState('test-owner/aquaflow', dto.prNumber)).toEqual({ state: 'closed', merged: false });
    });
  });
});

describe('getForgeCurrentVersion', () => {
  it('returns null before any accepted release, then the most recently decided accepted targetVersion', async () => {
    await withCleanDb(async (prisma: PrismaClient) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });

      expect(await getForgeCurrentVersion(owner, forge.id)).toBeNull();

      const base = {
        forgeId: forge.id, requestedById: owner.id, prUrl: 'https://x/pr',
        bumpLevel: 'minor' as const,
      };
      await prisma.promotionRequest.create({ data: {
        ...base, prNumber: 1, headSha: 'a', targetVersion: 'v1.0.0',
        status: 'accepted', decidedAt: new Date('2026-07-01T00:00:00Z'),
      }});
      await prisma.promotionRequest.create({ data: {
        ...base, prNumber: 2, headSha: 'b', targetVersion: 'v1.1.0',
        status: 'accepted', decidedAt: new Date('2026-07-02T00:00:00Z'),
      }});
      // Rejected later than both accepted rows — must not win.
      await prisma.promotionRequest.create({ data: {
        ...base, prNumber: 3, headSha: 'c', targetVersion: 'v9.9.9',
        status: 'rejected', decidedAt: new Date('2026-07-03T00:00:00Z'),
      }});

      expect(await getForgeCurrentVersion(owner, forge.id)).toBe('v1.1.0');
    });
  });

  it('requires read access to the forge', async () => {
    await withCleanDb(async (prisma: PrismaClient) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const outsider = await makeUser(prisma, { email: 's@x', name: 'Stranger', groups: [] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      await expect(getForgeCurrentVersion(outsider, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
