export interface RegistryClient {
  /**
   * Copy the manifest currently under `fromTag` to each tag in `toTags`
   * (a pure registry manifest operation — no rebuild). Throws if `fromTag`
   * does not exist in `repo`.
   */
  tagManifest(repo: string, fromTag: string, toTags: string[]): Promise<void>;

  /** List all tags currently present for `repo` (empty array if none). */
  listTags(repo: string): Promise<string[]>;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}
