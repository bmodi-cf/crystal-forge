// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { requestPromotion } from './promotions';
import { ForbiddenError } from '@/lib/errors';

function ghWithForge(): FakeGitHubClient {
  const gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
  return gh;
}

describe('requestPromotion', () => {
  let gh: FakeGitHubClient;
  let reg: FakeRegistryClient;
  beforeEach(() => { gh = ghWithForge(); reg = new FakeRegistryClient(); });

  it('opens a PR, computes v1.0.0 for the first release, and stores a pending request', async () => {
    await withCleanDb(async (prisma) => {
      const owner = await makeUser(prisma, { email: 'o@x', name: 'Owner', groups: ['Eng'] });
      const forge = await makeForge(prisma, {
        name: 'Aquaflow', createdById: owner.id, groups: ['Eng'],
        repoFullName: 'test-owner/aquaflow',
      });
      gh.seedBranch('test-owner/aquaflow', 'main', 'sha-main');
      await gh.createBranch('test-owner/aquaflow', 'main', 'dev');

      const dto = await requestPromotion(owner, forge.id, { bumpLevel: 'minor' }, gh, reg);

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
        requestPromotion(stranger, forge.id, { bumpLevel: 'patch' }, gh, reg),
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
      await requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, reg);
      await expect(
        requestPromotion(owner, forge.id, { bumpLevel: 'patch' }, gh, reg),
      ).rejects.toThrow(/in progress/i);
    });
  });
});
