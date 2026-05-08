// lib/github/octokit-client.ts
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { CreatedRepo, CreateRepoOptions, GitHubClient } from './types';

export class OctokitGitHubClient implements GitHubClient {
  private readonly client: Octokit;
  private readonly owner: string;
  private readonly templateOwner: string;
  private readonly templateRepo: string;

  constructor(config: {
    owner: string;
    templateRepo: string; // "owner/repo"
    appId: string;
    privateKey: string;
    installationId: string;
  }) {
    const [templateOwner, templateRepo] = config.templateRepo.split('/');
    if (!templateOwner || !templateRepo) {
      throw new Error('templateRepo must be "owner/repo"');
    }
    this.owner = config.owner;
    this.templateOwner = templateOwner;
    this.templateRepo = templateRepo;
    this.client = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      },
    });
  }

  async createRepoFromTemplate(opts: CreateRepoOptions): Promise<CreatedRepo> {
    const { data } = await this.client.repos.createUsingTemplate({
      template_owner: this.templateOwner,
      template_repo: this.templateRepo,
      owner: this.owner,
      name: opts.name,
      description: opts.description ?? undefined,
      private: opts.private,
      include_all_branches: false,
    });
    return { fullName: data.full_name, htmlUrl: data.html_url };
  }

  async archiveRepo(fullName: string): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    try {
      await this.client.repos.update({ owner, repo, archived: true });
    } catch (err: unknown) {
      // 404 means the repo is gone; treat as no-op for idempotency.
      if (isStatus(err, 404)) return;
      throw err;
    }
  }

  async deleteRepo(fullName: string): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    try {
      await this.client.repos.delete({ owner, repo });
    } catch (err: unknown) {
      if (isStatus(err, 404)) return;
      throw err;
    }
  }
}

function parseFullName(fullName: string): [string, string] {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo fullName: ${fullName}`);
  }
  return [owner, repo];
}

function isStatus(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: number }).status === status
  );
}
