// lib/github/types.ts
export type CreateRepoOptions = {
  /** Slugified repo name; written under the configured owner. */
  name: string;
  /** Used as the GitHub repo description on creation. */
  description: string | null;
  /** Always true in this slice; surfaced for forward-compatibility. */
  private: boolean;
};

export type CreatedRepo = {
  /** "owner/name" — canonical identifier used by the GitHub API. */
  fullName: string;
  /** Browser URL for the repo (e.g. https://github.com/owner/name). */
  htmlUrl: string;
};

/**
 * Body of forge.config.json, the source of forge identity inside a
 * cloned forge repo. Matches the spec contract — see
 * docs/superpowers/specs/2026-05-08-template-webapp-and-forge-config-design.md §3.B.
 */
export type ForgeConfigPayload = {
  name: string;
  description: string | null;
  slug: string;
  dbName: string;
  createdAt: string;
};

export type ForgeFiles = {
  forgeConfig: ForgeConfigPayload;
  /** Already-rendered .env.example body (UTF-8 text). */
  envExample: string;
  /** `.claude/settings.local.json` body — PreToolUse hook config. */
  claudeSettings: string;
  /** `.claude/hooks/block-dangerous-commands.sh` body — invoked by the hook. */
  claudeBlockScript: string;
  /** Top-level `CLAUDE.md` body — sandbox rules for the in-forge agent. */
  claudeMd: string;
};

export interface GitHubClient {
  /**
   * Generate a new repo from the configured template under the configured owner.
   * Throws on any GitHub failure (auth, rate-limit, name-taken, ...).
   */
  createRepoFromTemplate(opts: CreateRepoOptions): Promise<CreatedRepo>;

  /**
   * Idempotent. Calling on an already-archived repo is a no-op-success.
   */
  archiveRepo(fullName: string): Promise<void>;

  /**
   * Compensating action only. NOT user-facing. Used to roll back a just-created
   * repo when a downstream step fails. Permanent and unrecoverable.
   */
  deleteRepo(fullName: string): Promise<void>;

  /**
   * Waits for GitHub's async template populate to complete (poll
   * `contents/package.json` until present), then commits forge.config.json
   * AND .env.example to the default branch of `fullName`. Without the wait,
   * GitHub's later populate commit silently overwrites our writes — the
   * cloned forge ends up with the template's placeholder DATABASE_URL.
   *
   * Each commit uses an upsert PUT (on 422 the SHA is fetched and the
   * PUT is retried as an update) so adopting an already-populated repo
   * also works. PUTs retry on 404 with bounded exponential backoff
   * (200/400/800/1600/3200ms). Throws on any other failure.
   */
  writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void>;

  /**
   * Mints a repo-scoped installation token (contents + pull_requests write)
   * for `repoFullName` ("owner/repo"). Short-lived (~1h). Returns the token
   * and its expiry. Used for in-forge git/gh, refreshed while a session is open.
   */
  getScopedInstallationToken(repoFullName: string): Promise<{ token: string; expiresAt: string }>;

  /** Create `newBranch` pointing at the head of `fromBranch`. */
  createBranch(fullName: string, fromBranch: string, newBranch: string): Promise<void>;

  /** Apply/replace branch protection on `branch`. Idempotent. */
  setBranchProtection(
    fullName: string,
    branch: string,
    opts: BranchProtectionOptions,
  ): Promise<void>;

  /** Replace the repo's topics. Idempotent. */
  setRepoTopics(fullName: string, topics: readonly string[]): Promise<void>;

  /** Open a PR from `opts.head` into `opts.base`. */
  openPullRequest(fullName: string, opts: OpenPrOptions): Promise<PullRequestRef>;

  /** Fetch PR state + diff stats. */
  getPullRequest(fullName: string, number: number): Promise<PullRequestInfo>;

  /**
   * Normalized check-run results for a commit ref: **at most one entry per
   * check name**, reflecting the most recent run of that check. A commit can
   * carry runs from several suites (multiple PRs sharing a head, re-runs);
   * implementations must collapse them, since callers key gates by name.
   */
  getRefCheckResults(fullName: string, ref: string): Promise<CheckResult[]>;

  /**
   * Entry names (not full paths) of a directory at an exact ref. Empty array
   * when the path does not exist there — callers treat "no migrations
   * directory" as "no migrations", not as an error.
   *
   * Used by the first-release migration-parity guard, which compares a forge
   * database's applied migrations against the repo at the released sha.
   */
  listDirectoryAtRef(fullName: string, path: string, ref: string): Promise<string[]>;

  /**
   * Merge `head` into `base` directly (no PR). Used to sync main back into dev
   * after a squash-merged release, so the next promotion PR does not diverge.
   * Reports conflicts rather than throwing.
   */
  mergeBranch(fullName: string, base: string, head: string): Promise<BranchMergeResult>;

  /** Merge a PR. Throws if not mergeable. */
  mergePullRequest(
    fullName: string,
    number: number,
    opts?: MergeOptions,
  ): Promise<MergeResult>;

  /** Close a PR without merging. */
  closePullRequest(fullName: string, number: number): Promise<void>;

  /** Create a lightweight git tag `tag` at `sha`. */
  createGitTag(fullName: string, tag: string, sha: string): Promise<void>;
}

export type BranchProtectionOptions = {
  /** Status-check contexts that must pass before merge. */
  requiredChecks: readonly string[];
  /** Require the PR branch be up to date with the base before merge. */
  requireUpToDate: boolean;
};

/**
 * GitHub refuses branch protection on private repos below a paid plan
 * (403 "Upgrade to GitHub Pro or make this repository public…"). Callers
 * may treat this as a degraded-but-acceptable outcome rather than a failure.
 */
export class BranchProtectionUnavailableError extends Error {
  constructor(fullName: string, branch: string) {
    super(`Branch protection unavailable for ${fullName}@${branch} (private repo on a free plan)`);
    this.name = 'BranchProtectionUnavailableError';
  }
}

export type OpenPrOptions = {
  head: string; // e.g. 'dev'
  base: string; // e.g. 'main'
  title: string;
  body: string;
};

export type PullRequestRef = {
  number: number;
  url: string;
  headSha: string;
};

export type CheckConclusion =
  | 'success' | 'failure' | 'neutral' | 'cancelled'
  | 'timed_out' | 'action_required' | 'skipped' | null;

export type CheckResult = {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: CheckConclusion;
};

export type PullRequestInfo = {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  /**
   * GitHub's verdict on whether the PR can be merged, or `null` while it is
   * still computing one. `false` matters beyond the merge itself: GitHub cannot
   * build a merge ref for a conflicted PR, so it never dispatches
   * `pull_request`-triggered workflows — the promotion gates never run.
   */
  mergeable: boolean | null;
  /** GitHub's `mergeable_state` (`clean`, `dirty`, `blocked`, `behind`, ...). */
  mergeableState: string;
};

/** Outcome of merging one branch into another (`POST /repos/{r}/merges`). */
export type BranchMergeResult = {
  /** The merge commit, or null when nothing was merged. */
  sha: string | null;
  /** True when the merge could not be performed because of conflicts. */
  conflicted: boolean;
  /** True when `base` already contained `head`, so there was nothing to do. */
  alreadyUpToDate: boolean;
};

export type MergeOptions = { method: 'merge' | 'squash' | 'rebase' };
export type MergeResult = { sha: string; merged: boolean };
