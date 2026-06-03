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

  it('chmods .claude/hooks/block-dangerous-commands.sh executable after clone', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const { runner } = makeFakeRunner(async ({ cmd, args }) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        await fs.mkdir(path.join(dest, '.claude', 'hooks'), { recursive: true });
        // GitHub contents API does NOT preserve the executable bit, so the
        // file lands as 0o644 in a fresh clone.
        await fs.writeFile(
          path.join(dest, '.claude', 'hooks', 'block-dangerous-commands.sh'),
          '#!/usr/bin/env bash\nexit 0\n',
          { mode: 0o644 },
        );
      }
    });

    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    const hook = path.join(tmp, 'clones', 'marketing-frufru', '.claude', 'hooks', 'block-dangerous-commands.sh');
    const stat = await fs.stat(hook);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('throws if a runner step exits non-zero', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const failing: CommandRunner = { async run() { return { exitCode: 1 }; } };
    await expect(
      ensureClone({ slug: 's', repoFullName: 'o/s' }, fakeGh, failing),
    ).rejects.toThrow(/exit/i);
  });

  it('wraps next.config.ts to inject basePath, idempotently', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const { runner } = makeFakeRunner(async ({ cmd, args }) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        await fs.writeFile(
          path.join(dest, 'next.config.ts'),
          "import type { NextConfig } from 'next';\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n",
        );
      }
    });

    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    const cloneDir = path.join(tmp, 'clones', 'marketing-frufru');
    const base = await fs.readFile(path.join(cloneDir, 'next.config.base.ts'), 'utf8');
    expect(base).toContain('const nextConfig: NextConfig = {}');
    const cfg = await fs.readFile(path.join(cloneDir, 'next.config.ts'), 'utf8');
    expect(cfg).toContain("import base from './next.config.base'");
    expect(cfg).toContain('process.env.FORGE_BASE_PATH');

    // Second run must not double-wrap (idempotent via the base-file marker).
    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );
    expect(await fs.readFile(path.join(cloneDir, 'next.config.base.ts'), 'utf8')).toBe(base);
    expect(await fs.readFile(path.join(cloneDir, 'next.config.ts'), 'utf8')).toBe(cfg);
  });

  it('skips basePath injection when next.config.ts default export is a function', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const { runner } = makeFakeRunner(async ({ cmd, args }) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        await fs.writeFile(
          path.join(dest, 'next.config.ts'),
          'export default function config() { return {}; }\n',
        );
      }
    });

    await ensureClone(
      { slug: 'fn-config', repoFullName: 'bmodi-cf/fn-config' },
      fakeGh,
      runner,
    );

    const cloneDir = path.join(tmp, 'clones', 'fn-config');
    await expect(fs.stat(path.join(cloneDir, 'next.config.base.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(cloneDir, 'next.config.ts'), 'utf8')).toContain('export default function config');
  });

  it('creates the log directory before any runner.run is invoked', async () => {
    const fakeGh = new FakeGitHubClient({ owner: 'bmodi-cf', baseUrl: 'https://github.com' });
    const accessChecks: { logPath: string; parentExists: boolean }[] = [];
    const runner: CommandRunner = {
      async run(cmd, args, opts) {
        if (opts?.logPath) {
          try {
            await fs.access(path.dirname(opts.logPath));
            accessChecks.push({ logPath: opts.logPath, parentExists: true });
          } catch {
            accessChecks.push({ logPath: opts.logPath, parentExists: false });
          }
        }
        // Simulate `git clone` creating .git so subsequent steps run idempotently.
        if (cmd === 'git' && args[0] === 'clone') {
          const dest = args[args.length - 1]!;
          await fs.mkdir(path.join(dest, '.git'), { recursive: true });
        }
        return { exitCode: 0 };
      },
    };

    await ensureClone(
      { slug: 'marketing-frufru', repoFullName: 'bmodi-cf/marketing-frufru' },
      fakeGh,
      runner,
    );

    expect(accessChecks.length).toBeGreaterThan(0);
    for (const c of accessChecks) {
      expect(c.parentExists).toBe(true); // log dir must exist when runner runs
    }
    // Belt-and-braces: log path must be under <home>/logs/, not inside clone dir.
    expect(accessChecks[0]!.logPath).toMatch(/\/logs\/marketing-frufru\.log$/);
  });
});
