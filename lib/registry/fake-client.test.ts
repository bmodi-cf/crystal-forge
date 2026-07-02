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
});
