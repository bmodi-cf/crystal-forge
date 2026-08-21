import { gzipSync, gunzipSync, type ZlibOptions } from 'node:zlib';
import { ValidationError } from '@/lib/errors';
import type { RegistryClient } from '@/lib/registry/types';
import { writeTar, readTar, sha256Digest } from './tar';
import {
  BUNDLE_FILES,
  parseBundleJson,
  parseForgeJson,
  type BundleContents,
} from './types';

const SEED_SUFFIX = '-seed';
const LAYER_MEDIA_TYPE = 'application/vnd.oci.image.layer.v1.tar+gzip';
const CONFIG_MEDIA_TYPE = 'application/vnd.oci.image.config.v1+json';
const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';

/** A bundle lives in its own repo so its lifecycle is independent (spec §1.1). */
export function seedRepo(slug: string): string {
  return `${slug}${SEED_SUFFIX}`;
}

export function slugFromSeedRepo(repo: string): string | null {
  return repo.endsWith(SEED_SUFFIX) ? repo.slice(0, -SEED_SUFFIX.length) : null;
}

type OciManifest = {
  schemaVersion: number;
  mediaType: string;
  config: { mediaType: string; digest: string; size: number };
  layers: { mediaType: string; digest: string; size: number }[];
};

function packLayer(contents: BundleContents): { tar: Buffer; layer: Buffer } {
  const tar = writeTar([
    { name: BUNDLE_FILES.forge, body: Buffer.from(JSON.stringify(contents.forge, null, 2), 'utf8') },
    { name: BUNDLE_FILES.data, body: Buffer.from(contents.dataSql, 'utf8') },
    { name: BUNDLE_FILES.bundle, body: Buffer.from(JSON.stringify(contents.bundle, null, 2), 'utf8') },
  ]);
  // mtime: 0 keeps the gzip envelope byte-stable, like the tar inside it.
  // (Not in @types/node's ZlibOptions, though Node's binding accepts and
  // defaults it to 0 regardless — the cast documents the intent explicitly
  // rather than relying on that default silently.)
  return { tar, layer: gzipSync(tar, { level: 9, mtime: 0 } as ZlibOptions) };
}

/**
 * Push a bundle as an ordinary OCI image: one gzipped tar layer plus a minimal
 * config blob. Re-cutting identical content produces an identical manifest
 * digest, because both the tar and the gzip envelope are deterministic.
 */
export async function pushBundle(
  registry: RegistryClient,
  slug: string,
  contents: BundleContents,
): Promise<{ repo: string; tag: string; manifestDigest: string }> {
  const repo = seedRepo(slug);
  const tag = contents.bundle.version;
  const { tar, layer } = packLayer(contents);

  const config = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: {},
      rootfs: { type: 'layers', diff_ids: [sha256Digest(tar)] },
    }),
    'utf8',
  );

  const [configDigest, layerDigest] = await Promise.all([
    registry.putBlob(repo, config),
    registry.putBlob(repo, layer),
  ]);

  const manifest: OciManifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: { mediaType: CONFIG_MEDIA_TYPE, digest: configDigest, size: config.length },
    layers: [{ mediaType: LAYER_MEDIA_TYPE, digest: layerDigest, size: layer.length }],
  };

  const manifestDigest = await registry.putManifest(repo, tag, manifest);
  return { repo, tag, manifestDigest };
}

/**
 * Pull and verify a bundle. Verification is the spec §5 integrity guard: the
 * layer bytes are re-digested and compared with what the manifest claims, so a
 * truncated or swapped blob is refused rather than half-restored.
 */
export async function pullBundle(
  registry: RegistryClient,
  slug: string,
  tag: string,
): Promise<{ contents: BundleContents; manifestDigest: string }> {
  const repo = seedRepo(slug);
  const { body, digest: manifestDigest } = await registry.getManifest(repo, tag);

  let manifest: OciManifest;
  try {
    manifest = JSON.parse(body) as OciManifest;
  } catch {
    throw new ValidationError(`Bundle ${repo}:${tag} has an unparseable manifest`, {});
  }

  const descriptor = manifest.layers?.[0];
  if (!descriptor) {
    throw new ValidationError(`Bundle ${repo}:${tag} has no layers`, {});
  }

  const layer = await registry.getBlob(repo, descriptor.digest);
  const actual = sha256Digest(layer);
  if (actual !== descriptor.digest) {
    throw new ValidationError(
      `Bundle ${repo}:${tag} failed its integrity check: layer is ${actual}, ` +
        `manifest claims ${descriptor.digest}`,
      {},
    );
  }

  let files: Map<string, Buffer>;
  try {
    files = readTar(gunzipSync(layer));
  } catch (err) {
    throw new ValidationError(
      `Bundle ${repo}:${tag} layer is not a gzipped tar: ` +
        (err instanceof Error ? err.message : String(err)),
      {},
    );
  }

  for (const file of Object.values(BUNDLE_FILES)) {
    if (!files.has(file)) {
      throw new ValidationError(`Bundle ${repo}:${tag} is missing ${file}`, {});
    }
  }

  const json = (name: string): unknown => {
    try {
      return JSON.parse(files.get(name)!.toString('utf8'));
    } catch {
      throw new ValidationError(`Bundle ${repo}:${tag} has unparseable ${name}`, {});
    }
  };

  return {
    manifestDigest,
    contents: {
      forge: parseForgeJson(json(BUNDLE_FILES.forge)),
      dataSql: files.get(BUNDLE_FILES.data)!.toString('utf8'),
      bundle: parseBundleJson(json(BUNDLE_FILES.bundle)),
    },
  };
}
