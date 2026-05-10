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

  it('isAlive returns false for pid 0 (process-group sentinel)', () => {
    expect(isAlive(0)).toBe(false);
  });

  it('isAlive returns false for negative pid (process-group sentinel)', () => {
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(-9999)).toBe(false);
  });

  it('killProcess is a no-op for pid 0 (does NOT signal the process group)', async () => {
    // If this were broken, it would SIGTERM the test runner itself —
    // the test would never reach the expect.
    await killProcess(0, { graceMs: 50 });
    expect(true).toBe(true); // sentinel: we got here without dying
  });

  it('killProcess is a no-op for negative pid', async () => {
    await killProcess(-9999, { graceMs: 50 });
    expect(true).toBe(true);
  });
});
