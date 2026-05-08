import { describe, it, expect, beforeEach } from 'vitest';
import { FakeGitHubClient } from './fake-client';

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
