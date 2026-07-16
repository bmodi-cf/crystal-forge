import { describe, it, expect, beforeEach } from 'vitest';
import { FakeGitHubClient } from './fake-client';
import type { ForgeFiles } from './types';

describe('FakeGitHubClient', () => {
  let fake: FakeGitHubClient;

  beforeEach(() => {
    fake = new FakeGitHubClient({
      owner: 'bmodi-cf',
      baseUrl: 'https://github.com',
    });
  });

  it('creates a repo and returns its fullName + htmlUrl', async () => {
    const repo = await fake.createRepoFromTemplate({
      name: 'aquaflow',
      description: 'Hydraulics tool',
      private: true,
    });
    expect(repo.fullName).toBe('bmodi-cf/aquaflow');
    expect(repo.htmlUrl).toBe('https://github.com/bmodi-cf/aquaflow');
    expect(fake.getRepo('bmodi-cf/aquaflow')).toMatchObject({
      fullName: 'bmodi-cf/aquaflow',
      archived: false,
      private: true,
      description: 'Hydraulics tool',
    });
  });

  it('throws when a repo with the same slug already exists', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    await expect(
      fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true }),
    ).rejects.toThrow(/already exists/i);
  });

  it('archives a repo idempotently', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    await fake.archiveRepo('bmodi-cf/aquaflow');
    expect(fake.getRepo('bmodi-cf/aquaflow')?.archived).toBe(true);
    // Second call must succeed (no-op).
    await expect(fake.archiveRepo('bmodi-cf/aquaflow')).resolves.toBeUndefined();
    // Unknown repo must also succeed (no-op).
    await expect(fake.archiveRepo('bmodi-cf/never-existed')).resolves.toBeUndefined();
  });

  it('deletes a repo idempotently', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    await fake.deleteRepo('bmodi-cf/aquaflow');
    expect(fake.getRepo('bmodi-cf/aquaflow')).toBeUndefined();
    await expect(fake.deleteRepo('bmodi-cf/aquaflow')).resolves.toBeUndefined();
  });

  it('failNextCall makes the next matching call throw, then resumes normal behaviour', async () => {
    fake.failNextCall('createRepoFromTemplate', new Error('rate limited'));
    await expect(
      fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true }),
    ).rejects.toThrow('rate limited');
    // Subsequent call works.
    const repo = await fake.createRepoFromTemplate({
      name: 'aquaflow',
      description: null,
      private: true,
    });
    expect(repo.fullName).toBe('bmodi-cf/aquaflow');
  });

  it('listRepos returns every recorded repo', async () => {
    await fake.createRepoFromTemplate({ name: 'a', description: null, private: true });
    await fake.createRepoFromTemplate({ name: 'b', description: null, private: true });
    expect(fake.listRepos().map((r) => r.fullName).sort()).toEqual([
      'bmodi-cf/a',
      'bmodi-cf/b',
    ]);
  });
});

const exampleFiles = (): ForgeFiles => ({
  forgeConfig: {
    name: 'Aquaflow',
    description: 'Hydraulics tool',
    slug: 'aquaflow',
    dbName: 'aquaflow',
    createdAt: '2026-05-09T01:34:47.000Z',
  },
  envExample: 'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow\n',
  claudeSettings: '{"hooks":{}}\n',
  claudeBlockScript: '#!/usr/bin/env bash\nexit 0\n',
  claudeMd: '# Forge: Aquaflow\n',
});

describe('FakeGitHubClient.writeForgeFiles', () => {
  let fake: FakeGitHubClient;

  beforeEach(() => {
    fake = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
  });

  it('records the two files against the repo full name', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    const files = exampleFiles();
    await fake.writeForgeFiles('bmodi-cf/aquaflow', files);
    expect(fake.getFiles('bmodi-cf/aquaflow')).toEqual(files);
  });

  it('throws when the repo does not exist', async () => {
    await expect(
      fake.writeForgeFiles('bmodi-cf/missing', exampleFiles()),
    ).rejects.toThrow(/not found/i);
  });

  it('a second call overwrites the recorded files', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    const first = exampleFiles();
    await fake.writeForgeFiles('bmodi-cf/aquaflow', first);
    const second: ForgeFiles = {
      ...first,
      forgeConfig: { ...first.forgeConfig, description: 'changed' },
    };
    await fake.writeForgeFiles('bmodi-cf/aquaflow', second);
    expect(fake.getFiles('bmodi-cf/aquaflow')).toEqual(second);
  });

  it('failNextCall makes the next writeForgeFiles throw, then resumes', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    fake.failNextCall('writeForgeFiles', new Error('rate limited'));
    await expect(
      fake.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles()),
    ).rejects.toThrow('rate limited');
    // Subsequent call works.
    await fake.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles());
    expect(fake.getFiles('bmodi-cf/aquaflow')).toBeDefined();
  });

  it('deleteRepo also clears any recorded files for that repo', async () => {
    await fake.createRepoFromTemplate({ name: 'aquaflow', description: null, private: true });
    await fake.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles());
    await fake.deleteRepo('bmodi-cf/aquaflow');
    expect(fake.getFiles('bmodi-cf/aquaflow')).toBeUndefined();
  });
});

describe('FakeGitHubClient.getScopedInstallationToken', () => {
  it('returns a deterministic token and far-future expiry for the repo', async () => {
    const fake = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
    const res = await fake.getScopedInstallationToken('test-owner/aquaflow');
    expect(res.token).toBe('fake-scoped-token:test-owner/aquaflow');
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('FakeGitHubClient promotion methods', () => {
  let gh: FakeGitHubClient;
  beforeEach(async () => {
    gh = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
    await gh.createRepoFromTemplate({ name: 'app1', description: null, private: true });
    gh.seedBranch('test-owner/app1', 'main', 'sha-main');
  });

  it('createBranch clones the head sha of the source branch', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    expect(gh.getBranches('test-owner/app1').sort()).toEqual(['dev', 'main']);
  });

  it('setBranchProtection stores the options', async () => {
    await gh.setBranchProtection('test-owner/app1', 'main', {
      requiredChecks: ['build', 'lint'],
      requireUpToDate: true,
    });
    expect(gh.getProtection('test-owner/app1', 'main')).toEqual({
      requiredChecks: ['build', 'lint'],
      requireUpToDate: true,
    });
  });

  it('openPullRequest returns an incrementing number + head sha', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    const pr = await gh.openPullRequest('test-owner/app1', {
      head: 'dev', base: 'main', title: 'Promote', body: 'x',
    });
    expect(pr.number).toBe(1);
    expect(pr.headSha).toBeTruthy();
    expect(pr.url).toContain('test-owner/app1');
  });

  it('getRefCheckResults returns seeded checks', async () => {
    gh.setRefChecks('test-owner/app1', 'sha-dev', [
      { name: 'build', status: 'completed', conclusion: 'success' },
    ]);
    const checks = await gh.getRefCheckResults('test-owner/app1', 'sha-dev');
    expect(checks).toEqual([{ name: 'build', status: 'completed', conclusion: 'success' }]);
  });

  it('mergePullRequest marks the PR merged and returns a sha', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    const pr = await gh.openPullRequest('test-owner/app1', {
      head: 'dev', base: 'main', title: 'Promote', body: 'x',
    });
    const res = await gh.mergePullRequest('test-owner/app1', pr.number);
    expect(res.merged).toBe(true);
    expect(gh.getPullRequestState('test-owner/app1', pr.number)).toEqual({
      state: 'closed', merged: true,
    });
  });

  it('closePullRequest closes without merging', async () => {
    await gh.createBranch('test-owner/app1', 'main', 'dev');
    const pr = await gh.openPullRequest('test-owner/app1', {
      head: 'dev', base: 'main', title: 'Promote', body: 'x',
    });
    await gh.closePullRequest('test-owner/app1', pr.number);
    expect(gh.getPullRequestState('test-owner/app1', pr.number)).toEqual({
      state: 'closed', merged: false,
    });
  });
});
