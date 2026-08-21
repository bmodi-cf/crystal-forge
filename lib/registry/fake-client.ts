import type { RegistryClient } from './types';
import { RegistryError } from './types';
import { sha256Digest } from '@/lib/bundle/tar';

export class FakeRegistryClient implements RegistryClient {
  // repo -> tag -> manifest digest
  private readonly repos = new Map<string, Map<string, string>>();
  // repo -> blob digest -> bytes
  private readonly blobs = new Map<string, Map<string, Buffer>>();
  // repo -> manifest digest -> body
  private readonly manifests = new Map<string, Map<string, string>>();

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

  async putBlob(repo: string, bytes: Buffer): Promise<string> {
    const digest = sha256Digest(bytes);
    const store = this.blobs.get(repo) ?? new Map<string, Buffer>();
    store.set(digest, Buffer.from(bytes));
    this.blobs.set(repo, store);
    return digest;
  }

  async getBlob(repo: string, digest: string): Promise<Buffer> {
    const found = this.blobs.get(repo)?.get(digest);
    if (!found) throw new RegistryError(`blob ${digest} not found in ${repo}`);
    return Buffer.from(found);
  }

  async putManifest(repo: string, tag: string, manifest: unknown): Promise<string> {
    const body = JSON.stringify(manifest);
    const digest = sha256Digest(Buffer.from(body, 'utf8'));
    const bodies = this.manifests.get(repo) ?? new Map<string, string>();
    bodies.set(digest, body);
    this.manifests.set(repo, bodies);
    this.seedTag(repo, tag, digest);
    return digest;
  }

  async getManifest(repo: string, tag: string): Promise<{ body: string; digest: string }> {
    const digest = this.repos.get(repo)?.get(tag);
    const body = digest ? this.manifests.get(repo)?.get(digest) : undefined;
    if (!digest || body === undefined) {
      throw new RegistryError(`manifest ${repo}:${tag} not found`);
    }
    return { body, digest };
  }

  async manifestDigest(repo: string, tag: string): Promise<string | null> {
    return this.repos.get(repo)?.get(tag) ?? null;
  }

  async listRepositories(): Promise<string[]> {
    return [...new Set([...this.repos.keys(), ...this.manifests.keys(), ...this.blobs.keys()])];
  }
}
