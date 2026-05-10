// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnLongLived, killProcess, isAlive } from './process';

const spawned: number[] = [];

afterEach(async () => {
  for (const pid of spawned) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
  spawned.length = 0;
});

describe('process helpers', () => {
  it('spawnLongLived returns a live pid; isAlive reflects that', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-proc-'));
    const logPath = path.join(tmp, 'log');
    const pid = spawnLongLived('node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmp, logPath });
    spawned.push(pid);
    expect(typeof pid).toBe('number');
    expect(isAlive(pid)).toBe(true);
  });

  it('killProcess SIGTERMs and returns once the process exits', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-proc-'));
    const pid = spawnLongLived('node', ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmp, logPath: path.join(tmp, 'log'),
    });
    spawned.push(pid);
    await killProcess(pid, { graceMs: 1000 });
    expect(isAlive(pid)).toBe(false);
  });

  it('killProcess escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-proc-'));
    const pid = spawnLongLived(
      'node',
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { cwd: tmp, logPath: path.join(tmp, 'log') },
    );
    spawned.push(pid);
    await killProcess(pid, { graceMs: 200 });
    expect(isAlive(pid)).toBe(false);
  });

  it('isAlive returns false for an unknown pid', () => {
    expect(isAlive(999_999_999)).toBe(false);
  });
});
