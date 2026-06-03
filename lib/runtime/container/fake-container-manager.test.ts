import { describe, it, expect } from 'vitest';
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
