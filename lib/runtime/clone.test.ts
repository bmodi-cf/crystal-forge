// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureClone } from './clone';
import type { CommandRunner, RunOpts } from './runner-types';
import { FakeGitHubClient } from '@/lib/github/fake-client';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-clone-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

type Call = { cmd: string; args: string[]; opts?: RunOpts };

function makeFakeRunner(side: (call: Call) => Promise<void> = async () => {}): {
  runner: CommandRunner; calls: Call[];
} {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      await side({ cmd, args, opts });
      return { exitCode: 0 };
    },
  };
  return { runner, calls };
}

describe('ensureClone', () => {
  it('clones, rewrites the remote, copies env, installs, generates prisma — in order', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const { runner, calls } = makeFakeRunner(async ({ cmd, args }) => {
      // Simulate `git clone` creating .git and .env.example.
      if (cmd === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        await fs.writeFile(path.join(dest, '.env.example'), 'DATABASE_URL=foo\n');
      }
    });

    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    const cloneDir = path.join(tmp, 'clones', 'marketing-frufru');
    expect(calls[0]?.cmd).toBe('git');
    expect(calls[0]?.args[0]).toBe('clone');
    expect(calls[0]?.args[1]).toContain('x-access-token:fake-installation-token');
    expect(calls[1]?.args).toEqual(
      ['-C', cloneDir, 'remote', 'set-url', 'origin', 'https://github.com/bmodi-cf/marketing-frufru.git'],
    );
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'install')).toBeDefined();
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'prisma' && c.args[1] === 'generate')).toBeDefined();

    expect(await fs.readFile(path.join(cloneDir, '.env.local'), 'utf8')).toContain('DATABASE_URL=foo');
  });

  it('is idempotent: a second call skips clone, env-copy, and install', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const cloneDir = path.join(tmp, 'clones', 'marketing-frufru');
    await fs.mkdir(path.join(cloneDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(cloneDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(cloneDir, '.env.example'), 'X=1\n');
    await fs.writeFile(path.join(cloneDir, '.env.local'), 'X=existing\n');

    const { runner, calls } = makeFakeRunner();
    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'clone')).toBeUndefined();
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'install')).toBeUndefined();
    // prisma generate still runs (cheap, idempotent).
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'prisma')).toBeDefined();
    // .env.local left untouched.
    expect(await fs.readFile(path.join(cloneDir, '.env.local'), 'utf8')).toBe('X=existing\n');
  });

  it('throws if a runner step exits non-zero', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const failing: CommandRunner = { async run() { return { exitCode: 1 }; } };
    await expect(
      ensureClone({ slug: 's', repoFullName: 'o/s' }, fakeGh, failing),
    ).rejects.toThrow(/exit/i);
  });
});
