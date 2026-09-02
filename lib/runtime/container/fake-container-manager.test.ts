import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { FakeContainerManager } from './fake-container-manager';

describe('FakeContainerManager', () => {
  it('creates, inspects, stops, and removes a container', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'forge-x', image: 'img', labels: { 'crystal-forge.forgeId': 'f1' } });
    expect((await m.inspect(id)).running).toBe(true);
    await m.stop(id);
    expect((await m.inspect(id)).running).toBe(false);
    await m.remove(id);
    expect((await m.inspect(id)).exists).toBe(false);
  });

  it('records exec calls and returns the queued exit code', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'forge-x', image: 'img' });
    m.queueExit(0);
    const res = await m.exec(id, 'git', ['clone', 'url', '/workspace'], { workdir: '/workspace' });
    expect(res.exitCode).toBe(0);
    expect(m.execCalls).toEqual([
      { id, cmd: 'git', args: ['clone', 'url', '/workspace'], opts: { workdir: '/workspace' } },
    ]);
  });

  it('lists containers filtered by label', async () => {
    const m = new FakeContainerManager();
    await m.create({ name: 'a', image: 'img', labels: { 'crystal-forge.forgeId': 'f1' } });
    await m.create({ name: 'b', image: 'img', labels: { other: 'y' } });
    const found = await m.list({ label: 'crystal-forge.forgeId' });
    expect(found.map((c) => c.name)).toEqual(['a']);
  });
});

describe('FakeContainerManager.writeUpload', () => {
  it('records the upload and returns the repo-relative path', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    const res = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['abc']) });
    expect(res.path).toBe('uploads/logo.png');
    expect(mgr.uploads).toEqual([{ id, path: 'uploads/logo.png', bytes: 3 }]);
  });

  it('suffixes colliding names per container', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    const a = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['a']) });
    const b = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['bb']) });
    const c = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['ccc']) });
    expect([a.path, b.path, c.path]).toEqual([
      'uploads/logo.png', 'uploads/logo-2.png', 'uploads/logo-3.png',
    ]);
  });

  it('suffixes extensionless names without a stray dot', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    await mgr.writeUpload(id, { name: 'NOTES', body: Readable.from(['x']) });
    const second = await mgr.writeUpload(id, { name: 'NOTES', body: Readable.from(['x']) });
    expect(second.path).toBe('uploads/NOTES-2');
  });

  it('propagates a body stream error instead of recording an upload', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    const boom = new Readable({ read() { this.destroy(new Error('boom')); } });
    await expect(mgr.writeUpload(id, { name: 'x.txt', body: boom })).rejects.toThrow('boom');
    expect(mgr.uploads).toEqual([]);
  });
});

describe('FakeContainerManager.diskUsage', () => {
  it('returns fixed figures so the sampler works under FORGE_RUNTIME_MODE=fake', async () => {
    const mgr = new FakeContainerManager();
    await expect(mgr.diskUsage()).resolves.toEqual({
      imagesBytes: 1_000_000_000,
      containersBytes: 2_000_000,
      volumesBytes: 500_000_000,
      buildCacheBytes: 3_000_000_000,
    });
  });

  it('can be told to fail, so callers can test the null-columns path', async () => {
    const mgr = new FakeContainerManager();
    mgr.diskUsageError = new Error('daemon down');
    await expect(mgr.diskUsage()).rejects.toThrow(/daemon down/);
  });
});

describe('FakeContainerManager.list with running', () => {
  it('omits stopped containers when running is true', async () => {
    const mgr = new FakeContainerManager();
    const kept = await mgr.create({ name: 'a', image: 'i', labels: { 'crystal-forge.forgeId': 'f1' } });
    const stopped = await mgr.create({ name: 'b', image: 'i', labels: { 'crystal-forge.forgeId': 'f2' } });
    await mgr.stop(stopped);

    const all = await mgr.list({ label: 'crystal-forge.forgeId' });
    expect(all).toHaveLength(2);

    const running = await mgr.list({ label: 'crystal-forge.forgeId', running: true });
    expect(running.map((c) => c.id)).toEqual([kept]);
  });
});
