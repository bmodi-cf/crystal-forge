// lib/github/octokit-client.ts
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type {
  CreatedRepo,
  CreateRepoOptions,
  ForgeFiles,
  GitHubClient,
} from './types';

const RETRY_DELAYS_MS = [200, 400, 800, 1600, 3200] as const;

export class OctokitGitHubClient implements GitHubClient {
  private readonly client: Octokit;
  private readonly owner: string;
  private readonly templateOwner: string;
  private readonly templateRepo: string;
  private readonly retryDelaysMs: readonly number[];

  constructor(config: {
    owner: string;
    templateRepo: string; // "owner/repo"
    appId: string;
    privateKey: string;
    installationId: string;
    /** Test-only override. */
    octokit?: Octokit;
    /** Test-only override of retry backoff (default RETRY_DELAYS_MS). */
    retryDelaysMs?: readonly number[];
  }) {
    const [templateOwner, templateRepo] = config.templateRepo.split('/');
    if (!templateOwner || !templateRepo) {
      throw new Error('templateRepo must be "owner/repo"');
    }
    this.owner = config.owner;
    this.templateOwner = templateOwner;
    this.templateRepo = templateRepo;
    this.client = config.octokit ?? new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      },
    });
    this.retryDelaysMs = config.retryDelaysMs ?? RETRY_DELAYS_MS;
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

  async writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    const forgeConfigBody = JSON.stringify(files.forgeConfig, null, 2) + '\n';
    await this.putContents(
      owner,
      repo,
      'forge.config.json',
      forgeConfigBody,
      'chore: write forge.config.json',
    );
    await this.putContents(
      owner,
      repo,
      '.env.example',
      files.envExample,
      'chore: write .env.example',
    );
  }

  /**
   * PUT /repos/{owner}/{repo}/contents/{path}. Retries on 404 only with
   * bounded exponential backoff. Any other error (401/403/422/5xx) throws
   * immediately.
   */
  private async putContents(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.client.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
        });
        return;
      } catch (err: unknown) {
        if (isStatus(err, 404) && attempt < this.retryDelaysMs.length) {
          await sleep(this.retryDelaysMs[attempt]!);
          attempt++;
          continue;
        }
        throw err;
      }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
