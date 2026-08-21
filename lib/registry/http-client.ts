import type { RegistryClient } from './types';
import { RegistryError } from './types';
import { sha256Digest } from '@/lib/bundle/tar';

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

  async putBlob(repo: string, bytes: Buffer): Promise<string> {
    const digest = sha256Digest(bytes);

    // Already there? Registries dedupe by digest, so skip the upload.
    const head = await fetch(`${this.base}/${repo}/blobs/${digest}`, {
      method: 'HEAD',
      headers: { Authorization: this.auth },
    });
    if (head.ok) return digest;

    const start = await fetch(`${this.base}/${repo}/blobs/uploads/`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Length': '0' },
    });
    if (start.status !== 202) {
      throw new RegistryError(`POST blobs/uploads ${repo} → ${start.status}`);
    }
    const location = start.headers.get('location');
    if (!location) {
      throw new RegistryError(`POST blobs/uploads ${repo} returned no Location header`);
    }
    // Location may be absolute or root-relative; resolve either against /v2/.
    const url = new URL(location, `${this.base}/`);
    url.searchParams.set('digest', digest);

    const put = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: this.auth, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    if (put.status !== 201) {
      throw new RegistryError(`PUT blob ${repo} ${digest} → ${put.status}`);
    }
    return digest;
  }

  async getBlob(repo: string, digest: string): Promise<Buffer> {
    const res = await fetch(`${this.base}/${repo}/blobs/${digest}`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) throw new RegistryError(`GET blob ${repo} ${digest} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async putManifest(repo: string, tag: string, manifest: unknown): Promise<string> {
    const body = JSON.stringify(manifest);
    const res = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
      method: 'PUT',
      headers: {
        Authorization: this.auth,
        'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
      },
      body,
    });
    if (!res.ok) throw new RegistryError(`PUT manifest ${repo}:${tag} → ${res.status}`);
    // Trust the registry's digest when it supplies one; fall back to our own.
    return res.headers.get('docker-content-digest') ?? sha256Digest(Buffer.from(body, 'utf8'));
  }

  async getManifest(repo: string, tag: string): Promise<{ body: string; digest: string }> {
    const res = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
      headers: { Authorization: this.auth, Accept: MANIFEST_ACCEPT },
    });
    if (!res.ok) throw new RegistryError(`GET manifest ${repo}:${tag} → ${res.status}`);
    const body = await res.text();
    const digest =
      res.headers.get('docker-content-digest') ?? sha256Digest(Buffer.from(body, 'utf8'));
    return { body, digest };
  }

  async manifestDigest(repo: string, tag: string): Promise<string | null> {
    const res = await fetch(`${this.base}/${repo}/manifests/${tag}`, {
      method: 'HEAD',
      headers: { Authorization: this.auth, Accept: MANIFEST_ACCEPT },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new RegistryError(`HEAD manifest ${repo}:${tag} → ${res.status}`);
    const digest = res.headers.get('docker-content-digest');
    if (!digest) {
      throw new RegistryError(`HEAD manifest ${repo}:${tag} returned no Docker-Content-Digest`);
    }
    return digest;
  }

  async listRepositories(): Promise<string[]> {
    const res = await fetch(`${this.base}/_catalog?n=1000`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) throw new RegistryError(`GET _catalog → ${res.status}`);
    const json = (await res.json()) as { repositories?: string[] | null };
    return json.repositories ?? [];
  }
}
