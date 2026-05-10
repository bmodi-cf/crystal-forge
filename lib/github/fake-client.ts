import type {
  CreatedRepo,
  CreateRepoOptions,
  ForgeFiles,
  GitHubClient,
} from './types';

type Repo = {
  fullName: string;
  archived: boolean;
  private: boolean;
  description: string | null;
};

type Method =
  | 'createRepoFromTemplate'
  | 'archiveRepo'
  | 'deleteRepo'
  | 'writeForgeFiles';

export class FakeGitHubClient implements GitHubClient {
  private readonly owner: string;
  private readonly baseUrl: string;
  private readonly repos = new Map<string, Repo>();
  private readonly files = new Map<string, ForgeFiles>();
  private readonly nextErrors = new Map<Method, Error>();

  constructor(config: { owner: string; baseUrl: string }) {
    this.owner = config.owner;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async createRepoFromTemplate(opts: CreateRepoOptions): Promise<CreatedRepo> {
    this.maybeFail('createRepoFromTemplate');
    const fullName = `${this.owner}/${opts.name}`;
    if (this.repos.has(fullName)) {
      throw new Error(`repo ${fullName} already exists`);
    }
    this.repos.set(fullName, {
      fullName,
      archived: false,
      private: opts.private,
      description: opts.description,
    });
    return { fullName, htmlUrl: `${this.baseUrl}/${fullName}` };
  }

  async archiveRepo(fullName: string): Promise<void> {
    this.maybeFail('archiveRepo');
    const repo = this.repos.get(fullName);
    if (repo) repo.archived = true;
    // Unknown repo: no-op success (matches spec idempotency).
  }

  async deleteRepo(fullName: string): Promise<void> {
    this.maybeFail('deleteRepo');
    this.repos.delete(fullName);
    this.files.delete(fullName);
  }

  async writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void> {
    this.maybeFail('writeForgeFiles');
    if (!this.repos.has(fullName)) {
      throw new Error(`repo ${fullName} not found`);
    }
    this.files.set(fullName, files);
  }

  async getInstallationToken(): Promise<string> {
    return 'fake-installation-token';
  }

  // Test helpers -----------------------------------------------------------

  failNextCall(method: Method, error: Error): void {
    this.nextErrors.set(method, error);
  }

  getRepo(fullName: string): Repo | undefined {
    return this.repos.get(fullName);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  getFiles(fullName: string): ForgeFiles | undefined {
    return this.files.get(fullName);
  }

  private maybeFail(method: Method): void {
    const err = this.nextErrors.get(method);
    if (err) {
      this.nextErrors.delete(method);
      throw err;
    }
  }
}
