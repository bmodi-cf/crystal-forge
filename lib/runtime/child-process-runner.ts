import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { CommandResult, CommandRunner, RunOpts } from './runner-types';

export const childProcessRunner: CommandRunner = {
  run(cmd, args, opts: RunOpts = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const fd = opts.logPath ? fs.openSync(opts.logPath, 'a') : 'inherit';
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', fd as never, fd as never],
      });
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* noop */ }
          reject(new Error(`Command "${cmd}" timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      child.once('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        if (timer) clearTimeout(timer);
        if (typeof fd === 'number') fs.closeSync(fd);
        resolve({ exitCode: code ?? -1 });
      });
    });
  },
};
