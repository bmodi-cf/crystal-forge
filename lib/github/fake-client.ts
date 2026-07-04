import type {
  BranchProtectionOptions,
  CheckResult,
  CreatedRepo,
  CreateRepoOptions,
  ForgeFiles,
  GitHubClient,
  MergeOptions,
  MergeResult,
  OpenPrOptions,
  PullRequestInfo,
  PullRequestRef,
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
  | 'writeForgeFiles'
  | 'createBranch'
  | 'setBranchProtection'
  | 'setRepoTopics'
  | 'openPullRequest'
  | 'getPullRequest'
  | 'getRefCheckResults'
  | 'mergePullRequest'
  | 'closePullRequest'
  | 'createGitTag';

export class FakeGitHubClient implements GitHubClient {
  private readonly owner: string;
  private readonly baseUrl: string;
  private readonly repos = new Map<string, Repo>();
  private readonly files = new Map<string, ForgeFiles>();
  private readonly topics = new Map<string, string[]>();
  private readonly nextErrors = new Map<Method, Error>();

  // --- promotion state ---
  private readonly branches = new Map<string, Map<string, string>>(); // fullName -> branch -> sha
  private readonly protections = new Map<string, Map<string, BranchProtectionOptions>>();
  private readonly pulls = new Map<
    string,
    Map<number, { head: string; base: string; headSha: string; state: 'open' | 'closed'; merged: boolean }>
  >();
  private readonly prCounter = new Map<string, number>();
  private readonly checks = new Map<string, CheckResult[]>(); // `${fullName}@${ref}` -> checks

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
    this.seedBranch(fullName, 'main', 'sha-main');
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
    this.topics.delete(fullName);
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

  async createBranch(fullName: string, fromBranch: string, newBranch: string): Promise<void> {
    this.maybeFail('createBranch');
    const b = this.branches.get(fullName);
    const sha = b?.get(fromBranch);
    if (!b || sha === undefined) throw new Error(`branch ${fromBranch} not found in ${fullName}`);
    b.set(newBranch, sha);
  }

  async setBranchProtection(
    fullName: string,
    branch: string,
    opts: BranchProtectionOptions,
  ): Promise<void> {
    this.maybeFail('setBranchProtection');
    const p = this.protections.get(fullName) ?? new Map<string, BranchProtectionOptions>();
    p.set(branch, { requiredChecks: [...opts.requiredChecks], requireUpToDate: opts.requireUpToDate });
    this.protections.set(fullName, p);
  }

  async setRepoTopics(fullName: string, topics: readonly string[]): Promise<void> {
    this.maybeFail('setRepoTopics');
    if (!this.repos.has(fullName)) {
      throw new Error(`repo ${fullName} not found`);
    }
    this.topics.set(fullName, [...topics]);
  }

  async openPullRequest(fullName: string, opts: OpenPrOptions): Promise<PullRequestRef> {
    this.maybeFail('openPullRequest');
    const headSha = this.branches.get(fullName)?.get(opts.head) ?? `sha-${opts.head}`;
    const n = (this.prCounter.get(fullName) ?? 0) + 1;
    this.prCounter.set(fullName, n);
    const map = this.pulls.get(fullName) ?? new Map();
    map.set(n, { head: opts.head, base: opts.base, headSha, state: 'open', merged: false });
    this.pulls.set(fullName, map);
    return { number: n, url: `${this.baseUrl}/${fullName}/pull/${n}`, headSha };
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestInfo> {
    this.maybeFail('getPullRequest');
    const pr = this.pulls.get(fullName)?.get(number);
    if (!pr) throw new Error(`PR #${number} not found in ${fullName}`);
    return {
      number, state: pr.state, merged: pr.merged, headSha: pr.headSha,
      commits: 1, changedFiles: 1, additions: 1, deletions: 0,
    };
  }

  async getRefCheckResults(fullName: string, ref: string): Promise<CheckResult[]> {
    this.maybeFail('getRefCheckResults');
    return this.checks.get(`${fullName}@${ref}`) ?? [];
  }

  async mergePullRequest(
    fullName: string,
    number: number,
    _opts?: MergeOptions,
  ): Promise<MergeResult> {
    this.maybeFail('mergePullRequest');
    const pr = this.pulls.get(fullName)?.get(number);
    if (!pr) throw new Error(`PR #${number} not found in ${fullName}`);
    pr.state = 'closed';
    pr.merged = true;
    const sha = `merge-${pr.headSha}`;
    // advance base branch head to the merge commit
    this.branches.get(fullName)?.set(pr.base, sha);
    return { sha, merged: true };
  }

  async closePullRequest(fullName: string, number: number): Promise<void> {
    this.maybeFail('closePullRequest');
    const pr = this.pulls.get(fullName)?.get(number);
    if (!pr) throw new Error(`PR #${number} not found in ${fullName}`);
    pr.state = 'closed';
    pr.merged = false;
  }

  async createGitTag(fullName: string, tag: string, sha: string): Promise<void> {
    this.maybeFail('createGitTag');
    // tags are represented as branches namespace `tag/<name>` for the fake
    this.seedBranch(fullName, `tag/${tag}`, sha);
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

  seedBranch(fullName: string, branch: string, sha = `sha-${branch}`): void {
    const b = this.branches.get(fullName) ?? new Map<string, string>();
    b.set(branch, sha);
    this.branches.set(fullName, b);
  }

  getBranches(fullName: string): string[] {
    return [...(this.branches.get(fullName)?.keys() ?? [])];
  }

  getTopics(fullName: string): string[] {
    return this.topics.get(fullName) ?? [];
  }

  getProtection(fullName: string, branch: string): BranchProtectionOptions | undefined {
    return this.protections.get(fullName)?.get(branch);
  }

  setRefChecks(fullName: string, ref: string, checks: CheckResult[]): void {
    this.checks.set(`${fullName}@${ref}`, checks);
  }

  getPullRequestState(
    fullName: string,
    number: number,
  ): { state: 'open' | 'closed'; merged: boolean } | undefined {
    const pr = this.pulls.get(fullName)?.get(number);
    return pr ? { state: pr.state, merged: pr.merged } : undefined;
  }

  private maybeFail(method: Method): void {
    const err = this.nextErrors.get(method);
    if (err) {
      this.nextErrors.delete(method);
      throw err;
    }
  }
}
