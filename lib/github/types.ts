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
   * Commits forge.config.json AND .env.example to the default branch of
   * `fullName`. Two PUTs to /repos/{owner}/{repo}/contents/{path}, each
   * producing one commit. Throws on any failure; caller is responsible
   * for compensation.
   *
   * GitHub's template-clone is asynchronous — the new repo can return 404
   * on contents writes for a few hundred ms after createUsingTemplate
   * resolves. Each PUT retries on 404 only with bounded exponential
   * backoff (200/400/800/1600/3200ms). Any other status throws immediately.
   */
  writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void>;
}
