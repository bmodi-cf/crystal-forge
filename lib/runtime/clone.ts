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

const BASE_PATH_WRAPPER = `// crystal-forge: basePath injected for path-based reverse proxy. Do not edit.
import base from './next.config.base';
const basePath = process.env.FORGE_BASE_PATH || undefined;
export default { ...base, basePath };
`;

/**
 * Make the cloned Next.js app serve itself under basePath=/app/<slug> so it
 * works behind the dashboard's path-based reverse proxy. Idempotent: the
 * presence of next.config.base.ts is the marker that the patch already ran.
 *
 * The wrapper spreads the base file's default export, so that export must
 * resolve to a plain config **object** at module load. Plugin wrappers that
 * *return* an object (e.g. `export default withSentryConfig(nextConfig)`) are
 * fine — `base` is the returned object. Only a default export that is itself a
 * **function** (config-as-function, e.g. `export default (phase) => ({...})`)
 * cannot be spread; those are detected and skipped.
 */
async function injectBasePath(cloneDir: string): Promise<void> {
  const cfg = path.join(cloneDir, 'next.config.ts');
  const marker = path.join(cloneDir, 'next.config.base.ts');
  if (await exists(marker)) return; // already patched
  if (!(await exists(cfg))) return; // nothing to patch (e.g. .js/.mjs config — out of scope)
  const content = await fs.readFile(cfg, 'utf8');
  if (/export\s+default\s+(async\s+)?function|export\s+default\s*\(/.test(content)) {
    // Function-style config can't be spread into an object wrapper; leave it alone.
    console.warn('[runtime/clone] next.config.ts exports a function; skipping basePath injection');
    return;
  }
  await fs.rename(cfg, marker);
  await fs.writeFile(cfg, BASE_PATH_WRAPPER, 'utf8');
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

  // Run on every ensureClone (not just fresh clones) so existing clones are
  // patched on their next start. injectBasePath is idempotent.
  await injectBasePath(cloneDir);

  // GitHub's contents API doesn't preserve the executable bit; restore it on
  // the PreToolUse hook script so Claude Code can run it.
  const hookScript = path.join(cloneDir, '.claude', 'hooks', 'block-dangerous-commands.sh');
  if (await exists(hookScript)) {
    await fs.chmod(hookScript, 0o755);
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
