export interface RegistryClient {
  /**
   * Copy the manifest currently under `fromTag` to each tag in `toTags`
   * (a pure registry manifest operation — no rebuild). Throws if `fromTag`
   * does not exist in `repo`.
   */
  tagManifest(repo: string, fromTag: string, toTags: string[]): Promise<void>;

  /** List all tags currently present for `repo` (empty array if none). */
  listTags(repo: string): Promise<string[]>;

  /**
   * Upload `bytes` as a blob in `repo` and return its `sha256:…` digest.
   * Idempotent: a blob already present is not re-uploaded.
   */
  putBlob(repo: string, bytes: Buffer): Promise<string>;

  /** Fetch a blob by digest. Throws RegistryError when absent. */
  getBlob(repo: string, digest: string): Promise<Buffer>;

  /** PUT `manifest` (serialised as JSON) under `tag`; returns its digest. */
  putManifest(repo: string, tag: string, manifest: unknown): Promise<string>;

  /** Fetch a manifest body plus its digest. Throws RegistryError when absent. */
  getManifest(repo: string, tag: string): Promise<{ body: string; digest: string }>;

  /**
   * The manifest digest currently under `tag`, or null when the tag is absent.
   * Distinct from listTags: this identifies the *build*, which is what the
   * first-release version-match guard compares against a bundle's record.
   */
  manifestDigest(repo: string, tag: string): Promise<string | null>;

  /** Every repository in the registry catalog (empty array when none). */
  listRepositories(): Promise<string[]>;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}
