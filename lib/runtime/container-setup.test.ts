import { describe, it, expect } from 'vitest';
import { setupForgeContainer } from './container-setup';
import { FakeContainerManager } from './container/fake-container-manager';

describe('setupForgeContainer', () => {
  it('runs clone, env copy, basePath inject, install, and prisma generate', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    // Simulate a fresh container: the `test -d .git` (call 1) and
    // `test -d node_modules` (call 7) probes report ABSENT (exit 1) so the
    // clone and install steps actually run; every other step succeeds (exit 0).
    [1, 0, 0, 0, 0, 0, 1].forEach((code) => m.queueExit(code));
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 'gh_tok', logPath: '/tmp/acme.log',
    });
    const cmds = m.execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.includes('git clone'))).toBe(true);
    expect(cmds.some((c) => c.includes('remote set-url origin https://github.com/org/acme.git'))).toBe(true);
    expect(cmds.some((c) => c.includes('next.config.base.ts'))).toBe(true); // basePath inject
    expect(cmds.some((c) => c === 'pnpm install')).toBe(true);
    expect(cmds.some((c) => c === 'pnpm prisma generate')).toBe(true);
  });

  it('basePath wrapper also injects allowedDevOrigins from FORGE_DEV_ORIGINS', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    await setupForgeContainer(m, id, { slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log' });
    const inject = m.execCalls.find((c) => c.cmd === 'node' && c.args.join(' ').includes('next.config.base.ts'));
    expect(inject).toBeTruthy();
    expect(inject!.args.join(' ')).toContain('allowedDevOrigins');
    expect(inject!.args.join(' ')).toContain('FORGE_DEV_ORIGINS');
  });

  it('inject script re-writes stale wrapper that lacks allowedDevOrigins', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    await setupForgeContainer(m, id, { slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log' });
    const inject = m.execCalls.find((c) => c.cmd === 'node');
    // The inject script must contain the stale-wrapper re-injection branch.
    expect(inject!.args.join(' ')).toContain('updated stale basePath wrapper');
    expect(inject!.args.join(' ')).toContain('cur!==wrapper');
  });

  it('throws when a step exits non-zero', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    m.queueExit(1); // first exec (the .git test) "fails" → treated as "not cloned", fine
    m.queueExit(1); // git clone fails
    await expect(setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log',
    })).rejects.toThrow(/git clone/);
  });
});
