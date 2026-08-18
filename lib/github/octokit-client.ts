// lib/github/octokit-client.ts
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { BranchProtectionUnavailableError } from './types';
import type {
  BranchMergeResult,
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
      // An already-archived repo is read-only and rejects any update with a
      // 403 ("Repository was archived so is read-only"). That's exactly the
      // state archiveRepo wants, so confirm it and treat it as success.
      if (isStatus(err, 403) && (await this.isArchived(owner, repo))) return;
      throw err;
    }
  }

  private async isArchived(owner: string, repo: string): Promise<boolean> {
    try {
      const { data } = await this.client.repos.get({ owner, repo });
      return data.archived === true;
    } catch {
      return false;
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
    await this.waitForTemplatePopulate(owner, repo);
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
    await this.putContents(
      owner,
      repo,
      '.claude/settings.local.json',
      files.claudeSettings,
      'chore: write .claude/settings.local.json',
    );
    await this.putContents(
      owner,
      repo,
      '.claude/hooks/block-dangerous-commands.sh',
      files.claudeBlockScript,
      'chore: write .claude block hook',
    );
    await this.putContents(
      owner,
      repo,
      'CLAUDE.md',
      files.claudeMd,
      'chore: write CLAUDE.md',
    );
  }

  async getScopedInstallationToken(
    repoFullName: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const repo = repoFullName.split('/')[1];
    if (!repo) throw new Error(`repoFullName must be "owner/repo": ${repoFullName}`);
    // octokit-auth-app returns a repo+permission-scoped installation token
    // through the same client.auth() callable when given repositoryNames/permissions.
    const auth = (this.client as unknown as {
      auth: (opts: {
        type: 'installation';
        repositoryNames: string[];
        permissions: Record<string, string>;
      }) => Promise<{ token: string; expiresAt: string }>;
    }).auth;
    const result = await auth({
      type: 'installation',
      repositoryNames: [repo],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    return { token: result.token, expiresAt: result.expiresAt };
  }

  /**
   * PUT /repos/{owner}/{repo}/contents/{path}. Retries on 404 with bounded
   * backoff (template-cloned repo not yet visible). On 422 — which GitHub
   * returns when the file already exists and `sha` is required — fetch the
   * existing SHA and retry once as an update, so the call is idempotent for
   * adopted repos.
   */
  private async putContents(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    let attempt = 0;
    let sha: string | undefined;
    while (true) {
      try {
        await this.client.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        });
        return;
      } catch (err: unknown) {
        if (isStatus(err, 404) && attempt < this.retryDelaysMs.length) {
          await sleep(this.retryDelaysMs[attempt]!);
          attempt++;
          continue;
        }
        if (isStatus(err, 422) && sha === undefined) {
          const existing = await this.fetchFileSha(owner, repo, path);
          if (existing !== null) {
            sha = existing;
            continue;
          }
        }
        throw err;
      }
    }
  }

  /**
   * GitHub's createUsingTemplate returns before the template files are
   * actually copied. If we write our forge files first, the template
   * populate's later commit overwrites them. Poll `package.json` (which
   * the template ships) until present — then any subsequent writes stick.
   */
  private async waitForTemplatePopulate(owner: string, repo: string): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        const { data } = await this.client.repos.getContent({ owner, repo, path: 'package.json' });
        if (!Array.isArray(data) && (data as { type?: string }).type === 'file') return;
      } catch (err: unknown) {
        if (!isStatus(err, 404)) throw err;
      }
      if (attempt >= this.retryDelaysMs.length) {
        throw new Error(`Template populate for ${owner}/${repo} did not complete in time`);
      }
      await sleep(this.retryDelaysMs[attempt]!);
      attempt++;
    }
  }

  /** Returns the file SHA if it exists, null on 404, throws on other errors. */
  private async fetchFileSha(
    owner: string,
    repo: string,
    path: string,
  ): Promise<string | null> {
    try {
      const { data } = await this.client.repos.getContent({ owner, repo, path });
      if (Array.isArray(data) || (data as { type?: string }).type !== 'file') {
        return null;
      }
      return (data as { sha: string }).sha;
    } catch (err: unknown) {
      if (isStatus(err, 404)) return null;
      throw err;
    }
  }

  async createBranch(fullName: string, fromBranch: string, newBranch: string): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    const { data: ref } = await this.client.git.getRef({
      owner, repo, ref: `heads/${fromBranch}`,
    });
    await this.client.git.createRef({
      owner, repo, ref: `refs/heads/${newBranch}`, sha: ref.object.sha,
    });
  }

  async setBranchProtection(
    fullName: string,
    branch: string,
    opts: BranchProtectionOptions,
  ): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    try {
      await this.client.repos.updateBranchProtection({
        owner, repo, branch,
        required_status_checks: {
          strict: opts.requireUpToDate,
          contexts: [...opts.requiredChecks],
        },
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
      });
    } catch (err: unknown) {
      // Free plans refuse protection on private repos with this specific 403.
      if (isStatus(err, 403) && err instanceof Error && err.message.includes('Upgrade to GitHub')) {
        throw new BranchProtectionUnavailableError(fullName, branch);
      }
      throw err;
    }
  }

  async setRepoTopics(fullName: string, topics: readonly string[]): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    await this.client.repos.replaceAllTopics({ owner, repo, names: [...topics] });
  }

  async openPullRequest(fullName: string, opts: OpenPrOptions): Promise<PullRequestRef> {
    const [owner, repo] = parseFullName(fullName);
    const { data } = await this.client.pulls.create({
      owner, repo, head: opts.head, base: opts.base, title: opts.title, body: opts.body,
    });
    return { number: data.number, url: data.html_url, headSha: data.head.sha };
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestInfo> {
    const [owner, repo] = parseFullName(fullName);
    const { data } = await this.client.pulls.get({ owner, repo, pull_number: number });
    return {
      number: data.number,
      state: data.state === 'open' ? 'open' : 'closed',
      merged: Boolean(data.merged),
      headSha: data.head.sha,
      commits: data.commits ?? 0,
      changedFiles: data.changed_files ?? 0,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      mergeable: data.mergeable ?? null,
      mergeableState: data.mergeable_state ?? 'unknown',
    };
  }

  /**
   * Merge `head` into `base`. A 409 means conflicts and a 204 means `base`
   * already contained `head`; both are normal outcomes for the post-release
   * back-merge, so they are reported rather than thrown.
   */
  async mergeBranch(fullName: string, base: string, head: string): Promise<BranchMergeResult> {
    const [owner, repo] = parseFullName(fullName);
    try {
      const res = await this.client.repos.merge({ owner, repo, base, head });
      // Octokit types this as 201-only, but GitHub answers 204 for "base already
      // contains head" and then sends no body.
      const httpStatus: number = res.status;
      if (httpStatus === 204) return { sha: null, conflicted: false, alreadyUpToDate: true };
      return { sha: res.data?.sha ?? null, conflicted: false, alreadyUpToDate: false };
    } catch (err) {
      if (isStatus(err, 409)) return { sha: null, conflicted: true, alreadyUpToDate: false };
      throw err;
    }
  }

  /**
   * Current state of each named check on `ref`, one entry per name.
   *
   * A commit routinely carries check runs from more than one suite: the same
   * head can be (or have been) the head of several PRs into main — a feature
   * branch's PR plus the promotion's dev -> main PR — and each fires its own
   * promote-gates run. Workflow re-runs add more. `listForRef` returns all of
   * them, so without collapsing, callers see `build`/`lint`/... twice over and
   * `computeStatus`'s name-keyed map lets whichever duplicate happens to come
   * last in the response decide the verdict — which can be an unrelated PR's
   * run, masking a genuine failure in the promotion's own suite.
   *
   * Newest run per name wins (ties broken by run id, which ascends), so a
   * re-run still in flight correctly reports as unsettled rather than
   * resurrecting the previous attempt's conclusion.
   */
  async getRefCheckResults(fullName: string, ref: string): Promise<CheckResult[]> {
    const [owner, repo] = parseFullName(fullName);
    const { data } = await this.client.checks.listForRef({ owner, repo, ref, per_page: 100 });

    const newest = new Map<string, (typeof data.check_runs)[number]>();
    for (const c of data.check_runs) {
      const prev = newest.get(c.name);
      if (!prev || isNewerRun(c, prev)) newest.set(c.name, c);
    }

    return [...newest.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        name: c.name,
        status: c.status as CheckResult['status'],
        conclusion: (c.conclusion ?? null) as CheckResult['conclusion'],
      }));
  }

  async mergePullRequest(
    fullName: string,
    number: number,
    opts?: MergeOptions,
  ): Promise<MergeResult> {
    const [owner, repo] = parseFullName(fullName);
    const { data } = await this.client.pulls.merge({
      owner, repo, pull_number: number, merge_method: opts?.method ?? 'squash',
    });
    return { sha: data.sha, merged: data.merged };
  }

  async closePullRequest(fullName: string, number: number): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    await this.client.pulls.update({ owner, repo, pull_number: number, state: 'closed' });
  }

  async createGitTag(fullName: string, tag: string, sha: string): Promise<void> {
    const [owner, repo] = parseFullName(fullName);
    await this.client.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha });
  }
}

/** Later start wins; equal (or absent) starts fall back to the ascending run id. */
function isNewerRun(
  a: { started_at?: string | null; id: number },
  b: { started_at?: string | null; id: number },
): boolean {
  const at = a.started_at ?? '';
  const bt = b.started_at ?? '';
  return at === bt ? a.id > b.id : at > bt;
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
