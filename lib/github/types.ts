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
   * Mints an installation access token usable in `https://x-access-token:<token>@github.com/...`
   * URLs (e.g. for `git clone`). Tokens are short-lived (~1h) and the caller is
   * responsible for not persisting them. Throws on any auth failure.
   */
  getInstallationToken(): Promise<string>;
}
