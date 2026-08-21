import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRegistryClient } from './fake-client';
import { RegistryError } from './types';

describe('FakeRegistryClient', () => {
  let reg: FakeRegistryClient;
  beforeEach(() => { reg = new FakeRegistryClient(); });

  it('retags an existing manifest to new tags', async () => {
    reg.seedTag('aquaflow-designer', 'sha-abc123');
    await reg.tagManifest('aquaflow-designer', 'sha-abc123', ['v1.0.0', 'latest']);
    expect(reg.getTags('aquaflow-designer').sort()).toEqual(
      ['latest', 'sha-abc123', 'v1.0.0'],
    );
  });

  it('throws when the source tag is missing', async () => {
    await expect(
      reg.tagManifest('aquaflow-designer', 'sha-missing', ['v1.0.0']),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  it('listTags returns empty for an unknown repo', async () => {
    expect(await reg.listTags('nope')).toEqual([]);
  });

  it('putBlob returns a real sha256 digest and getBlob round-trips it', async () => {
    const bytes = Buffer.from('layer bytes');
    const digest = await reg.putBlob('sse-seed', bytes);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await reg.getBlob('sse-seed', digest)).equals(bytes)).toBe(true);
  });

  it('putBlob is idempotent for identical bytes', async () => {
    const a = await reg.putBlob('sse-seed', Buffer.from('same'));
    const b = await reg.putBlob('sse-seed', Buffer.from('same'));
    expect(a).toBe(b);
  });

  it('getBlob throws for an unknown digest', async () => {
    await expect(reg.getBlob('sse-seed', 'sha256:' + '0'.repeat(64))).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  it('blob stores are per-repo', async () => {
    const digest = await reg.putBlob('sse-seed', Buffer.from('x'));
    await expect(reg.getBlob('other-seed', digest)).rejects.toBeInstanceOf(RegistryError);
  });

  it('putManifest tags the manifest and reports its digest', async () => {
    const digest = await reg.putManifest('sse-seed', 'v1.0.0', { schemaVersion: 2 });
    expect(await reg.manifestDigest('sse-seed', 'v1.0.0')).toBe(digest);
    expect(await reg.listTags('sse-seed')).toEqual(['v1.0.0']);
    expect(JSON.parse((await reg.getManifest('sse-seed', 'v1.0.0')).body)).toEqual({
      schemaVersion: 2,
    });
  });

  it('manifestDigest is null for a tag that does not exist', async () => {
    expect(await reg.manifestDigest('sse-seed', 'v9.9.9')).toBeNull();
  });

  it('getManifest throws for a tag that does not exist', async () => {
    await expect(reg.getManifest('sse-seed', 'v9.9.9')).rejects.toBeInstanceOf(RegistryError);
  });

  it('listRepositories reports every repo touched by seedTag or putManifest', async () => {
    reg.seedTag('second-set-of-eyes', 'v1.0.0');
    await reg.putManifest('second-set-of-eyes-seed', 'v1.0.0', { schemaVersion: 2 });
    expect((await reg.listRepositories()).sort()).toEqual([
      'second-set-of-eyes',
      'second-set-of-eyes-seed',
    ]);
  });
});
