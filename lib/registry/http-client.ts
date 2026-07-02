import type { RegistryClient } from './types';
import { RegistryError } from './types';

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export type HttpRegistryConfig = {
  host: string; // e.g. registry.crystalfountains.com
  username: string;
  password: string;
};

/** Retag by GET-ing the source manifest and PUT-ing it under each new tag. */
export class HttpRegistryClient implements RegistryClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(cfg: HttpRegistryConfig) {
    this.base = `https://${cfg.host}/v2`;
    this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  }

  async tagManifest(repo: string, fromTag: string, toTags: string[]): Promise<void> {
    const getRes = await fetch(`${this.base}/${repo}/manifests/${fromTag}`, {
      headers: { Authorization: this.auth, Accept: MANIFEST_ACCEPT },
    });
    if (!getRes.ok) {
      throw new RegistryError(`GET manifest ${repo}:${fromTag} → ${getRes.status}`);
    }
    const contentType =
      getRes.headers.get('content-type') ?? 'application/vnd.oci.image.manifest.v1+json';
    const body = await getRes.text(); // must re-PUT byte-identical body
    for (const tag of toTags) {
      const putRes = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
        method: 'PUT',
        headers: { Authorization: this.auth, 'Content-Type': contentType },
        body,
      });
      if (!putRes.ok) {
        throw new RegistryError(`PUT manifest ${repo}:${tag} → ${putRes.status}`);
      }
    }
  }

  async listTags(repo: string): Promise<string[]> {
    const res = await fetch(`${this.base}/${repo}/tags/list`, {
      headers: { Authorization: this.auth },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new RegistryError(`GET tags/list ${repo} → ${res.status}`);
    const json = (await res.json()) as { tags?: string[] | null };
    return json.tags ?? [];
  }
}
