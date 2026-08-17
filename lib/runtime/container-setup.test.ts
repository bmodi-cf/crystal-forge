import { describe, it, expect } from 'vitest';
import { setupForgeContainer } from './container-setup';
import { FakeContainerManager } from './container/fake-container-manager';

describe('setupForgeContainer', () => {
  it('runs clone, env copy, basePath inject, install, and prisma generate', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    // Simulate a fresh container: the `test -d .git` (call 1) and
    // `test -d node_modules` (call 11) probes report ABSENT (exit 1) so the
    // clone and install steps actually run; every other step succeeds (exit 0).
    // Call sequence: 1 test -d .git, 2 git clone, 3 remote set-url, 4 checkout
    // dev, 5 write the gh credential store (must run BEFORE gh auth setup-git —
    // see container-setup.ts step 1b), 6 gh auth setup-git, 7 .env.local seed,
    // 8 basePath inject, 9 chmod hook, 10 restart-app.sh, 11 settings.json,
    // 12 test -d node_modules.
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1].forEach((code) => m.queueExit(code));
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 'gh_tok', logPath: '/tmp/acme.log',
    });
    const cmds = m.execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.includes('git clone'))).toBe(true);
    expect(cmds.some((c) => c.includes('remote set-url origin https://github.com/org/acme.git'))).toBe(true);
    expect(cmds.some((c) => c.includes('gh auth setup-git'))).toBe(true); // git credential helper
    // The gh credential store write must be queued before `gh auth setup-git`.
    const credWriteIdx = cmds.findIndex((c) => c.includes('/home/forge/.config/gh/hosts.yml'));
    const setupGitIdx = cmds.findIndex((c) => c.includes('gh auth setup-git'));
    expect(credWriteIdx).toBeGreaterThanOrEqual(0);
    expect(credWriteIdx).toBeLessThan(setupGitIdx);
    expect(cmds.some((c) => c.includes('next.config.base.ts'))).toBe(true); // basePath inject
    expect(cmds.some((c) => c === 'pnpm install')).toBe(true);
    expect(cmds.some((c) => c === 'pnpm prisma generate')).toBe(true);
    expect(cmds.some((c) => c === 'pnpm prisma migrate deploy')).toBe(true);
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

  it('skips prisma migrate deploy when prisma/migrations is absent', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    // The forge's repo has no committed migration history (e.g. a fresh template
    // with only a schema, or a non-Prisma forge): the probe reports ABSENT.
    m.failCommand('test -d /workspace/prisma/migrations');
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log',
    });
    const cmds = m.execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    // It still probes for the migrations dir...
    expect(cmds.some((c) => c.includes('test -d /workspace/prisma/migrations'))).toBe(true);
    // ...but does not attempt to deploy migrations that don't exist.
    expect(cmds.some((c) => c === 'pnpm prisma migrate deploy')).toBe(false);
  });

  it('runs prisma migrate deploy when prisma/migrations is present', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    // Default fake exit code is 0, so the migrations probe reports PRESENT.
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log',
    });
    const cmds = m.execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c === 'pnpm prisma migrate deploy')).toBe(true);
  });

  it('seeds the gh credential store with the create-time token', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 'ghs_seed', logPath: '/tmp/acme.log',
    });
    const wrote = m.execCalls.find((c) =>
      c.cmd === 'sh' && c.args.at(-1)?.includes('/home/forge/.config/gh/hosts.yml'));
    expect(wrote).toBeTruthy();
    expect(wrote!.opts?.env).toEqual({ FORGE_GH_TOKEN: 'ghs_seed' });
  });

  // Forge work belongs on dev: main is production and only advances through an
  // approved promotion. `git clone` lands on the repo's default branch (main),
  // so without an explicit checkout every agent commit starts from main and the
  // promotion PR (dev -> main) has nothing to merge.
  it('checks out dev after a fresh clone', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    m.failCommand('test -d /workspace/.git'); // fresh container: nothing cloned yet
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log',
    });
    const cmds = m.execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    const cloneIdx = cmds.findIndex((c) => c.includes('git clone'));
    const checkoutIdx = cmds.findIndex((c) => c.includes('checkout dev'));
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeGreaterThan(cloneIdx);
  });

  it('leaves an already-cloned workspace on whatever branch it is on', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    // Default exit 0 => `test -d .git` reports PRESENT, so this is a restart of
    // an existing forge. Switching branches under someone's uncommitted work
    // would be destructive.
    await setupForgeContainer(m, id, {
      slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log',
    });
    const cmds = m.execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.includes('git clone'))).toBe(false);
    expect(cmds.some((c) => c.includes('checkout dev'))).toBe(false);
  });

  it('completes setup when the repo has no dev branch (adopted plain repo)', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    m.failCommand('test -d /workspace/.git');
    m.failCommand('checkout dev'); // no origin/dev to switch to
    await expect(
      setupForgeContainer(m, id, {
        slug: 'acme', repoFullName: 'org/acme', token: 't', logPath: '/tmp/x.log',
      }),
    ).resolves.toBeUndefined();
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
