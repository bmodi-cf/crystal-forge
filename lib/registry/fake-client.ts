import type { RegistryClient } from './types';
import { RegistryError } from './types';

export class FakeRegistryClient implements RegistryClient {
  // repo -> tag -> synthetic digest
  private readonly repos = new Map<string, Map<string, string>>();

  seedTag(repo: string, tag: string, digest = `sha256:${tag}`): void {
    const tags = this.repos.get(repo) ?? new Map<string, string>();
    tags.set(tag, digest);
    this.repos.set(repo, tags);
  }

  getTags(repo: string): string[] {
    return [...(this.repos.get(repo)?.keys() ?? [])];
  }

  async tagManifest(repo: string, fromTag: string, toTags: string[]): Promise<void> {
    const tags = this.repos.get(repo);
    const digest = tags?.get(fromTag);
    if (!tags || digest === undefined) {
      throw new RegistryError(`tag ${fromTag} not found in ${repo}`);
    }
    for (const t of toTags) tags.set(t, digest);
  }

  async listTags(repo: string): Promise<string[]> {
    return this.getTags(repo);
  }
}
