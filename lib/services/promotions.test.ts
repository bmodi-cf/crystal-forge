// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { requestPromotion, refreshPromotionGates, listPendingPromotions, acceptPromotion, rejectPromotion, getForgeCurrentVersion } from './promotions';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { promotionBlocker } from './promotion-blocker';

function ghWithForge(): FakeGitHubClient {
  const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
  return gh;
}

/** Workspace guard stub: the forge is running and exactly matches origin/dev. */
const inSync = async () => null;

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

      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'minor' }, gh, inSync);

      expect(dto.targetVersion).toBe('v1.0.0'); // first release ignores bump level
      expect(dto.prNumber).toBe(1);
      expect(dto.status).toBe('checks_running');
      expect(gh.getPullRequestState('test-owner/aquaflow', 1)).toEqual({ state: 'open', merged: false });
    });
  });

  it('refuses when the forge workspace is not in sync with origin/dev', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');

      const outOfSync = async () => ({
        kind: 'ahead' as const,
        title: 'Workspace has unpushed commits',
        message: 'Push to dev, then request the release.',
      });

      await expect(
        requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, outOfSync),
      ).rejects.toBeInstanceOf(ValidationError);

      // No PR may be opened, and no request row left behind, for a tree that
      // is not what would actually be built.
      expect(gh.getPullRequestState('test-owner/aquaflow', 1)).toBeUndefined();
      expect(await prisma.promotionRequest.count({ where: { forgeId: forge.id } })).toBe(0);
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
        requestPromotion(stranger, forge.id, { bumpLevel: 'patch' }, gh, inSync),
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
      await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, inSync);
      await expect(
        requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, inSync),
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
      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, inSync);
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
      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, inSync);
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
  const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, inSync);
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

describe('refreshPromotionGates mergeability', () => {
  let gh: FakeGitHubClient;
  beforeEach(() => { gh = ghWithForge(); });

  async function seedRequest(prisma: PrismaClient) {
    const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
    const forge = await makeForge(prisma, {
      name: 'Aquaflow', createdById: owner.id, groups: ['Eng'], repoFullName: 'test-owner/aquaflow',
    });
    gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
    await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
    return { owner, forge, dto: await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, inSync) };
  }

  // The crystal-lattice PR #4 case: conflicts stop GitHub from ever dispatching
  // promote-gates, so zero check runs exist and the request would otherwise sit
  // at checks_running forever with no explanation.
  it('records the conflict so a gate-less request explains itself', async () => {
    await withCleanDb(async (prisma) => {
      const { dto } = await seedRequest(prisma);
      gh.setPullRequestMergeable('test-owner/aquaflow', dto.prNumber, false);

      const refreshed = await refreshPromotionGates(dto.id, gh);

      expect(refreshed.summary?.gates).toEqual([]);
      expect(refreshed.summary?.mergeable).toBe(false);
      expect(refreshed.summary?.mergeableState).toBe('dirty');
      expect(promotionBlocker(refreshed)?.kind).toBe('conflict');
    });
  });

  it('records a clean PR as mergeable', async () => {
    await withCleanDb(async (prisma) => {
      const { dto } = await seedRequest(prisma);
      const refreshed = await refreshPromotionGates(dto.id, gh);
      expect(refreshed.summary?.mergeable).toBe(true);
      expect(promotionBlocker(refreshed)).toBeNull();
    });
  });
});

describe('acceptPromotion guards and back-merge', () => {
  let gh: FakeGitHubClient;
  let reg: FakeRegistryClient;
  beforeEach(() => { gh = ghWithForge(); reg = new FakeRegistryClient(); });

  // Without this guard the merge call fails deep in Octokit with GitHub's
  // "Pull Request is not mergeable", which surfaces as an opaque 500.
  it('refuses to accept a conflicted PR with an actionable message', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);
      gh.setPullRequestMergeable('test-owner/aquaflow', dto.prNumber, false);

      await expect(acceptPromotion(admin, dto.id, gh, reg)).rejects.toBeInstanceOf(ValidationError);
      await expect(acceptPromotion(admin, dto.id, gh, reg)).rejects.toThrow(/conflict/i);
      // Nothing was released.
      expect(gh.getPullRequestState('test-owner/aquaflow', dto.prNumber)).toEqual({
        state: 'open', merged: false,
      });
    });
  });

  it('refuses to release when dev moved since the gates last ran', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);
      gh.setPullRequestHead('test-owner/aquaflow', dto.prNumber, 'sha-pushed-after-approval');

      await expect(acceptPromotion(admin, dto.id, gh, reg)).rejects.toThrow(/moved/i);
      expect(gh.getPullRequestState('test-owner/aquaflow', dto.prNumber)).toEqual({
        state: 'open', merged: false,
      });
      expect(reg.getTags('aquaflow')).not.toContain('v1.0.0');
    });
  });

  // The squash merge puts a commit on main that dev does not have. Left alone,
  // main and dev diverge a little more with every release until a promotion PR
  // conflicts — which is exactly how the gates stopped running.
  it('syncs main back into dev after a release so the next promotion PR does not diverge', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);

      await acceptPromotion(admin, dto.id, gh, reg);

      const mainSha = gh.getBranchSha('test-owner/aquaflow', 'main');
      const devSha = gh.getBranchSha('test-owner/aquaflow', 'dev');
      expect(mainSha).toBe(`merge-${dto.headSha}`);
      expect(devSha).toBe(`merge-${mainSha}`);
    });
  });

  it('still reports the release when the back-merge conflicts', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);
      gh.setBranchMergeConflict('test-owner/aquaflow', 'dev', 'main');

      const accepted = await acceptPromotion(admin, dto.id, gh, reg);

      expect(accepted.status).toBe('accepted');
      expect(accepted.imageRef).toContain('v1.0.0');
    });
  });

  it('still reports the release when the back-merge call itself fails', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);
      gh.failNextCall('mergeBranch', new Error('GitHub down'));

      const accepted = await acceptPromotion(admin, dto.id, gh, reg);

      expect(accepted.status).toBe('accepted');
    });
  });
});

describe('refreshPromotionGates head tracking', () => {
  let gh: FakeGitHubClient;
  beforeEach(() => { gh = ghWithForge(); });

  async function seedRequest(prisma: PrismaClient) {
    const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
    const forge = await makeForge(prisma, {
      name: 'Aquaflow', createdById: owner.id, groups: ['Eng'], repoFullName: 'test-owner/aquaflow',
    });
    gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
    await gh.createBranch('test-owner/aquaflow', 'main', 'dev');
    return { owner, forge, dto: await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, inSync) };
  }

  // Pushing to dev (a conflict fix, or just more work) moves the PR head, and
  // GitHub runs the gates on the new sha. Watching the sha captured at request
  // time would report zero gates forever.
  it('follows the PR head when dev is pushed and reads gates for the new sha', async () => {
    await withCleanDb(async (prisma) => {
      const { dto } = await seedRequest(prisma);
      gh.setPullRequestHead('test-owner/aquaflow', dto.prNumber, 'sha-new-head');
      gh.setRefChecks('test-owner/aquaflow', 'sha-new-head',
        ['build', 'typecheck', 'lint', 'tests'].map((name) => ({
          name, status: 'completed' as const, conclusion: 'success' as const,
        })));

      const refreshed = await refreshPromotionGates(dto.id, gh);

      expect(refreshed.headSha).toBe('sha-new-head');
      expect(refreshed.summary?.gates.length).toBe(4);
      expect(refreshed.status).toBe('awaiting_approval');
    });
  });

  // A stale approval must not release the newly pushed code unreviewed, nor
  // retag an image built from the old sha.
  it('sends an approved request back to checks_running when the head moves', async () => {
    await withCleanDb(async (prisma) => {
      const { dto } = await seedRequest(prisma);
      gh.setRefChecks('test-owner/aquaflow', dto.headSha,
        ['build', 'typecheck', 'lint', 'tests'].map((name) => ({
          name, status: 'completed' as const, conclusion: 'success' as const,
        })));
      expect((await refreshPromotionGates(dto.id, gh)).status).toBe('awaiting_approval');

      gh.setPullRequestHead('test-owner/aquaflow', dto.prNumber, 'sha-new-head');
      const refreshed = await refreshPromotionGates(dto.id, gh);

      expect(refreshed.status).toBe('checks_running');
      expect(refreshed.headSha).toBe('sha-new-head');
      expect(refreshed.summary?.gates).toEqual([]);
    });
  });

  // The gate-start grace period has to restart from the new head, or the
  // freshly pushed commit is instantly accused of never starting its gates.
  it('restarts the gate-start clock from the new head', async () => {
    await withCleanDb(async (prisma) => {
      const { dto } = await seedRequest(prisma);
      const before = await refreshPromotionGates(dto.id, gh);
      const firstSeen = before.summary?.headSince;
      expect(firstSeen).toBeTruthy();

      gh.setPullRequestHead('test-owner/aquaflow', dto.prNumber, 'sha-new-head');
      const after = await refreshPromotionGates(dto.id, gh);

      expect(after.summary?.headSince).not.toBe(firstSeen);
      expect(Date.parse(after.summary!.headSince!)).toBeGreaterThanOrEqual(Date.parse(firstSeen!));
    });
  });

  it('leaves headSince alone while the head is unchanged', async () => {
    await withCleanDb(async (prisma) => {
      const { dto } = await seedRequest(prisma);
      const first = await refreshPromotionGates(dto.id, gh);
      const second = await refreshPromotionGates(dto.id, gh);
      expect(second.summary?.headSince).toBe(first.summary?.headSince);
    });
  });
});

describe('refreshPromotionGates concurrency', () => {
  let gh: FakeGitHubClient;
  let reg: FakeRegistryClient;
  beforeEach(() => { gh = ghWithForge(); reg = new FakeRegistryClient(); });

  /**
   * A refresh reads the row, then makes two GitHub calls, then writes. If the
   * admin clicks Accept inside that window the refresh writes its stale status
   * back over the decision — and because the resurrected status is active, the
   * request returns to the Pending tab and every later refresh keeps it there.
   * Observed on Crystal Lattice v1.2.0: merged, tagged and image-tagged, yet
   * still listed as awaiting_approval.
   */
  class AcceptMidRefreshClient extends FakeGitHubClient {
    constructor(private readonly onRead: () => Promise<void>, cfg: { owner: string; baseUrl: string }) {
      super(cfg);
    }
    async getRefCheckResults(fullName: string, ref: string) {
      await this.onRead();
      return super.getRefCheckResults(fullName, ref);
    }
  }

  it('does not resurrect a request that was accepted mid-refresh', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);

      // Same repo state, but this client accepts the request while the refresh
      // is between its read and its write.
      const racy = new AcceptMidRefreshClient(
        async () => { await acceptPromotion(admin, dto.id, gh, reg); },
        { owner: 'test-owner', baseUrl: 'https://github.com' },
      );
      racy.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await racy.createBranch('test-owner/aquaflow', 'main', 'dev');
      await racy.openPullRequest('test-owner/aquaflow', {
        head: 'dev', base: 'main', title: 'Promote', body: 'x',
      });
      racy.setRefChecks('test-owner/aquaflow', dto.headSha,
        ['build', 'typecheck', 'lint', 'tests'].map((name) => ({
          name, status: 'completed' as const, conclusion: 'success' as const,
        })));

      const refreshed = await refreshPromotionGates(dto.id, racy);

      expect(refreshed.status).toBe('accepted');
      const row = await prisma.promotionRequest.findUniqueOrThrow({ where: { id: dto.id } });
      expect(row.status).toBe('accepted');
      expect(row.decidedAt).not.toBeNull();
    });
  });

  it('keeps a decided request off the pending list', async () => {
    await withCleanDb(async (prisma) => {
      const { admin, dto } = await seedAwaiting(prisma, gh, reg);
      await acceptPromotion(admin, dto.id, gh, reg);

      await refreshPromotionGates(dto.id, gh);

      const pending = await listPendingPromotions(admin);
      expect(pending.map((p) => p.id)).not.toContain(dto.id);
    });
  });
});
