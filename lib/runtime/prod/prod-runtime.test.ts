// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeContainerManager } from '@/lib/runtime/container/fake-container-manager';
import { FakeDatabaseProvisioner } from '@/lib/db/fake-provisioner';
import { startForgeContainer, stopForgeContainer } from './prod-runtime';
import { slugToDbName } from '@/lib/github/slug';

const prevRegistry = process.env.REGISTRY_HOST;
beforeEach(() => { process.env.REGISTRY_HOST = 'reg.example.com'; });
afterEach(() => {
  if (prevRegistry === undefined) delete process.env.REGISTRY_HOST;
  else process.env.REGISTRY_HOST = prevRegistry;
});

const input = { forgeId: 'f1', slug: 'acme-portal', deployVersion: 'v1.2.3', dbName: 'acme_portal', role: 'acme_portal_role' };

function deps(overrides = {}) {
  return {
    containerManager: new FakeContainerManager(),
    provisioner: new FakeDatabaseProvisioner(),
    probe: async () => true,
    allocatePort: async () => 3055,
    ...overrides,
  };
}

describe('startForgeContainer', () => {
  it('creates a container from the pinned registry image with prod labels/env and no git/volumes/command', async () => {
    const d = deps();
    const { port } = await startForgeContainer(d, input);
    expect(port).toBe(3055);

    const containers = d.containerManager as FakeContainerManager;
    const spec = containers.created[0]!;
    const c = (await containers.list({ label: 'crystal-forge.forgeId' }))[0]!;
    expect(spec.image).toBe('reg.example.com/acme-portal:v1.2.3');
    expect(spec.labels).toMatchObject({
      'crystal-forge.forgeId': 'f1',
      'crystal-forge.version': 'v1.2.3',
      'crystal-forge.port': '3055',
    });
    expect(spec.env).toHaveProperty('DATABASE_URL');
    expect(spec.env).toHaveProperty('FORGE_BASE_PATH', '/app/acme-portal');
    expect(spec.env).not.toHaveProperty('GH_TOKEN'); // no git in prod
    expect(spec.volumes ?? []).toEqual([]);          // no workspace/claude volumes
    expect(spec.command).toBeUndefined();            // use the image's baked entrypoint
    expect(c.labels['crystal-forge.forgeId']).toBe('f1');
  });

  it('removes the container and throws when the probe never succeeds', async () => {
    const d = deps({ probe: async () => false, probeTimeoutMs: 30, probeIntervalMs: 10 });
    await expect(startForgeContainer(d, input)).rejects.toThrow(/did not become healthy/i);
    const remaining = await d.containerManager.list({ label: 'crystal-forge.forgeId' });
    expect(remaining).toHaveLength(0);
  });

  it('creates the per-forge database (prod forges are enabled via SQL, not createForge)', async () => {
    const d = deps();
    await startForgeContainer(d, input);
    expect((d.provisioner as FakeDatabaseProvisioner).has(input.dbName)).toBe(true);
  });

  it('is idempotent when the database already exists', async () => {
    const d = deps();
    await (d.provisioner as FakeDatabaseProvisioner).createDatabase(slugToDbName(input.slug));
    // A pre-existing DB (e.g. a prior boot, or a promoted forge) must not throw.
    await expect(startForgeContainer(d, input)).resolves.toMatchObject({ port: 3055 });
  });
});

describe('stopForgeContainer', () => {
  it('stops and removes the container', async () => {
    const d = deps();
    const { containerId } = await startForgeContainer(d, input);
    await stopForgeContainer(d, containerId);
    expect((await d.containerManager.inspect(containerId)).exists).toBe(false);
  });
});
