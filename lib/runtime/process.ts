import { spawn } from 'node:child_process';
import fs from 'node:fs';

export type SpawnOpts = {
  cwd: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
};

export function spawnLongLived(cmd: string, args: string[], opts: SpawnOpts): number {
  const fd = fs.openSync(opts.logPath, 'a');
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', fd, fd],
    detached: false,
  });
  child.unref();
  if (!child.pid) {
    fs.closeSync(fd);
    throw new Error(`Failed to spawn ${cmd}`);
  }
  return child.pid;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killProcess(
  pid: number,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const grace = opts.graceMs ?? 5000;
  if (!isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const start = Date.now();
  while (Date.now() - start < grace) {
    if (!isAlive(pid)) return;
    await sleep(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) return;
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
