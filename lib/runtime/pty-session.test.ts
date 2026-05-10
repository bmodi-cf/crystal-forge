// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { spawnClaudeSession } from './pty-session';

const sessions: Array<{ kill: () => void }> = [];

afterEach(() => {
  while (sessions.length) sessions.pop()?.kill();
});

describe('spawnClaudeSession', () => {
  it('spawns a child shell, streams stdout, and exits cleanly on kill', async () => {
    // Use bash as a stand-in for `claude` so the test doesn't require auth.
    const session = spawnClaudeSession({
      command: 'bash',
      args: ['-c', 'echo hello-from-pty; sleep 5'],
      cwd: process.cwd(),
      cols: 80, rows: 24,
    });
    sessions.push(session);
    expect(typeof session.pid).toBe('number');

    const buf: string[] = [];
    session.onData((chunk) => buf.push(chunk));

    // Wait briefly for echo output.
    await new Promise((r) => setTimeout(r, 200));
    expect(buf.join('')).toContain('hello-from-pty');

    const exitPromise = new Promise<number>((resolve) => session.onExit((code) => resolve(code)));
    session.kill();
    const exitCode = await Promise.race([
      exitPromise,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('exit timeout')), 2000)),
    ]);
    expect(typeof exitCode).toBe('number');
  });

  it('forwards write() to the child stdin', async () => {
    const session = spawnClaudeSession({
      command: 'bash',
      args: ['-c', 'cat'], // echoes whatever we write
      cwd: process.cwd(),
      cols: 80, rows: 24,
    });
    sessions.push(session);

    const buf: string[] = [];
    session.onData((chunk) => buf.push(chunk));

    session.write('ping\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(buf.join('')).toContain('ping');
  });

  it('resize() does not throw', async () => {
    const session = spawnClaudeSession({
      command: 'bash',
      args: ['-c', 'sleep 2'],
      cwd: process.cwd(),
      cols: 80, rows: 24,
    });
    sessions.push(session);
    expect(() => session.resize(120, 30)).not.toThrow();
  });
});
