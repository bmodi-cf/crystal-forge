import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitHubClient } from '@/lib/github/types';
import { forgeClonePath, logPath as logPathFor } from './paths';
import type { CommandRunner } from './runner-types';
import { childProcessRunner } from './child-process-runner';

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 60 * 1000;

export type ForgeForClone = {
  slug: string;
  repoFullName: string;
};

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

function assertOk(result: { exitCode: number }, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode})`);
  }
}

export async function ensureClone(
  forge: ForgeForClone,
  githubClient: GitHubClient,
  runner: CommandRunner = childProcessRunner,
): Promise<void> {
  const cloneDir = forgeClonePath(forge.slug);
  const log = logPathFor(forge.slug);
  await fs.mkdir(path.dirname(cloneDir), { recursive: true });
  await fs.mkdir(path.dirname(log), { recursive: true });

  if (!(await exists(path.join(cloneDir, '.git')))) {
    const token = await githubClient.getInstallationToken();
    const cloneUrl = `https://x-access-token:${token}@github.com/${forge.repoFullName}.git`;
    assertOk(
      await runner.run('git', ['clone', cloneUrl, cloneDir], {
        logPath: log, timeoutMs: CLONE_TIMEOUT_MS,
      }),
      'git clone',
    );
    assertOk(
      await runner.run(
        'git',
        ['-C', cloneDir, 'remote', 'set-url', 'origin', `https://github.com/${forge.repoFullName}.git`],
        { logPath: log, timeoutMs: QUICK_TIMEOUT_MS },
      ),
      'git remote set-url',
    );
  }

  const envLocal = path.join(cloneDir, '.env.local');
  const envExample = path.join(cloneDir, '.env.example');
  if (!(await exists(envLocal)) && (await exists(envExample))) {
    await fs.copyFile(envExample, envLocal);
  }

  if (!(await exists(path.join(cloneDir, 'node_modules')))) {
    assertOk(
      await runner.run('pnpm', ['install'], {
        cwd: cloneDir, logPath: log, timeoutMs: INSTALL_TIMEOUT_MS,
      }),
      'pnpm install',
    );
  }

  assertOk(
    await runner.run('pnpm', ['prisma', 'generate'], {
      cwd: cloneDir, logPath: log, timeoutMs: QUICK_TIMEOUT_MS,
    }),
    'pnpm prisma generate',
  );
}
