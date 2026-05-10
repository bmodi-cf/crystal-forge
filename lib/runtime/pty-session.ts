import { spawn as spawnPty, type IPty } from 'node-pty';
import { claudeCredentialsEnv } from './claude-credentials';

export type SpawnOpts = {
  /** Defaults to 'claude' — overridable for tests. */
  command?: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** Extra env overrides, merged on top of process.env + claudeCredentialsEnv(). */
  env?: Record<string, string>;
};

export type Session = {
  pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): void;
  onExit(handler: (code: number) => void): void;
  kill(signal?: string): void;
};

export function spawnClaudeSession(opts: SpawnOpts): Session {
  const command = opts.command ?? 'claude';
  const args = opts.args ?? [];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  Object.assign(env, claudeCredentialsEnv(), opts.env ?? {});

  const child: IPty = spawnPty(command, args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env,
  });

  return {
    pid: child.pid,
    write: (data) => child.write(typeof data === 'string' ? data : data.toString('utf8')),
    resize: (cols, rows) => child.resize(cols, rows),
    onData: (handler) => { child.onData(handler); },
    onExit: (handler) => { child.onExit(({ exitCode }) => handler(exitCode)); },
    kill: (signal) => { try { child.kill(signal); } catch { /* already dead */ } },
  };
}
