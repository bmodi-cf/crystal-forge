import { env } from '@/lib/env';
import { FakeGitHubClient } from './fake-client';
import { OctokitGitHubClient } from './octokit-client';
import type { GitHubClient } from './types';

let cached: GitHubClient | null = null;

export function getGitHubClient(): GitHubClient {
  if (cached) return cached;
  if (env.GITHUB_CLIENT_MODE === 'fake') {
    cached = new FakeGitHubClient({
      owner: env.GITHUB_REPO_OWNER,
      baseUrl: env.GITHUB_BASE_URL,
    });
  } else {
    cached = new OctokitGitHubClient({
      owner: env.GITHUB_REPO_OWNER,
      templateRepo: env.GITHUB_TEMPLATE_REPO,
      appId: env.GITHUB_APP_ID!, // env validation guarantees presence
      privateKey: env.GITHUB_APP_PRIVATE_KEY!,
      installationId: env.GITHUB_APP_INSTALLATION_ID!,
    });
  }
  return cached;
}

/** Test-only. Drops the cached client so the next call re-reads env. */
export function resetGitHubClient(): void {
  cached = null;
}

export type { GitHubClient } from './types';
