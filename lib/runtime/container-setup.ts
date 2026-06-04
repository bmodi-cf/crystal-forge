import { CONTAINER_WORKDIR } from './paths';
import type { ContainerManager, ExecOpts } from './container/types';

const W = CONTAINER_WORKDIR;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 60 * 1000;

export type SetupOpts = { slug: string; repoFullName: string; token: string; logPath: string };

// Wrapper written when injecting basePath. Mirrors clone.ts BASE_PATH_WRAPPER.
const WRAPPER = `// crystal-forge: basePath + dev origins injected for the reverse proxy. Do not edit.
import base from './next.config.base';
const basePath = process.env.FORGE_BASE_PATH || undefined;
const allowedDevOrigins = (process.env.FORGE_DEV_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
export default { ...base, basePath, ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}) };
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

  // 3. Inject basePath wrapper. Idempotent: next.config.base.ts is the marker that
  //    the wrapper was already injected. Also re-injects when the wrapper is stale
  //    (i.e. missing allowedDevOrigins), so old containers pick up new features on
  //    the next start without manual intervention.
  //    Driven by `node -e` rather than a shell heredoc — the heredoc was fragile
  //    under dash (Debian /bin/sh) and silently failed with a syntax error, so
  //    basePath was never injected. The script is passed as a single argv element.
  const injectScript = [
    `const fs=require('fs');`,
    `const dir=${JSON.stringify(W)};`,
    `const cfg=dir+'/next.config.ts',base=dir+'/next.config.base.ts';`,
    `const wrapper=${JSON.stringify(WRAPPER)};`,
    `if(!fs.existsSync(base)&&fs.existsSync(cfg)){`,
    // First-time injection: rename original → base, write wrapper.
    `const c=fs.readFileSync(cfg,'utf8');`,
    `if(/export\\s+default\\s+(async\\s+)?function|export\\s+default\\s*\\(/.test(c)){`,
    `console.log('skip basePath inject (function config)');`,
    `}else{fs.renameSync(cfg,base);fs.writeFileSync(cfg,wrapper);}`,
    `}else if(fs.existsSync(base)&&fs.existsSync(cfg)){`,
    // Re-inject stale wrapper (e.g. missing allowedDevOrigins from older release).
    `const cur=fs.readFileSync(cfg,'utf8');`,
    `if(cur!==wrapper){fs.writeFileSync(cfg,wrapper);console.log('updated stale basePath wrapper');}`,
    `}`,
  ].join('');
  await exec('node', ['-e', injectScript]);

  // 4. Restore exec bit on the PreToolUse hook (GitHub contents API drops it).
  await exec('sh', ['-c',
    `test -f ${W}/.claude/hooks/block-dangerous-commands.sh && chmod 755 ${W}/.claude/hooks/block-dangerous-commands.sh || true`,
  ]);

  // 4b. Inject restart-app.sh so the agent can trigger a production rebuild
  //     without needing dashboard access. Kills next-server; the supervisor
  //     loop detects the exit and runs `pnpm build && pnpm start` automatically.
  //     Also writes .claude/settings.json to pre-approve the script so the
  //     agent is never prompted. Both files belong in the template repo long-
  //     term; this injection covers forges until the template is updated.
  await exec('sh', ['-c', [
    `cat > ${W}/restart-app.sh << 'RESTART_EOF'`,
    `#!/bin/sh`,
    `echo "[restart-app] stopping server — supervisor will rebuild and restart (~60s)..."`,
    `pkill -f next-server 2>/dev/null || pkill -f "next start" 2>/dev/null || true`,
    `echo "[restart-app] done."`,
    `RESTART_EOF`,
    `chmod +x ${W}/restart-app.sh`,
  ].join('\n')]);
  await exec('sh', ['-c', [
    `mkdir -p ${W}/.claude`,
    `cat > ${W}/.claude/settings.json << 'SETTINGS_EOF'`,
    `{`,
    `  "permissions": {`,
    `    "allow": ["Bash(./restart-app.sh)", "Bash(/workspace/restart-app.sh)"]`,
    `  }`,
    `}`,
    `SETTINGS_EOF`,
  ].join('\n')]);

  // 5. Install deps if node_modules is absent.
  const modulesPresent = (await exec('test', ['-d', `${W}/node_modules`])).exitCode === 0;
  if (!modulesPresent) {
    await assertOk(exec('pnpm', ['install'], { timeoutMs: INSTALL_TIMEOUT_MS }), 'pnpm install');
  }

  // 6. Generate Prisma client (every start; cheap).
  await assertOk(exec('pnpm', ['prisma', 'generate'], { timeoutMs: QUICK_TIMEOUT_MS }), 'pnpm prisma generate');
}
