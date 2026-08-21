// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRegistryClient } from '@/lib/registry/fake-client';
import { ValidationError } from '@/lib/errors';
import type { BundleContents } from './types';
import { pushBundle, pullBundle, seedRepo, slugFromSeedRepo } from './registry-bundle';

const contents: BundleContents = {
  forge: {
    name: 'Second Set of Eyes',
    displayName: 'Second Set of Eyes',
    description: 'Drawing review',
    slug: 'second-set-of-eyes',
    repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
    deployVersion: 'v1.0.0',
  },
  dataSql: 'CREATE TABLE "ReviewDocument" (id text primary key);\n',
  bundle: {
    version: 'v1.0.0',
    sourceHost: 'pilot',
    cutAt: '2026-08-21T18:00:00.000Z',
    appImageDigest: 'sha256:' + 'a'.repeat(64),
    migrations: ['20260801120000_init'],
  },
};

describe('seedRepo / slugFromSeedRepo', () => {
  it('derives the seed repo from a slug and back again', () => {
    expect(seedRepo('second-set-of-eyes')).toBe('second-set-of-eyes-seed');
    expect(slugFromSeedRepo('second-set-of-eyes-seed')).toBe('second-set-of-eyes');
  });

  it('returns null for a repo that is not a seed repo', () => {
    expect(slugFromSeedRepo('second-set-of-eyes')).toBeNull();
  });
});

describe('pushBundle / pullBundle', () => {
  let reg: FakeRegistryClient;
  beforeEach(() => { reg = new FakeRegistryClient(); });

  it('round-trips a bundle through the registry', async () => {
    const pushed = await pushBundle(reg, 'second-set-of-eyes', contents);
    expect(pushed).toMatchObject({ repo: 'second-set-of-eyes-seed', tag: 'v1.0.0' });

    const { contents: back, manifestDigest } = await pullBundle(
      reg, 'second-set-of-eyes', 'v1.0.0',
    );
    expect(manifestDigest).toBe(pushed.manifestDigest);
    expect(back).toEqual(contents);
  });

  it('publishes a manifest a registry client would recognise', async () => {
    await pushBundle(reg, 'second-set-of-eyes', contents);
    const { body } = await reg.getManifest('second-set-of-eyes-seed', 'v1.0.0');
    const manifest = JSON.parse(body);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.mediaType).toBe('application/vnd.oci.image.manifest.v1+json');
    expect(manifest.layers).toHaveLength(1);
    expect(manifest.layers[0].mediaType).toBe('application/vnd.oci.image.layer.v1.tar+gzip');
    expect(manifest.layers[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.config.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('re-pushing the same content is stable (same manifest digest)', async () => {
    const a = await pushBundle(reg, 'second-set-of-eyes', contents);
    const b = await pushBundle(reg, 'second-set-of-eyes', contents);
    expect(b.manifestDigest).toBe(a.manifestDigest);
  });

  it('rejects a layer whose bytes do not match the digest the manifest claims', async () => {
    await pushBundle(reg, 'second-set-of-eyes', contents);
    // Corrupt the layer: repoint the manifest at a blob of other bytes.
    const { body } = await reg.getManifest('second-set-of-eyes-seed', 'v1.0.0');
    const manifest = JSON.parse(body);
    const otherDigest = await reg.putBlob(
      'second-set-of-eyes-seed', Buffer.from('not a gzipped tar'),
    );
    manifest.layers[0].digest = otherDigest;
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', manifest);

    await expect(pullBundle(reg, 'second-set-of-eyes', 'v1.0.0')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a bundle missing one of the three files', async () => {
    const { writeTar } = await import('./tar');
    const { gzipSync } = await import('node:zlib');
    type ZlibOptions = Parameters<typeof gzipSync>[1];
    const layer = gzipSync(writeTar([{ name: 'data.sql', body: Buffer.from('SELECT 1;') }]), {
      level: 9, mtime: 0,
    } as ZlibOptions);
    const layerDigest = await reg.putBlob('second-set-of-eyes-seed', layer);
    const configDigest = await reg.putBlob('second-set-of-eyes-seed', Buffer.from('{}'));
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configDigest,
        size: 2,
      },
      layers: [{
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: layerDigest,
        size: layer.length,
      }],
    });

    await expect(pullBundle(reg, 'second-set-of-eyes', 'v1.0.0')).rejects.toThrow(/forge\.json/);
  });

  it('rejects a manifest with no layers', async () => {
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      layers: [],
    });
    await expect(pullBundle(reg, 'second-set-of-eyes', 'v1.0.0')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
