import { CONTAINER_WORKDIR } from './paths';
import type { ContainerManager, ExecOpts } from './container/types';

const W = CONTAINER_WORKDIR;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 60 * 1000;

export type SetupOpts = { slug: string; repoFullName: string; token: string; logPath: string };

// Wrapper written when injecting basePath. Mirrors clone.ts BASE_PATH_WRAPPER.
const WRAPPER = `// crystal-forge: basePath injected for path-based reverse proxy. Do not edit.
import base from './next.config.base';
const basePath = process.env.FORGE_BASE_PATH || undefined;
export default { ...base, basePath };
`;

export async function setupForgeContainer(
  mgr: ContainerManager,
  id: string,
  opts: SetupOpts,
): Promise<void> {
  const base: ExecOpts = { workdir: W, logPath: opts.logPath };
  const exec = (cmd: string, args: string[], o: ExecOpts = {}) =>
    mgr.exec(id, cmd, args, { ...base, ...o });
  const assertOk = async (p: Promise<{ exitCode: number }>, label: string) => {
    const { exitCode } = await p;
    if (exitCode !== 0) throw new Error(`${label} failed (exit ${exitCode})`);
  };

  // 1. Clone if /workspace/.git is absent. The GitHub token goes via an env var,
  //    never the URL/argv (avoids leaking it into docker ps / logs).
  const gitPresent = (await exec('test', ['-d', `${W}/.git`])).exitCode === 0;
  if (!gitPresent) {
    await assertOk(
      exec('sh', ['-c',
        `git clone "https://x-access-token:$GH_TOKEN@github.com/${opts.repoFullName}.git" ${W}`,
      ], { env: { GH_TOKEN: opts.token }, timeoutMs: CLONE_TIMEOUT_MS }),
      'git clone',
    );
    await assertOk(
      exec('git', ['-C', W, 'remote', 'set-url', 'origin',
        `https://github.com/${opts.repoFullName}.git`], { timeoutMs: QUICK_TIMEOUT_MS }),
      'git remote set-url',
    );
  }

  // 2. Seed .env.local from .env.example when present and missing.
  await exec('sh', ['-c',
    `test -f ${W}/.env.local || { test -f ${W}/.env.example && cp ${W}/.env.example ${W}/.env.local; } || true`,
  ]);

  // 3. Inject basePath wrapper (idempotent: next.config.base.ts is the marker).
  //    Driven by `node -e` rather than a shell heredoc — the heredoc was fragile
  //    under dash (Debian /bin/sh) and silently failed with a syntax error, so
  //    basePath was never injected. The script is passed as a single argv element.
  const injectScript = [
    `const fs=require('fs');`,
    `const dir=${JSON.stringify(W)};`,
    `const cfg=dir+'/next.config.ts',base=dir+'/next.config.base.ts';`,
    `if(!fs.existsSync(base)&&fs.existsSync(cfg)){`,
    `const c=fs.readFileSync(cfg,'utf8');`,
    `if(/export\\s+default\\s+(async\\s+)?function|export\\s+default\\s*\\(/.test(c)){`,
    `console.log('skip basePath inject (function config)');`,
    `}else{fs.renameSync(cfg,base);fs.writeFileSync(cfg,${JSON.stringify(WRAPPER)});}`,
    `}`,
  ].join('');
  await exec('node', ['-e', injectScript]);

  // 4. Restore exec bit on the PreToolUse hook (GitHub contents API drops it).
  await exec('sh', ['-c',
    `test -f ${W}/.claude/hooks/block-dangerous-commands.sh && chmod 755 ${W}/.claude/hooks/block-dangerous-commands.sh || true`,
  ]);

  // 5. Install deps if node_modules is absent.
  const modulesPresent = (await exec('test', ['-d', `${W}/node_modules`])).exitCode === 0;
  if (!modulesPresent) {
    await assertOk(exec('pnpm', ['install'], { timeoutMs: INSTALL_TIMEOUT_MS }), 'pnpm install');
  }

  // 6. Generate Prisma client (every start; cheap).
  await assertOk(exec('pnpm', ['prisma', 'generate'], { timeoutMs: QUICK_TIMEOUT_MS }), 'pnpm prisma generate');
}
